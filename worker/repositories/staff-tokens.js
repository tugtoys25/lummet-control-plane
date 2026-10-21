// Staff API tokens (machine credentials for CI). (Repository: all SQL for staff_api_tokens lives here.)

export async function insert(env, { id, name, prefix, hash, scopes, createdBy, expiresAt }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO staff_api_tokens (id, name, token_prefix, token_hash, scopes, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, name, prefix, hash, JSON.stringify(scopes), createdBy || null, expiresAt || null).run();
}

export async function findByHash(env, hash) {
  return env.LUMMET_DB.prepare(`SELECT * FROM staff_api_tokens WHERE token_hash = ?`).bind(hash).first();
}

/** At most once a minute, so a script uploading hundreds of files does not write a row per request. */
export async function touchLastUsed(env, id) {
  await env.LUMMET_DB.prepare(
    `UPDATE staff_api_tokens SET last_used_at = CURRENT_TIMESTAMP
      WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))`
  ).bind(id).run();
}

export async function list(env) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, name, token_prefix, scopes, status, created_by, created_at, expires_at, last_used_at, revoked_at
       FROM staff_api_tokens ORDER BY created_at DESC, rowid DESC LIMIT 100`
  ).all();
  return r.results || [];
}

export async function getById(env, id) {
  return env.LUMMET_DB.prepare(`SELECT id, name, token_prefix, status FROM staff_api_tokens WHERE id = ?`).bind(id).first();
}

/** Returns true when an ACTIVE token was revoked by this call. */
export async function markRevoked(env, id) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE staff_api_tokens SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'active'`
  ).bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}
