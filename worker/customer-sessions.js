// =====================================================
// ORGANIZATION SESSIONS: LIST AND REVOKE  (Round 6.4B, release 2.6.0.10)
//
// An owner or admin can see the live sign-in sessions of their organization's members and end one (or all of one member's) immediately.
//
//   CUSTOMER_SESSION_ADMIN=off      (default) the routes answer 404 and nothing is read.
//   CUSTOMER_SESSION_ADMIN=shadow   the list works; a revoke is a DRY RUN: it reports wouldRevoke, deletes nothing, and writes an audit row.
//   CUSTOMER_SESSION_ADMIN=on       the list works and a revoke deletes the session rows.
//
// "Immediate" is literal: a session is a row, every request looks the row up (customer-auth.getCustomerSession), so deleting the row ends
// the session on the very next request. No migration is needed and no token has to expire first.
//
// Scope: a session is in an organization's view when its person is a current member AND the session's active organization is that
// organization (see repositories/customer-sessions.js). Revoking a session deletes the whole session, which is the person's sign-in on
// one device, not a per-organization permission. So an admin of organization A can end a shared member's session only while that session
// is active in A. This is the least-privilege reading; see DECISIONS_v2.6.0.10 and OPEN_ITEMS_v2.6.0.10 question 1.
//
// The session id is the login secret and never leaves this module. Callers get an opaque handle: "<userId>.<24 hex of a SHA-256 over the id>".
//
// revokeAllSessionsForUser() is the reusable core. It is not tied to HTTP, a role or an organization, so SCIM deprovision (Round 7.1C)
// calls it directly with actorType "system" and its own reason. It is idempotent: a replay revokes nothing and still succeeds.
// =====================================================

import { logAudit } from "./audit.js";
import { getMembership } from "./organizations.js";
import { roleAtLeast } from "./customer-rbac.js";
import * as repo from "./repositories/customer-sessions.js";

export const SESSION_ADMIN_MODES = ["off", "shadow", "on"];
export const REASON_MIN = 5;
export const REASON_MAX = 500;
export const DEFAULT_PAGE = 50;
export const MAX_PAGE = 200;

/** The rollout flag. Unset or invalid is off (config-check refuses an invalid value in production). */
export function sessionAdminMode(env) {
  const v = String((env && env.CUSTOMER_SESSION_ADMIN) || "off").trim().toLowerCase();
  return SESSION_ADMIN_MODES.includes(v) ? v : "off";
}

/** Opaque, stable, non-secret name for one session. Bound to the person so a handle cannot be pointed at someone else's session. */
export async function sessionHandle(userId, sessionId) {
  const bytes = new TextEncoder().encode(`lummet:customer-session-handle:v1:${sessionId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
  return `${userId}.${hex}`;
}

function splitHandle(handle) {
  if (typeof handle !== "string" || handle.length > 200) return null;
  const dot = handle.lastIndexOf(".");
  if (dot < 1) return null;
  const userId = handle.slice(0, dot); const digest = handle.slice(dot + 1);
  return /^[0-9a-f]{24}$/.test(digest) && /^[A-Za-z0-9_-]{1,100}$/.test(userId) ? { userId, digest } : null;
}

function parseLimit(raw) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_PAGE) : DEFAULT_PAGE;
}

/** A page of the organization's live sessions. Admin or owner only. */
export async function listSessions(env, { organizationId, actorUserId, actorSessionId = null, limit, cursor }) {
  const mode = sessionAdminMode(env);
  if (mode === "off") return { ok: false, status: 404, error: "not_available" };
  const membership = actorUserId && organizationId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!membership || !roleAtLeast(membership.role, "admin")) return { ok: false, status: 403, error: "forbidden" };
  let beforeRowid = null;
  if (cursor != null && cursor !== "") {
    if (!/^\d{1,15}$/.test(String(cursor))) return { ok: false, status: 422, error: "invalid_cursor" };
    beforeRowid = Number(cursor);
  }
  const size = parseLimit(limit);
  const rows = await repo.listInOrganization(env, { organizationId, nowIso: new Date().toISOString(), limit: size + 1, beforeRowid });
  const more = rows.length > size;
  const pageRows = more ? rows.slice(0, size) : rows;
  const data = [];
  for (const r of pageRows) {
    data.push({
      handle: await sessionHandle(r.user_id, r.id), userId: r.user_id, email: r.email, fullName: r.full_name || null, role: r.role,
      createdAt: r.created_at, expiresAt: r.expires_at, current: !!actorSessionId && r.id === actorSessionId
    });
  }
  return { ok: true, data, nextCursor: more ? String(pageRows[pageRows.length - 1].rid) : null, mode };
}

/**
 * Ends sessions on behalf of an organization admin or owner. Target is either { handle } (one session) or { userId } (all of that
 * member's sessions that are in this organization's scope). Needs a written reason; every attempt, refused or not, is audited.
 */
export async function revokeSessions(env, { organizationId, actorUserId, actorSessionId = null, handle, userId, reason, requestId = null, ipHash = null, endpoint = null, method = null }) {
  const mode = sessionAdminMode(env);
  if (mode === "off") return { ok: false, status: 404, error: "not_available" };

  const trimmed = typeof reason === "string" ? reason.trim() : "";
  const byHandle = handle !== undefined && handle !== null;
  const audit = (action, ok, status, error, resourceId) => logAudit(env, {
    actorType: "customer_user", customerUserId: actorUserId || null, organizationId: organizationId || null,
    endpoint, method, resource: "customer_session", resourceId: resourceId || null, action, success: ok, statusCode: status,
    errorMessage: ok ? null : error, reason: trimmed.slice(0, REASON_MAX) || null, requestId, ipHash
  });
  const refuse = async (status, error, resourceId = null) => { await audit("customer_session_revoke_refused", false, status, error, resourceId); return { ok: false, status, error }; };

  const actor = actorUserId && organizationId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!actor || !roleAtLeast(actor.role, "admin")) return refuse(403, "forbidden");
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) return refuse(422, "reason_required");

  let targetUserId = null; let digest = null;
  if (byHandle) {
    const parts = splitHandle(handle);
    if (!parts) return refuse(typeof handle === "string" ? 404 : 422, typeof handle === "string" ? "session_not_found" : "invalid_handle");
    targetUserId = parts.userId; digest = parts.digest;
  } else if (typeof userId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(userId)) {
    targetUserId = userId;
  } else {
    return refuse(422, "target_required");
  }

  const nowIso = new Date().toISOString();
  let candidates = await repo.listForUserInOrganization(env, { organizationId, userId: targetUserId, nowIso });
  if (digest) {
    const kept = [];
    for (const c of candidates) if ((await sessionHandle(c.user_id, c.id)) === handle) kept.push(c);
    candidates = kept;
  }
  if (!candidates.length) return refuse(404, "session_not_found", targetUserId);

  const targetRole = candidates[0].role;
  if (targetRole === "owner" && actor.role !== "owner") return refuse(403, "cannot_revoke_owner_session", targetUserId);
  if (actorSessionId && candidates.some((c) => c.id === actorSessionId)) return refuse(409, "use_logout_for_own_session", targetUserId);

  if (mode === "shadow") {
    await audit("customer_session_revoke_shadow", true, 200, null, targetUserId);
    return { ok: true, shadow: true, revoked: 0, wouldRevoke: candidates.length, mode };
  }

  let revoked = 0;
  for (const c of candidates) revoked += await repo.deleteOne(env, { sessionId: c.id, userId: c.user_id });
  await audit("customer_session_revoke", true, 200, null, targetUserId);
  return { ok: true, shadow: false, revoked, mode };
}

/**
 * The reusable core: ends every session a person holds (optionally keeping one). No role, organization or flag logic here, so the
 * caller decides who is allowed (SCIM deprovision in 7.1C passes actorType "system"). Idempotent. Always audited.
 * Errors from the database are not caught: a revoke that did not happen must never be reported as done.
 */
export async function revokeAllSessionsForUser(env, { userId, reason, exceptSessionId = null, actorType = "system", actorId = null, organizationId = null, requestId = null, ipHash = null, endpoint = null, method = null }) {
  if (typeof userId !== "string" || !userId) return { ok: false, status: 422, error: "user_required" };
  const revoked = await repo.deleteAllForUser(env, { userId, exceptSessionId });
  await logAudit(env, {
    actorType, customerUserId: actorType === "customer_user" ? actorId : null, organizationId, endpoint, method,
    resource: "customer_session", resourceId: userId, action: "customer_sessions_revoke_user", success: true, statusCode: 200,
    reason: (typeof reason === "string" ? reason.trim() : "").slice(0, REASON_MAX) || null, requestId, ipHash
  });
  return { ok: true, revoked };
}
