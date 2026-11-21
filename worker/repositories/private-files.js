// Storage for private (non-public) files: support attachments and announcement attachments. Bytes live in R2; this holds the records.
const COLS = "id, organization_id, purpose, message_id, announcement_id, filename, mime_type, size_bytes, r2_key, uploaded_by_kind, uploaded_by, created_at";

export const insert = (env, f) => env.LUMMET_DB.prepare(
  `INSERT INTO private_files (id, organization_id, purpose, filename, mime_type, size_bytes, r2_key, uploaded_by_kind, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
).bind(f.id, f.organizationId || null, f.purpose, f.filename, f.mimeType, f.sizeBytes, f.r2Key, f.uploadedByKind, f.uploadedBy || null).run();

export const get = (env, id) => env.LUMMET_DB.prepare(`SELECT ${COLS} FROM private_files WHERE id = ?`).bind(id).first();

const marks = (n) => Array(n).fill("?").join(",");

/** Files this person uploaded for support that are not yet attached to a message. */
export async function pendingSupport(env, ids, organizationId, kind, uploadedBy) {
  if (!ids.length) return [];
  const r = await env.LUMMET_DB.prepare(
    `SELECT ${COLS} FROM private_files WHERE id IN (${marks(ids.length)}) AND purpose = 'support' AND organization_id = ? AND uploaded_by_kind = ? AND COALESCE(uploaded_by,'') = ? AND message_id IS NULL`
  ).bind(...ids, organizationId, kind, uploadedBy || "").all();
  return r.results || [];
}
export async function attachToMessage(env, ids, messageId) {
  if (!ids.length) return;
  await env.LUMMET_DB.prepare(`UPDATE private_files SET message_id = ? WHERE id IN (${marks(ids.length)}) AND message_id IS NULL`).bind(messageId, ...ids).run();
}
export async function forMessages(env, messageIds) {
  if (!messageIds.length) return [];
  const r = await env.LUMMET_DB.prepare(`SELECT id, message_id, filename, mime_type, size_bytes FROM private_files WHERE message_id IN (${marks(messageIds.length)}) ORDER BY created_at`).bind(...messageIds).all();
  return r.results || [];
}
export async function pendingAnnouncement(env, ids, staffId) {
  if (!ids.length) return [];
  const r = await env.LUMMET_DB.prepare(
    `SELECT ${COLS} FROM private_files WHERE id IN (${marks(ids.length)}) AND purpose = 'announcement' AND uploaded_by_kind = 'staff' AND COALESCE(uploaded_by,'') = ? AND announcement_id IS NULL`
  ).bind(...ids, staffId || "").all();
  return r.results || [];
}
export async function attachToAnnouncement(env, ids, announcementId) {
  if (!ids.length) return;
  await env.LUMMET_DB.prepare(`UPDATE private_files SET announcement_id = ? WHERE id IN (${marks(ids.length)}) AND announcement_id IS NULL`).bind(announcementId, ...ids).run();
}
export async function forAnnouncements(env, announcementIds) {
  if (!announcementIds.length) return [];
  const r = await env.LUMMET_DB.prepare(`SELECT id, announcement_id, filename, mime_type, size_bytes FROM private_files WHERE announcement_id IN (${marks(announcementIds.length)}) ORDER BY created_at`).bind(...announcementIds).all();
  return r.results || [];
}
/** Uploaded but never attached, older than `cutoffIso`: abandoned uploads. */
export async function orphans(env, cutoffIso, limit) {
  const r = await env.LUMMET_DB.prepare(`SELECT id, r2_key FROM private_files WHERE message_id IS NULL AND announcement_id IS NULL AND created_at < ? LIMIT ?`).bind(cutoffIso, limit).all();
  return r.results || [];
}
export const remove = (env, id) => env.LUMMET_DB.prepare(`DELETE FROM private_files WHERE id = ?`).bind(id).run();
export async function forOrganization(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(`SELECT id, r2_key FROM private_files WHERE organization_id = ?`).bind(organizationId).all();
  return r.results || [];
}
export async function countPendingFor(env, kind, uploadedBy) {
  const r = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM private_files WHERE uploaded_by_kind = ? AND COALESCE(uploaded_by,'') = ? AND message_id IS NULL AND announcement_id IS NULL`).bind(kind, uploadedBy || "").first();
  return r?.n || 0;
}

export async function keysForMessages(env, messageIds) {
  if (!messageIds.length) return [];
  const r = await env.LUMMET_DB.prepare(`SELECT id, r2_key FROM private_files WHERE message_id IN (${marks(messageIds.length)})`).bind(...messageIds).all();
  return r.results || [];
}
export async function keysForAnnouncement(env, announcementId) {
  const r = await env.LUMMET_DB.prepare(`SELECT id, r2_key FROM private_files WHERE announcement_id = ?`).bind(announcementId).all();
  return r.results || [];
}
