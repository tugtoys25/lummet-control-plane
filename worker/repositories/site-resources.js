// Per-site provisioned resources (route, worker, d1, kv, r2) and the tenant's Super API credential.
// (Repository: all SQL for these lookups used by deployments and site bindings.)

export async function findActiveResource(env, siteId, type) {
  return env.LUMMET_DB.prepare(
    `SELECT resource_id, resource_name, metadata FROM site_resources WHERE site_id = ? AND resource_type = ? AND status = 'active'`
  ).bind(siteId, type).first();
}

/** Remembers the site's single route; a redeploy that replaced it reactivates the row. */
export async function saveRoute(env, { siteId, provider, routeId, pattern, zoneId }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name, metadata)
     VALUES (?, ?, 'route', ?, ?, ?)
     ON CONFLICT(site_id, resource_type) DO UPDATE SET resource_id = excluded.resource_id, resource_name = excluded.resource_name, metadata = excluded.metadata, status = 'active', deleted_at = NULL`
  ).bind(siteId, provider, routeId, pattern, zoneId ? JSON.stringify({ zoneId }) : null).run();
}

/** The zone a recorded route lives in. Rows written before platform domains have no zone id: null = the default zone. */
export function routeZoneId(row) {
  try { return (row?.metadata ? JSON.parse(row.metadata).zoneId : null) || null; } catch (_) { return null; }
}

export async function findActiveCredential(env, tenantId) {
  return env.LUMMET_DB.prepare(
    `SELECT credential_id, encrypted_secret, secret_iv FROM tenant_api_credentials WHERE tenant_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
  ).bind(tenantId).first();
}
