// =====================================================
// PUBLIC SITE — DATA ACCESS
// Every query here is READ-ONLY and filtered to published/active
// rows, so a draft can never be reached from a public route. Nothing
// is invented: if a query returns no rows the caller renders nothing.
// =====================================================


const db = (env) => env.LUMMET_DB;

// -----------------------------------------------------
// RESILIENT READS (2.6.1.4)
// A cold homepage render used to issue ~19 separate D1 queries, and ONE transient error (network connection lost, DB
// overloaded, a replica catching up) failed the whole page; the router could only retry the entire render once. Two
// changes make that survivable:
//   1. every public READ is retried on its own (up to 3 attempts, short jittered back-off, per-attempt time limit), so a
//      brief hiccup costs milliseconds instead of a 503. Writes never go through these helpers.
//   2. the shared layout and the homepage read their rows through ONE db.batch() each (one round trip, one point of
//      failure) instead of a dozen parallel queries.
// A deterministic error (missing table or column, bad SQL) is not retried: retrying cannot fix it.
// -----------------------------------------------------

const NON_TRANSIENT = /no such (table|column)|syntax error|incomplete input|SQLITE_(ERROR|CONSTRAINT|MISMATCH)|constraint failed|too many (sql )?variables/i;
const READ_ATTEMPTS = 3;
const READ_TIMEOUT_MS = 4000;
const READ_BACKOFF_MS = [60, 180];

export function isTransientDbError(err) {
  return !NON_TRANSIENT.test(String((err && err.message) || err || ""));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`D1 read timed out after ${ms}ms (${label})`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export async function readWithRetry(label, run, { attempts = READ_ATTEMPTS, timeoutMs = READ_TIMEOUT_MS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(Promise.resolve().then(run), timeoutMs, label);
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt === attempts) break;
      console.error(`public-site read retry ${attempt}/${attempts - 1} (${label}):`, err?.message || err);
      await sleep((READ_BACKOFF_MS[attempt - 1] || 200) + Math.floor(Math.random() * 40));
    }
  }
  throw lastErr;
}

async function all(env, sql, ...binds) {
  return readWithRetry(sql.slice(0, 60).replace(/\s+/g, " "), async () => {
    const res = await db(env).prepare(sql).bind(...binds).all();
    return res.results || [];
  });
}

async function first(env, sql, ...binds) {
  return readWithRetry(sql.slice(0, 60).replace(/\s+/g, " "), async () => (await db(env).prepare(sql).bind(...binds).first()) || null);
}

/** Several SELECTs in one D1 round trip. stmts: [{ sql, binds }] -> an array of row arrays, in the same order. */
async function readBatch(env, label, stmts) {
  return readWithRetry(`batch:${label}`, async () => {
    const prepared = stmts.map((s) => db(env).prepare(s.sql).bind(...(s.binds || [])));
    const res = await db(env).batch(prepared);
    if (!Array.isArray(res) || res.length !== stmts.length) throw new Error(`D1 batch returned ${Array.isArray(res) ? res.length : "no"} results for ${stmts.length} statements`);
    return res.map((r) => (r && r.results) || []);
  });
}

// Same query as cms.js's listActiveAdsForPlacement. Repeated here because a repository
// must not depend on a business module (test/sql-boundary.test.js).
function activeAdsQuery(placement) {
  const nowIso = new Date().toISOString().slice(0, 10);
  return {
    sql: `SELECT * FROM lummet_advertisements
     WHERE placement = ? AND status = 'active'
       AND (start_date IS NULL OR start_date <= ?)
       AND (end_date IS NULL OR end_date >= ?)
     ORDER BY sort_order`,
    binds: [placement, nowIso, nowIso]
  };
}

async function listActiveAdsForPlacement(env, placement) {
  const q = activeAdsQuery(placement);
  return all(env, q.sql, ...q.binds);
}

// ---- Site-wide ---------------------------------------

const SQL_SETTINGS = `SELECT key, value FROM lummet_site_settings`;
const SQL_NAV = `SELECT placement, label, href, visible_when FROM lummet_nav_links
     WHERE status = 'published' ORDER BY placement, sort_order, id`;
const SQL_COUNTS = `SELECT
       (SELECT COUNT(*) FROM lummet_brands WHERE status = 'published') AS brands,
       (SELECT COUNT(*) FROM lummet_updates WHERE status = 'published') AS updates,
       (SELECT COUNT(*) FROM lummet_publications WHERE status = 'published') AS publications,
       (SELECT COUNT(*) FROM lummet_partners WHERE status = 'published') AS partners,
       (SELECT COUNT(*) FROM lummet_faqs WHERE status = 'published') AS faqs,
       (SELECT MAX(COALESCE(published_at, created_at)) FROM lummet_updates WHERE status = 'published') AS latest_update`;
const SQL_PAGE_SLUGS = `SELECT slug FROM lummet_pages WHERE status = 'published'`;
const SQL_FORM_KEYS = `SELECT form_key FROM lummet_forms WHERE status = 'published'`;
const SQL_ANCHORS = `SELECT section_key, kind, cta_href FROM lummet_homepage_sections
     WHERE status = 'published' AND section_key IS NOT NULL`;
const SQL_UI = `SELECT ui_key, value FROM lummet_ui_strings`;

const shapeSettings = (rows) => { const out = {}; for (const r of rows) out[r.key] = r.value; return out; };
const shapeUi = (rows) => { const out = {}; for (const r of rows) out[r.ui_key] = r.value; return out; };
function shapeCounts(row, pages, forms) {
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

export async function getSettings(env) {
  return shapeSettings(await all(env, SQL_SETTINGS));
}

export async function getNavLinks(env) {
  return all(env, SQL_NAV);
}

/** Counts + the set of published page slugs: drives nav visibility and the stats section. */
export async function getSiteCounts(env) {
  const [row, pages, forms] = await Promise.all([first(env, SQL_COUNTS), all(env, SQL_PAGE_SLUGS), all(env, SQL_FORM_KEYS)]);
  return shapeCounts(row, pages, forms);
}

/** Published homepage sections (key, kind, cta target): used to hide nav links to anchors that are not on the page. */
export function listHomepageAnchors(env) {
  return all(env, SQL_ANCHORS);
}

/**
 * Everything the shared layout needs on EVERY public page (settings, nav, counts, anchors, interface strings), in ONE D1
 * round trip. Replaces seven separate reads.
 */
export async function loadSiteData(env) {
  const [settings, nav, counts, pages, forms, anchors, ui] = await readBatch(env, "site", [
    { sql: SQL_SETTINGS }, { sql: SQL_NAV }, { sql: SQL_COUNTS }, { sql: SQL_PAGE_SLUGS }, { sql: SQL_FORM_KEYS }, { sql: SQL_ANCHORS }, { sql: SQL_UI }
  ]);
  return { settings: shapeSettings(settings), links: nav, counts: shapeCounts(counts[0], pages, forms), anchorRows: anchors, ui: shapeUi(ui) };
}

// ---- Interface text ------------------------------------

/** Every interface string (button labels, aria labels, empty states, form errors) as { key: value }. */
export async function getUiStrings(env) {
  return shapeUi(await all(env, SQL_UI));
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

function updatesQuery({ limit = 10, offset = 0, excludeSlug = null } = {}) {
  return {
    sql: `${UPDATE_SELECT} ${excludeSlug ? "AND u.slug != ?" : ""}
     ORDER BY COALESCE(u.published_at, u.created_at) DESC, u.id DESC LIMIT ? OFFSET ?`,
    binds: [...(excludeSlug ? [excludeSlug] : []), limit, offset]
  };
}

export function listUpdates(env, opts = {}) {
  const q = updatesQuery(opts);
  return all(env, q.sql, ...q.binds);
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

function publicationsQuery({ type = null, limit = 9, offset = 0, excludeSlug = null } = {}) {
  const clauses = [];
  const binds = [];
  if (type) { clauses.push("AND p.publication_type = ?"); binds.push(type); }
  if (excludeSlug) { clauses.push("AND p.slug != ?"); binds.push(excludeSlug); }
  return {
    sql: `${PUB_SELECT} ${clauses.join(" ")}
     ORDER BY COALESCE(p.published_at, p.created_at) DESC, p.id DESC LIMIT ? OFFSET ?`,
    binds: [...binds, limit, offset]
  };
}

export function listPublications(env, opts = {}) {
  const q = publicationsQuery(opts);
  return all(env, q.sql, ...q.binds);
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

// ---- Homepage (batched) --------------------------------

const SQL_HOME_SECTIONS = `SELECT * FROM lummet_homepage_sections WHERE status = 'published' ORDER BY sort_order, id`;
const SQL_HOME_FEATURES = `SELECT * FROM lummet_features WHERE status = 'published' ORDER BY group_key, sort_order, id`;
const SQL_HOME_FAQS = `SELECT * FROM lummet_faqs WHERE status = 'published' ORDER BY group_key, sort_order, id`;
const SQL_BRANDS = `SELECT * FROM lummet_brands WHERE status = 'published' ORDER BY sort_order, name LIMIT ?`;

/** The homepage's primary rows (sections, features, FAQs, brands) in one round trip. Strict: the page cannot render without them. */
export async function loadHomePrimary(env, { brandLimit = 12 } = {}) {
  const [rows, features, faqs, brands] = await readBatch(env, "home-primary", [
    { sql: SQL_HOME_SECTIONS }, { sql: SQL_HOME_FEATURES }, { sql: SQL_HOME_FAQS }, { sql: SQL_BRANDS, binds: [brandLimit] }
  ]);
  return { rows, features, faqs, brands };
}

/** The homepage's optional rows (latest updates, insights, partners, banner) in one round trip. The caller treats a failure as "leave those sections out". */
export async function loadHomeSecondary(env) {
  const u = updatesQuery({ limit: 3 });
  const p = publicationsQuery({ limit: 3 });
  const ad = activeAdsQuery("homepage_banner");
  const [updates, publications, partners, ads] = await readBatch(env, "home-secondary", [
    u, p, { sql: `SELECT * FROM lummet_partners WHERE status = 'published' ORDER BY sort_order, name LIMIT ?`, binds: [8] }, ad
  ]);
  return { updates, publications, partners, banner: ads[0] || null };
}
