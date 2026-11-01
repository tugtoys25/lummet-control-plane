// The ONLY Worker code that writes plan_prices (migration 0052).
//
// Prices stay immutable. This module can do exactly two things, and nothing else:
//   1. INSERT a new version row (version + 1, new lookup key, new Stripe price id).
//   2. flip the PREVIOUS row of the same plan/currency/interval to active = 0, in the same batch, so there is never a
//      moment with two active prices (uq_plan_prices_one_active would reject it anyway).
// It never changes the amount, currency, interval, plan, lookup key, Stripe price id or version of an existing row, and
// it never deletes one: a subscriber still on version 1 keeps mapping to its plan after version 2 goes live.
// test/plan-prices.test.js enforces that no OTHER file under worker/ writes the table, and that this one stays this narrow.

export async function maxVersion(env, planId, currency, interval) {
  const r = await env.LUMMET_DB.prepare(`SELECT MAX(version) v FROM plan_prices WHERE plan_id = ? AND currency = ? AND interval = ?`).bind(planId, currency, interval).first();
  return Number(r?.v || 0);
}

export async function stripePriceIdTaken(env, stripePriceId) {
  return !!(await env.LUMMET_DB.prepare(`SELECT id FROM plan_prices WHERE stripe_price_id = ?`).bind(stripePriceId).first());
}

/**
 * Makes `row` the active price for its plan/currency/interval and mirrors its amount into plans.price_cents (the list
 * price the pricing page shows), exactly as scripts/stripe-sync.mjs does. One batch: all or nothing.
 */
export async function activateNewVersion(env, row) {
  const db = env.LUMMET_DB;
  await db.batch([
    db.prepare(`UPDATE plan_prices SET active = 0 WHERE plan_id = ? AND currency = ? AND interval = ? AND active = 1`).bind(row.planId, row.currency, row.interval),
    db.prepare(
      `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, tax_behavior, stripe_price_id, lookup_key, stripe_mode, version, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).bind(row.id, row.planId, row.currency, row.interval, row.unitAmountCents, row.taxBehavior, row.stripePriceId, row.lookupKey, row.stripeMode, row.version),
    db.prepare(`UPDATE plans SET price_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(row.unitAmountCents, row.planId)
  ]);
}
