// Plan catalog management (staff console). Repository: ALL SQL for managing plans, products, labels, feature lines,
// entitlements and promotions lives here. The rules (validation, what may be deleted, what publish means) live in
// worker/plan-catalog.js. Prices are NOT written here: see plan-price-versions.js.

const SORTS = {
  product: "pr.category, pr.name, p.sort_order, p.price_cents, p.id",
  name: "p.name COLLATE NOCASE",
  price: "p.price_cents",
  status: "p.status",
  trial: "p.trial_days",
  subs: "live_subscriptions",
  updated: "COALESCE(p.updated_at, p.created_at)",
  created: "p.created_at"
};
export const SORT_KEYS = Object.keys(SORTS);

const LIST_SELECT = `
  SELECT p.id, p.key, p.name, p.product_id, p.billing_period, p.price_cents, p.currency, p.trial_days, p.status,
         p.tagline, p.description, p.sort_order, p.is_featured, p.cta_label, p.seo_title, p.seo_description,
         p.published_at, p.created_at, p.updated_at,
         pr.name AS product, pr.key AS product_key, pr.category, pr.status AS product_status,
         (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status IN ('trialing','active','past_due')) AS live_subscriptions,
         (SELECT COUNT(*) FROM subscriptions s WHERE s.plan_id = p.id) AS total_subscriptions,
         (SELECT COUNT(*) FROM plan_prices x WHERE x.plan_id = p.id) AS price_versions,
         (SELECT COUNT(*) FROM plan_promotions pp WHERE pp.plan_id = p.id AND pp.status = 'active'
             AND (pp.ends_at IS NULL OR pp.ends_at > datetime('now'))) AS open_promotions,
         ap.stripe_price_id AS active_price_id, ap.lookup_key AS price_lookup_key, ap.version AS price_version,
         ap.stripe_mode AS price_mode, ap.unit_amount_cents AS price_amount_cents
    FROM plans p JOIN products pr ON pr.id = p.product_id
    LEFT JOIN plan_prices ap ON ap.id = (
       SELECT x.id FROM plan_prices x WHERE x.plan_id = p.id AND x.active = 1
          AND x.currency = lower(p.currency) AND x.interval = CASE p.billing_period WHEN 'annual' THEN 'year' ELSE 'month' END
        ORDER BY x.version DESC LIMIT 1)`;

const like = (q) => `%${String(q || "").trim().replace(/[%_\\]/g, "")}%`;

/** One page of plans. `limit` capped at 200. Returns { rows, total }. */
export async function listPlans(env, { q = "", status = "", productId = "", labelId = "", period = "", sort = "product", dir = "asc", limit = 50, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Math.floor(Number(limit)) || 50, 1), 200);
  const off = Math.min(Math.max(Math.floor(Number(offset)) || 0, 0), 500000);
  const orderBy = SORTS[sort] || SORTS.product;
  const direction = String(dir).toLowerCase() === "desc" ? "DESC" : "ASC";
  const where = `WHERE (? = '' OR p.name LIKE ? OR p.key LIKE ? OR pr.name LIKE ? OR p.id = ?)
      AND (? = '' OR p.status = ?) AND (? = '' OR p.product_id = ?) AND (? = '' OR p.billing_period = ?)
      AND (? = '' OR EXISTS (SELECT 1 FROM plan_label_links l WHERE l.plan_id = p.id AND l.label_id = ?))`;
  const args = [String(q).trim(), like(q), like(q), like(q), String(q).trim(), status, status, productId, productId, period, period, labelId, labelId];
  const rows = (await env.LUMMET_DB.prepare(`${LIST_SELECT} ${where} ORDER BY ${orderBy} ${orderBy.includes(",") ? "" : direction}, p.id LIMIT ? OFFSET ?`)
    .bind(...args, lim, off).all()).results || [];
  const total = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM plans p JOIN products pr ON pr.id = p.product_id ${where}`).bind(...args).first())?.n || 0;
  return { rows, total: Number(total) };
}

/** Every plan, unpaged (CSV export; capped). */
export async function listAllForExport(env, limit = 5000) {
  return (await env.LUMMET_DB.prepare(`${LIST_SELECT} ORDER BY pr.category, pr.name, p.sort_order, p.price_cents, p.id LIMIT ?`).bind(limit).all()).results || [];
}

export async function getPlan(env, planId) {
  return env.LUMMET_DB.prepare(`${LIST_SELECT} WHERE p.id = ?`).bind(planId).first();
}

export async function getPlanByKey(env, key) {
  return env.LUMMET_DB.prepare(`SELECT id, key FROM plans WHERE key = ?`).bind(key).first();
}

export async function statusCounts(env) {
  const r = (await env.LUMMET_DB.prepare(`SELECT status, COUNT(*) n FROM plans GROUP BY status`).all()).results || [];
  const out = { draft: 0, active: 0, retired: 0, total: 0 };
  for (const row of r) { out[row.status] = Number(row.n); out.total += Number(row.n); }
  return out;
}

// ---- products ----
export async function listProducts(env) {
  return (await env.LUMMET_DB.prepare(
    `SELECT pr.id, pr.key, pr.name, pr.category, pr.status, (SELECT COUNT(*) FROM plans p WHERE p.product_id = pr.id) AS plan_count
       FROM products pr ORDER BY pr.category, pr.name`).all()).results || [];
}
export async function getProduct(env, id) {
  return env.LUMMET_DB.prepare(`SELECT id, key, name, category, status FROM products WHERE id = ?`).bind(id).first();
}
export async function getProductByKey(env, key) {
  return env.LUMMET_DB.prepare(`SELECT id FROM products WHERE key = ?`).bind(key).first();
}
export async function insertProduct(env, { id, key, name, category }) {
  await env.LUMMET_DB.prepare(`INSERT INTO products (id, key, name, category, status) VALUES (?, ?, ?, ?, 'active')`).bind(id, key, name, category).run();
}
export async function updateProduct(env, id, { name, status }) {
  const sets = [], vals = [];
  if (name !== undefined) { sets.push("name = ?"); vals.push(name); }
  if (status !== undefined) { sets.push("status = ?"); vals.push(status); }
  if (!sets.length) return;
  await env.LUMMET_DB.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
}

// ---- plan rows ----
export async function insertPlan(env, p) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status, description, tagline, sort_order, is_featured, cta_label, seo_title, seo_description, published_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(p.id, p.productId, p.key, p.name, p.billingPeriod, p.priceCents, p.currency, p.trialDays, p.status, p.description, p.tagline, p.sortOrder, p.isFeatured ? 1 : 0, p.ctaLabel, p.seoTitle, p.seoDescription, p.status === "active" ? new Date().toISOString().replace("T", " ").slice(0, 19) : null).run();
}

const UPDATABLE = {
  productId: "product_id", name: "name", billingPeriod: "billing_period", priceCents: "price_cents", currency: "currency", trialDays: "trial_days",
  description: "description", tagline: "tagline", sortOrder: "sort_order", isFeatured: "is_featured", ctaLabel: "cta_label", seoTitle: "seo_title", seoDescription: "seo_description"
};
export async function updatePlanFields(env, planId, fields) {
  const sets = [], vals = [];
  for (const [k, col] of Object.entries(UPDATABLE)) {
    if (k in fields) { sets.push(`${col} = ?`); vals.push(k === "isFeatured" ? (fields[k] ? 1 : 0) : fields[k]); }
  }
  if (!sets.length) return 0;
  sets.push("updated_at = CURRENT_TIMESTAMP");
  const r = await env.LUMMET_DB.prepare(`UPDATE plans SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, planId).run();
  return r.meta?.changes || 0;
}

/** Sets status; the first publish also stamps published_at. */
export async function setPlanStatus(env, planId, status) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE plans SET status = ?, updated_at = CURRENT_TIMESTAMP,
            published_at = CASE WHEN ? = 'active' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END
      WHERE id = ?`
  ).bind(status, status, planId).run();
  return r.meta?.changes || 0;
}

export async function setFeatured(env, planId, featured) {
  const r = await env.LUMMET_DB.prepare(`UPDATE plans SET is_featured = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(featured ? 1 : 0, planId).run();
  return r.meta?.changes || 0;
}

/** At most one recommended plan per product family and billing period: featuring a plan un-features its siblings. */
export async function clearFeaturedSiblings(env, planId) {
  await env.LUMMET_DB.prepare(
    `UPDATE plans SET is_featured = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id != ? AND is_featured = 1
        AND product_id = (SELECT product_id FROM plans WHERE id = ?)
        AND billing_period = (SELECT billing_period FROM plans WHERE id = ?)`
  ).bind(planId, planId, planId).run();
}

export async function setTrialDays(env, planId, days) {
  const r = await env.LUMMET_DB.prepare(`UPDATE plans SET trial_days = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(days, planId).run();
  return r.meta?.changes || 0;
}

/** What blocks a hard delete. */
export async function deleteBlockers(env, planId) {
  const subs = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM subscriptions WHERE plan_id = ?`).bind(planId).first())?.n || 0;
  const prices = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM plan_prices WHERE plan_id = ?`).bind(planId).first())?.n || 0;
  const intents = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM plan_change_intents WHERE from_plan_id = ? OR to_plan_id = ?`).bind(planId, planId).first())?.n || 0;
  const crypto = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM crypto_checkouts WHERE plan_id = ?`).bind(planId).first())?.n || 0;
  return { subscriptions: Number(subs), prices: Number(prices), intents: Number(intents), checkouts: Number(crypto) };
}

export async function deletePlan(env, planId) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM plans WHERE id = ?`).bind(planId).run();
  return r.meta?.changes || 0;
}

// ---- entitlements ----
export async function listEntitlements(env, planId) {
  return (await env.LUMMET_DB.prepare(`SELECT key, value_type, value FROM plan_entitlements WHERE plan_id = ? ORDER BY key`).bind(planId).all()).results || [];
}
/** Replaces the whole set atomically. */
export async function replaceEntitlements(env, planId, rows) {
  const db = env.LUMMET_DB;
  await db.batch([
    db.prepare(`DELETE FROM plan_entitlements WHERE plan_id = ?`).bind(planId),
    ...rows.map((r) => db.prepare(`INSERT INTO plan_entitlements (plan_id, key, value_type, value) VALUES (?, ?, ?, ?)`).bind(planId, r.key, r.valueType, String(r.value))),
    db.prepare(`UPDATE plans SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(planId)
  ]);
}

// ---- marketing feature lines ----
export async function listFeatures(env, planId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, label, included, highlight, sort_order FROM plan_features WHERE plan_id = ? ORDER BY sort_order, id`).bind(planId).all()).results || [];
}
export async function replaceFeatures(env, planId, rows) {
  const db = env.LUMMET_DB;
  await db.batch([
    db.prepare(`DELETE FROM plan_features WHERE plan_id = ?`).bind(planId),
    ...rows.map((r, i) => db.prepare(`INSERT INTO plan_features (plan_id, label, included, highlight, sort_order) VALUES (?, ?, ?, ?, ?)`).bind(planId, r.label, r.included ? 1 : 0, r.highlight ? 1 : 0, i)),
    db.prepare(`UPDATE plans SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(planId)
  ]);
}

// ---- labels ----
export async function listLabels(env) {
  return (await env.LUMMET_DB.prepare(
    `SELECT l.id, l.key, l.name, l.color, (SELECT COUNT(*) FROM plan_label_links k WHERE k.label_id = l.id) AS plan_count FROM plan_labels l ORDER BY l.name COLLATE NOCASE`).all()).results || [];
}
export async function getLabel(env, id) {
  return env.LUMMET_DB.prepare(`SELECT id, key, name, color FROM plan_labels WHERE id = ?`).bind(id).first();
}
export async function getLabelByKey(env, key) {
  return env.LUMMET_DB.prepare(`SELECT id FROM plan_labels WHERE key = ?`).bind(key).first();
}
export async function insertLabel(env, { id, key, name, color }) {
  await env.LUMMET_DB.prepare(`INSERT INTO plan_labels (id, key, name, color) VALUES (?, ?, ?, ?)`).bind(id, key, name, color).run();
}
export async function updateLabel(env, id, { name, color }) {
  const sets = [], vals = [];
  if (name !== undefined) { sets.push("name = ?"); vals.push(name); }
  if (color !== undefined) { sets.push("color = ?"); vals.push(color); }
  if (!sets.length) return;
  await env.LUMMET_DB.prepare(`UPDATE plan_labels SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
}
export async function deleteLabel(env, id) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM plan_labels WHERE id = ?`).bind(id).run();
  return r.meta?.changes || 0;
}
/** Labels for many plans in one query: Map(planId -> [{id,key,name,color}]). */
export async function labelsForPlans(env, planIds) {
  const map = new Map();
  if (!planIds.length) return map;
  const marks = planIds.map(() => "?").join(",");
  const rows = (await env.LUMMET_DB.prepare(
    `SELECT k.plan_id, l.id, l.key, l.name, l.color FROM plan_label_links k JOIN plan_labels l ON l.id = k.label_id
      WHERE k.plan_id IN (${marks}) ORDER BY l.name COLLATE NOCASE`).bind(...planIds).all()).results || [];
  for (const r of rows) { if (!map.has(r.plan_id)) map.set(r.plan_id, []); map.get(r.plan_id).push({ id: r.id, key: r.key, name: r.name, color: r.color }); }
  return map;
}
export async function setPlanLabels(env, planId, labelIds) {
  const db = env.LUMMET_DB;
  await db.batch([
    db.prepare(`DELETE FROM plan_label_links WHERE plan_id = ?`).bind(planId),
    ...labelIds.map((id) => db.prepare(`INSERT OR IGNORE INTO plan_label_links (plan_id, label_id) VALUES (?, ?)`).bind(planId, id)),
    db.prepare(`UPDATE plans SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(planId)
  ]);
}
export async function addPlanLabel(env, planId, labelId) {
  const r = await env.LUMMET_DB.prepare(`INSERT OR IGNORE INTO plan_label_links (plan_id, label_id) VALUES (?, ?)`).bind(planId, labelId).run();
  return r.meta?.changes || 0;
}
export async function removePlanLabel(env, planId, labelId) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM plan_label_links WHERE plan_id = ? AND label_id = ?`).bind(planId, labelId).run();
  return r.meta?.changes || 0;
}

// ---- promotions ----
export async function listPromotions(env, planId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT pp.id, pp.plan_id, pp.name, pp.badge_text, pp.coupon_id, pp.starts_at, pp.ends_at, pp.status, pp.created_at,
            c.code AS coupon_code, c.percent_off, c.amount_off_cents, c.status AS coupon_status, c.expires_at AS coupon_expires_at
       FROM plan_promotions pp LEFT JOIN coupons c ON c.id = pp.coupon_id WHERE pp.plan_id = ? ORDER BY pp.created_at DESC, pp.rowid DESC`).bind(planId).all()).results || [];
}
export async function getPromotion(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM plan_promotions WHERE id = ?`).bind(id).first();
}
export async function insertPromotion(env, p) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO plan_promotions (id, plan_id, name, badge_text, coupon_id, starts_at, ends_at, status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(p.id, p.planId, p.name, p.badgeText, p.couponId, p.startsAt, p.endsAt, p.status).run();
}
export async function updatePromotion(env, id, p) {
  await env.LUMMET_DB.prepare(
    `UPDATE plan_promotions SET name = ?, badge_text = ?, coupon_id = ?, starts_at = ?, ends_at = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(p.name, p.badgeText, p.couponId, p.startsAt, p.endsAt, p.status, id).run();
}
export async function deletePromotion(env, id) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM plan_promotions WHERE id = ?`).bind(id).run();
  return r.meta?.changes || 0;
}
export async function listCouponChoices(env) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, code, percent_off, amount_off_cents, status, expires_at FROM coupons WHERE organization_id IS NULL ORDER BY created_at DESC LIMIT 200`).all()).results || [];
}
export async function getCoupon(env, id) {
  return env.LUMMET_DB.prepare(`SELECT id, code, organization_id, status FROM coupons WHERE id = ?`).bind(id).first();
}

// ---- prices (read only here) ----
export async function listPriceVersions(env, planId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, currency, interval, unit_amount_cents, tax_behavior, stripe_price_id, lookup_key, stripe_mode, version, active, created_at
       FROM plan_prices WHERE plan_id = ? ORDER BY interval, version DESC`).bind(planId).all()).results || [];
}

/** Copies feature lines, entitlements and labels from one plan to another (duplicate). */
export async function copyPlanDetails(env, fromId, toId) {
  const db = env.LUMMET_DB;
  await db.batch([
    db.prepare(`INSERT INTO plan_entitlements (plan_id, key, value_type, value) SELECT ?, key, value_type, value FROM plan_entitlements WHERE plan_id = ?`).bind(toId, fromId),
    db.prepare(`INSERT INTO plan_features (plan_id, label, included, highlight, sort_order) SELECT ?, label, included, highlight, sort_order FROM plan_features WHERE plan_id = ?`).bind(toId, fromId),
    db.prepare(`INSERT OR IGNORE INTO plan_label_links (plan_id, label_id) SELECT ?, label_id FROM plan_label_links WHERE plan_id = ?`).bind(toId, fromId)
  ]);
}
