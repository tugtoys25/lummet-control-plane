// Storage for announcements, their email recipients and read marks, plus the audience queries.
export const MAX_RECIPIENTS = 5000;
const ACTIVE = `u.status = 'active'`;

/** People an audience rule reaches. kind: all | user | organization | site | billing. */
export async function resolveAudience(env, kind, ref) {
  const db = env.LUMMET_DB; let r;
  if (kind === "all") r = await db.prepare(`SELECT u.id, u.email FROM customer_users u WHERE ${ACTIVE} ORDER BY u.created_at LIMIT ?`).bind(MAX_RECIPIENTS + 1).all();
  else if (kind === "user") r = await db.prepare(`SELECT u.id, u.email FROM customer_users u WHERE ${ACTIVE} AND u.id = ?`).bind(ref).all();
  else if (kind === "organization") r = await db.prepare(`SELECT DISTINCT u.id, u.email FROM customer_users u JOIN organization_users m ON m.user_id = u.id WHERE ${ACTIVE} AND m.organization_id = ? LIMIT ?`).bind(ref, MAX_RECIPIENTS + 1).all();
  else if (kind === "site") r = await db.prepare(`SELECT DISTINCT u.id, u.email FROM customer_users u JOIN organization_users m ON m.user_id = u.id JOIN sites s ON s.organization_id = m.organization_id WHERE ${ACTIVE} AND s.id = ? LIMIT ?`).bind(ref, MAX_RECIPIENTS + 1).all();
  else if (kind === "billing") r = ref
    ? await db.prepare(`SELECT DISTINCT u.id, u.email FROM customer_users u JOIN organization_users m ON m.user_id = u.id WHERE ${ACTIVE} AND m.organization_id = ? AND m.role IN ('billing','owner') LIMIT ?`).bind(ref, MAX_RECIPIENTS + 1).all()
    : await db.prepare(`SELECT DISTINCT u.id, u.email FROM customer_users u JOIN organization_users m ON m.user_id = u.id WHERE ${ACTIVE} AND m.role IN ('billing','owner') LIMIT ?`).bind(MAX_RECIPIENTS + 1).all();
  return r ? r.results || [] : [];
}
export const findUser = (env, idOrEmail) => env.LUMMET_DB.prepare(`SELECT id, email FROM customer_users WHERE (id = ? OR lower(email) = lower(?)) AND status = 'active'`).bind(idOrEmail, idOrEmail).first();
export const findOrganization = (env, id) => env.LUMMET_DB.prepare(`SELECT id, name FROM organizations WHERE id = ?`).bind(id).first();
export const findSite = (env, id) => env.LUMMET_DB.prepare(`SELECT s.id, s.name, o.name AS organization FROM sites s JOIN organizations o ON o.id = s.organization_id WHERE s.id = ?`).bind(id).first();

export async function insertAnnouncement(env, a, recipients) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO announcements (id, subject, body_html, format, audience_kind, audience_ref, audience_label, channels, recipient_count, email_total, created_by_staff) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(a.id, a.subject, a.bodyHtml, a.format, a.audienceKind, a.audienceRef || null, a.audienceLabel, JSON.stringify(a.channels), a.recipientCount, a.emailTotal, a.createdByStaff || null).run();
  for (let i = 0; i < recipients.length; i += 50) {
    await env.LUMMET_DB.batch(recipients.slice(i, i + 50).map((p) => env.LUMMET_DB.prepare(`INSERT OR IGNORE INTO announcement_recipients (announcement_id, user_id, email) VALUES (?, ?, ?)`).bind(a.id, p.id, p.email)));
  }
}
export async function pendingRecipients(env, limit) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT r.announcement_id, r.user_id, r.email, r.attempts, a.subject, a.body_html, a.created_at FROM announcement_recipients r JOIN announcements a ON a.id = r.announcement_id WHERE r.email_status = 'pending' AND a.hidden_at IS NULL ORDER BY a.created_at, r.rowid LIMIT ?`
  ).bind(limit).all();
  return r.results || [];
}
export const markRecipient = (env, announcementId, userId, status, bumpAttempts = false) =>
  env.LUMMET_DB.prepare(`UPDATE announcement_recipients SET email_status = ?, attempts = attempts + ? WHERE announcement_id = ? AND user_id = ?`).bind(status, bumpAttempts ? 1 : 0, announcementId, userId).run();

export async function listForStaff(env, limit = 50) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT a.id, a.subject, a.audience_kind, a.audience_label, a.channels, a.recipient_count, a.email_total, a.created_at, a.hidden_at, a.edited_at,
            (SELECT COUNT(*) FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.email_status = 'queued') AS emails_queued,
            (SELECT COUNT(*) FROM announcement_recipients r WHERE r.announcement_id = a.id AND r.email_status = 'failed') AS emails_failed,
            (SELECT COUNT(*) FROM announcement_reads d WHERE d.announcement_id = a.id) AS reads
       FROM announcements a ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`
  ).bind(limit).all();
  return r.results || [];
}

// What a signed-in person sees on the dashboard: the audience rule evaluated for them, newest first.
const VISIBLE = `a.hidden_at IS NULL AND a.channels LIKE '%"dashboard"%' AND (
    a.audience_kind = 'all'
 OR (a.audience_kind = 'user' AND a.audience_ref = @u)
 OR (a.audience_kind = 'organization' AND a.audience_ref IN (SELECT organization_id FROM organization_users WHERE user_id = @u))
 OR (a.audience_kind = 'site' AND a.audience_ref IN (SELECT s.id FROM sites s JOIN organization_users m ON m.organization_id = s.organization_id WHERE m.user_id = @u))
 OR (a.audience_kind = 'billing' AND EXISTS (SELECT 1 FROM organization_users m WHERE m.user_id = @u AND m.role IN ('billing','owner') AND (COALESCE(a.audience_ref,'') = '' OR m.organization_id = a.audience_ref))))`.replace(/@u/g, "?");
const VISIBLE_ARGS = (userId) => [userId, userId, userId, userId];

export async function listForUser(env, userId, limit = 50) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT a.id, a.subject, a.body_html, a.created_at, a.edited_at, (SELECT 1 FROM announcement_reads d WHERE d.announcement_id = a.id AND d.user_id = ?) AS is_read FROM announcements a WHERE ${VISIBLE} ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?`
  ).bind(userId, ...VISIBLE_ARGS(userId), limit).all();
  return r.results || [];
}
export async function unreadCount(env, userId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) AS n FROM announcements a WHERE ${VISIBLE} AND NOT EXISTS (SELECT 1 FROM announcement_reads d WHERE d.announcement_id = a.id AND d.user_id = ?)`
  ).bind(...VISIBLE_ARGS(userId), userId).first();
  return r?.n || 0;
}
export const markRead = (env, userId, ids) => env.LUMMET_DB.batch(ids.map((id) => env.LUMMET_DB.prepare(`INSERT OR IGNORE INTO announcement_reads (announcement_id, user_id) VALUES (?, ?)`).bind(id, userId)));

/** Choices for the staff composer. */
export async function pickers(env) {
  const [o, s] = await Promise.all([
    env.LUMMET_DB.prepare(`SELECT id, name FROM organizations ORDER BY name LIMIT 300`).all(),
    env.LUMMET_DB.prepare(`SELECT s.id, s.name, o.name AS organization FROM sites s JOIN organizations o ON o.id = s.organization_id ORDER BY o.name, s.name LIMIT 500`).all()
  ]);
  return { organizations: o.results || [], sites: s.results || [] };
}

export const getAnnouncement = (env, id) => env.LUMMET_DB.prepare(`SELECT id, subject, body_html, format, audience_kind, audience_label, channels, hidden_at, edited_at, created_at FROM announcements WHERE id = ?`).bind(id).first();
export const updateAnnouncement = (env, id, { subject, bodyHtml, format }) => env.LUMMET_DB.prepare(`UPDATE announcements SET subject = ?, body_html = ?, format = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(subject, bodyHtml, format, id).run();
export const setHidden = (env, id, hidden) => env.LUMMET_DB.prepare(`UPDATE announcements SET hidden_at = ${hidden ? "CURRENT_TIMESTAMP" : "NULL"} WHERE id = ?`).bind(id).run();
/** Recipients, reads and the row itself (a foreign key cascade would do the first two; they are removed explicitly so it does not depend on it). */
export const deleteAnnouncement = (env, id) => env.LUMMET_DB.batch([
  env.LUMMET_DB.prepare(`DELETE FROM announcement_recipients WHERE announcement_id = ?`).bind(id),
  env.LUMMET_DB.prepare(`DELETE FROM announcement_reads WHERE announcement_id = ?`).bind(id),
  env.LUMMET_DB.prepare(`DELETE FROM announcements WHERE id = ?`).bind(id),
]);
