// Site address labels: the <label> in <label>.<platform domain>.
//
// One rule, enforced here and by a unique index (migration 0088): a label belongs to one non-deleted site per platform
// domain. The same label on another domain is a different address and stays free. A customer is NEVER given a different
// label than the one they asked for: a taken label is refused, with suggestions, and the customer picks.
//
// A label is also held while the address could still answer: a site that is being deleted, and the old address of a
// site that was moved, for as long as its redirect lives.
import { normalizeHostname } from "./platform-domains.js";
import * as repo from "./repositories/site-labels.js";

export const MIN_LABEL = 3;
export const MAX_LABEL = 40;                               // DNS allows 63; shorter keeps hostnames and Worker names sane
const LABEL_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Names that would look like the platform itself, or collide with mail/DNS conventions. Customers cannot take these.
export const RESERVED_LABELS = new Set([
  "www", "www1", "www2", "web", "app", "apps", "api", "admin", "administrator", "root", "staff", "platform", "cp", "console",
  "dashboard", "portal", "login", "signin", "signup", "register", "account", "accounts", "billing", "pay", "payments", "checkout",
  "support", "help", "status", "docs", "developer", "developers", "security", "abuse", "postmaster", "hostmaster", "webmaster",
  "mail", "email", "smtp", "imap", "pop", "pop3", "mx", "ns", "ns1", "ns2", "ns3", "dns", "ftp", "sftp", "ssh", "vpn",
  "cdn", "static", "assets", "origin", "edge", "internal", "localhost", "lummet", "sze", "sites"
]);

/** Lowercase, hyphen-separated, trimmed, capped. What a site NAME turns into when the customer did not type an address. */
export function slugifyLabel(name) {
  return String(name ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "").slice(0, MAX_LABEL).replace(/-+$/g, "");
}

/** What the customer typed, cleaned the same gentle way (case, spaces, stray dots), but never reshaped into another word. */
export function normalizeLabel(input) {
  return String(input ?? "").trim().toLowerCase().replace(/\s+/g, "-").replace(/^-+|-+$/g, "");
}

/** { ok: true } or { ok: false, reason: 'empty'|'too_short'|'too_long'|'invalid'|'reserved' } (pure, no database). */
export function validateLabel(label) {
  const l = String(label ?? "");
  if (!l) return { ok: false, reason: "empty" };
  if (l.length < MIN_LABEL) return { ok: false, reason: "too_short" };
  if (l.length > MAX_LABEL) return { ok: false, reason: "too_long" };
  if (!LABEL_RE.test(l) || l.slice(2, 4) === "--") return { ok: false, reason: "invalid" };
  if (RESERVED_LABELS.has(l)) return { ok: false, reason: "reserved" };
  return { ok: true };
}

export const REASON_TEXT = {
  empty: "Enter a site address.",
  too_short: `Use at least ${MIN_LABEL} characters.`,
  too_long: `Use at most ${MAX_LABEL} characters.`,
  invalid: "Use only lowercase letters, numbers and hyphens, and do not start or end with a hyphen.",
  reserved: "That name is reserved. Try another.",
  taken: "That address is already taken."
};

/** A domain row as the rest of the platform passes it: { id, hostname, is_default }. NULL platform_domain_id means the default. */
function domainFilter(domain) {
  const id = domain?.id || null;
  const includeNull = !id || !!domain?.is_default;
  return { id, includeNull };
}

const nowIso = () => new Date().toISOString();

/** Labels in `labels` that are NOT free on `domain`. One query for sites, one for live redirects. Never reveals who holds them. */
export async function takenLabels(env, { labels, domain, excludeSiteId = null }) {
  const list = [...new Set(labels)].filter(Boolean);
  if (!list.length) return new Set();
  const { id, includeNull } = domainFilter(domain);
  const taken = new Set(await repo.heldLabels(env, { labels: list, domainId: id, includeNull, excludeSiteId }));

  // The old address of a moved site keeps redirecting until its redirect expires; nobody else may claim it meanwhile.
  const host = normalizeHostname(domain?.hostname);
  if (host) {
    const rows = await repo.liveRedirects(env, list.map((l) => `${l}.${host}`), nowIso());
    for (const r of rows) if (!excludeSiteId || r.site_id !== excludeSiteId) taken.add(r.old_host.slice(0, r.old_host.length - host.length - 1));
  }
  return taken;
}

/** { ok, available, label, host, reason? }. `reason` is a REASON_TEXT key when not available. */
export async function checkLabel(env, { label, domain, excludeSiteId = null }) {
  const l = normalizeLabel(label);
  const host = normalizeHostname(domain?.hostname);
  const v = validateLabel(l);
  if (!v.ok) return { ok: true, available: false, label: l, host: l && host ? `${l}.${host}` : null, reason: v.reason };
  const taken = await takenLabels(env, { labels: [l], domain, excludeSiteId });
  return { ok: true, available: !taken.has(l), label: l, host: `${l}.${host}`, ...(taken.has(l) ? { reason: "taken" } : {}) };
}

/** Other words built from the one the customer wanted. Ordered by how natural they read; numbers come last, only if needed. */
export function candidateLabels(label, { year = new Date().getUTCFullYear() } = {}) {
  const base = label.replace(/-+$/g, "");
  const words = [`${base}-hub`, `${base}-online`, `${base}-pro`, `my-${base}`, `${base}-zone`, `best-${base}`, `${base}-guide`, `the-${base}`, `${base}-club`, `${base}-${year}`, `${base}-site`];
  const numbers = [`${base}-2`, `${base}-3`];
  return [...words, ...numbers].filter((c) => validateLabel(c).ok);
}

/** Up to `limit` free alternatives on this domain, plus the domains (from `otherDomains`) where the wanted label is free as asked. */
export async function suggestLabels(env, { label, domain, otherDomains = [], limit = 4, excludeSiteId = null }) {
  const l = normalizeLabel(label);
  const host = normalizeHostname(domain?.hostname);
  let suggestions = [];
  if (validateLabel(l).ok) {
    const cands = candidateLabels(l);
    const taken = await takenLabels(env, { labels: cands, domain, excludeSiteId });
    suggestions = cands.filter((c) => !taken.has(c)).slice(0, limit).map((c) => ({ label: c, host: `${c}.${host}` }));
  }
  const elsewhere = [];
  if (validateLabel(l).ok) {
    for (const d of otherDomains) {
      if (!d || (domain?.id && d.id === domain.id)) continue;
      if (!(await takenLabels(env, { labels: [l], domain: d, excludeSiteId })).has(l)) elsewhere.push({ id: d.id, label: d.label, hostname: d.hostname, host: `${l}.${normalizeHostname(d.hostname)}` });
    }
  }
  return { suggestions, otherDomains: elsewhere };
}
