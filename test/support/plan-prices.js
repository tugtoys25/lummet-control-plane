// test/support/plan-prices.js
//
// Sprint 3.1: checkout, plan changes and webhook plan mapping read plan_prices, not the old plans.stripe_price_id field.
// Tests that need a plan to be "billing configured" call setPlanPrice, which writes a row the same way the sync
// script does (the plan's own currency, interval and amount; lookup key from the shared rule; previous active row retired).
import { priceLookupKey, PERIOD_INTERVAL } from '../../worker/catalog.js';

export async function setPlanPrice(env, planId, stripePriceId, { mode = 'unknown', version = null, amountCents = null } = {}) {
  const plan = await env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ?`).bind(planId).first();
  if (!plan) throw new Error(`setPlanPrice: no plan ${planId}`);
  const interval = PERIOD_INTERVAL[plan.billing_period];
  const currency = String(plan.currency).toLowerCase();
  const v = version ?? ((await env.LUMMET_DB.prepare(`SELECT COALESCE(MAX(version), 0) + 1 AS v FROM plan_prices WHERE plan_id = ? AND currency = ? AND interval = ?`).bind(planId, currency, interval).first()).v);
  await env.LUMMET_DB.prepare(`UPDATE plan_prices SET active = 0 WHERE plan_id = ? AND currency = ? AND interval = ? AND active = 1`).bind(planId, currency, interval).run();
  await env.LUMMET_DB.prepare(
    `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key, stripe_mode, version, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).bind(`pp_${planId}_${v}_${stripePriceId}`, planId, currency, interval, amountCents ?? plan.price_cents, stripePriceId, priceLookupKey(plan.key, interval, currency, v), mode, v).run();
}
