// Per-site provisioned resources (route, worker, d1, kv, r2) and the tenant's Super API credential.
// (Repository: all SQL for these lookups used by deployments and site bindings.)

export async function findActiveResource(env, siteId, type) {
  return env.LUMMET_DB.prepare(
    `SELECT resource_id, resource_name FROM site_resources WHERE site_id = ? AND resource_type = ? AND status = 'active'`
  ).bind(siteId, type).first();
}

/** Remembers the site's single route; a redeploy that replaced it reactivates the row. */
export async function saveRoute(env, { siteId, provider, routeId, pattern }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name)
     VALUES (?, ?, 'route', ?, ?)
     ON CONFLICT(site_id, resource_type) DO UPDATE SET resource_id = excluded.resource_id, resource_name = excluded.resource_name, status = 'active', deleted_at = NULL`
  ).bind(siteId, provider, routeId, pattern).run();
}

export async function findActiveCredential(env, tenantId) {
  return env.LUMMET_DB.prepare(
    `SELECT credential_id, encrypted_secret, secret_iv FROM tenant_api_credentials WHERE tenant_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`
  ).bind(tenantId).first();
}
