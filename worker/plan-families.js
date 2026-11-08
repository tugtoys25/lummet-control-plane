// Plan families and site types (migration 0089). Pure rules for the editable parts of a product: public name, slug,
// description, order and the two visibility switches. No database access here.
//
// A product has a stable internal `id`/`key` (never shown, never changes) and an editable public `slug`. Renaming a slug
// keeps the old one in product_slug_history so links keep working (see resolveFamilySlug in repositories/plan-catalog.js).

export const RESERVED_SLUGS = new Set(["all", "new", "edit", "admin", "api", "app", "pricing", "plans", "plan", "signup", "login", "none", "null", "undefined", "default", "staff"]);
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/** "Affiliate Platform & Tools" -> "affiliate-platform-tools" (ASCII only, at most 64 characters). */
export function slugify(text) {
  return String(text ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/g, "");
}

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const flag = (v) => (v === true || v === 1 || v === "1" || v === "true" ? 1 : 0);

/**
 * Validates the editable product fields. `partial` = only the keys present are checked (an update). Returns
 * { ok: true, value } with database-ready values (snake_case) or { ok: false, status, error }.
 */
export function validateProductFields(input = {}, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  const fail = (error) => ({ ok: false, status: 422, error });
  if (!partial || has("name")) { const n = clean(input.name, 80); if (n.length < 2) return fail("invalid_name"); out.name = n; }
  if (has("publicName")) { const n = clean(input.publicName, 80); if (n && n.length < 2) return fail("invalid_public_name"); out.public_name = n || null; }
  if (has("slug")) {
    const s = slugify(input.slug);
    if (!SLUG_RE.test(s)) return fail("invalid_slug");
    if (RESERVED_SLUGS.has(s)) return fail("reserved_slug");
    out.slug = s;
  }
  if (has("description")) out.description = clean(input.description, 400) || null;
  if (has("sortOrder")) {
    const n = Number(input.sortOrder);
    if (!Number.isInteger(n) || n < -1000 || n > 1000) return fail("invalid_sort_order");
    out.sort_order = n;
  }
  if (has("showOnPricing")) out.show_on_pricing = flag(input.showOnPricing);
  if (has("showInSiteCreation")) out.show_in_site_creation = flag(input.showInSiteCreation);
  return { ok: true, value: out };
}

/** The name a visitor sees: the public name when staff set one, otherwise the internal name. */
export const displayName = (p) => (p && (p.public_name || p.name)) || "";
