// =====================================================
// TENANT DATA ACCESS (shared low-level reads)
// Split out from registry.js so client.js can read tenant
// rows and active credentials without importing registry.js
// (which itself will route its connection tests through
// client.js) — avoids a circular import between the two.
// =====================================================

export async function getTenant(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM tenants WHERE id = ?`)
    .bind(id)
    .first();
}

export async function getTenantByHost(env, host) {
  return env.LUMMET_DB.prepare(`SELECT * FROM tenants WHERE host = ?`)
    .bind(host)
    .first();
}

export async function getActiveCredential(env, tenantId) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM tenant_api_credentials WHERE tenant_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`
  )
    .bind(tenantId)
    .first();
}
