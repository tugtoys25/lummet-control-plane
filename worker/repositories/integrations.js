// Storage for chat integrations (Slack, Discord, Teams, Telegram). The destination is already encrypted when it gets here.
export async function list(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM integrations WHERE organization_id = ? ORDER BY created_at DESC`).bind(organizationId).all();
  return r.results || [];
}
export async function listActive(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM integrations WHERE organization_id = ? AND status = 'active'`).bind(organizationId).all();
  return r.results || [];
}
export async function count(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM integrations WHERE organization_id = ?`).bind(organizationId).first();
  return r?.n || 0;
}
export async function get(env, organizationId, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM integrations WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first();
}
export async function insert(env, { id, organizationId, provider, name, encryptedSecret, secretIv, targetHint, eventTypes, createdBy }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO integrations (id, organization_id, provider, name, encrypted_secret, secret_iv, target_hint, event_types, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, organizationId, provider, name, encryptedSecret, secretIv, targetHint, eventTypes, createdBy || null).run();
}
export async function remove(env, id) {
  await env.LUMMET_DB.prepare(`DELETE FROM integrations WHERE id = ?`).bind(id).run();
}
export async function update(env, id, { status, eventTypes, name }) {
  await env.LUMMET_DB.prepare(`UPDATE integrations SET status = ?, event_types = ?, name = ? WHERE id = ?`).bind(status, eventTypes, name, id).run();
}
export async function recordOutcome(env, id, { ok, error }) {
  await env.LUMMET_DB.prepare(
    `UPDATE integrations SET last_status = ?, last_error = ?, last_sent_at = CURRENT_TIMESTAMP, sent_count = sent_count + ?, failure_count = failure_count + ? WHERE id = ?`
  ).bind(ok ? "ok" : "failed", ok ? null : error, ok ? 1 : 0, ok ? 0 : 1, id).run();
}
