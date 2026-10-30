// =====================================================
// NOWPAYMENTS BILLING SERVICE
//
// Glue between billing-nowpayments.js (the API) and billing.js (the state machine). It does not duplicate billing.js: a confirmed
// crypto payment is translated into the SAME three events a Stripe checkout produces (checkout.session.completed,
// customer.subscription.updated, invoice.paid) and handed to billing.js's own handlers. That keeps receipts, site restore,
// revenue tracking, coupons-off, grace recovery and webhooks identical across gateways, with no edit to billing.js.
//
// Safety rules:
//   - The IPN is only a doorbell. Org and plan come from OUR crypto_checkouts row (matched by the order id we sent), and the payment
//     is re-read from NOWPayments and its amount compared to the row before anything is granted.
//   - Every IPN is recorded once (billing_webhook_events, provider "nowpayments"); a redelivery is a no-op, a failed one is retried.
//   - Only `finished` grants access. partially_paid is recorded and never grants.
// =====================================================
import * as np from "./billing-nowpayments.js";
import { createBillingService } from "./billing.js";
import * as webhookEvents from "./repositories/billing-webhooks.js";
import * as repo from "./repositories/crypto-checkouts.js";
import { billingConfig } from "./billing-config.js";

const DAY_MS = 86400000;

function addPeriod(fromMs, billingPeriod) {
  const d = new Date(fromMs);
  if (billingPeriod === "annual") d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.getTime();
}

const IN_FLIGHT = new Set(["waiting", "confirming", "confirmed", "sending"]);

export function createCryptoBilling(provider = np) {
  const service = createBillingService(provider);

  /** Creates one invoice for one period of `planId`. The customer pays on NOWPayments' hosted page. */
  async function startCryptoCheckout(env, { organizationId, planId, successUrl, cancelUrl, ipnUrl, couponCode }) {
    if (!successUrl || !cancelUrl || !ipnUrl) return { ok: false, status: 422, error: "success_and_cancel_url_required" };
    if (couponCode) return { ok: false, status: 422, error: "coupon_not_supported_for_gateway" };

    const plan = await repo.findActivePlan(env, planId);
    if (!plan) return { ok: false, status: 422, error: "invalid_plan" };
    if (!["monthly", "annual"].includes(plan.billing_period) || !(Number(plan.price_cents) > 0)) return { ok: false, status: 409, error: "plan_not_billing_configured" };

    const existing = await repo.currentSubscription(env, organizationId);
    if (existing && existing.provider && existing.provider !== provider.PROVIDER_NAME) return { ok: false, status: 409, error: "organization_already_subscribed" };

    const customer = await service.ensureBillingCustomer(env, organizationId);
    if (!customer) return { ok: false, status: 404, error: "organization_not_found" };

    const orderId = crypto.randomUUID();
    const currency = String(plan.currency || "USD").toUpperCase();
    await repo.insertPending(env, { id: orderId, organizationId, planId: plan.id, amountCents: Number(plan.price_cents), currency });

    let session;
    try {
      session = await provider.createCheckoutSession(env, {
        successUrl, cancelUrl, ipnUrl, orderId, amountCents: Number(plan.price_cents), currency,
        description: `${plan.name || plan.key || "Lummet plan"} (${plan.billing_period})`
      });
    } catch (error) {
      await repo.markFailedById(env, orderId);
      throw error;
    }
    await repo.setInvoice(env, orderId, { providerInvoiceId: session.providerSessionId, invoiceUrl: session.checkoutUrl });
    return { ok: true, gateway: provider.PROVIDER_NAME, checkoutUrl: session.checkoutUrl, providerSessionId: session.providerSessionId };
  }

  /** The three events a paid period produces. Shapes match what billing.js's handlers read from a Stripe event. */
  function eventsFor({ checkout, plan, subscriptionId, customerId, payment, periodStartMs, periodEndMs, now }) {
    const created = Math.floor(now / 1000);
    const unix = (ms) => Math.floor(ms / 1000);
    const orderMeta = { organization_id: checkout.organization_id, plan_id: checkout.plan_id };
    const base = (suffix) => `np_${payment.payment_id}_${suffix}`;
    return [
      { id: base("checkout"), type: "checkout.session.completed", created, data: { object: {
        id: `np_cs_${checkout.id}`, client_reference_id: checkout.organization_id, customer: customerId, subscription: subscriptionId, metadata: orderMeta } } },
      { id: base("subscription"), type: "customer.subscription.updated", created, data: { object: {
        id: subscriptionId, status: "active", customer: customerId, current_period_start: unix(periodStartMs), current_period_end: unix(periodEndMs),
        cancel_at_period_end: false, metadata: orderMeta } } },
      { id: base("invoice"), type: "invoice.paid", created, data: { object: {
        id: `np_inv_${checkout.id}`, customer: customerId, subscription: subscriptionId, payment_intent: `np_pay_${payment.payment_id}`,
        amount_due: checkout.amount_cents, amount_paid: checkout.amount_cents, currency: String(checkout.currency).toLowerCase(),
        hosted_invoice_url: checkout.invoice_url || null, period_start: unix(periodStartMs), period_end: unix(periodEndMs), metadata: orderMeta } } }
    ];
  }

  async function grantPeriod(env, checkout, payment) {
    const plan = await repo.findPlan(env, checkout.plan_id);
    if (!plan) throw new Error(`crypto checkout ${checkout.id} names unknown plan ${checkout.plan_id}`);
    const now = Date.now();

    const existing = await repo.currentSubscription(env, checkout.organization_id);
    if (existing && existing.provider && existing.provider !== provider.PROVIDER_NAME) {
      throw new Error(`organization ${checkout.organization_id} now has a ${existing.provider} subscription; refusing to grant a crypto period (checkout ${checkout.id})`);
    }
    const mine = existing && existing.provider === provider.PROVIDER_NAME ? existing : null;
    const subscriptionId = mine?.provider_subscription_id || `np_sub_${checkout.id}`;

    // Paying early extends from the end of the paid period; paying late starts from now. Periods never overlap or get lost.
    const currentEnd = mine?.current_period_end ? Date.parse(mine.current_period_end) : NaN;
    const periodStartMs = Number.isFinite(currentEnd) && currentEnd > now ? currentEnd : now;
    const periodEndMs = addPeriod(periodStartMs, plan.billing_period);

    const customerId = `np_cus_${checkout.organization_id}`;
    for (const event of eventsFor({ checkout, plan, subscriptionId, customerId, payment, periodStartMs, periodEndMs, now })) {
      await service.dispatchEventForReplay(env, event);
    }

    // A customer who pays for a different plan than the one they hold switches to it (crypto has no in-place plan change).
    const after = await repo.currentSubscription(env, checkout.organization_id);
    if (after && after.plan_id !== checkout.plan_id) await repo.switchPlan(env, after, checkout.plan_id);
    await repo.markPaid(env, checkout.id, payment.payment_id);
  }

  async function processPayment(env, payload) {
    const status = String(payload.payment_status).toLowerCase();
    const checkout = payload.order_id ? await repo.findById(env, payload.order_id) : null;
    if (!checkout) {
      // Not one of ours (the NOWPayments account may serve other things). Nothing to do, and not a failure to retry.
      console.warn(JSON.stringify({ msg: "nowpayments_ipn_unknown_order", orderId: payload.order_id || null, paymentId: payload.payment_id, status }));
      return { ignored: "unknown_order" };
    }
    if (checkout.status === "paid" && status !== "refunded") return { ignored: "already_paid" };

    if (IN_FLIGHT.has(status)) {
      await repo.markConfirming(env, checkout.id, payload.payment_id);
      return { status: "confirming" };
    }
    if (status === "partially_paid") {
      // Too little arrived. Access is NOT granted; staff see it here and can top-up or refund with NOWPayments.
      await repo.markPartiallyPaid(env, checkout.id, payload.payment_id);
      return { status: "partially_paid" };
    }
    if (status === "failed" || status === "expired") {
      await repo.markEnded(env, checkout.id, status);
      return { status };
    }
    if (status === "refunded") {
      await repo.markRefunded(env, checkout.id);
      return { status: "refunded", note: "staff must review: access is not removed automatically" };
    }
    if (status !== "finished") return { ignored: `status_${status}` };

    // finished: never trust the body. Re-read the payment and compare it to what we asked for.
    const live = await provider.getPayment(env, payload.payment_id);
    if (String(live?.payment_status).toLowerCase() !== "finished") throw new Error(`payment ${payload.payment_id} is not finished at NOWPayments (${live?.payment_status})`);
    if (String(live?.order_id) !== checkout.id) throw new Error(`payment ${payload.payment_id} belongs to order ${live?.order_id}, not ${checkout.id}`);
    if (String(live?.price_currency || "").toUpperCase() !== String(checkout.currency).toUpperCase() || Math.round(Number(live?.price_amount) * 100) !== checkout.amount_cents) {
      throw new Error(`payment ${payload.payment_id} amount ${live?.price_amount} ${live?.price_currency} does not match checkout ${checkout.id}`);
    }
    await grantPeriod(env, checkout, live);
    return { status: "granted" };
  }

  async function handleWebhook(request, env) {
    const verification = await provider.verifyAndParseWebhook(request, env);
    if (!verification.valid) return { ok: false, status: 400, error: verification.reason || "invalid_signature" };
    const event = verification.event;

    const inserted = await webhookEvents.recordReceived(env, provider.PROVIDER_NAME, event.id, event.type);
    if (!inserted) {
      const claimed = await webhookEvents.claimRetry(env, provider.PROVIDER_NAME, event.id);
      if (!claimed) return { ok: true, duplicate: true };
    }
    try {
      const outcome = await processPayment(env, event.data.object);
      await webhookEvents.markProcessed(env, provider.PROVIDER_NAME, event.id);
      return { ok: true, duplicate: false, outcome };
    } catch (error) {
      await webhookEvents.markFailed(env, provider.PROVIDER_NAME, event.id, error?.message || error);
      return { ok: false, status: 500, error: "webhook_processing_failed" };
    }
  }

  /**
   * Crypto periods are prepaid, so nobody bills a lapsed one. A period that ended without payment becomes past_due, with the same
   * grace clock a failed Stripe invoice gets, so the existing lifecycle sweep carries it on to restricted and suspended. A customer
   * who asked to cancel at period end is simply canceled. Idempotent: each UPDATE is guarded by the status it expects.
   */
  async function expireLapsedPeriods(env, now = Date.now()) {
    const result = { pastDue: 0, canceled: 0 };
    const rows = await repo.listLapsed(env, provider.PROVIDER_NAME, new Date(now).toISOString());
    const graceDays = billingConfig(env).graceDays;
    for (const sub of rows) {
      const toStatus = sub.cancel_at_period_end ? "canceled" : "past_due";
      const changed = toStatus === "canceled"
        ? await repo.lapseToCanceled(env, sub.id)
        : await repo.lapseToPastDue(env, sub.id, new Date(now + graceDays * DAY_MS).toISOString());
      if (changed) {
        await repo.insertLapseEvent(env, sub.id, toStatus);
        if (toStatus === "canceled") result.canceled += 1; else result.pastDue += 1;
      }
    }
    return result;
  }

  return { service, startCryptoCheckout, handleWebhook, expireLapsedPeriods, processPayment };
}

export const cryptoBilling = createCryptoBilling(np);
