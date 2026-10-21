// Pricing read model for the public pricing page (v7G). All SQL for it lives here.


const PRICING_KEYS = ["sites.max", "domains.custom.max", "users.max", "ai.credits_monthly", "analytics.level", "affiliate.enabled", "reports.enabled", "alerts.enabled", "api.enabled"];

/** Active, priced, recurring plans of active products, with the entitlements the pricing page lists. */
export async function listPricing(env) {
  const plans = (await env.LUMMET_DB.prepare(
    `SELECT p.id, p.name, p.billing_period, p.price_cents, p.currency, p.trial_days, pr.id AS product_id, pr.name AS product_name, pr.category
       FROM plans p JOIN products pr ON pr.id = p.product_id
      WHERE p.status = 'active' AND pr.status = 'active' AND p.price_cents IS NOT NULL AND p.price_cents > 0
        AND p.billing_period IN ('monthly', 'annual')
      ORDER BY pr.category, pr.name, p.price_cents, p.id`
  ).all()).results;
  if (!plans.length) return [];
  const marks = PRICING_KEYS.map(() => "?").join(",");
  const ents = (await env.LUMMET_DB.prepare(
    `SELECT plan_id, key, value FROM plan_entitlements WHERE key IN (${marks})`
  ).bind(...PRICING_KEYS).all()).results;
  const byPlan = new Map();
  for (const e of ents) { if (!byPlan.has(e.plan_id)) byPlan.set(e.plan_id, {}); byPlan.get(e.plan_id)[e.key] = e.value; }
  return plans.map((p) => ({ ...p, entitlements: byPlan.get(p.id) || {} }));
}
