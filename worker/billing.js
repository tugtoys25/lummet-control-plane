// =====================================================
// BILLING SERVICE (master prompt sections 14-15)
//
// Provider-neutral — every function here deals only in this
// repo's internal subscription statuses and its own tables.
// The only thing that knows Stripe exists is the `provider`
// object passed to createBillingService(), matching
// billing-provider.js's documented contract. Production code
// uses the `billing` singleton at the bottom of this file
// (bound to billing-stripe.js); tests construct their own
// service bound to a fake provider (test/support/
// fake-billing-provider.js) so the state-machine and
// idempotency logic below can be exercised without any
// network access or real Stripe account.
// =====================================================

import * as webhookEvents from "./repositories/billing-webhooks.js";
import * as couponRepo from "./repositories/coupons.js";
import * as customerRepo from "./repositories/billing-customers.js";
import * as stripeProvider from "./billing-stripe.js";
import * as webhooks from "./webhooks.js";

const NON_TERMINAL_STATUSES = "('canceled','expired','incomplete_expired')";

// How long a pending checkout holds the last uses of a limited coupon.
const COUPON_HOLD_SECONDS = 3600;

export function createBillingService(provider) {
  async function getOrganizationIdForProviderCustomer(env, providerCustomerId) {
    if (!providerCustomerId) return null;
    const row = await env.LUMMET_DB.prepare(
      `SELECT organization_id FROM billing_customers WHERE provider = ? AND provider_customer_id = ?`
    )
      .bind(provider.PROVIDER_NAME, providerCustomerId)
      .first();
    return row?.organization_id || null;
  }

  async function getSubscriptionByProviderId(env, providerSubscriptionId) {
    return env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE provider_subscription_id = ?`)
      .bind(providerSubscriptionId)
      .first();
  }

  async function getCurrentSubscription(env, organizationId) {
    return env.LUMMET_DB.prepare(
      `SELECT * FROM subscriptions WHERE organization_id = ? AND status NOT IN ${NON_TERMINAL_STATUSES} ORDER BY created_at DESC LIMIT 1`
    )
      .bind(organizationId)
      .first();
  }

  async function recordSubscriptionStatusEvent(env, { subscriptionId, fromStatus, toStatus, reason, actorType, actorId }) {
    await env.LUMMET_DB.prepare(
      `INSERT INTO subscription_status_events (subscription_id, from_status, to_status, reason, actor_type, actor_id)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(subscriptionId, fromStatus || null, toStatus, reason || null, actorType || "system", actorId || null)
      .run();
  }

  async function ensureBillingCustomer(env, organizationId) {
    const existing = await env.LUMMET_DB.prepare(
      `SELECT * FROM billing_customers WHERE organization_id = ? AND provider = ?`
    )
      .bind(organizationId, provider.PROVIDER_NAME)
      .first();
    if (existing) return existing;

    const org = await env.LUMMET_DB.prepare(`SELECT * FROM organizations WHERE id = ?`).bind(organizationId).first();
    if (!org) return null;

    const created = await provider.createCustomer(env, { organizationId, email: org.billing_email || null });

    await env.LUMMET_DB.prepare(
      `INSERT INTO billing_customers (organization_id, provider, provider_customer_id) VALUES (?, ?, ?)`
    )
      .bind(organizationId, provider.PROVIDER_NAME, created.providerCustomerId)
      .run();

    return { organization_id: organizationId, provider: provider.PROVIDER_NAME, provider_customer_id: created.providerCustomerId };
  }

  /**
   * Checks a coupon code for an organization without using it up.
   * Case-insensitive on the code. Fails with invalid_coupon (unknown,
   * disabled, expired, or scoped to a different organization), coupon_exhausted (limit reached) or
   * coupon_already_used (this organization redeemed it before).
   * The count is only a pre-check: the real redemption is recorded
   * when checkout completes, so two simultaneous checkouts can both
   * pass here for the last remaining use.
   */
  async function validateCoupon(env, organizationId, code) {
    const clean = String(code || "").trim();
    if (!clean) return { ok: false, error: "invalid_coupon" };
    const coupon = await couponRepo.findActiveByCode(env, clean);
    if (!coupon) return { ok: false, error: "invalid_coupon" };
    // Organization-scoped coupon used by someone else: same answer as an unknown code,
    // so a scoped code cannot be discovered by guessing.
    if (coupon.organization_id && coupon.organization_id !== organizationId) return { ok: false, error: "invalid_coupon" };
    if (coupon.max_redemptions != null) {
      // Redemptions plus other organizations' unexpired holds. Your own hold never blocks you.
      const holds = await couponRepo.countOtherHolds(env, coupon.id, organizationId);
      if (coupon.redemption_count + holds >= coupon.max_redemptions) return { ok: false, error: "coupon_exhausted" };
    }
    if (await couponRepo.hasRedeemed(env, coupon.id, organizationId)) return { ok: false, error: "coupon_already_used" };
    return {
      ok: true,
      coupon,
      summary: { code: coupon.code, percentOff: coupon.percent_off, amountOffCents: coupon.amount_off_cents, duration: coupon.duration }
    };
  }

  /** Records a redemption once; safe to call again for the same organization (webhook retries). */
  async function recordCouponRedemption(env, { couponId, organizationId, subscriptionId }) {
    if (!couponId) return;
    await couponRepo.releaseHold(env, couponId, organizationId);
    if (!(await couponRepo.findById(env, couponId))) return;
    if (await couponRepo.addRedemption(env, { couponId, organizationId, subscriptionId })) await couponRepo.incrementRedemptionCount(env, couponId);
    if (subscriptionId) await couponRepo.attachToSubscription(env, subscriptionId, couponId);
  }

  /**
   * Starts a real checkout for a paid plan. Refuses (rather than
   * faking success) when the plan has no provider price configured
   * yet, or when the organization already has a real provider
   * subscription — an existing PHASE-1 TRIAL (provider IS NULL) is
   * fine and gets converted in place once checkout completes (see
   * dispatchEvent's "checkout.session.completed" case below).
   */
  async function startCheckout(env, { organizationId, planId, successUrl, cancelUrl, couponCode }) {
    if (!successUrl || !cancelUrl) return { ok: false, status: 422, error: "success_and_cancel_url_required" };

    const plan = await env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ? AND status = 'active'`).bind(planId).first();
    if (!plan) return { ok: false, status: 422, error: "invalid_plan" };
    if (!plan.stripe_price_id) return { ok: false, status: 409, error: "plan_not_billing_configured" };

    const existingSub = await env.LUMMET_DB.prepare(
      `SELECT id, provider FROM subscriptions WHERE organization_id = ? AND status NOT IN ${NON_TERMINAL_STATUSES}`
    )
      .bind(organizationId)
      .first();
    if (existingSub && existingSub.provider) {
      return { ok: false, status: 409, error: "organization_already_subscribed" };
    }

    const customer = await ensureBillingCustomer(env, organizationId);
    if (!customer) return { ok: false, status: 404, error: "organization_not_found" };

    let couponProviderId = null;
    let couponId = null;
    let held = false;
    if (couponCode) {
      const checked = await validateCoupon(env, organizationId, couponCode);
      if (!checked.ok) return { ok: false, status: 422, error: checked.error };
      couponProviderId = checked.coupon.provider_coupon_id;
      couponId = checked.coupon.id;
      if (checked.coupon.max_redemptions != null) {
        if (!(await couponRepo.reserveUse(env, couponId, organizationId, COUPON_HOLD_SECONDS))) return { ok: false, status: 422, error: "coupon_exhausted" };
        held = true;
      }
    }

    let session;
    try {
      session = await provider.createCheckoutSession(env, {
      providerCustomerId: customer.provider_customer_id,
      priceId: plan.stripe_price_id,
      successUrl,
      cancelUrl,
      trialDays: plan.trial_days || 0,
      organizationId,
      planId,
      couponProviderId,
      couponId,
      // A held coupon use must not outlive the checkout page that holds it:
      // the provider session expires shortly after the hold does.
      ...(held ? { expiresAt: Math.floor(Date.now() / 1000) + COUPON_HOLD_SECONDS + 60 } : {})
      });
    } catch (err) {
      if (held) await couponRepo.releaseHold(env, couponId, organizationId);
      throw err;
    }

    return { ok: true, checkoutUrl: session.checkoutUrl, providerSessionId: session.providerSessionId };
  }

  /**
   * Returns a provider-hosted page where the customer updates their card
   * and views invoices. Only for organizations that already have a
   * provider customer (i.e. started a checkout); a provider failure is
   * reported as portal_unavailable rather than leaked verbatim.
   */
  async function openBillingPortal(env, organizationId, { returnUrl }) {
    if (!returnUrl) return { ok: false, status: 422, error: "return_url_required" };
    const providerCustomerId = await customerRepo.findProviderCustomerId(env, organizationId, provider.PROVIDER_NAME);
    if (!providerCustomerId) return { ok: false, status: 409, error: "no_billing_customer" };
    try {
      const session = await provider.createPortalSession(env, { providerCustomerId, returnUrl });
      return { ok: true, portalUrl: session.portalUrl };
    } catch (_) {
      return { ok: false, status: 502, error: "portal_unavailable" };
    }
  }

  async function cancelSubscription(env, organizationId, { atPeriodEnd = true, actorUserId } = {}) {
    const sub = await getCurrentSubscription(env, organizationId);
    if (!sub) return { ok: false, status: 404, error: "no_active_subscription" };

    if (!sub.provider_subscription_id) {
      // A Phase-1 trial with no provider involved yet — cancel
      // locally; there is nothing to tell a payment provider about.
      await env.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'canceled', canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(sub.id)
        .run();
      await recordSubscriptionStatusEvent(env, {
        subscriptionId: sub.id, fromStatus: sub.status, toStatus: "canceled",
        reason: "canceled during trial (no provider)", actorType: "customer_user", actorId: actorUserId
      });
      return { ok: true, canceledImmediately: true };
    }

    await provider.cancelSubscription(env, sub.provider_subscription_id, { atPeriodEnd });

    if (atPeriodEnd) {
      await env.LUMMET_DB.prepare(`UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(sub.id)
        .run();
    }
    // Immediate cancellation's authoritative status update comes from
    // the customer.subscription.deleted webhook, not assumed here —
    // never fake a state the provider hasn't confirmed (rule #5).

    return { ok: true, canceledImmediately: false };
  }

  async function resumeSubscription(env, organizationId) {
    const sub = await getCurrentSubscription(env, organizationId);
    if (!sub) return { ok: false, status: 404, error: "no_active_subscription" };
    if (!sub.cancel_at_period_end) return { ok: false, status: 409, error: "not_pending_cancellation" };
    if (!sub.provider_subscription_id) return { ok: false, status: 409, error: "no_provider_subscription" };

    await provider.resumeSubscription(env, sub.provider_subscription_id);
    await env.LUMMET_DB.prepare(`UPDATE subscriptions SET cancel_at_period_end = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(sub.id)
      .run();

    return { ok: true };
  }

  async function changePlan(env, organizationId, newPlanId, { actorUserId } = {}) {
    const sub = await getCurrentSubscription(env, organizationId);
    if (!sub) return { ok: false, status: 404, error: "no_active_subscription" };
    if (!sub.provider_subscription_id) return { ok: false, status: 409, error: "no_provider_subscription" };

    const newPlan = await env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ? AND status = 'active'`).bind(newPlanId).first();
    if (!newPlan) return { ok: false, status: 422, error: "invalid_plan" };
    if (!newPlan.stripe_price_id) return { ok: false, status: 409, error: "plan_not_billing_configured" };

    await provider.changePlan(env, sub.provider_subscription_id, newPlan.stripe_price_id);

    // plan_id swaps locally right away so entitlements reflect the
    // new plan immediately; status/period fields still wait for the
    // provider's own customer.subscription.updated webhook.
    await env.LUMMET_DB.prepare(`UPDATE subscriptions SET plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(newPlanId, sub.id)
      .run();
    await recordSubscriptionStatusEvent(env, {
      subscriptionId: sub.id, fromStatus: sub.status, toStatus: sub.status,
      reason: `plan changed to ${newPlan.key}`, actorType: "customer_user", actorId: actorUserId
    });

    return { ok: true };
  }

  async function listInvoices(env, organizationId) {
    const result = await env.LUMMET_DB.prepare(`SELECT * FROM invoices WHERE organization_id = ? ORDER BY created_at DESC`)
      .bind(organizationId)
      .all();
    return result.results || [];
  }

  // -----------------------------------------------------
  // Webhook event dispatch — only the lifecycle events that
  // actually change local state are handled. Anything else
  // (e.g. customer.updated, invoice.upcoming) is intentionally
  // a no-op and still marked 'processed' by handleWebhook, since
  // ignoring an event type on purpose is not a processing
  // failure that Stripe should keep retrying.
  // -----------------------------------------------------

  async function dispatchEvent(env, event) {
    const obj = event.data?.object || {};

    switch (event.type) {
      case "checkout.session.completed": {
        const organizationId =
          obj.client_reference_id || obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        const planId = obj.metadata?.plan_id;
        const providerSubscriptionId = obj.subscription;

        if (!organizationId || !planId || !providerSubscriptionId) {
          throw new Error(`checkout.session.completed missing organization_id/plan_id/subscription (session ${obj.id})`);
        }

        const existing = await getCurrentSubscription(env, organizationId);

        if (existing && !existing.provider) {
          // Converting a Phase-1 trial in place — see the header
          // comment on startCheckout().
          await env.LUMMET_DB.prepare(
            `UPDATE subscriptions SET plan_id = ?, provider = ?, provider_subscription_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          )
            .bind(planId, provider.PROVIDER_NAME, providerSubscriptionId, existing.id)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: existing.id, fromStatus: existing.status, toStatus: "active",
            reason: "checkout completed", actorType: "billing_webhook"
          });
          await recordCouponRedemption(env, { couponId: obj.metadata?.coupon_id, organizationId, subscriptionId: existing.id });
          await webhooks.dispatchEvent(env, organizationId, "subscription.changed", { subscriptionId: existing.id, status: "active" });
        } else if (!existing) {
          const id = crypto.randomUUID();
          await env.LUMMET_DB.prepare(
            `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id) VALUES (?, ?, ?, 'active', ?, ?)`
          )
            .bind(id, organizationId, planId, provider.PROVIDER_NAME, providerSubscriptionId)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: id, fromStatus: null, toStatus: "active", reason: "checkout completed", actorType: "billing_webhook"
          });
          await recordCouponRedemption(env, { couponId: obj.metadata?.coupon_id, organizationId, subscriptionId: id });
          await webhooks.dispatchEvent(env, organizationId, "subscription.changed", { subscriptionId: id, status: "active" });
        } else if (existing.provider_subscription_id === providerSubscriptionId) {
          // A redelivery of this same checkout whose earlier attempt got partway: the subscription is
          // already in place, so only the steps that may not have happened yet are repeated (both are idempotent).
          await recordCouponRedemption(env, { couponId: obj.metadata?.coupon_id, organizationId, subscriptionId: existing.id });
          await webhooks.dispatchEvent(env, organizationId, "subscription.changed", { subscriptionId: existing.id, status: existing.status });
        } else {
          // The organization already has a DIFFERENT provider
          // subscription — startCheckout() should have refused this
          // case up front, so reaching it here means two checkouts
          // raced. Don't silently pick a winner; surface it as a
          // failed webhook event for staff to resolve.
          throw new Error(
            `organization ${organizationId} already has provider subscription ${existing.id}; refusing to create a second one from session ${obj.id}`
          );
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = await getSubscriptionByProviderId(env, obj.id);
        if (!sub) throw new Error(`customer.subscription.updated for unknown subscription ${obj.id}`);

        const newStatus = provider.normalizeSubscriptionStatus(obj.status);
        const currentPeriodEnd = obj.current_period_end
          ? new Date(obj.current_period_end * 1000).toISOString()
          : sub.current_period_end;

        await env.LUMMET_DB.prepare(
          `UPDATE subscriptions SET status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        )
          .bind(newStatus, currentPeriodEnd, obj.cancel_at_period_end ? 1 : 0, sub.id)
          .run();

        if (newStatus !== sub.status) {
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: sub.id, fromStatus: sub.status, toStatus: newStatus,
            reason: "provider subscription updated", actorType: "billing_webhook"
          });
          await webhooks.dispatchEvent(env, sub.organization_id, "subscription.changed", { subscriptionId: sub.id, status: newStatus });
        }
        break;
      }

      case "customer.subscription.deleted": {
        const sub = await getSubscriptionByProviderId(env, obj.id);
        if (!sub) throw new Error(`customer.subscription.deleted for unknown subscription ${obj.id}`);

        await env.LUMMET_DB.prepare(
          `UPDATE subscriptions SET status = 'canceled', canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        )
          .bind(sub.id)
          .run();
        await recordSubscriptionStatusEvent(env, {
          subscriptionId: sub.id, fromStatus: sub.status, toStatus: "canceled",
          reason: "provider subscription deleted", actorType: "billing_webhook"
        });
        await webhooks.dispatchEvent(env, sub.organization_id, "subscription.changed", { subscriptionId: sub.id, status: "canceled" });
        break;
      }

      case "invoice.paid": {
        const organizationId = obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        if (!organizationId) throw new Error(`invoice.paid with no resolvable organization (invoice ${obj.id})`);
        const sub = obj.subscription ? await getSubscriptionByProviderId(env, obj.subscription) : null;

        await env.LUMMET_DB.prepare(
          `INSERT INTO invoices (id, organization_id, subscription_id, provider, provider_invoice_id, status, amount_due_cents, amount_paid_cents, currency, hosted_invoice_url, period_start, period_end, paid_at)
           VALUES (?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT(provider, provider_invoice_id) DO UPDATE SET
             status = 'paid', amount_paid_cents = excluded.amount_paid_cents, paid_at = CURRENT_TIMESTAMP`
        )
          .bind(
            crypto.randomUUID(), organizationId, sub?.id || null, provider.PROVIDER_NAME, obj.id,
            obj.amount_due || 0, obj.amount_paid || 0, (obj.currency || "usd").toUpperCase(), obj.hosted_invoice_url || null,
            obj.period_start ? new Date(obj.period_start * 1000).toISOString() : null,
            obj.period_end ? new Date(obj.period_end * 1000).toISOString() : null
          )
          .run();

        const paymentProviderId = obj.payment_intent || `${obj.id}_payment`;
        await env.LUMMET_DB.prepare(
          `INSERT INTO payments (id, organization_id, invoice_id, provider, provider_payment_id, status, amount_cents, currency)
           SELECT ?, ?, i.id, ?, ?, 'succeeded', ?, ?
           FROM invoices i WHERE i.provider = ? AND i.provider_invoice_id = ?
           ON CONFLICT(provider, provider_payment_id) DO NOTHING`
        )
          .bind(
            crypto.randomUUID(), organizationId, provider.PROVIDER_NAME, paymentProviderId,
            obj.amount_paid || 0, (obj.currency || "usd").toUpperCase(), provider.PROVIDER_NAME, obj.id
          )
          .run();

        if (sub && sub.status === "past_due") {
          await env.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'active', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(sub.id)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: sub.id, fromStatus: "past_due", toStatus: "active", reason: "invoice paid", actorType: "billing_webhook"
          });
        }
        break;
      }

      case "invoice.payment_failed": {
        const organizationId = obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        if (!organizationId) throw new Error(`invoice.payment_failed with no resolvable organization (invoice ${obj.id})`);
        const sub = obj.subscription ? await getSubscriptionByProviderId(env, obj.subscription) : null;

        await env.LUMMET_DB.prepare(
          `INSERT INTO invoices (id, organization_id, subscription_id, provider, provider_invoice_id, status, amount_due_cents, amount_paid_cents, currency, hosted_invoice_url)
           VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
           ON CONFLICT(provider, provider_invoice_id) DO UPDATE SET status = 'open'`
        )
          .bind(
            crypto.randomUUID(), organizationId, sub?.id || null, provider.PROVIDER_NAME, obj.id,
            obj.amount_due || 0, obj.amount_paid || 0, (obj.currency || "usd").toUpperCase(), obj.hosted_invoice_url || null
          )
          .run();

        // Grace period, not an immediate cutoff — entitlements.js's
        // USABLE_STATUSES already treats "past_due" as usable, so
        // this alone doesn't lock the organization out.
        if (sub && sub.status !== "past_due") {
          await env.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'past_due', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
            .bind(sub.id)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: sub.id, fromStatus: sub.status, toStatus: "past_due",
            reason: "invoice payment failed", actorType: "billing_webhook"
          });
        }
        await webhooks.dispatchEvent(env, organizationId, "payment.failed", { invoiceId: obj.id, amountDue: obj.amount_due || 0 });
        break;
      }

      default:
        // Deliberately ignored — see this function's header comment.
        break;
    }
  }

  /**
   * Verifies, de-duplicates, and processes one webhook delivery.
   * The idempotency guard runs BEFORE any state change: the event
   * row is inserted first (unique on provider+event id). An event
   * already seen is skipped if processed or in flight, but is taken
   * back for another attempt if it failed or its earlier attempt died
   * (v7C; see repositories/billing-webhooks.js) — required for
   * correctness against Stripe's at-least-once delivery guarantee
   * (section 14/40).
   */
  async function handleWebhook(request, env) {
    const verification = await provider.verifyAndParseWebhook(request, env);
    if (!verification.valid) {
      return { ok: false, status: 400, error: verification.reason || "invalid_signature" };
    }
    const event = verification.event;

    const inserted = await webhookEvents.recordReceived(env, provider.PROVIDER_NAME, event.id, event.type);
    if (!inserted) {
      // Seen before. Skip it if it was processed, is being processed right now, or has used up its
      // attempts. Take it back for another try if it FAILED, or a previous attempt died mid-way
      // (stuck in 'received'): the provider redelivering an event is the retry signal, and
      // acknowledging it without reprocessing would silently drop the business operation.
      const claimed = await webhookEvents.claimRetry(env, provider.PROVIDER_NAME, event.id);
      if (!claimed) return { ok: true, duplicate: true };
    }

    try {
      await dispatchEvent(env, event);
      await webhookEvents.markProcessed(env, provider.PROVIDER_NAME, event.id);
      return { ok: true, duplicate: false };
    } catch (error) {
      await webhookEvents.markFailed(env, provider.PROVIDER_NAME, event.id, error?.message || error);
      // A 5xx makes the provider redeliver; the event is retried (up to webhookEvents.MAX_ATTEMPTS)
      // and the failed_billing_webhooks alert covers one that never succeeds.
      return { ok: false, status: 500, error: "webhook_processing_failed" };
    }
  }

  return {
    ensureBillingCustomer,
    startCheckout,
    validateCoupon,
    openBillingPortal,
    cancelSubscription,
    resumeSubscription,
    changePlan,
    listInvoices,
    handleWebhook
  };
}

// Production singleton, bound to the real Stripe provider — used by
// index.js. Unit tests import createBillingService directly with a fake
// provider. Route-level tests, which go through index.js and so this
// singleton, swap the provider with __setBillingProviderForTests();
// production never calls it, and passing nothing restores Stripe.
const providerRef = { current: stripeProvider };
const providerProxy = new Proxy({}, { get: (_target, key) => providerRef.current[key] });
export function __setBillingProviderForTests(p) {
  providerRef.current = p || stripeProvider;
}
export const billing = createBillingService(providerProxy);
