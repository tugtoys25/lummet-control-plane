// Customer API key rows (v7I). All SQL for customer_api_keys, and the site-ownership check used when scoping a key to a site.

export async function siteBelongsToOrganization(env, siteId, organizationId) {
  const row = await env.LUMMET_DB.prepare(`SELECT id FROM sites WHERE id = ? AND organization_id = ?`).bind(siteId, organizationId).first();
  return !!row;
}

export async function insert(env, { id, organizationId, siteId, name, prefix, keyHash, scopes, createdBy, expiresAt }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_api_keys (id, organization_id, site_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, organizationId, siteId || null, name, prefix, keyHash, JSON.stringify(scopes), createdBy || null, expiresAt || null).run();
}

export async function listForOrganization(env, organizationId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT id, site_id, name, key_prefix, scopes, status, created_at, last_used_at, expires_at
     FROM customer_api_keys WHERE organization_id = ? ORDER BY created_at DESC`
  ).bind(organizationId).all();
  return result.results || [];
}

export async function existsInOrganization(env, keyId, organizationId) {
  const row = await env.LUMMET_DB.prepare(`SELECT id FROM customer_api_keys WHERE id = ? AND organization_id = ?`).bind(keyId, organizationId).first();
  return !!row;
}

export async function markRevoked(env, keyId) {
  await env.LUMMET_DB.prepare(`UPDATE customer_api_keys SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(keyId).run();
}

export async function findByHash(env, keyHash) {
  return env.LUMMET_DB.prepare(`SELECT * FROM customer_api_keys WHERE key_hash = ?`).bind(keyHash).first();
}

export async function touchLastUsed(env, keyId) {
  await env.LUMMET_DB.prepare(`UPDATE customer_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(keyId).run();
}
