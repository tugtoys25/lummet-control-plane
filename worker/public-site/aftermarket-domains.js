// =====================================================
// PUBLIC SITE — DOMAIN AFTERMARKET HELPERS (pure + small reads)
// Shared by forms.js (the buy enquiry form) and aftermarket.js (list, landing and seller pages).
// =====================================================

import * as data from "./data.js";

export const BUY_FORM_KEY = "domain-acquisition";
export const SELL_FORM_KEY = "sell-domain";
export const OTHER_OPTION = "Other";

const TOKEN_PREFIX = "lummet-verify=";

/** The value a seller puts in the _lummet-verify TXT record. */
export function newVerifyToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  return TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HOST_RE = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

/** "HTTPS://WWW.Example.com/path" -> "example.com"; "" when it cannot be a domain name. */
export function normalizeDomain(input) {
  let v = String(input ?? "").trim().toLowerCase();
  if (!v) return "";
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "").replace(/^www\./, "");
  if (!HOST_RE.test(v)) return "";
  if (/^\d+(\.\d+){3}$/.test(v)) return "";          // an IPv4 address is not a domain name
  if (!/[a-z]/.test(v.split(".").pop())) return "";   // the last label (TLD) must contain a letter
  return v;
}

function hostFromUrl(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ""; }
}

/** Hosts that belong to this platform itself: they can never be listed for sale or served as a for-sale page. */
export function platformHosts(env, siteBaseUrl) {
  const hosts = new Set();
  for (const u of [siteBaseUrl, env.PORTAL_BASE_URL]) {
    const h = hostFromUrl(u);
    if (h) hosts.add(h.replace(/^www\./, ""));
  }
  return hosts;
}

export function isReservedDomain(env, domain, siteBaseUrl) {
  if (platformHosts(env, siteBaseUrl).has(domain)) return true;
  if (/\.(workers\.dev|pages\.dev)$/.test(domain)) return true;
  const suffix = String(env.PLATFORM_DOMAIN_SUFFIX || "").trim().toLowerCase();
  if (suffix && (domain === suffix || domain.endsWith(`.${suffix}`))) return true;
  return false;
}

/**
 * The domain a visitor is asking about, or null. Only a domain that is LISTED for sale is ever named on the page, so a
 * crafted ?domain= link cannot make this site say that somebody else's domain is for sale.
 *   1. ?domain=example.com  (what a redirect rule from the parked domain adds: ...?domain=${host})
 *   2. the host the request arrived on, when it is a hosted for-sale domain
 */
export async function subjectFromRequest(ctx) {
  const { env, url, siteCtx } = ctx;
  const fromQuery = normalizeDomain(url.searchParams.get("domain"));
  if (fromQuery) {
    const row = await data.getListedAftermarketDomain(env, fromQuery);
    if (row) return { row, domain: row.domain, source: "redirect" };
  }
  const host = normalizeDomain(url.hostname);
  if (host && !platformHosts(env, siteCtx?.site?.base_url).has(host)) {
    const row = await data.getHostedAftermarketDomain(env, host);
    if (row) return { row, domain: row.domain, source: "host" };
  }
  return null;
}

/** Options for the "Chosen domain" select: the subject first, then the other listed domains, then Other. */
export async function domainOptions(env, subject, { withOther = true } = {}) {
  const rows = await data.listAftermarketDomains(env, 50);
  const names = [...new Set([subject?.domain, ...rows.map((r) => r.domain)].filter(Boolean))];
  if (withOther) names.push(OTHER_OPTION);
  return names;
}

/** Replace the stored options of the buy form's `domain` select by the live list. Other fields are untouched. */
export async function withDomainOptions(env, formKey, fields, subject) {
  if (formKey !== BUY_FORM_KEY) return fields;
  const hasOther = fields.some((f) => f.field_key === "domain_other");
  const options = (await domainOptions(env, subject, { withOther: hasOther })).join("\n");
  return fields.map((f) => (f.field_key === "domain" && f.type === "select" ? { ...f, options } : f));
}
