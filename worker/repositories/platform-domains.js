// Platform domains (migration 0085). All SQL for the feature lives here; worker/platform-domains.js holds the logic.

const bool = (v) => (v ? 1 : 0);

export function hydrate(row) {
  if (!row) return null;
  let check = null;
  try { check = row.last_check_json ? JSON.parse(row.last_check_json) : null; } catch (_) { check = null; }
  return { ...row, is_default: !!row.is_default, allow_customer_choice: !!row.allow_customer_choice, last_check: check };
}

export async function list(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM platform_domains ORDER BY sort_order, hostname`).all();
  return r.results.map(hydrate);
}

export async function get(env, id) {
  return hydrate(await env.LUMMET_DB.prepare(`SELECT * FROM platform_domains WHERE id = ?`).bind(id).first());
}

export async function getByHostname(env, hostname) {
  return hydrate(await env.LUMMET_DB.prepare(`SELECT * FROM platform_domains WHERE hostname = ?`).bind(hostname).first());
}

export async function getDefault(env) {
  return hydrate(await env.LUMMET_DB.prepare(`SELECT * FROM platform_domains WHERE is_default = 1 LIMIT 1`).first());
}

export async function count(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM platform_domains`).first();
  return Number(r?.n || 0);
}

/** ON CONFLICT(hostname) DO NOTHING: two requests racing on first use cannot both create the bootstrap row, but a second default still throws. */
export async function insert(env, d) {
  const res = await env.LUMMET_DB.prepare(
    `INSERT INTO platform_domains
       (id, hostname, label, cf_zone_id, cname_target, status, is_default, allow_customer_choice, entitlement_key, sort_order, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(hostname) DO NOTHING`
  ).bind(d.id, d.hostname, d.label, d.cfZoneId || null, d.cnameTarget || null, d.status || "pending", bool(d.isDefault), d.allowCustomerChoice === false ? 0 : 1, d.entitlementKey || null, d.sortOrder || 0, d.createdBy || null).run();
  return (res?.meta?.changes ?? 1) > 0;
}

const COLUMNS = { label: "label", cfZoneId: "cf_zone_id", cnameTarget: "cname_target", status: "status", allowCustomerChoice: "allow_customer_choice", entitlementKey: "entitlement_key", sortOrder: "sort_order" };

/** Updates only the named fields (allow-listed column names, values bound). */
export async function update(env, id, fields) {
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(COLUMNS)) {
    if (!(k in fields)) continue;
    sets.push(`${col} = ?`);
    vals.push(k === "allowCustomerChoice" ? bool(fields[k]) : fields[k] ?? null);
  }
  if (!sets.length) return;
  await env.LUMMET_DB.prepare(`UPDATE platform_domains SET ${sets.join(", ")}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...vals, id).run();
}

export async function saveCheck(env, id, result) {
  await env.LUMMET_DB.prepare(`UPDATE platform_domains SET last_check_at = CURRENT_TIMESTAMP, last_check_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(JSON.stringify(result), id).run();
}

/** Atomic switch: the old default is cleared and the new one set in one batch, so the one-default index never trips. */
export async function setDefault(env, id) {
  await env.LUMMET_DB.batch([
    // Sites with no stored domain mean "the default they were created under": pin them to the OLD default first, so a
    // new default never silently changes the host of an existing site.
    env.LUMMET_DB.prepare(`UPDATE sites SET platform_domain_id = (SELECT id FROM platform_domains WHERE is_default = 1 AND id != ?) WHERE platform_domain_id IS NULL AND EXISTS (SELECT 1 FROM platform_domains WHERE is_default = 1 AND id != ?)`).bind(id, id),
    env.LUMMET_DB.prepare(`UPDATE platform_domains SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE is_default = 1 AND id != ?`).bind(id),
    env.LUMMET_DB.prepare(`UPDATE platform_domains SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id)
  ]);
}

export async function setSortOrders(env, orderedIds) {
  await env.LUMMET_DB.batch(orderedIds.map((id, i) => env.LUMMET_DB.prepare(`UPDATE platform_domains SET sort_order = ? WHERE id = ?`).bind(i, id)));
}

export async function remove(env, id) {
  await env.LUMMET_DB.prepare(`DELETE FROM platform_domains WHERE id = ? AND is_default = 0`).bind(id).run();
}

/** Sites on a domain. A site with a NULL platform_domain_id counts for the default domain. */
export async function siteCountsByStatus(env, domainId, { isDefault }) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT status, COUNT(*) AS n FROM sites WHERE platform_domain_id = ? ${isDefault ? "OR platform_domain_id IS NULL" : ""} GROUP BY status`
  ).bind(domainId).all();
  return Object.fromEntries(r.results.map((x) => [x.status, Number(x.n)]));
}

export async function setSiteDomain(env, siteId, domainId) {
  await env.LUMMET_DB.prepare(`UPDATE sites SET platform_domain_id = ? WHERE id = ?`).bind(domainId, siteId).run();
}

export async function getSite(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT id, slug, host_label, status, primary_domain, platform_domain_id, organization_id FROM sites WHERE id = ?`).bind(siteId).first();
}

/** Sites on a domain (a NULL platform_domain_id counts for the default domain). Newest first, capped. */
export async function listSites(env, domainId, { isDefault, limit = 100 }) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT s.id, s.name, s.slug, s.status, s.primary_domain, o.name AS organization_name
       FROM sites s LEFT JOIN organizations o ON o.id = s.organization_id
      WHERE s.platform_domain_id = ? ${isDefault ? "OR s.platform_domain_id IS NULL" : ""}
      ORDER BY s.created_at DESC LIMIT ?`
  ).bind(domainId, Math.min(500, Math.max(1, limit))).all();
  return r.results;
}
