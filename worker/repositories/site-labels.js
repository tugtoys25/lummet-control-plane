// SQL for site address labels (worker/site-labels.js holds the rules). Plain data in, plain data out.

/** Labels among `labels` held by a site that is not deleted on one platform domain. A NULL host_label falls back to the slug. */
export async function heldLabels(env, { labels, domainId, includeNull, excludeSiteId }) {
  const ph = labels.map(() => "?").join(",");
  const domainSql = domainId ? (includeNull ? "(platform_domain_id = ? OR platform_domain_id IS NULL)" : "platform_domain_id = ?") : "platform_domain_id IS NULL";
  let sql = `SELECT COALESCE(host_label, slug) AS label FROM sites WHERE (host_label IN (${ph}) OR (host_label IS NULL AND slug IN (${ph}))) AND status != 'deleted' AND ${domainSql}`;
  const binds = [...labels, ...labels, ...(domainId ? [domainId] : [])];
  if (excludeSiteId) { sql += " AND id != ?"; binds.push(excludeSiteId); }
  return ((await env.LUMMET_DB.prepare(sql).bind(...binds).all()).results || []).map((r) => r.label);
}

/** Old addresses (full hostnames) still redirecting: { old_host, site_id }. */
export async function liveRedirects(env, hosts, nowIso) {
  const ph = hosts.map(() => "?").join(",");
  return (await env.LUMMET_DB.prepare(`SELECT old_host, site_id FROM site_host_redirects WHERE old_host IN (${ph}) AND expires_at > ?`).bind(...hosts, nowIso).all()).results || [];
}
