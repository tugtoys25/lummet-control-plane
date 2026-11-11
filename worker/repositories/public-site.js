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
// Only brands staff have published (new live sites start as drafts until an admin publishes them).
// SELECT * so a database that has not run migration 0082 yet still serves the site: the strip just uses defaults.
const SQL_BRAND_STRIP = `SELECT * FROM lummet_brands WHERE status = 'published' ORDER BY sort_order, name LIMIT 40`;
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
  const [settings, nav, counts, pages, forms, anchors, ui, strip] = await readBatch(env, "site", [
    { sql: SQL_SETTINGS }, { sql: SQL_NAV }, { sql: SQL_COUNTS }, { sql: SQL_PAGE_SLUGS }, { sql: SQL_FORM_KEYS }, { sql: SQL_ANCHORS }, { sql: SQL_UI }, { sql: SQL_BRAND_STRIP }
  ]);
  return { settings: shapeSettings(settings), links: nav, counts: shapeCounts(counts[0], pages, forms), anchorRows: anchors, ui: shapeUi(ui), brandRows: strip || [] };
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
      `INSERT INTO lummet_inquiries (form_key, name, email, summary, details, payload, status, ip_hash, subject_ref, source)
       VALUES (?, ?, ?, ?, ?, ?, 'new', ?, ?, ?) RETURNING id`
    )
    .bind(row.form_key, row.name, row.email, row.summary, row.details, row.payload, row.ip_hash || "", row.subject_ref || null, row.source || null)
    .first();
  return res?.id ?? null;
}

// ---- Domain aftermarket -------------------------------

export function getAftermarketDomain(env, domain) {
  return first(env, `SELECT * FROM lummet_aftermarket_domains WHERE domain = ?`, String(domain || ""));
}

export function getListedAftermarketDomain(env, domain) {
  return first(env, `SELECT * FROM lummet_aftermarket_domains WHERE domain = ? AND status = 'listed'`, String(domain || ""));
}

export function getHostedAftermarketDomain(env, domain) {
  return first(env, `SELECT * FROM lummet_aftermarket_domains WHERE domain = ? AND status = 'listed' AND hosted = 1`, String(domain || ""));
}

export function listAftermarketDomains(env, limit = 200) {
  return all(env, `SELECT * FROM lummet_aftermarket_domains WHERE status = 'listed' ORDER BY sort_order, domain LIMIT ?`, limit);
}

/**
 * Seller claim: a new row, or a fresh token on an unverified/removed seller row. Never touches an admin row or a listed one.
 * A listing owned by an organization can only be re-claimed by that organization; an anonymous (email) claim can be taken over by
 * a signed-in seller, never the other way round.
 */
export async function upsertAftermarketClaim(env, { domain, email, price, description, token, organizationId = null, userId = null }) {
  const existing = await db(env).prepare(`SELECT id, status, source, organization_id FROM lummet_aftermarket_domains WHERE domain = ?`).bind(domain).first();
  if (!existing) {
    await db(env)
      .prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, description, asking_price, source, owner_email, verify_token, organization_id, owner_user_id) VALUES (?, 'pending', ?, ?, 'seller', ?, ?, ?, ?)`)
      .bind(domain, description || null, price || null, email || null, token, organizationId, userId).run();
    return true;
  }
  if (existing.source !== "seller" || !["pending", "unlisted"].includes(existing.status)) return false;
  if (existing.organization_id && existing.organization_id !== organizationId) return false;
  await db(env)
    .prepare(`UPDATE lummet_aftermarket_domains SET status = 'pending', description = ?, asking_price = ?, owner_email = ?, verify_token = ?, hosted = 0, verified_method = NULL, verified_at = NULL,
              organization_id = COALESCE(?, organization_id), owner_user_id = COALESCE(?, owner_user_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(description || null, price || null, email || null, token, organizationId, userId, existing.id).run();
  return true;
}

const ZONE_COLUMNS = new Set(["cf_zone_id", "ns_assigned", "ns_detected_at", "activation_asked_at", "zone_expires_at", "next_check_at", "status", "hosted", "verified_method", "verified_at"]);

/** Zone bookkeeping for a seller's nameserver verification. Only the listed columns can be written. */
export async function patchAftermarketZone(env, id, patch) {
  const keys = Object.keys(patch).filter((k) => ZONE_COLUMNS.has(k));
  if (!keys.length) return;
  await db(env)
    .prepare(`UPDATE lummet_aftermarket_domains SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), id).run();
}

export async function countOpenAftermarketZones(env) {
  const row = await db(env).prepare(`SELECT COUNT(*) AS n FROM lummet_aftermarket_domains WHERE cf_zone_id IS NOT NULL AND status = 'pending'`).first();
  return row?.n || 0;
}

/** Pending claims with a zone that are due a check (or have expired). */
export async function listAftermarketZonesDue(env, nowIso, limit = 10) {
  const res = await db(env)
    .prepare(`SELECT * FROM lummet_aftermarket_domains WHERE cf_zone_id IS NOT NULL AND status = 'pending' AND (next_check_at IS NULL OR next_check_at <= ?) ORDER BY next_check_at LIMIT ?`)
    .bind(nowIso, limit).all();
  return res.results || [];
}

/** Zones whose domain is no longer pending or listed (unlisted, sold, back to draft): to be deleted at Cloudflare. */
export async function listAftermarketZonesToRelease(env, limit = 10) {
  const res = await db(env)
    .prepare(`SELECT * FROM lummet_aftermarket_domains WHERE cf_zone_id IS NOT NULL AND status IN ('unlisted', 'sold', 'draft') LIMIT ?`)
    .bind(limit).all();
  return res.results || [];
}

// ---- Seller portal (organization-scoped) ----

/** An organization's domains that have a Cloudflare zone (deleted first when the organization is erased). */
export async function listAftermarketZonesForOrg(env, organizationId) {
  const res = await db(env).prepare(`SELECT id, cf_zone_id FROM lummet_aftermarket_domains WHERE organization_id = ? AND cf_zone_id IS NOT NULL`).bind(organizationId).all();
  return res.results || [];
}


export async function listAftermarketForOrg(env, organizationId) {
  const res = await db(env)
    .prepare(`SELECT d.*, (SELECT COUNT(*) FROM lummet_inquiries i WHERE i.subject_ref = d.domain AND i.form_key = 'domain-acquisition') AS enquiry_count,
                     (SELECT MAX(i.created_at) FROM lummet_inquiries i WHERE i.subject_ref = d.domain AND i.form_key = 'domain-acquisition') AS last_enquiry_at
              FROM lummet_aftermarket_domains d WHERE d.organization_id = ? ORDER BY d.id DESC`)
    .bind(organizationId).all();
  return res.results || [];
}

export function getAftermarketForOrg(env, organizationId, domain) {
  return first(env, `SELECT * FROM lummet_aftermarket_domains WHERE domain = ? AND organization_id = ?`, String(domain || ""), organizationId);
}

/** What a seller may see of an enquiry: when, the offer text and where it came from. Buyer contact details stay with Lummet. */
export function listEnquiriesForDomain(env, domain, limit = 50) {
  return all(env, `SELECT id, created_at, summary, source, status FROM lummet_inquiries WHERE subject_ref = ? AND form_key = 'domain-acquisition' ORDER BY id DESC LIMIT ?`, String(domain || ""), limit);
}

const LISTING_COLUMNS = new Set(["headline", "description", "asking_price", "status"]);

export async function updateAftermarketListing(env, id, patch) {
  const keys = Object.keys(patch).filter((k) => LISTING_COLUMNS.has(k));
  if (!keys.length) return;
  await db(env)
    .prepare(`UPDATE lummet_aftermarket_domains SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(...keys.map((k) => patch[k] ?? null), id).run();
}

export async function touchAftermarketCheck(env, id) {
  await db(env).prepare(`UPDATE lummet_aftermarket_domains SET last_check_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
}

export async function markAftermarketVerified(env, id, method) {
  await db(env)
    .prepare(`UPDATE lummet_aftermarket_domains SET status = 'listed', verified_method = ?, hosted = ?, verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`)
    .bind(method, method === "ns" ? 1 : 0, id).run();
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
