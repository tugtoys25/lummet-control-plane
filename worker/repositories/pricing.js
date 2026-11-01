// Pricing read model for the public pricing page (v7G). All SQL for it lives here.


const PRICING_KEYS = ["sites.max", "domains.custom.max", "users.max", "ai.credits_monthly", "analytics.level", "affiliate.enabled", "reports.enabled", "alerts.enabled", "api.enabled"];

/** Active, priced, recurring plans of active products, with the entitlements the pricing page lists. */
export async function listPricing(env, { requirePrice = false } = {}) {
  const plans = (await env.LUMMET_DB.prepare(
    `SELECT p.id, p.name, p.billing_period, p.price_cents, p.currency, p.trial_days, pr.id AS product_id, pr.name AS product_name, pr.category
       FROM plans p JOIN products pr ON pr.id = p.product_id
      WHERE p.status = 'active' AND pr.status = 'active' AND p.price_cents IS NOT NULL AND p.price_cents > 0
        AND p.billing_period IN ('monthly', 'annual')
        ${requirePrice ? "AND EXISTS (SELECT 1 FROM plan_prices pp WHERE pp.plan_id = p.id AND pp.active = 1 AND pp.stripe_price_id IS NOT NULL)" : ""}
      ORDER BY pr.category, pr.name, p.price_cents, p.id`
  ).all()).results;
  if (!plans.length) return [];
  const marks = PRICING_KEYS.map(() => "?").join(",");
  const ents = (await env.LUMMET_DB.prepare(
    `SELECT plan_id, key, value FROM plan_entitlements WHERE key IN (${marks})`
  ).bind(...PRICING_KEYS).all()).results;
  const byPlan = new Map();
  for (const e of ents) { if (!byPlan.has(e.plan_id)) byPlan.set(e.plan_id, {}); byPlan.get(e.plan_id)[e.key] = e.value; }
  const extras = await pricingExtras(env, plans.map((p) => p.id));
  return plans.map((p) => ({ ...p, entitlements: byPlan.get(p.id) || {}, ...(extras.get(p.id) || {}) }));
}

/**
 * Staff-managed presentation (migration 0078): tagline, recommended flag, sort order, button text, custom feature lines,
 * label chips and the live promotion. Strictly additive and fail-soft: if anything here fails (for example the migration
 * has not been applied yet) the pricing page renders exactly as it did before, from entitlements alone.
 */
async function pricingExtras(env, ids) {
  const out = new Map();
  try {
    const marks = ids.map(() => "?").join(",");
    const get = (id) => { if (!out.has(id)) out.set(id, { feature_lines: [], labels: [], promo: null }); return out.get(id); };
    const base = (await env.LUMMET_DB.prepare(`SELECT id, tagline, is_featured, sort_order, cta_label, seo_description FROM plans WHERE id IN (${marks})`).bind(...ids).all()).results;
    for (const r of base) Object.assign(get(r.id), { tagline: r.tagline || "", is_featured: !!r.is_featured, sort_order: Number(r.sort_order) || 0, cta_label: r.cta_label || "", seo_description: r.seo_description || "" });
    for (const f of (await env.LUMMET_DB.prepare(`SELECT plan_id, label, included, highlight FROM plan_features WHERE plan_id IN (${marks}) ORDER BY plan_id, sort_order, id`).bind(...ids).all()).results) {
      get(f.plan_id).feature_lines.push({ text: f.label, included: !!f.included, highlight: !!f.highlight });
    }
    for (const l of (await env.LUMMET_DB.prepare(`SELECT k.plan_id, l.name, l.color FROM plan_label_links k JOIN plan_labels l ON l.id = k.label_id WHERE k.plan_id IN (${marks}) ORDER BY l.name COLLATE NOCASE`).bind(...ids).all()).results) {
      get(l.plan_id).labels.push({ name: l.name, color: l.color });
    }
    // One live promotion per plan: active, inside its window, and (when it points at a coupon) that coupon is still usable by anyone.
    for (const r of (await env.LUMMET_DB.prepare(
      `SELECT pp.plan_id, pp.badge_text, c.code FROM plan_promotions pp LEFT JOIN coupons c ON c.id = pp.coupon_id
        WHERE pp.plan_id IN (${marks}) AND pp.status = 'active'
          AND (pp.starts_at IS NULL OR pp.starts_at <= datetime('now')) AND (pp.ends_at IS NULL OR pp.ends_at > datetime('now'))
          AND (pp.coupon_id IS NULL OR (c.status = 'active' AND c.organization_id IS NULL AND (c.expires_at IS NULL OR c.expires_at > datetime('now'))
               AND (c.max_redemptions IS NULL OR c.redemption_count < c.max_redemptions)))
        ORDER BY COALESCE(pp.ends_at, '9999-12-31'), pp.created_at`).bind(...ids).all()).results) {
      const e = get(r.plan_id); if (!e.promo) e.promo = { text: r.badge_text, code: r.code || "" };
    }
  } catch (err) {
    console.error("pricing extras unavailable:", err?.message || err);
    return new Map();
  }
  return out;
}
