// Subscription rows written or read by the Phase 2.2 webhook handlers. Repository: plain data in, plain data out.
// The rules (which statuses are materialised, what counts as a duplicate) live in billing.js.

export async function planIdForPrice(env, priceId) {
  if (!priceId) return null;
  // plan_prices (migration 0052), any version: a subscriber still on version 1 maps to its plan after version 2 goes live.
  return (await env.LUMMET_DB.prepare(`SELECT plan_id FROM plan_prices WHERE stripe_price_id = ?`).bind(priceId).first())?.plan_id || null;
}

export async function planById(env, planId) {
  return env.LUMMET_DB.prepare(`SELECT id, key, name, billing_period, price_cents, currency, status FROM plans WHERE id = ?`).bind(planId).first();
}

/** A local trial becomes the provider's subscription (same row, so history and the welcome dedupe key carry over). */
export async function convertLocalToProvider(env, id, f) {
  await env.LUMMET_DB.prepare(
    `UPDATE subscriptions SET plan_id = ?, provider = ?, provider_subscription_id = ?, status = ?, stripe_status = ?, trial_ends_at = COALESCE(?, trial_ends_at),
       current_period_start = COALESCE(?, current_period_start), current_period_end = COALESCE(?, current_period_end),
       grace_ends_at = NULL, restricted_at = NULL, suspended_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(f.planId, f.provider, f.providerSubscriptionId, f.status, f.stripeStatus, f.trialEndsAt, f.periodStart, f.periodEnd, id).run();
}

export async function insertProviderSubscription(env, f) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan_id, status, stripe_status, provider, provider_subscription_id, trial_ends_at, current_period_start, current_period_end, cancel_at_period_end)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(f.id, f.organizationId, f.planId, f.status, f.stripeStatus, f.provider, f.providerSubscriptionId, f.trialEndsAt, f.periodStart, f.periodEnd, f.cancelAtPeriodEnd ? 1 : 0).run();
}

/** Persist the provider-confirmed/accepted pause resume timestamp without changing the local status optimistically. */
export async function setPauseResumeAt(env, subscriptionId, resumesAt) {
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET pause_resumes_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(resumesAt, subscriptionId).run();
}
