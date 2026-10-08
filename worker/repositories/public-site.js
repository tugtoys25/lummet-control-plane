// =====================================================
// PUBLIC SITE — DATA ACCESS
// Every query here is READ-ONLY and filtered to published/active
// rows, so a draft can never be reached from a public route. Nothing
// is invented: if a query returns no rows the caller renders nothing.
// =====================================================


const db = (env) => env.LUMMET_DB;

async function all(env, sql, ...binds) {
  const res = await db(env).prepare(sql).bind(...binds).all();
  return res.results || [];
}

async function first(env, sql, ...binds) {
  return (await db(env).prepare(sql).bind(...binds).first()) || null;
}

// Same query as cms.js's listActiveAdsForPlacement. Repeated here because a repository
// must not depend on a business module (test/sql-boundary.test.js).
async function listActiveAdsForPlacement(env, placement) {
  const nowIso = new Date().toISOString().slice(0, 10);
  return all(
    env,
    `SELECT * FROM lummet_advertisements
     WHERE placement = ? AND status = 'active'
       AND (start_date IS NULL OR start_date <= ?)
       AND (end_date IS NULL OR end_date >= ?)
     ORDER BY sort_order`,
    placement, nowIso, nowIso
  );
}

// ---- Site-wide ---------------------------------------

export async function getSettings(env) {
  const rows = await all(env, `SELECT key, value FROM lummet_site_settings`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

export async function getNavLinks(env) {
  return all(
    env,
    `SELECT placement, label, href, visible_when FROM lummet_nav_links
     WHERE status = 'published' ORDER BY placement, sort_order, id`
  );
}

/** Counts + the set of published page slugs: drives nav visibility and the stats section. */
export async function getSiteCounts(env) {
  const row = await first(
    env,
    `SELECT
       (SELECT COUNT(*) FROM lummet_brands WHERE status = 'published') AS brands,
       (SELECT COUNT(*) FROM lummet_updates WHERE status = 'published') AS updates,
       (SELECT COUNT(*) FROM lummet_publications WHERE status = 'published') AS publications,
       (SELECT COUNT(*) FROM lummet_partners WHERE status = 'published') AS partners,
       (SELECT COUNT(*) FROM lummet_faqs WHERE status = 'published') AS faqs,
       (SELECT MAX(COALESCE(published_at, created_at)) FROM lummet_updates WHERE status = 'published') AS latest_update`
  );
  const pages = await all(env, `SELECT slug FROM lummet_pages WHERE status = 'published'`);
  const forms = await all(env, `SELECT form_key FROM lummet_forms WHERE status = 'published'`);
  return {
    brands: row?.brands || 0,
    updates: row?.updates || 0,
    publications: row?.publications || 0,
    partners: row?.partners || 0,
    faqs: row?.faqs || 0,
    latestUpdate: row?.latest_update || null,
    pageSlugs: new Set(pages.map((p) => p.slug)),
    formKeys: new Set(forms.map((f) => f.form_key))
  };
}

/** Published homepage sections (key, kind, cta target): used to hide nav links to anchors that are not on the page. */
export function listHomepageAnchors(env) {
  return all(
    env,
    `SELECT section_key, kind, cta_href FROM lummet_homepage_sections
     WHERE status = 'published' AND section_key IS NOT NULL`
  );
}

// ---- Interface text ------------------------------------

/** Every interface string (button labels, aria labels, empty states, form errors) as { key: value }. */
export async function getUiStrings(env) {
  const rows = await all(env, `SELECT ui_key, value FROM lummet_ui_strings`);
  const out = {};
  for (const r of rows) out[r.ui_key] = r.value;
  return out;
}

// ---- Forms (contact, demo, ...) --------------------------

export function getForm(env, key) {
  return first(env, `SELECT * FROM lummet_forms WHERE form_key = ? AND status = 'published'`, key);
}

export function listFormFields(env, key) {
  return all(
    env,
    `SELECT * FROM lummet_form_fields WHERE form_key = ? AND status = 'published' ORDER BY sort_order, id`,
    key
  );
}

export function listPublishedForms(env) {
  return all(env, `SELECT form_key, updated_at FROM lummet_forms WHERE status = 'published' ORDER BY form_key`);
}

export async function countRecentInquiriesByIp(env, ipHash, sinceIso) {
  const row = await first(
    env,
    `SELECT COUNT(*) AS n FROM lummet_inquiries WHERE ip_hash = ? AND created_at >= ?`,
    ipHash || "",
    sinceIso
  );
  return row?.n || 0;
}

export async function insertInquiry(env, row) {
  const res = await db(env)
    .prepare(
      `INSERT INTO lummet_inquiries (form_key, name, email, summary, details, payload, status, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?) RETURNING id`
    )
    .bind(row.form_key, row.name, row.email, row.summary, row.details, row.payload, row.ip_hash || "")
    .first();
  return res?.id ?? null;
}

// ---- Brands ------------------------------------------

export function listBrands(env, limit = 100) {
  return all(
    env,
    `SELECT * FROM lummet_brands WHERE status = 'published' ORDER BY sort_order, name LIMIT ?`,
    limit
  );
}

export function getBrand(env, slug) {
  return first(env, `SELECT * FROM lummet_brands WHERE slug = ? AND status = 'published'`, slug);
}

// ---- Updates -----------------------------------------

const UPDATE_SELECT = `
  SELECT u.*, a.name AS author_name, a.slug AS author_slug
  FROM lummet_updates u
  LEFT JOIN lummet_authors a ON a.id = u.author_id
  WHERE u.status = 'published'`;

export function listUpdates(env, { limit = 10, offset = 0, excludeSlug = null } = {}) {
  return all(
    env,
    `${UPDATE_SELECT} ${excludeSlug ? "AND u.slug != ?" : ""}
     ORDER BY COALESCE(u.published_at, u.created_at) DESC, u.id DESC LIMIT ? OFFSET ?`,
    ...(excludeSlug ? [excludeSlug] : []),
    limit,
    offset
  );
}

export async function countUpdates(env) {
  return (await first(env, `SELECT COUNT(*) AS n FROM lummet_updates WHERE status = 'published'`))?.n || 0;
}

export function getUpdate(env, slug) {
  return first(env, `${UPDATE_SELECT} AND u.slug = ?`, slug);
}

// ---- Publications (Insights) --------------------------

const PUB_SELECT = `
  SELECT p.*, a.name AS author_name, a.slug AS author_slug
  FROM lummet_publications p
  LEFT JOIN lummet_authors a ON a.id = p.author_id
  WHERE p.status = 'published'`;

export function listPublications(env, { type = null, limit = 9, offset = 0, excludeSlug = null } = {}) {
  const clauses = [];
  const binds = [];
  if (type) { clauses.push("AND p.publication_type = ?"); binds.push(type); }
  if (excludeSlug) { clauses.push("AND p.slug != ?"); binds.push(excludeSlug); }
  return all(
    env,
    `${PUB_SELECT} ${clauses.join(" ")}
     ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC LIMIT ? OFFSET ?`,
    ...binds,
    limit,
    offset
  );
}

export async function countPublications(env, type = null) {
  const row = type
    ? await first(env, `SELECT COUNT(*) AS n FROM lummet_publications WHERE status = 'published' AND publication_type = ?`, type)
    : await first(env, `SELECT COUNT(*) AS n FROM lummet_publications WHERE status = 'published'`);
  return row?.n || 0;
}

export async function listPublicationTypes(env) {
  return all(
    env,
    `SELECT publication_type AS type, COUNT(*) AS n FROM lummet_publications
     WHERE status = 'published' GROUP BY publication_type ORDER BY publication_type`
  );
}

export function getPublication(env, slug) {
  return first(env, `${PUB_SELECT} AND p.slug = ?`, slug);
}

// ---- Partners, pages, authors -------------------------

export function listPartners(env, limit = 100) {
  return all(env, `SELECT * FROM lummet_partners WHERE status = 'published' ORDER BY sort_order, name LIMIT ?`, limit);
}

export function getPage(env, slug) {
  return first(
    env,
    `SELECT p.*, a.name AS author_name, a.slug AS author_slug
     FROM lummet_pages p LEFT JOIN lummet_authors a ON a.id = p.author_id
     WHERE p.slug = ? AND p.status = 'published'`,
    slug
  );
}

export function listPublishedPages(env) {
  return all(env, `SELECT slug, updated_at FROM lummet_pages WHERE status = 'published' ORDER BY slug`);
}

export function getAuthor(env, slug) {
  return first(env, `SELECT * FROM lummet_authors WHERE slug = ?`, slug);
}

export async function listAuthorWork(env, authorId) {
  const [updates, publications] = await Promise.all([
    all(env, `${UPDATE_SELECT} AND u.author_id = ? ORDER BY COALESCE(u.published_at, u.created_at) DESC LIMIT 50`, authorId),
    all(env, `${PUB_SELECT} AND p.author_id = ? ORDER BY COALESCE(p.published_at, p.created_at) DESC LIMIT 50`, authorId)
  ]);
  return { updates, publications };
}

export function listAuthorsWithPublishedWork(env) {
  return all(
    env,
    `SELECT slug, updated_at FROM lummet_authors a
     WHERE EXISTS (SELECT 1 FROM lummet_updates u WHERE u.author_id = a.id AND u.status = 'published')
        OR EXISTS (SELECT 1 FROM lummet_publications p WHERE p.author_id = a.id AND p.status = 'published')
     ORDER BY slug`
  );
}

// ---- Homepage building blocks -------------------------

export function listHomepageSections(env) {
  return all(
    env,
    `SELECT * FROM lummet_homepage_sections WHERE status = 'published' ORDER BY sort_order, id`
  );
}

export function listFeatures(env) {
  return all(
    env,
    `SELECT * FROM lummet_features WHERE status = 'published' ORDER BY group_key, sort_order, id`
  );
}

export function listFaqs(env) {
  return all(
    env,
    `SELECT * FROM lummet_faqs WHERE status = 'published' ORDER BY group_key, sort_order, id`
  );
}

export async function getBannerAd(env) {
  const ads = await listActiveAdsForPlacement(env, "homepage_banner");
  return ads[0] || null;
}
