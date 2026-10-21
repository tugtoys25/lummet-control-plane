// Delegated root domains (domain_zones) and the hostnames served through them. All SQL for the nameserver custom
// domain flow lives here (worker/zone-domains.js holds the logic and has no SQL of its own).

const json = (v) => JSON.stringify(Array.isArray(v) ? v : []);
const parse = (s) => { try { const v = JSON.parse(s || "[]"); return Array.isArray(v) ? v : []; } catch (_) { return []; } };

/** A row as the service and the views use it: JSON columns parsed. */
export function hydrate(row) {
  if (!row) return null;
  return { ...row, name_servers: parse(row.name_servers), detected_name_servers: row.detected_name_servers == null ? null : parse(row.detected_name_servers) };
}

export async function getZone(env, id) {
  return hydrate(await env.LUMMET_DB.prepare(`SELECT * FROM domain_zones WHERE id = ?`).bind(id).first());
}

export async function findLiveByName(env, zoneName) {
  return hydrate(await env.LUMMET_DB.prepare(`SELECT * FROM domain_zones WHERE zone_name = ? AND status NOT IN ('removed','expired')`).bind(zoneName).first());
}

export async function findByProviderZoneId(env, providerZoneId) {
  return hydrate(await env.LUMMET_DB.prepare(`SELECT * FROM domain_zones WHERE provider_zone_id = ? AND status NOT IN ('removed','expired')`).bind(providerZoneId).first());
}

export async function listForSite(env, siteId) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM domain_zones WHERE site_id = ? AND status != 'removed' ORDER BY created_at, id`).bind(siteId).all();
  return r.results.map(hydrate);
}

export async function listForOrganization(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT z.* FROM domain_zones z JOIN sites s ON s.id = z.site_id WHERE s.organization_id = ? AND z.status != 'removed' ORDER BY z.created_at, z.id`
  ).bind(organizationId).all();
  return r.results.map(hydrate);
}

export async function insertZone(env, { id, siteId, zoneName, providerZoneId, nameServers, expiresAt, createdBy, nextCheckAt }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO domain_zones (id, site_id, zone_name, provider_zone_id, name_servers, expires_at, created_by, next_check_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, siteId, zoneName, providerZoneId, json(nameServers), expiresAt, createdBy || null, nextCheckAt || null).run();
}

/** Only the listed columns can change, so a typo in the service cannot touch anything else. */
const ZONE_COLUMNS = new Set([
  "provider_zone_id", "status", "name_servers", "detected_name_servers", "nameservers_detected_at", "last_checked_at", "next_check_at",
  "check_count", "last_activation_check_at", "activated_at", "failure_reason", "expires_at", "reminder_sent_at", "removed_at"
]);
export async function updateZone(env, id, fields) {
  const keys = Object.keys(fields).filter((k) => ZONE_COLUMNS.has(k));
  if (!keys.length) return;
  const values = keys.map((k) => (k === "name_servers" || k === "detected_name_servers") ? json(fields[k]) : fields[k]);
  await env.LUMMET_DB.prepare(`UPDATE domain_zones SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...values, id).run();
}

export async function addEvent(env, zoneId, kind, detail, { actorType = "system", actorId = null } = {}) {
  await env.LUMMET_DB.prepare(`INSERT INTO domain_zone_events (zone_id, kind, detail, actor_type, actor_id) VALUES (?, ?, ?, ?, ?)`)
    .bind(zoneId, kind, detail ? String(detail).slice(0, 300) : null, actorType, actorId).run();
}

export async function listEvents(env, zoneId, limit = 30) {
  return (await env.LUMMET_DB.prepare(`SELECT kind, detail, actor_type, created_at FROM domain_zone_events WHERE zone_id = ? ORDER BY id DESC LIMIT ?`).bind(zoneId, limit).all()).results;
}

/** Zones the maintenance sweep should look at now: pending and due, plus active ones with hostnames still in progress. */
export async function listDueForSweep(env, { nowIso, limit = 10 }) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT * FROM domain_zones
      WHERE (status = 'pending' AND (next_check_at IS NULL OR next_check_at <= ?))
         OR (status = 'active' AND EXISTS (SELECT 1 FROM domains d WHERE d.zone_id = domain_zones.id AND d.status IN ('dns_verified','ssl_pending','awaiting_nameservers') AND (domain_zones.next_check_at IS NULL OR domain_zones.next_check_at <= ?)))
      ORDER BY COALESCE(next_check_at, created_at) LIMIT ?`
  ).bind(nowIso, nowIso, limit).all();
  return r.results.map(hydrate);
}

// ---- hostnames served through a zone (rows of `domains`) ----

export async function insertZoneHostname(env, { id, siteId, hostname, zoneId, token, status = "awaiting_nameservers" }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO domains (id, site_id, hostname, verification_token, status, verification_method, method, zone_id) VALUES (?, ?, ?, ?, ?, 'NS', 'nameservers', ?)`
  ).bind(id, siteId, hostname, token, status, zoneId).run();
}

// ---- single subdomains kept at the customer's own DNS (method 'cname') ----

export async function insertCnameHostname(env, { id, siteId, hostname, token, instructions, expiresAt, nextCheckAt }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO domains (id, site_id, hostname, verification_token, status, verification_method, method, dns_instructions, expires_at, next_check_at)
     VALUES (?, ?, ?, ?, 'pending', 'TXT', 'cname', ?, ?, ?)`
  ).bind(id, siteId, hostname, token, JSON.stringify(instructions || []), expiresAt, nextCheckAt).run();
}

export async function getDomain(env, id) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM domains WHERE id = ?`).bind(id).first();
  return hydrateDomain(row);
}

export function hydrateDomain(row) {
  if (!row) return null;
  let instructions = [];
  try { const v = JSON.parse(row.dns_instructions || "[]"); if (Array.isArray(v)) instructions = v; } catch (_) { /* keep [] */ }
  return { ...row, dns_instructions: instructions };
}

export async function listCnameForSite(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM domains WHERE site_id = ? AND method = 'cname' AND status != 'removed' ORDER BY created_at, id`).bind(siteId).all()).results.map(hydrateDomain);
}

export async function listDueCname(env, { nowIso, limit = 10 }) {
  return (await env.LUMMET_DB.prepare(
    `SELECT * FROM domains WHERE method = 'cname' AND status IN ('pending','dns_verified','ssl_pending') AND (next_check_at IS NULL OR next_check_at <= ?)
      ORDER BY COALESCE(next_check_at, created_at) LIMIT ?`
  ).bind(nowIso, limit).all()).results.map(hydrateDomain);
}

export async function listDomainEvents(env, domainId, limit = 20) {
  return (await env.LUMMET_DB.prepare(`SELECT to_status AS kind, reason AS detail, actor_type, created_at FROM domain_events WHERE domain_id = ? ORDER BY id DESC LIMIT ?`).bind(domainId, limit).all()).results;
}

/** Live zone that contains this hostname (the hostname itself or any parent). Longest match wins. */
export async function findZoneContaining(env, hostname) {
  const labels = String(hostname).split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const zone = await findLiveByName(env, labels.slice(i).join("."));
    if (zone) return zone;
  }
  return null;
}

/** Cname-method rows with a Worker route, whatever their status (erasure marks rows removed before our cleanup runs). */
export async function listRoutesForSite(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, route_id, hostname FROM domains WHERE site_id = ? AND route_id IS NOT NULL`).bind(siteId).all()).results;
}

export async function listHostnames(env, zoneId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM domains WHERE zone_id = ? AND status != 'removed' ORDER BY length(hostname), hostname`).bind(zoneId).all()).results;
}

const DOMAIN_COLUMNS = new Set([
  "status", "ssl_status", "ssl_resource_id", "custom_domain_id", "dns_verified_at", "ssl_verified_at", "failure_reason", "removed_at", "is_primary",
  "route_id", "dns_instructions", "cname_seen_at", "next_check_at", "last_checked_at", "check_count", "expires_at", "reminder_sent_at"
]);
export async function updateHostname(env, id, fields) {
  const keys = Object.keys(fields).filter((k) => DOMAIN_COLUMNS.has(k));
  if (!keys.length) return;
  await env.LUMMET_DB.prepare(`UPDATE domains SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).bind(...keys.map((k) => fields[k]), id).run();
}

export async function hostnameInUse(env, hostname) {
  return !!(await env.LUMMET_DB.prepare(`SELECT 1 AS x FROM domains WHERE hostname = ? AND status != 'removed'`).bind(hostname).first());
}

export async function addHostnameEvent(env, { domainId, fromStatus, toStatus, reason, actorType = "system", actorId = null }) {
  await env.LUMMET_DB.prepare(`INSERT INTO domain_events (domain_id, from_status, to_status, reason, actor_type, actor_id) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(domainId, fromStatus || null, toStatus, reason || null, actorType, actorId).run();
}

export async function getSite(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT id, organization_id, name, status, primary_domain, tenant_id, slug FROM sites WHERE id = ?`).bind(siteId).first();
}

export async function setSitePrimaryDomain(env, siteId, hostname) {
  await env.LUMMET_DB.prepare(`UPDATE domains SET is_primary = 0 WHERE site_id = ?`).bind(siteId).run();
  await env.LUMMET_DB.prepare(`UPDATE domains SET is_primary = 1 WHERE site_id = ? AND hostname = ? AND status = 'active'`).bind(siteId, hostname).run();
  await env.LUMMET_DB.prepare(`UPDATE sites SET primary_domain = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(hostname, siteId).run();
}

export async function hasPrimaryCustomDomain(env, siteId) {
  return !!(await env.LUMMET_DB.prepare(`SELECT 1 AS x FROM domains WHERE site_id = ? AND is_primary = 1 AND status = 'active'`).bind(siteId).first());
}

/** Distinct "domains" an organization uses against domains.custom.max: a zone with apex + www counts once. */
export async function countCustomDomains(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(DISTINCT COALESCE(d.zone_id, d.id)) AS c FROM domains d JOIN sites s ON s.id = d.site_id WHERE s.organization_id = ? AND d.status != 'removed'`
  ).bind(organizationId).first();
  return row?.c || 0;
}

export async function ownerEmails(env, organizationId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT u.email FROM organization_users ou JOIN customer_users u ON u.id = ou.user_id WHERE ou.organization_id = ? AND ou.role IN ('owner','admin') AND u.status = 'active'`
  ).bind(organizationId).all()).results.map((r) => r.email);
}

export async function countByStatus(env) {
  return (await env.LUMMET_DB.prepare(`SELECT status, COUNT(*) AS n FROM domain_zones GROUP BY status`).all()).results;
}

/** Zones for the staff screen, with the owning site and organization. */
export async function listAllForStaff(env, { status = "", limit = 100, offset = 0 } = {}) {
  return (await env.LUMMET_DB.prepare(
    `SELECT z.id, z.zone_name, z.status, z.name_servers, z.nameservers_detected_at, z.last_checked_at, z.check_count, z.activated_at, z.failure_reason, z.expires_at, z.created_at,
            s.id AS site_id, s.name AS site, o.id AS organization_id, o.name AS organization
       FROM domain_zones z JOIN sites s ON s.id = z.site_id JOIN organizations o ON o.id = s.organization_id
      WHERE (? = '' OR z.status = ?) ORDER BY z.created_at DESC, z.id LIMIT ? OFFSET ?`
  ).bind(status, status, Math.min(Math.max(Number(limit) || 100, 1), 500), Math.min(Math.max(Math.floor(Number(offset)) || 0, 0), 500000)).all()).results;
}

/** Zones of a site that are not removed, for cleanup when a site/organization is deleted. */
export async function listCleanupForSite(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, provider_zone_id, zone_name FROM domain_zones WHERE site_id = ? AND status != 'removed'`).bind(siteId).all()).results;
}
export async function listCustomDomainsForSite(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, custom_domain_id, hostname FROM domains WHERE site_id = ? AND custom_domain_id IS NOT NULL AND status != 'removed'`).bind(siteId).all()).results;
}
