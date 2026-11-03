// =====================================================
// BRAND PROFILES — DATA ACCESS (lummet_brands)
// Used by the "Powered by Lummet" listing (site-brands.js) and the dashboard brand band (brand-band.js).
// Plain data in, plain data out; no business rules here. Imports nothing (repositories never depend on business modules).
// =====================================================

const db = (env) => env.LUMMET_DB;

/** Brand rows for the dashboard band. SELECT * so a database without the accent/strip columns still works. */
export async function listForBand(env, { includeDrafts = false, limit = 48 } = {}) {
  const where = includeDrafts ? "" : "WHERE status = 'published'";
  const result = await db(env).prepare(
    `SELECT * FROM lummet_brands ${where} ORDER BY (status = 'published') DESC, sort_order, name LIMIT ${Math.max(1, Math.floor(limit))}`
  ).all();
  return result.results || [];
}

export function slugTaken(env, slug) {
  return db(env).prepare(`SELECT 1 AS x FROM lummet_brands WHERE slug = ?`).bind(slug).first().then(Boolean);
}

export function getSiteForBrand(env, siteId) {
  return db(env).prepare(
    `SELECT id, organization_id, tenant_id, name, slug, status, primary_domain FROM sites WHERE id = ?`
  ).bind(siteId).first();
}

export function hidesLummetBranding(env, organizationId) {
  return db(env).prepare(`SELECT hide_lummet_branding FROM organization_branding WHERE organization_id = ?`).bind(organizationId).first()
    .then((row) => Boolean(row && Number(row.hide_lummet_branding) === 1));
}

export function findBySite(env, siteId) {
  return db(env).prepare(`SELECT id, status, auto_hidden, website_url FROM lummet_brands WHERE site_id = ?`).bind(siteId).first();
}

/** INSERT OR IGNORE: returns the number of rows written (0 when a unique index already has this site or tenant). */
export async function insertSiteBrand(env, { tenantId, name, slug, category, tagline, websiteUrl, siteId }) {
  const res = await db(env).prepare(
    `INSERT OR IGNORE INTO lummet_brands (tenant_id, name, slug, tagline, category, website_url, status, sort_order, source, site_id)
     VALUES (?, ?, ?, ?, ?, ?, 'published', 100, 'site', ?)`
  ).bind(tenantId || null, name, slug, tagline, category, websiteUrl, siteId).run();
  return res?.meta && typeof res.meta.changes === "number" ? res.meta.changes : 1;
}

export async function republish(env, id, { tenantId, websiteUrl }) {
  await db(env).prepare(
    `UPDATE lummet_brands SET status = 'published', auto_hidden = 0, tenant_id = COALESCE(?, tenant_id), website_url = COALESCE(website_url, ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(tenantId || null, websiteUrl, id).run();
}

export async function fillWebsiteUrl(env, id, websiteUrl) {
  await db(env).prepare(
    `UPDATE lummet_brands SET website_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND (website_url IS NULL OR website_url = '')`
  ).bind(websiteUrl, id).run();
}

export async function autoHide(env, id) {
  await db(env).prepare(`UPDATE lummet_brands SET status = 'draft', auto_hidden = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
}
