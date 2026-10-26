// Customer sessions (table customer_sessions, migration 0006): the queries behind the organization session list and revoke (Round 6.4B).
// Plain data in, plain data out. What a session MEANS for an organization (who may see it, who may end it) lives in worker/customer-sessions.js.
//
// Scope rule used by every organization query here: a session belongs to an organization's view when its person is CURRENTLY a member of
// that organization AND the session's active organization is that organization. Both conditions are checked inside the query, so a
// removed member, or a session that is active in a different organization, can never be reached through this organization.
// The session id is the login secret (it is the cookie value). It is returned to the service only so a handle can be derived; it must never leave the service.

const SCOPE = `FROM customer_sessions s
       JOIN organization_users m ON m.user_id = s.user_id AND m.organization_id = ?
       JOIN customer_users u ON u.id = s.user_id
      WHERE s.active_organization_id = ? AND s.expires_at > ?`;

/** One page of live sessions in an organization's scope, newest first by rowid. beforeRowid is the previous page's last rid (or null). */
export async function listInOrganization(env, { organizationId, nowIso, limit, beforeRowid }) {
  const paged = beforeRowid != null;
  const r = await env.LUMMET_DB.prepare(
    `SELECT s.rowid AS rid, s.id, s.user_id, s.created_at, s.expires_at, m.role, u.email, u.full_name
       ${SCOPE}${paged ? " AND s.rowid < ?" : ""}
      ORDER BY s.rowid DESC LIMIT ?`
  ).bind(...[organizationId, organizationId, nowIso, ...(paged ? [beforeRowid] : []), limit]).all();
  return r.results || [];
}

/** Every live session of one person that is in the organization's scope (at most 200). */
export async function listForUserInOrganization(env, { organizationId, userId, nowIso }) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT s.rowid AS rid, s.id, s.user_id, s.created_at, s.expires_at, m.role, u.email, u.full_name
       ${SCOPE} AND s.user_id = ?
      ORDER BY s.rowid DESC LIMIT 200`
  ).bind(organizationId, organizationId, nowIso, userId).all();
  return r.results || [];
}

/** Deletes exactly this session, only while it still belongs to this person. Returns how many rows went (0 or 1). */
export async function deleteOne(env, { sessionId, userId }) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM customer_sessions WHERE id = ? AND user_id = ?`).bind(sessionId, userId).run();
  return Number(r.meta?.changes || 0);
}

/** Deletes every session of one person, except the one named (when given). Expired rows go too. Returns how many rows went. */
export async function deleteAllForUser(env, { userId, exceptSessionId }) {
  const except = typeof exceptSessionId === "string" && exceptSessionId.length > 0;
  const r = await env.LUMMET_DB.prepare(
    `DELETE FROM customer_sessions WHERE user_id = ?${except ? " AND id != ?" : ""}`
  ).bind(...(except ? [userId, exceptSessionId] : [userId])).run();
  return Number(r.meta?.changes || 0);
}

/** How many live sessions a person holds (used by the shadow dry run for the unscoped case). */
export async function countLiveForUser(env, { userId, nowIso, exceptSessionId }) {
  const except = typeof exceptSessionId === "string" && exceptSessionId.length > 0;
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) AS n FROM customer_sessions WHERE user_id = ? AND expires_at > ?${except ? " AND id != ?" : ""}`
  ).bind(...(except ? [userId, nowIso, exceptSessionId] : [userId, nowIso])).first();
  return Number(row?.n || 0);
}
