// plan_prices rows (migration 0052). Repository: plain data in, plain data out; the rules live in worker/plan-prices.js.
// IMMUTABLE BY DESIGN: nothing here updates the amount, currency, interval, plan, lookup key or version of a row.
// New prices are written only by scripts/stripe-sync.mjs (its generated SQL), never by the Worker.

/** The price new customers get for a plan: active, in the plan's currency and interval. Newest version wins. */
export async function activeForPlan(env, planId, currency, interval) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM plan_prices WHERE plan_id = ? AND currency = ? AND interval = ? AND active = 1 ORDER BY version DESC LIMIT 1`
  ).bind(planId, String(currency).toLowerCase(), interval).first();
}

/** Any version, active or not: a subscriber stays on the price they bought, and a webhook for it must still map. */
export async function byStripePriceId(env, stripePriceId) {
  if (!stripePriceId) return null;
  return env.LUMMET_DB.prepare(`SELECT * FROM plan_prices WHERE stripe_price_id = ?`).bind(stripePriceId).first();
}

/** One page for the staff API. limit is capped at 200. */
export async function listPage(env, { planId = "", limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 200);
  const off = Math.min(Math.max(Math.floor(Number(offset)) || 0, 0), 500000);
  const r = await env.LUMMET_DB.prepare(
    `SELECT pp.*, p.key AS plan_key, p.price_cents AS plan_price_cents
       FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
      WHERE (? = '' OR pp.plan_id = ?)
      ORDER BY p.key, pp.interval, pp.version DESC, pp.id LIMIT ? OFFSET ?`
  ).bind(planId, planId, lim + 1, off).all();
  const rows = r.results || [];
  return { rows: rows.slice(0, lim), hasMore: rows.length > lim };
}
