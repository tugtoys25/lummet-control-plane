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
import * as subscriptionRepo from "./repositories/billing-subscriptions.js";
import * as stripeProvider from "./billing-stripe.js";
import * as webhooks from "./webhooks.js";
import { billingConfig, renewalNoticeMode, effectiveTrialDays } from "./billing-config.js";
import { applySiteGate } from "./billing-lifecycle.js";
import * as lifecycleRepo from "./repositories/billing-lifecycle.js";
import * as trialAbuse from "./trial-abuse.js";
import { notify, dayOf } from "./billing-notifications.js";
import { remindTrial, renewalWanted } from "./billing-reminders.js";
import { otherOrgOwnedBySamePerson } from "./repositories/billing-lifecycle.js";
import { resolveCheckoutPrice as resolvePlanPrice } from "./plan-prices.js";
import * as intentRepo from "./repositories/plan-change-intents.js";
import { syncPlanFromSubscription, noteUnknownPriceOnCreate, classifyDirection } from "./plan-sync.js";
import { checkDowngradeGuard } from "./plan-change-guard.js";
import { saveBillingProfile } from "./phase3-source-of-truth.js";
import * as commercial from "./commercial.js";
import * as commercialRepo from "./repositories/commercial.js";
import * as revenue from "./revenue.js";

const NON_TERMINAL_STATUSES = "('canceled','expired','incomplete_expired')";

// Plan-change intents (sprint 3.2). An intent still unconfirmed after this long may be replaced by a newer request,
// and alerts staff (`plan_change_stuck`) until it is. A pending intent is retried (same idempotency key) this many times.
const INTENT_STALE_MINUTES = 60;
const INTENT_RETRY_AFTER_MINUTES = 2;
const INTENT_MAX_ATTEMPTS = 5;

// How long a pending checkout holds the last uses of a limited coupon.
const COUPON_HOLD_SECONDS = 3600;

/** "livemode_mismatch" when the event's mode does not belong to this environment, else null. */
export function modeMismatch(env, event) {
  if (typeof event?.livemode !== "boolean") return null;
  const environment = env && env.ENVIRONMENT;
  if (!environment) return null;
  const expectLive = environment === "production";
  return event.livemode === expectLive ? null : "livemode_mismatch";
}

const DAY_MS = 86400000;
// Stripe will not start a Checkout trial that ends in under 48 hours. Below this the customer is charged now.
const MIN_STRIPE_TRIAL_MS = 49 * 3600 * 1000;

export function createBillingService(provider) {
  /**
   * Trials never stack. With BILLING_ENFORCE off the legacy behaviour is kept (the plan's trial days, always).
   * Otherwise: an organization that already has a local trial gets Stripe a trial_end equal to what is LEFT of it
   * (none when expired, or when under Stripe's 48 hour minimum), and one that never trialed gets the plan's days.
   */
  function trialParams(env, plan, existingSub) {
    if (billingConfig(env).mode === "off") return { trialDays: effectiveTrialDays(env, plan.trial_days) };
    if (existingSub && !existingSub.provider) {
      const end = existingSub.trial_ends_at ? Date.parse(existingSub.trial_ends_at) : NaN;
      if (Number.isFinite(end) && end - Date.now() >= MIN_STRIPE_TRIAL_MS) return { trialDays: 0, trialEnd: Math.floor(end / 1000) };
      return { trialDays: 0 };
    }
    return { trialDays: effectiveTrialDays(env, plan.trial_days) };
  }

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

  async function getBillingProfile(env, organizationId) {
    return env.LUMMET_DB.prepare("SELECT * FROM organization_billing_profiles WHERE organization_id=?").bind(organizationId).first();
  }

  async function updateBillingProfile(env, organizationId, input, { actorUserId } = {}) {
    const clean = {
      legal_name: String(input?.legal_name || "").trim().slice(0, 200) || null,
      billing_email: String(input?.billing_email || "").trim().toLowerCase() || null,
      address_line1: String(input?.address_line1 || "").trim().slice(0, 200) || null,
      address_line2: String(input?.address_line2 || "").trim().slice(0, 200) || null,
      city: String(input?.city || "").trim().slice(0, 100) || null,
      region: String(input?.region || "").trim().slice(0, 100) || null,
      postal_code: String(input?.postal_code || "").trim().slice(0, 32) || null,
      country: String(input?.country || "").trim().toUpperCase() || null,
      tax_exempt: input?.tax_exempt === true,
      po_number: String(input?.po_number || "").trim().slice(0, 100) || null
    };
    if (clean.billing_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.billing_email)) return { ok: false, status: 422, error: "billing_email_invalid" };
    if (clean.country && !/^[A-Z]{2}$/.test(clean.country)) return { ok: false, status: 422, error: "country_invalid" };
    if (!clean.legal_name || !clean.billing_email || !clean.address_line1 || !clean.city || !clean.country) return { ok: false, status: 422, error: "billing_profile_required_fields_missing" };
    const customer = await ensureBillingCustomer(env, organizationId);
    if (!customer) return { ok: false, status: 404, error: "organization_not_found" };
    try {
      await provider.updateCustomer(env, customer.provider_customer_id, clean, { idempotencyKey: `billing-profile:${organizationId}:${crypto.randomUUID()}` });
    } catch (e) {
      console.error(JSON.stringify({ msg: "billing_profile_provider_sync_failed", organizationId, actorUserId: actorUserId || null, error: e?.message || String(e) }));
      return { ok: false, status: 502, error: "billing_profile_sync_failed" };
    }
    const profile = await saveBillingProfile(env, organizationId, { ...clean, stripe_customer_id: customer.provider_customer_id });
    return { ok: true, profile };
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
    const checkoutPrice = await resolvePlanPrice(env, plan);
    if (!checkoutPrice.ok) return { ok: false, status: checkoutPrice.status, error: checkoutPrice.error };

    const existingSub = await env.LUMMET_DB.prepare(
      `SELECT id, provider, trial_ends_at FROM subscriptions WHERE organization_id = ? AND status NOT IN ${NON_TERMINAL_STATUSES}`
    )
      .bind(organizationId)
      .first();
    if (existingSub && existingSub.provider) {
      return { ok: false, status: 409, error: "organization_already_subscribed" };
    }

    const customer = await ensureBillingCustomer(env, organizationId);
    if (!customer) return { ok: false, status: 404, error: "organization_not_found" };

    // A brand-new trial (the organization has no local trial to carry over) is only offered to someone who has not
    // had one: same owner elsewhere, or a business domain that already did. Otherwise the customer is simply charged
    // at checkout, which is also what they get if they ignore the trial offer.
    let trialRefused = null;
    let trialOverride = null;
    if (!existingSub && (plan.trial_days || 0) > 0 && billingConfig(env).mode !== "off") {
      if (await otherOrgOwnedBySamePerson(env, organizationId)) trialRefused = "owner";
      else {
        const byDomain = await trialAbuse.checkTrialByDomain(env, organizationId);
        if (!byDomain.ok) trialRefused = byDomain.reason;
      }
      if (trialRefused) trialOverride = { trialDays: 0 };
    }

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
      priceId: checkoutPrice.price.stripe_price_id,
      successUrl,
      cancelUrl,
      ...(trialOverride || trialParams(env, plan, existingSub)),
      organizationId,
      planId,
      couponProviderId,
      couponId,
      taxEnabled: env.STRIPE_TAX_ENABLED === "true",
      // A held coupon use must not outlive the checkout page that holds it:
      // the provider session expires shortly after the hold does.
      ...(held ? { expiresAt: Math.floor(Date.now() / 1000) + COUPON_HOLD_SECONDS + 60 } : {})
      });
    } catch (err) {
      if (held) await couponRepo.releaseHold(env, couponId, organizationId);
      throw err;
    }

    return { ok: true, checkoutUrl: session.checkoutUrl, providerSessionId: session.providerSessionId, ...(trialRefused ? { trialRefused } : {}) };
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

  async function pauseSubscription(env, organizationId, { resumesAt, actorUserId } = {}) {
    if (String(env.BILLING_SAVE_FLOW || "off").toLowerCase() !== "on") return { ok: false, status: 404, error: "save_flow_disabled" };
    const sub = await getCurrentSubscription(env, organizationId);
    if (!sub) return { ok: false, status: 404, error: "no_active_subscription" };
    if (!sub.provider_subscription_id) return { ok: false, status: 409, error: "no_provider_subscription" };
    const timestamp = Date.parse(String(resumesAt || ""));
    if (!Number.isFinite(timestamp) || timestamp <= Date.now()) return { ok: false, status: 422, error: "invalid_pause_resume_time" };
    if (sub.cancel_at_period_end) return { ok: false, status: 409, error: "cancellation_already_scheduled" };
    try {
      const result = await provider.pauseSubscription(env, sub.provider_subscription_id, { resumesAt: new Date(timestamp).toISOString(), idempotencyKey: `pause:${sub.id}:${Math.floor(timestamp / 1000)}` });
      await subscriptionRepo.setPauseResumeAt(env, sub.id, result.resumesAt || new Date(timestamp).toISOString());
      await recordSubscriptionStatusEvent(env, { subscriptionId: sub.id, fromStatus: sub.status, toStatus: sub.status, reason: "customer requested temporary pause", actorType: "customer_user", actorId: actorUserId });
      return { ok: true, resumesAt: result.resumesAt || new Date(timestamp).toISOString() };
    } catch (_) { return { ok: false, status: 502, error: "pause_provider_unavailable" }; }
  }

  async function resumePausedSubscription(env, organizationId, { actorUserId } = {}) {
    if (String(env.BILLING_SAVE_FLOW || "off").toLowerCase() !== "on") return { ok: false, status: 404, error: "save_flow_disabled" };
    const sub = await getCurrentSubscription(env, organizationId);
    if (!sub) return { ok: false, status: 404, error: "no_active_subscription" };
    if (!sub.provider_subscription_id || !sub.pause_resumes_at) return { ok: false, status: 409, error: "subscription_not_paused" };
    try {
      await provider.resumePausedSubscription(env, sub.provider_subscription_id, { idempotencyKey: `unpause:${sub.id}:${Math.floor(Date.now() / 60000)}` });
      await subscriptionRepo.setPauseResumeAt(env, sub.id, null);
      await recordSubscriptionStatusEvent(env, { subscriptionId: sub.id, fromStatus: sub.status, toStatus: sub.status, reason: "customer resumed temporary pause", actorType: "customer_user", actorId: actorUserId });
      return { ok: true };
    } catch (_) { return { ok: false, status: 502, error: "pause_provider_unavailable" }; }
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

  async function changePlan(env, organizationId, newPlanId, { actorUserId, staffOverrideReason } = {}) {
    const sub = await getCurrentSubscription(env, organizationId);
    if (!sub) return { ok: false, status: 404, error: "no_active_subscription" };
    if (!sub.provider_subscription_id) return { ok: false, status: 409, error: "no_provider_subscription" };

    const newPlan = await env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ? AND status = 'active'`).bind(newPlanId).first();
    if (!newPlan) return { ok: false, status: 422, error: "invalid_plan" };
    const newPrice = await resolvePlanPrice(env, newPlan);
    if (!newPrice.ok) return { ok: false, status: newPrice.status, error: newPrice.error };

    const previousPlan = await subscriptionRepo.planById(env, sub.plan_id);
    const direction = classifyDirection(previousPlan, newPlan);
    if (direction === "downgrade") {
      const guard = await checkDowngradeGuard(env, organizationId, newPlan.id);
      if (!guard.ok && !String(staffOverrideReason || "").trim()) {
        return { ok: false, status: 409, error: "downgrade_blocked", blockers: guard.blockers };
      }
      if (!guard.ok && String(staffOverrideReason || "").trim()) {
        await recordSubscriptionStatusEvent(env, {
          subscriptionId: sub.id, fromStatus: sub.status, toStatus: sub.status,
          reason: `STAFF DOWNGRADE OVERRIDE to ${newPlan.key}: ${String(staffOverrideReason).trim().slice(0,500)}`,
          actorType: "lummet_admin", actorId: actorUserId
        });
      }
    }

    // BILLING_ENFORCE=enforce: the change is an INTENT. It is written first, sent to the provider with its own
    // idempotency key, and plan_id changes only when the provider's webhook confirms the new price (N2). Under
    // `shadow` the legacy path below still runs and the decision enforce would have taken is logged.
    if (billingConfig(env).mode === "enforce") return requestPlanChange(env, { sub, newPlan, newPrice, actorUserId });
    if (billingConfig(env).mode === "shadow") {
      console.log(JSON.stringify({ msg: "billing_plan_change_shadow", subscriptionId: sub.id, from: sub.plan_id, to: newPlan.id, wouldBe: sub.plan_id === newPlan.id ? "already_on_plan" : "intent" }));
    }
    const providerChange = await provider.changePlan(env, sub.provider_subscription_id, newPrice.price.stripe_price_id, { atPeriodEnd: direction === "downgrade" });

    // A scheduled downgrade must retain today's entitlements until Stripe applies the next phase. Upgrades remain immediate.
    if (direction !== "downgrade") {
      await env.LUMMET_DB.prepare(`UPDATE subscriptions SET plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(newPlanId, sub.id).run();
    }
    await recordSubscriptionStatusEvent(env, {
      subscriptionId: sub.id, fromStatus: sub.status, toStatus: sub.status,
      reason: direction === "downgrade" ? `plan downgrade scheduled for period end: ${newPlan.key}` : `plan changed to ${newPlan.key}`,
      actorType: String(actorUserId || "").startsWith("staff:") ? "lummet_admin" : "customer_user", actorId: actorUserId
    });

    // Phase 2.2: notify only once the new plan is effective. A scheduled downgrade is not effective yet.
    if (direction !== "downgrade" && previousPlan?.id !== newPlan.id) {
      try {
        await notify.planChanged(env, { organizationId, subscriptionId: sub.id, fromPlanId: previousPlan?.id || null, toPlanId: newPlan.id, planName: newPlan.name, previousPlanName: previousPlan?.name || null });
      } catch (e) {
        console.error(JSON.stringify({ msg: "billing_plan_changed_notice_failed", organizationId, error: e?.message || String(e) }));
      }
    }

    return direction === "downgrade" ? { ok: true, pending: true, scheduled: true, effectiveAt: providerChange?.effectiveAt || null, direction } : { ok: true };
  }

  /**
   * Sends one pending intent to the provider. Safe to repeat: the intent's idempotency key makes the provider apply
   * it once however many times it is sent. "rejected" (the provider said no, retrying cannot help) fails the intent;
   * anything else (provider unreachable, timeout) leaves it pending for the sweep, and is logged, never swallowed.
   */
  async function submitIntent(env, intent, providerSubscriptionId) {
    try {
      await provider.changePlan(env, providerSubscriptionId, intent.to_price_id, { idempotencyKey: intent.idempotency_key, atPeriodEnd: intent.direction === "downgrade" });
    } catch (e) {
      const message = e?.message || String(e);
      if (e?.kind === "rejected") {
        await intentRepo.moveIntent(env, intent.id, "pending", "failed", { error: message, bumpAttempts: true });
        console.error(JSON.stringify({ msg: "billing_plan_change_rejected", intentId: intent.id, error: message }));
        return { status: "failed", error: message };
      }
      await intentRepo.noteAttempt(env, intent.id, message);
      console.error(JSON.stringify({ msg: "billing_plan_change_delayed", intentId: intent.id, error: message }));
      return { status: "pending", error: message };
    }
    await intentRepo.moveIntent(env, intent.id, "pending", "submitted", { bumpAttempts: true });
    return { status: "submitted" };
  }

  /** The enforce-mode plan change: intent first, provider second, webhook confirms. Never changes plan_id itself. */
  async function requestPlanChange(env, { sub, newPlan, newPrice, actorUserId }) {
    if (sub.plan_id === newPlan.id) return { ok: false, status: 409, error: "already_on_plan" };

    await intentRepo.supersedeStale(env, sub.id, INTENT_STALE_MINUTES);
    const open = await intentRepo.openIntentFor(env, sub.id);
    if (open) {
      // The same request repeated (a double click, a retry) is answered with the one already in flight.
      if (open.to_plan_id === newPlan.id) return { ok: true, pending: true, intentId: open.id, status: open.status, duplicate: true };
      return { ok: false, status: 409, error: "plan_change_in_progress" };
    }

    const [fromPlan, toPlan] = await Promise.all([intentRepo.planForSync(env, sub.plan_id), intentRepo.planForSync(env, newPlan.id)]);
    const id = crypto.randomUUID();
    const intent = {
      id, subscription_id: sub.id, idempotency_key: `plan-change:${id}`, to_price_id: newPrice.price.stripe_price_id,
      direction: classifyDirection(fromPlan, toPlan)
    };
    const inserted = await intentRepo.insertIntent(env, {
      id, subscriptionId: sub.id, fromPlanId: sub.plan_id, toPlanId: newPlan.id, idempotencyKey: intent.idempotency_key,
      direction: intent.direction, toPriceId: intent.to_price_id, requestedBy: actorUserId || null
    });
    if (!inserted) return { ok: false, status: 409, error: "plan_change_in_progress" };   // another request won the race

    await recordSubscriptionStatusEvent(env, {
      subscriptionId: sub.id, fromStatus: sub.status, toStatus: sub.status,
      reason: `plan change requested: ${fromPlan?.key || sub.plan_id} -> ${newPlan.key} (waiting for the provider)`,
      actorType: String(actorUserId || "").startsWith("staff:") ? "lummet_admin" : "customer_user", actorId: actorUserId
    });

    const sent = await submitIntent(env, intent, sub.provider_subscription_id);
    if (sent.status === "failed") return { ok: false, status: 422, error: "plan_change_rejected" };
    return { ok: true, pending: true, intentId: id, direction: intent.direction, status: sent.status };
  }

  /**
   * Sweep step (every mode: a customer's change must not be lost because the flag was flipped): resends intents that
   * never reached the provider, and fails the ones that ran out of attempts. Same idempotency key every time.
   */
  async function retryPlanChangeIntents(env, { limit = 25 } = {}) {
    let ok = 0, failed = 0;
    for (const row of await intentRepo.pendingToRetry(env, INTENT_RETRY_AFTER_MINUTES, limit)) {
      if (!row.provider_subscription_id) {
        await intentRepo.moveIntent(env, row.id, "pending", "failed", { error: "subscription has no provider subscription" });
        failed += 1;
        continue;
      }
      if (row.attempts >= INTENT_MAX_ATTEMPTS) {
        await intentRepo.moveIntent(env, row.id, "pending", "failed", { error: `retries used up: ${row.last_error || "provider unreachable"}` });
        console.error(JSON.stringify({ msg: "billing_plan_change_gave_up", intentId: row.id, attempts: row.attempts }));
        failed += 1;
        continue;
      }
      const sent = await submitIntent(env, row, row.provider_subscription_id);
      if (sent.status === "submitted") ok += 1; else if (sent.status === "failed") failed += 1;
    }
    return { planChangeRetries: ok, planChangeRetriesFailed: failed };
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
  // (e.g. customer.updated) is intentionally
  // a no-op and still marked 'processed' by handleWebhook, since
  // ignoring an event type on purpose is not a processing
  // failure that Stripe should keep retrying.
  // -----------------------------------------------------

  /**
   * What status a just-completed checkout starts in. Legacy (BILLING_ENFORCE=off): always "active". Otherwise
   * "trialing" when the session carried a provider trial (we put has_trial in its metadata), so a card trial is not
   * reported as paid, and the provider's own trial end is kept. The provider's next subscription.updated confirms it.
   */
  function checkoutStartState(env, obj) {
    if (billingConfig(env).mode === "off" || obj.metadata?.has_trial !== "1") return { status: "active", trialEndsAt: null };
    const unix = Number(obj.metadata?.trial_end);
    return { status: "trialing", trialEndsAt: Number.isFinite(unix) && unix > 0 ? new Date(unix * 1000).toISOString() : null };
  }

  /** After payment recovers, undo a billing suspension of sites (only ones billing suspended, never staff's). */
  async function restoreSitesIfNeeded(env, organizationId) {
    if (!billingConfig(env).suspendSites) return;
    await applySiteGate(env, organizationId, "active");
  }

  /**
   * One trial per card. After a checkout that carried a trial, look up the card's fingerprint and remember its hash.
   * If ANOTHER organization already had a trial on this card: under "enforce" the trial is ended now (the first
   * invoice is raised immediately, no second free trial); under "shadow" it is only recorded. A failed lookup is not
   * swallowed: it fails the webhook, Stripe redelivers, and the repeat is safe (every step is idempotent).
   */
  async function enforceCardTrial(env, { organizationId, subscriptionRow, providerSubscriptionId }) {
    const mode = billingConfig(env).mode;
    if (mode === "off" || typeof provider.getCardFingerprint !== "function" || !subscriptionRow) return;
    const fingerprint = await provider.getCardFingerprint(env, providerSubscriptionId);
    const seen = await trialAbuse.registerCardForTrial(env, organizationId, fingerprint);
    if (!seen.used) {
      await trialAbuse.recordTrialByDomain(env, organizationId);
      return;
    }
    if (mode === "shadow") { await trialAbuse.recordTrialRefusalShadow(env, organizationId, "trial_refused:card"); return; }
    await provider.endTrialNow(env, providerSubscriptionId);
    await lifecycleRepo.endLocalTrial(env, subscriptionRow.id);
    await recordSubscriptionStatusEvent(env, {
      subscriptionId: subscriptionRow.id, fromStatus: subscriptionRow.status, toStatus: subscriptionRow.status,
      reason: "trial refused: this card already had a trial", actorType: "billing_webhook"
    });
  }

  /**
   * Plan sync for one subscription event (sprint 3.2). When the plan really changed, the owners are told once: the
   * notification's dedupe stage is built from the EVENT time, so a redelivered event cannot send a second email.
   */
  async function syncPlanFor(env, { sub, obj, event }) {
    return syncPlanFromSubscription(env, {
      sub, obj, event,
      recordStatusEvent: (f) => recordSubscriptionStatusEvent(env, f),
      onApplied: async ({ fromPlanId, toPlanId, fromName, toName, eventAt }) => {
        try {
          await notify.planChanged(env, {
            organizationId: sub.organization_id, subscriptionId: sub.id, fromPlanId, toPlanId,
            planName: toName, previousPlanName: fromName, now: eventAt * 1000
          });
        } catch (e) {
          // A mail problem never undoes a plan change the provider already made: logged, and the notification
          // engine's own retry and alerts (billing_email_stuck) cover delivery.
          console.error(JSON.stringify({ msg: "billing_plan_changed_notice_failed", organizationId: sub.organization_id, error: e?.message || String(e) }));
        }
      }
    });
  }

  // Round 6.1A: every handled provider event is followed by one revenue observation. It reads the subscription the handlers just wrote,
  // never changes it, and a failure there is logged and never fails the webhook (see worker/revenue.js).
  async function dispatchEvent(env, event) {
    await dispatchBillingEvent(env, event);
    await revenue.trackProviderEvent(env, event, getSubscriptionByProviderId);
  }

  async function dispatchBillingEvent(env, event) {
    const obj = event.data?.object || {};

    switch (event.type) {
      case "checkout.session.completed": {
        if (event.data?.object?.metadata?.lummet_purchase_type === "credit_pack") {
          await commercial.grantCreditPackFromCheckout(env, event.data.object);
          break;
        }
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
          const start = checkoutStartState(env, obj);
          await env.LUMMET_DB.prepare(
            `UPDATE subscriptions SET plan_id = ?, provider = ?, provider_subscription_id = ?, status = ?, trial_ends_at = COALESCE(?, trial_ends_at),
               grace_ends_at = NULL, restricted_at = NULL, suspended_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          )
            .bind(planId, provider.PROVIDER_NAME, providerSubscriptionId, start.status, start.trialEndsAt, existing.id)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: existing.id, fromStatus: existing.status, toStatus: start.status,
            reason: "checkout completed", actorType: "billing_webhook"
          });
          await recordCouponRedemption(env, { couponId: obj.metadata?.coupon_id, organizationId, subscriptionId: existing.id });
          await webhooks.dispatchEvent(env, organizationId, "subscription.changed", { subscriptionId: existing.id, status: start.status });
          await restoreSitesIfNeeded(env, organizationId);
        } else if (!existing) {
          const id = crypto.randomUUID();
          const start = checkoutStartState(env, obj);
          await env.LUMMET_DB.prepare(
            `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id, trial_ends_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
            .bind(id, organizationId, planId, start.status, provider.PROVIDER_NAME, providerSubscriptionId, start.trialEndsAt)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: id, fromStatus: null, toStatus: start.status, reason: "checkout completed", actorType: "billing_webhook"
          });
          await recordCouponRedemption(env, { couponId: obj.metadata?.coupon_id, organizationId, subscriptionId: id });
          await webhooks.dispatchEvent(env, organizationId, "subscription.changed", { subscriptionId: id, status: start.status });
          await restoreSitesIfNeeded(env, organizationId);
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
        if (obj.metadata?.has_trial === "1") {
          const current = await getSubscriptionByProviderId(env, providerSubscriptionId);
          await enforceCardTrial(env, { organizationId, subscriptionRow: current, providerSubscriptionId });
        }
        break;
      }

      case "customer.subscription.updated": {
        const sub = await getSubscriptionByProviderId(env, obj.id);
        if (!sub) throw new Error(`customer.subscription.updated for unknown subscription ${obj.id}`);

        const cfg = billingConfig(env);
        const newStatus = provider.normalizeSubscriptionStatus(obj.status, { restrictUnpaid: cfg.mode === "enforce" });
        const currentPeriodEnd = obj.current_period_end
          ? new Date(obj.current_period_end * 1000).toISOString()
          : sub.current_period_end;
        const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
        const recovered = newStatus === "active" || newStatus === "trialing";
        const enteringRestricted = newStatus === "restricted" && sub.status !== "restricted";

        await env.LUMMET_DB.prepare(
          `UPDATE subscriptions SET status = ?, stripe_status = ?, current_period_start = COALESCE(?, current_period_start), current_period_end = ?,
             cancel_at_period_end = ?, trial_ends_at = COALESCE(?, trial_ends_at), pause_resumes_at = ?,
             latest_invoice_id = COALESCE(?, latest_invoice_id),
             grace_ends_at = CASE WHEN ? THEN NULL ELSE grace_ends_at END,
             restricted_at = CASE WHEN ? THEN NULL WHEN ? THEN COALESCE(restricted_at, CURRENT_TIMESTAMP) ELSE restricted_at END,
             suspended_at = CASE WHEN ? THEN NULL ELSE suspended_at END,
             updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        )
          .bind(
            newStatus, obj.status || null, iso(obj.current_period_start), currentPeriodEnd, obj.cancel_at_period_end ? 1 : 0,
            iso(obj.trial_end), iso(obj.pause_collection?.resumes_at),
            typeof obj.latest_invoice === "string" ? obj.latest_invoice : obj.latest_invoice?.id || null,
            recovered ? 1 : 0, recovered ? 1 : 0, enteringRestricted ? 1 : 0, recovered ? 1 : 0, sub.id
          )
          .run();

        if (obj.cancel_at_period_end && !sub.cancel_at_period_end) {
          await notify.cancellationScheduled(env, { organizationId: sub.organization_id, subscriptionId: sub.id, endsAt: currentPeriodEnd });
        }
        await commercial.confirmAddonIntentsFromSubscription(env, sub, obj);

        if (newStatus !== sub.status) {
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: sub.id, fromStatus: sub.status, toStatus: newStatus,
            reason: "provider subscription updated", actorType: "billing_webhook"
          });
          await webhooks.dispatchEvent(env, sub.organization_id, "subscription.changed", { subscriptionId: sub.id, status: newStatus });
          if (recovered) await restoreSitesIfNeeded(env, sub.organization_id);
        }

        // Plan sync (sprint 3.2): the price on the subscription decides the plan. Inert under BILLING_ENFORCE=off.
        await syncPlanFor(env, { sub: { ...sub, status: newStatus }, obj, event });
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

        // Paying clears the clock. Legacy (BILLING_ENFORCE=off) only ever revived past_due; with the lifecycle on, a
        // restricted or suspended subscription is revived by a paid invoice too (the late-payment path).
        const recoverable = billingConfig(env).mode === "off" ? ["past_due"] : ["past_due", "restricted", "unpaid", "suspended"];
        if (sub && recoverable.includes(sub.status)) {
          await env.LUMMET_DB.prepare(
            `UPDATE subscriptions SET status = 'active', grace_ends_at = NULL, restricted_at = NULL, suspended_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          )
            .bind(sub.id)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: sub.id, fromStatus: sub.status, toStatus: "active", reason: "invoice paid", actorType: "billing_webhook"
          });
          await restoreSitesIfNeeded(env, sub.organization_id);
          // Only an account that had actually been restricted or suspended gets "active again"; a past-due recovery is just a receipt.
          if (sub.status !== "past_due") await notify.reactivated(env, { organizationId, subscriptionId: sub.id, invoiceId: obj.id });
        }
        try { await commercial.grantFounderLicenseFromPaidInvoice(env, obj); } catch (e) { throw new Error(`founder_license_grant_failed: ${e?.message || e}`); }
        if (obj.metadata?.lummet_quote_id && obj.metadata?.founder_license !== '1') {
          const quote = await commercialRepo.findInvoicedQuote(env,obj.metadata.lummet_quote_id);
          if (quote?.organization_id === organizationId) {
            const lines = await commercial.listQuoteLinesForEntitlements?.(env, quote.id);
            if (lines) await commercial.grantQuoteEntitlementsAfterPayment(env, quote, lines);
          }
        }
        await notify.receipt(env, { organizationId, subscriptionId: sub?.id || null, invoice: obj });
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
          // The grace clock starts at the FIRST failure and is never extended by later retries of the same invoice.
          const graceEndsAt = new Date(Date.now() + billingConfig(env).graceDays * DAY_MS).toISOString();
          await env.LUMMET_DB.prepare(
            `UPDATE subscriptions SET status = 'past_due', grace_ends_at = COALESCE(grace_ends_at, ?), latest_invoice_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
          )
            .bind(graceEndsAt, obj.id || null, sub.id)
            .run();
          await recordSubscriptionStatusEvent(env, {
            subscriptionId: sub.id, fromStatus: sub.status, toStatus: "past_due",
            reason: "invoice payment failed", actorType: "billing_webhook"
          });
        }
        await webhooks.dispatchEvent(env, organizationId, "payment.failed", { invoiceId: obj.id, amountDue: obj.amount_due || 0 });
        const failedSub = sub ? await getSubscriptionByProviderId(env, obj.subscription) : null;
        await notify.paymentFailed(env, { organizationId, subscriptionId: sub?.id || null, invoice: obj, graceEndsAt: failedSub?.grace_ends_at || null });
        break;
      }

      case "customer.subscription.created": {
        // Upsert by provider id. checkout.session.completed normally creates the row; this event covers the case where
        // it arrives first, or is lost, and is a no-op when the subscription is already known (any order, any repeat).
        const knownSub = await getSubscriptionByProviderId(env, obj.id);
        if (knownSub) {
          await syncPlanFor(env, { sub: knownSub, obj, event });
          break;
        }
        const organizationId = obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        if (!organizationId) {
          console.warn(JSON.stringify({ msg: "billing_subscription_created_not_ours", providerSubscriptionId: obj.id }));
          break;
        }
        // A price the catalog does not hold is raised for staff even when metadata names a plan (inert under BILLING_ENFORCE=off).
        await noteUnknownPriceOnCreate(env, { obj, event, organizationId });
        const cfg = billingConfig(env);
        let status = provider.normalizeSubscriptionStatus(obj.status, { restrictUnpaid: cfg.mode === "enforce" });
        // Only a confirmed subscription is materialised here. An incomplete one (payment not finished) waits for the
        // checkout or update event that says it is real: nothing is granted on a guess.
        if (status !== "trialing" && status !== "active") break;
        if (cfg.mode === "off" && status === "trialing") status = "active";   // legacy parity with checkout.session.completed
        const priceId = obj.items?.data?.[0]?.price?.id || obj.plan?.id || null;
        const planId = obj.metadata?.plan_id || (await subscriptionRepo.planIdForPrice(env, priceId));
        if (!planId) throw new Error(`customer.subscription.created: no plan matches subscription ${obj.id} (price ${priceId || "unknown"})`);
        const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
        const trialEndsAt = status === "trialing" ? iso(obj.trial_end) : null;
        const existing = await getCurrentSubscription(env, organizationId);
        let subscriptionId;
        if (existing && existing.provider_subscription_id && existing.provider_subscription_id !== obj.id) {
          throw new Error(`organization ${organizationId} already has provider subscription ${existing.id}; refusing to create a second one from ${obj.id}`);
        } else if (existing) {
          // A local trial being converted, exactly as checkout.session.completed does it.
          subscriptionId = existing.id;
          await subscriptionRepo.convertLocalToProvider(env, existing.id, {
            planId, provider: provider.PROVIDER_NAME, providerSubscriptionId: obj.id, status, stripeStatus: obj.status || null,
            trialEndsAt, periodStart: iso(obj.current_period_start), periodEnd: iso(obj.current_period_end)
          });
          await recordSubscriptionStatusEvent(env, { subscriptionId, fromStatus: existing.status, toStatus: status, reason: "provider subscription created", actorType: "billing_webhook" });
        } else {
          subscriptionId = crypto.randomUUID();
          await subscriptionRepo.insertProviderSubscription(env, {
            id: subscriptionId, organizationId, planId, status, stripeStatus: obj.status || null, provider: provider.PROVIDER_NAME, providerSubscriptionId: obj.id,
            trialEndsAt, periodStart: iso(obj.current_period_start), periodEnd: iso(obj.current_period_end), cancelAtPeriodEnd: obj.cancel_at_period_end
          });
          await recordSubscriptionStatusEvent(env, { subscriptionId, fromStatus: null, toStatus: status, reason: "provider subscription created", actorType: "billing_webhook" });
        }
        await recordCouponRedemption(env, { couponId: obj.metadata?.coupon_id, organizationId, subscriptionId });
        await webhooks.dispatchEvent(env, organizationId, "subscription.changed", { subscriptionId, status });
        await restoreSitesIfNeeded(env, organizationId);
        // A card trial has no other welcome. Same dedupe key as a local trial's welcome, so a converted trial is not welcomed twice.
        if (status === "trialing") await notify.trialStarted(env, { organizationId, subscriptionId, trialEndsAt });
        break;
      }

      case "customer.subscription.trial_will_end": {
        const sub = await getSubscriptionByProviderId(env, obj.id);
        if (!sub) throw new Error(`customer.subscription.trial_will_end for unknown subscription ${obj.id}`);
        // The same helper the sweep uses, so the reminder is one email whichever of the two gets there first.
        await remindTrial(env, {
          organizationId: sub.organization_id, subscriptionId: sub.id,
          trialEndsAt: obj.trial_end ? obj.trial_end * 1000 : sub.trial_ends_at, createdAt: sub.created_at
        });
        break;
      }

      case "invoice.payment_action_required": {
        const organizationId = obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        if (!organizationId) throw new Error(`invoice.payment_action_required with no resolvable organization (invoice ${obj.id})`);
        const sub = obj.subscription ? await getSubscriptionByProviderId(env, obj.subscription) : null;
        await notify.cardAuthentication(env, { organizationId, subscriptionId: sub?.id || null, invoice: obj });
        break;
      }

      case "checkout.session.expired": {
        // The checkout page is gone: give back the use of a limited coupon it was holding.
        const couponId = obj.metadata?.coupon_id;
        const organizationId = obj.client_reference_id || obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        if (couponId && organizationId) await couponRepo.releaseHold(env, couponId, organizationId);
        break;
      }

      case "invoice.upcoming": {
        const organizationId = obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        const sub = organizationId && obj.subscription ? await getSubscriptionByProviderId(env, obj.subscription) : null;
        if (!sub || sub.status !== "active" || sub.cancel_at_period_end || !(Number(obj.amount_due) > 0)) break;
        const plan = await subscriptionRepo.planById(env, sub.plan_id);
        if (renewalNoticeMode(env) === "off" || !renewalWanted(env, plan?.billing_period)) break;
        // Same stage as the sweep's renewal notice (the renewal DAY), so Stripe's event and the sweep send one email between them.
        const renewsAt = sub.current_period_end || (obj.next_payment_attempt ? new Date(obj.next_payment_attempt * 1000).toISOString() : obj.period_end ? new Date(obj.period_end * 1000).toISOString() : null);
        if (!dayOf(renewsAt)) break;
        await notify.renewalNotice(env, { organizationId, subscriptionId: sub.id, renewsAt, amountCents: obj.amount_due, currency: obj.currency });
        break;
      }

      case "invoice.finalized":
      case "invoice.marked_uncollectible":
      case "invoice.voided": {
        const organizationId = obj.metadata?.organization_id || (await getOrganizationIdForProviderCustomer(env, obj.customer));
        if (!organizationId) throw new Error(`${event.type} with no resolvable organization (invoice ${obj.id})`);
        const sub = obj.subscription ? await getSubscriptionByProviderId(env, typeof obj.subscription === "string" ? obj.subscription : obj.subscription.id) : null;
        const status = event.type === "invoice.finalized" ? (obj.status || "open") : event.type === "invoice.voided" ? "void" : "uncollectible";
        await env.LUMMET_DB.prepare(`INSERT INTO invoices
          (id, organization_id, subscription_id, provider, provider_invoice_id, status, amount_due_cents, amount_paid_cents, currency, hosted_invoice_url, number, subtotal_cents, tax_cents, discount_cents, total_cents, pdf_url, due_at, attempt_count, next_attempt_at, provider_event_created)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, provider_invoice_id) DO UPDATE SET status=excluded.status, amount_due_cents=excluded.amount_due_cents,
          amount_paid_cents=excluded.amount_paid_cents, hosted_invoice_url=excluded.hosted_invoice_url, number=excluded.number,
          subtotal_cents=excluded.subtotal_cents, tax_cents=excluded.tax_cents, discount_cents=excluded.discount_cents,
          total_cents=excluded.total_cents, pdf_url=excluded.pdf_url, due_at=excluded.due_at, attempt_count=excluded.attempt_count,
          next_attempt_at=excluded.next_attempt_at, provider_event_created=excluded.provider_event_created
          WHERE excluded.provider_event_created >= invoices.provider_event_created`)
          .bind(crypto.randomUUID(), organizationId, sub?.id || null, provider.PROVIDER_NAME, obj.id, status,
            obj.amount_due || 0, obj.amount_paid || 0, obj.currency || "usd", obj.hosted_invoice_url || null,
            obj.number || null, obj.subtotal ?? null, obj.tax ?? null, obj.total_discount_amounts?.reduce((n,x)=>n+(x.amount||0),0) ?? null,
            obj.total ?? null, obj.invoice_pdf || null, obj.due_date ? new Date(obj.due_date*1000).toISOString() : null,
            obj.attempt_count || 0, obj.next_payment_attempt ? new Date(obj.next_payment_attempt*1000).toISOString() : null, Number(event.created) || 0).run();
        const invoiceEvent = await env.LUMMET_DB.prepare("SELECT provider_event_created FROM invoices WHERE provider=? AND provider_invoice_id=?").bind(provider.PROVIDER_NAME, obj.id).first();
        if ((invoiceEvent?.provider_event_created || 0) <= (Number(event.created) || 0)) for (const line of (obj.lines?.data || [])) {
          await env.LUMMET_DB.prepare(`INSERT INTO invoice_lines (id, invoice_id, provider_line_id, description, quantity, unit_amount_cents, amount_cents, currency, period_start, period_end, price_id)
            SELECT ?, i.id, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM invoices i WHERE i.provider=? AND i.provider_invoice_id=?
            ON CONFLICT(invoice_id, provider_line_id) DO UPDATE SET description=excluded.description, quantity=excluded.quantity, amount_cents=excluded.amount_cents`)
            .bind(crypto.randomUUID(), line.id, line.description || null, line.quantity ?? null, line.price?.unit_amount ?? null, line.amount || 0,
              line.currency || obj.currency || "usd", line.period?.start ? new Date(line.period.start*1000).toISOString() : null,
              line.period?.end ? new Date(line.period.end*1000).toISOString() : null, line.price?.id || null, provider.PROVIDER_NAME, obj.id).run();
        }
        break;
      }

      case "charge.refunded": {
        const chargeId = obj.id;
        const payment = await env.LUMMET_DB.prepare("SELECT id, organization_id FROM payments WHERE provider=? AND provider_payment_id=?")
          .bind(provider.PROVIDER_NAME, chargeId).first();
        const organizationId = payment?.organization_id || (obj.metadata?.organization_id || null);
        if (!organizationId) throw new Error(`charge.refunded has no resolvable organization (charge ${chargeId})`);
        for (const refund of (obj.refunds?.data || [])) {
          await env.LUMMET_DB.prepare(`INSERT INTO refunds (id, organization_id, payment_id, provider, provider_refund_id, provider_charge_id, amount_cents, currency, status, reason, provider_event_created)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_refund_id) DO UPDATE SET amount_cents=excluded.amount_cents, status=excluded.status, reason=excluded.reason, provider_event_created=excluded.provider_event_created WHERE excluded.provider_event_created >= refunds.provider_event_created`)
            .bind(crypto.randomUUID(), organizationId, payment?.id || null, provider.PROVIDER_NAME, refund.id, chargeId, refund.amount || 0,
              refund.currency || obj.currency || "usd", refund.status || "succeeded", refund.reason || null, Number(event.created) || 0).run();
        }
        // A refund is a ledger event only; it deliberately does not alter subscription MRR or plan entitlements.
        // The one exception is a one-time credit pack: the refunded share of its credits is reversed (idempotent, monotone).
        await commercial.reverseCreditPackForRefund(env, obj);
        break;
      }

      case "charge.dispute.created":
      case "charge.dispute.closed": {
        const chargeId = typeof obj.charge === "string" ? obj.charge : obj.charge?.id;
        const payment = chargeId ? await env.LUMMET_DB.prepare("SELECT organization_id FROM payments WHERE provider=? AND provider_payment_id=?")
          .bind(provider.PROVIDER_NAME, chargeId).first() : null;
        const organizationId = payment?.organization_id || obj.metadata?.organization_id;
        if (!organizationId) throw new Error(`${event.type} has no resolvable organization (dispute ${obj.id})`);
        await env.LUMMET_DB.prepare(`INSERT INTO disputes (id, organization_id, provider, provider_dispute_id, provider_charge_id, amount_cents, currency, status, reason, evidence_due_at, provider_event_created)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_dispute_id) DO UPDATE SET status=excluded.status, reason=excluded.reason, evidence_due_at=excluded.evidence_due_at, provider_event_created=excluded.provider_event_created, updated_at=CURRENT_TIMESTAMP WHERE excluded.provider_event_created >= disputes.provider_event_created`)
          .bind(crypto.randomUUID(), organizationId, provider.PROVIDER_NAME, obj.id, chargeId || null, obj.amount || 0, obj.currency || "usd", obj.status || "unknown",
            obj.reason || null, obj.evidence_details?.due_by ? new Date(obj.evidence_details.due_by*1000).toISOString() : null, Number(event.created) || 0).run();
        if (event.type === "charge.dispute.created") {
          console.error(JSON.stringify({msg:"dispute_open", organizationId, disputeId:obj.id, amount:obj.amount || 0}));
        }
        break;
      }

      case "credit_note.created": {
        const invoiceId = typeof obj.invoice === "string" ? obj.invoice : obj.invoice?.id;
        const invoice = invoiceId ? await env.LUMMET_DB.prepare("SELECT id, organization_id FROM invoices WHERE provider=? AND provider_invoice_id=?")
          .bind(provider.PROVIDER_NAME, invoiceId).first() : null;
        const organizationId = invoice?.organization_id || obj.metadata?.organization_id;
        if (!organizationId) throw new Error(`credit_note.created has no resolvable organization (credit note ${obj.id})`);
        await env.LUMMET_DB.prepare(`INSERT INTO credit_notes (id, organization_id, invoice_id, provider, provider_credit_note_id, amount_cents, currency, status, reason, provider_event_created)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(provider, provider_credit_note_id) DO UPDATE SET amount_cents=excluded.amount_cents, status=excluded.status, reason=excluded.reason, provider_event_created=excluded.provider_event_created WHERE excluded.provider_event_created >= credit_notes.provider_event_created`)
          .bind(crypto.randomUUID(), organizationId, invoice?.id || null, provider.PROVIDER_NAME, obj.id, obj.amount || 0, obj.currency || "usd", obj.status || "issued", obj.reason || null, Number(event.created) || 0).run();
        break;
      }

      case "customer.updated": {
        const organizationId = await getOrganizationIdForProviderCustomer(env, obj.id);
        if (!organizationId) throw new Error(`customer.updated for unknown customer ${obj.id}`);
        await env.LUMMET_DB.prepare(`INSERT INTO organization_billing_profiles
          (organization_id, legal_name, billing_email, address_line1, address_line2, city, region, postal_code, country, tax_exempt, stripe_customer_id, provider_event_created, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(organization_id) DO UPDATE SET legal_name=excluded.legal_name,
          billing_email=excluded.billing_email,
          address_line1=excluded.address_line1,
          address_line2=excluded.address_line2,
          city=excluded.city, region=excluded.region,
          postal_code=excluded.postal_code, country=excluded.country,
          tax_exempt=excluded.tax_exempt, stripe_customer_id=excluded.stripe_customer_id, provider_event_created=excluded.provider_event_created, updated_at=CURRENT_TIMESTAMP WHERE excluded.provider_event_created >= organization_billing_profiles.provider_event_created`)
          .bind(organizationId, obj.name || null, obj.email || null, obj.address?.line1 || null, obj.address?.line2 || null,
            obj.address?.city || null, obj.address?.state || null, obj.address?.postal_code || null, obj.address?.country || null,
            obj.tax_exempt === "exempt" ? 1 : 0, obj.id, Number(event.created) || 0).run();
        break;
      }

      case "payment_method.attached":
      case "payment_method.detached":
      case "payment_method.automatically_updated": {
        const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
        const existingMethod = await env.LUMMET_DB.prepare("SELECT organization_id FROM billing_payment_methods WHERE provider=? AND provider_payment_method_id=?")
          .bind(provider.PROVIDER_NAME, obj.id).first();
        const organizationId = (customerId ? await getOrganizationIdForProviderCustomer(env, customerId) : null) || existingMethod?.organization_id;
        if (!organizationId) throw new Error(`${event.type} for unresolvable payment method ${obj.id}`);
        const detached = event.type === "payment_method.detached";
        await env.LUMMET_DB.prepare(`INSERT INTO billing_payment_methods
          (id, organization_id, provider, provider_payment_method_id, type, card_brand, card_last4, card_fingerprint, status, last_event_created, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(provider, provider_payment_method_id) DO UPDATE SET organization_id=excluded.organization_id,
          type=excluded.type, card_brand=excluded.card_brand, card_last4=excluded.card_last4,
          card_fingerprint=excluded.card_fingerprint, status=excluded.status, last_event_created=excluded.last_event_created, updated_at=CURRENT_TIMESTAMP
          WHERE excluded.last_event_created >= billing_payment_methods.last_event_created`)
          .bind(crypto.randomUUID(), organizationId, provider.PROVIDER_NAME, obj.id, obj.type || null,
            obj.card?.brand || null, obj.card?.last4 || null, obj.card?.fingerprint || null, detached ? "detached" : "attached", Number(event.created) || 0).run();
        break;
      }

      case "customer.tax_id.created":
      case "customer.tax_id.updated":
      case "customer.tax_id.deleted": {
        const customerId = typeof obj.customer === "string" ? obj.customer : obj.customer?.id;
        const organizationId = await getOrganizationIdForProviderCustomer(env, customerId);
        if (!organizationId) throw new Error(`${event.type} for unknown customer ${customerId || "unknown"}`);
        if (event.type === "customer.tax_id.deleted") {
          await env.LUMMET_DB.prepare(`INSERT INTO organization_billing_profiles (organization_id, tax_id, tax_id_type, stripe_customer_id, provider_event_created, updated_at)
            VALUES (?, NULL, NULL, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(organization_id) DO UPDATE SET tax_id=NULL, tax_id_type=NULL, stripe_customer_id=excluded.stripe_customer_id,
            provider_event_created=excluded.provider_event_created, updated_at=CURRENT_TIMESTAMP
            WHERE excluded.provider_event_created >= organization_billing_profiles.provider_event_created`)
            .bind(organizationId, customerId, Number(event.created) || 0).run();
        } else {
          await env.LUMMET_DB.prepare("INSERT INTO organization_billing_profiles (organization_id, tax_id_type, tax_id, stripe_customer_id, provider_event_created, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(organization_id) DO UPDATE SET tax_id_type=excluded.tax_id_type, tax_id=excluded.tax_id, stripe_customer_id=excluded.stripe_customer_id, provider_event_created=excluded.provider_event_created, updated_at=CURRENT_TIMESTAMP WHERE excluded.provider_event_created >= organization_billing_profiles.provider_event_created")
            .bind(organizationId, obj.type || null, obj.value || null, customerId, Number(event.created) || 0).run();
        }
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

    // Mode guard: production only accepts live-mode events, staging and development only test-mode ones. An event
    // with no livemode field (never sent by Stripe) is not judged. Rejections are logged and counted, then answered
    // with 200 so Stripe does not keep retrying an event that can never be valid here.
    const wrongMode = modeMismatch(env, event);
    if (wrongMode) {
      console.warn(JSON.stringify({ msg: "billing_webhook_rejected", reason: wrongMode, eventId: event.id, type: event.type }));
      await lifecycleRepo.insertWebhookRejection(env, { provider: provider.PROVIDER_NAME, eventId: event.id, eventType: event.type, reason: wrongMode });
      return { ok: true, rejected: wrongMode };
    }

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

  // Phase 5.7: staff replay of a failed webhook. The payload is not stored locally, so the event is re-read from the provider
  // by id (never taken from the caller). Only failed or stuck events can be replayed; one UPDATE claims it, so concurrent
  // replays run it once, and a processed event is refused. dispatchEvent is the same idempotent path redelivery uses.
  async function replayWebhookEvent(env, eventId, { reason, staffId, newId = () => crypto.randomUUID() } = {}) {
    const cleanReason = String(reason || "").trim();
    const cleanId = String(eventId || "").trim();
    if (!cleanReason || !staffId) return { ok: false, status: 422, error: "reason_required" };
    if (!/^evt_[A-Za-z0-9_]{6,100}$/.test(cleanId) && typeof provider.retrieveEvent !== "function") return { ok: false, status: 422, error: "invalid_event_id" };
    const name = provider.PROVIDER_NAME;
    const log = (outcome, error) => webhookEvents.insertReplayLog(env, { id: newId(), provider: name, eventId: cleanId, staffId, reason: cleanReason.slice(0, 500), outcome, error });
    const row = await webhookEvents.findEvent(env, name, cleanId);
    if (!row) { await log("not_found"); return { ok: false, status: 404, error: "event_not_found" }; }
    if (row.status === "processed") { await log("not_claimable"); return { ok: false, status: 409, error: "event_already_processed" }; }
    let event;
    try { event = await (typeof provider.retrieveEvent === "function" ? provider.retrieveEvent(env, cleanId) : stripeProvider.stripeRequest(env, "GET", `/v1/events/${encodeURIComponent(cleanId)}`)); }
    catch (error) { return { ok: false, status: 502, error: "provider_event_fetch_failed" }; }
    if (!event || event.id !== cleanId) return { ok: false, status: 502, error: "provider_event_mismatch" };
    if (modeMismatch(env, event)) { await log("mode_mismatch"); return { ok: false, status: 409, error: "livemode_mismatch" }; }
    const claimed = await webhookEvents.claimStaffReplay(env, name, cleanId);
    if (!claimed) { await log("not_claimable"); return { ok: false, status: 409, error: "event_not_replayable" }; }
    try {
      await dispatchEvent(env, event);
      await webhookEvents.markProcessed(env, name, cleanId);
      await log("processed");
      return { ok: true, eventId: cleanId, eventType: event.type };
    } catch (error) {
      await webhookEvents.markFailed(env, name, cleanId, error?.message || error);
      await log("failed", error?.message || error);
      return { ok: false, status: 500, error: "webhook_replay_failed" };
    }
  }
  async function listFailedWebhookEvents(env, opts) { return webhookEvents.listFailedEvents(env, opts); }

  return {
    replayWebhookEvent,
    listFailedWebhookEvents,
    ensureBillingCustomer,
    getBillingProfile,
    updateBillingProfile,
    startCheckout,
    validateCoupon,
    openBillingPortal,
    cancelSubscription,
    pauseSubscription,
    resumePausedSubscription,
    resumeSubscription,
    changePlan,
    retryPlanChangeIntents,
    listInvoices,
    handleWebhook,
    dispatchEventForReplay: dispatchEvent
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
