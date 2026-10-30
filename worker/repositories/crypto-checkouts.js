// Crypto (NOWPayments) checkouts and the subscription rows they touch (migration 0074). All SQL for billing-nowpayments-service.js lives here.

const NON_TERMINAL = "('canceled','expired','incomplete_expired')";

export async function findActivePlan(env, planId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ? AND status = 'active'`).bind(planId).first();
}
export async function findPlan(env, planId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ?`).bind(planId).first();
}
export async function currentSubscription(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ? AND status NOT IN ${NON_TERMINAL} ORDER BY created_at DESC LIMIT 1`).bind(organizationId).first();
}

export async function insertPending(env, { id, organizationId, planId, amountCents, currency }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO crypto_checkouts (id, organization_id, plan_id, amount_cents, currency, status) VALUES (?, ?, ?, ?, ?, 'pending')`
  ).bind(id, organizationId, planId, amountCents, currency).run();
}
export async function markFailedById(env, id) {
  await env.LUMMET_DB.prepare(`UPDATE crypto_checkouts SET status = 'failed' WHERE id = ?`).bind(id).run();
}
export async function setInvoice(env, id, { providerInvoiceId, invoiceUrl }) {
  await env.LUMMET_DB.prepare(`UPDATE crypto_checkouts SET provider_invoice_id = ?, invoice_url = ? WHERE id = ?`).bind(providerInvoiceId, invoiceUrl, id).run();
}
export async function findById(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM crypto_checkouts WHERE id = ?`).bind(String(id)).first();
}
export async function markConfirming(env, id, paymentId) {
  await env.LUMMET_DB.prepare(`UPDATE crypto_checkouts SET status = 'confirming', provider_payment_id = ? WHERE id = ? AND status IN ('pending','confirming')`).bind(String(paymentId), id).run();
}
export async function markPartiallyPaid(env, id, paymentId) {
  await env.LUMMET_DB.prepare(`UPDATE crypto_checkouts SET status = 'partially_paid', provider_payment_id = ? WHERE id = ? AND status <> 'paid'`).bind(String(paymentId), id).run();
}
/** failed | expired. Never overwrites a paid checkout. */
export async function markEnded(env, id, status) {
  await env.LUMMET_DB.prepare(`UPDATE crypto_checkouts SET status = ? WHERE id = ? AND status <> 'paid'`).bind(status, id).run();
}
export async function markRefunded(env, id) {
  await env.LUMMET_DB.prepare(`UPDATE crypto_checkouts SET status = 'refunded' WHERE id = ?`).bind(id).run();
}
export async function markPaid(env, id, paymentId) {
  await env.LUMMET_DB.prepare(`UPDATE crypto_checkouts SET status = 'paid', provider_payment_id = ?, paid_at = COALESCE(paid_at, CURRENT_TIMESTAMP) WHERE id = ?`).bind(String(paymentId), id).run();
}

/** A customer who paid for a different plan than the one they hold moves to it (crypto has no in-place plan change). */
export async function switchPlan(env, subscription, planId) {
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET plan_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(planId, subscription.id).run();
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscription_status_events (subscription_id, from_status, to_status, reason, actor_type) VALUES (?, ?, ?, ?, 'billing_webhook')`
  ).bind(subscription.id, subscription.status, subscription.status, `plan changed by crypto payment: ${subscription.plan_id} -> ${planId}`).run();
}

export async function listLapsed(env, provider, nowIso, limit = 200) {
  return (await env.LUMMET_DB.prepare(
    `SELECT * FROM subscriptions WHERE provider = ? AND status = 'active' AND current_period_end IS NOT NULL AND current_period_end <= ? LIMIT ?`
  ).bind(provider, nowIso, limit).all()).results || [];
}
/** One guarded UPDATE decides, so two sweeps cannot both change a row. Returns true when this call changed it. */
export async function lapseToPastDue(env, subscriptionId, graceEndsAtIso) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE subscriptions SET status = 'past_due', grace_ends_at = COALESCE(grace_ends_at, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'`
  ).bind(graceEndsAtIso, subscriptionId).run();
  return (r?.meta?.changes || 0) > 0;
}
export async function lapseToCanceled(env, subscriptionId) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE subscriptions SET status = 'canceled', canceled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'`
  ).bind(subscriptionId).run();
  return (r?.meta?.changes || 0) > 0;
}
export async function insertLapseEvent(env, subscriptionId, toStatus) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscription_status_events (subscription_id, from_status, to_status, reason, actor_type) VALUES (?, 'active', ?, 'crypto period ended without payment', 'system')`
  ).bind(subscriptionId, toStatus).run();
}
