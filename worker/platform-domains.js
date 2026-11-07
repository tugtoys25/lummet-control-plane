// Platform domains: the one place that knows which domains a site can run on. Replaces direct reads of
// PLATFORM_DOMAIN_SUFFIX / CF_ZONE_ID elsewhere. SQL lives in repositories/platform-domains.js.
// env.PLATFORM_DOMAIN_SUFFIX and env.CF_ZONE_ID are only the bootstrap fallback: once a default row exists the table wins.
import * as repo from "./repositories/platform-domains.js";
import { requireEntitlement } from "./entitlements.js";

export const FALLBACK_SUFFIX = "sites.lummet.app";
const HOST_RE = /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const normalizeHostname = (v) => String(v ?? "").trim().toLowerCase().replace(/^\*?\.?/, "").replace(/\.$/, "");
export const isValidHostname = (v) => HOST_RE.test(normalizeHostname(v));

/** <slug>.<domain>. `domain` is a row ({ hostname }) or a bare hostname string. */
export function hostFor(site, domain) {
  const hostname = typeof domain === "string" ? domain : domain?.hostname;
  return `${site.slug}.${normalizeHostname(hostname)}`;
}

/** The env-derived row used before any table row exists (and by sync callers/tests with no database). */
export function envFallbackDomain(env) {
  const hostname = normalizeHostname(env?.PLATFORM_DOMAIN_SUFFIX) || FALLBACK_SUFFIX;
  return { id: null, hostname, label: hostname, cf_zone_id: env?.CF_ZONE_ID || null, status: "active", is_default: true, allow_customer_choice: true, entitlement_key: null, sort_order: 0, bootstrap: true };
}

/** Creates the default row from env on first use. A no-op when any row exists (the table wins over env). */
export async function ensureBootstrap(env) {
  if (!env?.LUMMET_DB) return null;
  if ((await repo.count(env)) > 0) return repo.getDefault(env);
  const d = envFallbackDomain(env);
  await repo.insert(env, { id: crypto.randomUUID(), hostname: d.hostname, label: d.label, cfZoneId: d.cf_zone_id, status: "active", isDefault: true, createdBy: "system:bootstrap" });
  return repo.getDefault(env);
}

export async function listDomains(env) {
  await ensureBootstrap(env);
  return repo.list(env);
}

export async function getDefaultDomain(env) {
  return (await ensureBootstrap(env)) || envFallbackDomain(env);
}

/** A site with no platform_domain_id (every site made before this feature) runs on the default domain. */
export async function getDomainForSite(env, site) {
  if (site?.platform_domain_id) {
    const d = await repo.get(env, site.platform_domain_id);
    if (d) return d;
  }
  return getDefaultDomain(env);
}

/** Domains an organisation may pick when creating a site: active, customer choice on, entitlement (if any) satisfied. */
export async function listChoosableDomains(env, { organizationId } = {}) {
  const out = [];
  for (const d of await listDomains(env)) {
    if (d.status !== "active" || !d.allow_customer_choice) continue;
    if (d.entitlement_key && !(organizationId && await requireEntitlement(env, organizationId, d.entitlement_key))) continue;
    out.push(d);
  }
  return out;
}

/** Every hostname a customer may never claim: all rows in any status (disabled included), or the env value before bootstrap. */
export async function reservedHostnames(env) {
  const rows = env?.LUMMET_DB ? await listDomains(env) : [];
  const names = new Set(rows.map((d) => d.hostname));
  names.add(normalizeHostname(env?.PLATFORM_DOMAIN_SUFFIX) || FALLBACK_SUFFIX);
  return [...names];
}

/** The Cloudflare zone a domain's routes live in. No domain, or no zone recorded, means the default zone. */
export function zoneIdFor(env, domain) {
  return domain?.cf_zone_id || env?.CF_ZONE_ID || null;
}

/**
 * What a customer gets when they do not choose: the platform default if customers may pick it, otherwise the first
 * domain they may pick, otherwise the platform default. Also what the create-site screen preselects.
 */
export async function defaultForCustomer(env, { organizationId } = {}) {
  const choosable = await listChoosableDomains(env, { organizationId });
  const def = await getDefaultDomain(env);
  return choosable.find((d) => d.id && d.id === def.id) || choosable[0] || def;
}

/** The list the create-site screen shows: only what this organisation may choose, the one that applies by default flagged. */
export async function customerDomainOptions(env, { organizationId } = {}) {
  const choosable = await listChoosableDomains(env, { organizationId });
  const applied = await defaultForCustomer(env, { organizationId });
  const list = choosable.length ? choosable : [applied];
  return list.map((d) => ({ id: d.id, label: d.label, hostname: d.hostname, isDefault: d.id === applied.id }));
}

/** Validates a customer's choice. Omitted -> their default. Returns { ok, domain } or { ok: false, error: "invalid_platform_domain" }. */
export async function resolveCustomerChoice(env, { organizationId, platformDomainId } = {}) {
  if (platformDomainId === undefined || platformDomainId === null || platformDomainId === "") return { ok: true, domain: await defaultForCustomer(env, { organizationId }) };
  const choosable = await listChoosableDomains(env, { organizationId });
  const hit = choosable.find((d) => d.id === String(platformDomainId));
  return hit ? { ok: true, domain: hit } : { ok: false, error: "invalid_platform_domain" };
}

/** { [siteId]: "<slug>.<domain>" } for a list of sites, reading the domain table once. NULL means the default. */
export async function hostsForSites(env, sites) {
  const rows = await listDomains(env);
  const byId = new Map(rows.map((d) => [d.id, d]));
  const def = rows.find((d) => d.is_default) || envFallbackDomain(env);
  const out = {};
  for (const s of sites) out[s.id] = hostFor(s, byId.get(s.platform_domain_id) || def);
  return out;
}
