// =====================================================
// ORGANIZATION SECURITY POLICY  (Round 6.4A, release 2.6.0.9)
//
// What an owner may require of everyone in their organization. Round 6.4A implements ONE control: org-wide 2FA.
// Round 6.4C (release 2.6.0.11) adds the other two columns of the table, each behind its own flag:
//   ORG_IP_ALLOWLIST=off|shadow|enforce    (default off) per-organization IP allowlist, business plans only (entitlement `security.ip_allowlist.enabled`).
//   ORG_SSO_REQUIREMENT=off|shadow         (default off) a STUB: the owner can record "SSO required"; nothing enforces it until an IdP is named (BLOCKED).
// See the 6.4C section at the end of this file.
//
//   ORG_SECURITY_POLICY=off      (default) nothing is read, nothing is blocked, the API answers 404.
//   ORG_SECURITY_POLICY=shadow   the policy can be set and read; a session that WOULD be blocked is only reported (wouldBlock).
//   ORG_SECURITY_POLICY=enforce  a person who is a member of an organization that requires 2FA, and has no active authenticator factor,
//                                gets a restricted session: the 2FA setup routes and logout work, everything else answers 403.
//
// 2FA here means an ACTIVE authenticator-app (TOTP) factor. Passkeys do not count yet: a session does not record how it was
// authenticated, so a passkey on the account cannot tell a passkey sign-in from a password-only one (see DECISIONS_v2.6.0.9, OPEN_ITEMS).
//
// Roles are untouched. Only an owner may change the policy. The billing role gets no new right and no exemption.
// =====================================================

import { logAudit } from "./audit.js";
import { getTotpStatus } from "./totp.js";
import { getMembership, getOrganization } from "./organizations.js";
import { requireEntitlement } from "./entitlements.js";
import { normalizeAllowlist, ipAllowed, clientIpFromRequest, MAX_ENTRIES } from "./ip-allowlist.js";
import * as repo from "./repositories/org-security-policy.js";

export const POLICY_MODES = ["off", "shadow", "enforce"];
export const REASON_MIN = 5;
export const REASON_MAX = 500;

/** The rollout flag. Unset or invalid is off (config-check refuses an invalid value in production). */
export function orgSecurityPolicyMode(env) {
  const v = String((env && env.ORG_SECURITY_POLICY) || "off").trim().toLowerCase();
  return POLICY_MODES.includes(v) ? v : "off";
}

/** The stored row as the service reports it. No row means every control is off. */
export function policyView(row) {
  return {
    organizationId: row ? row.organization_id : null,
    require2fa: !!(row && row.require_2fa === 1),
    requireSso: !!(row && row.require_sso === 1),            // stored only: a stub, never enforced (Round 6.4C, no IdP named)
    ipAllowlist: row ? safeList(row.ip_allowlist_json) : [], // enforced by evaluateOrgIpAccess when ORG_IP_ALLOWLIST=enforce and the plan includes it
    updatedAt: row ? row.updated_at : null
  };
}
function safeList(json) {
  const v = JSON.parse(json); // the column is CHECKed json_valid, so this cannot throw on stored data
  return Array.isArray(v) ? v : [];
}

/**
 * Decides, for one person on one request, whether an organization policy blocks the session.
 * Called on every customer session use, so it does nothing (no query at all) while the flag is off.
 * Errors are not caught: a failed lookup must fail the request, never silently let a blocked person through.
 */
export async function evaluateSessionUse(env, userId) {
  const mode = orgSecurityPolicyMode(env);
  const open = { mode, blocked: false, wouldBlock: false, reason: null, organizationIds: [] };
  if (mode === "off" || !userId) return open;
  const organizationIds = await repo.enforcingOrganizationIdsForUser(env, userId);
  if (!organizationIds.length) return open;
  if ((await getTotpStatus(env, userId)).enabled) return open;
  return { mode, blocked: mode === "enforce", wouldBlock: true, reason: "org_2fa_required", organizationIds };
}

/** Reads the policy of one organization for a member. Anyone else, in any other organization, gets nothing. */
export async function readPolicy(env, { organizationId, actorUserId }) {
  const mode = orgSecurityPolicyMode(env);
  if (mode === "off") return { ok: false, status: 404, error: "not_available" };
  const membership = actorUserId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!membership) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true, policy: policyView(await repo.getPolicy(env, organizationId)), enforcement: mode, role: membership.role };
}

/**
 * Turns the org-wide 2FA requirement on or off. Owner only. Every change carries a reason and writes an audit row; so does a refused attempt.
 * Turning it ON needs the acting owner to have 2FA already (otherwise the owner could lock themselves out), which is the recovery rule
 * for this round; turning it OFF never needs anything.
 */
export async function setRequire2fa(env, { organizationId, actorUserId, require2fa, reason, requestId = null, ipHash = null, endpoint = null, method = null }) {
  if (orgSecurityPolicyMode(env) === "off") return { ok: false, status: 404, error: "not_available" };

  const typed = typeof require2fa === "boolean";
  const action = typed ? `require_2fa_${require2fa ? "enable" : "disable"}` : "require_2fa_change";
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  const audit = (ok, status, error) => logAudit(env, {
    actorType: "customer_user", customerUserId: actorUserId || null, organizationId: organizationId || null,
    endpoint, method, resource: "organization_security_policy", resourceId: organizationId || null,
    action: ok ? action : `${action}_refused`, success: ok, statusCode: status, errorMessage: ok ? null : error,
    reason: trimmed.slice(0, REASON_MAX) || null, requestId, ipHash
  });
  const refuse = async (status, error) => { await audit(false, status, error); return { ok: false, status, error }; };

  const membership = actorUserId && organizationId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!membership || membership.role !== "owner") return refuse(403, "forbidden");
  if (!typed) return refuse(422, "invalid_value");
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) return refuse(422, "reason_required");
  if (require2fa && !(await getTotpStatus(env, actorUserId)).enabled) return refuse(409, "actor_needs_2fa");

  const current = await repo.getPolicy(env, organizationId);
  const before = !!(current && current.require_2fa === 1);
  if (before === require2fa) {
    return { ok: true, changed: false, policy: policyView(current), enforcement: orgSecurityPolicyMode(env), membersWithout2fa: await repo.countMembersWithout2fa(env, organizationId) };
  }
  await repo.upsertRequire2fa(env, organizationId, require2fa, new Date().toISOString());
  await audit(true, 200, null);
  return {
    ok: true, changed: true, policy: policyView(await repo.getPolicy(env, organizationId)), enforcement: orgSecurityPolicyMode(env),
    membersWithout2fa: await repo.countMembersWithout2fa(env, organizationId)
  };
}

// =====================================================
// ROUND 6.4C: IP ALLOWLIST, LOCKOUT PROTECTION, SSO REQUIREMENT STUB
// =====================================================

export const IP_ALLOWLIST_ENTITLEMENT = "security.ip_allowlist.enabled";
export const SSO_STUB_STATUS = "stub_no_idp";

/** ORG_IP_ALLOWLIST. Unset or invalid is off (config-check refuses an invalid value in production). Setting it to shadow or off lifts every denial at once. */
export function ipAllowlistMode(env) {
  const v = String((env && env.ORG_IP_ALLOWLIST) || "off").trim().toLowerCase();
  return POLICY_MODES.includes(v) ? v : "off";
}
/** ORG_SSO_REQUIREMENT. Only off and shadow exist: there is no enforce, because no identity provider has been named (BLOCKED). Anything else is off. */
export function ssoRequirementMode(env) {
  const v = String((env && env.ORG_SSO_REQUIREMENT) || "off").trim().toLowerCase();
  return v === "shadow" ? "shadow" : "off";
}
/** IP_ALLOWLIST_MAX_ENTRIES: how many entries one list may hold. Default 50, clamped to 1..200. */
export function ipAllowlistMaxEntries(env) {
  const n = Number.parseInt(String((env && env.IP_ALLOWLIST_MAX_ENTRIES) || ""), 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 200) : MAX_ENTRIES;
}

async function planIncludesAllowlist(env, organizationId) {
  return (await requireEntitlement(env, organizationId, IP_ALLOWLIST_ENTITLEMENT)) === true;
}

/**
 * Decides, for one request to one organization, whether that organization's IP allowlist denies it.
 * Per organization, not per session: a person who belongs to two organizations is restricted only inside the one that has a list.
 * Nothing is read while the flag is off. Rules, in order:
 *   - no stored list (or an empty one): allowed.
 *   - the plan does not include the allowlist (downgrade, cancelled, unpaid): NOT enforced, so a lapsed organization can always sign in and fix billing.
 *   - the client address (CF-Connecting-IP only) inside the list: allowed. Missing, unreadable or outside: denied.
 * shadow reports (wouldDeny) and never denies. Errors are not caught: a failed lookup fails the request instead of silently letting someone through.
 */
export async function evaluateOrgIpAccess(env, request, organizationId) {
  const mode = ipAllowlistMode(env);
  const open = { mode, denied: false, wouldDeny: false, reason: null };
  if (mode === "off" || !organizationId) return open;
  const row = await repo.getPolicy(env, organizationId);
  const list = row ? safeList(row.ip_allowlist_json) : [];
  if (!list.length) return open;
  if (!(await planIncludesAllowlist(env, organizationId))) return open;
  const ip = clientIpFromRequest(request);
  if (ip && ipAllowed(ip, list)) return open;
  return { mode, denied: mode === "enforce", wouldDeny: true, reason: "ip_not_allowed" };
}

/** Reads the allowlist state of one organization. Admin or owner only (the list names the organization's own networks). */
export async function readIpAllowlist(env, { organizationId, actorUserId }) {
  const mode = ipAllowlistMode(env);
  if (mode === "off") return { ok: false, status: 404, error: "not_available" };
  const membership = actorUserId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) return { ok: false, status: 403, error: "forbidden" };
  const row = await repo.getPolicy(env, organizationId);
  const list = row ? safeList(row.ip_allowlist_json) : [];
  const entitled = await planIncludesAllowlist(env, organizationId);
  return {
    ok: true, enforcement: mode, role: membership.role,
    data: { organizationId, ipAllowlist: list, entitled, enforced: mode === "enforce" && entitled && list.length > 0, updatedAt: row ? row.updated_at : null }
  };
}

/**
 * Replaces the allowlist (an empty list clears it). Owner only; a written reason; every change and every refusal is audited.
 * Lockout protection, all before anything is stored:
 *   1. the list is validated and canonicalized (no allow-everything entry, bounded size);
 *   2. setting a non-empty list needs the plan entitlement (clearing never does, so a downgraded owner can always remove it);
 *   3. the address the owner is using right now must be inside the new list (409 would_lock_out_actor), and must be readable (409 client_ip_unknown).
 * Recovery if an owner is locked out later (their address changed): Lummet staff clear the list (clearIpAllowlistAsStaff); another owner on an allowed
 * address can edit it; ORG_IP_ALLOWLIST=shadow|off lifts every denial; a lapsed plan stops enforcement (see evaluateOrgIpAccess).
 */
export async function setIpAllowlist(env, { organizationId, actorUserId, ipAllowlist, reason, request = null, requestId = null, ipHash = null, endpoint = null, method = null }) {
  if (ipAllowlistMode(env) === "off") return { ok: false, status: 404, error: "not_available" };

  const trimmed = typeof reason === "string" ? reason.trim() : "";
  const normalized = normalizeAllowlist(ipAllowlist, { max: ipAllowlistMaxEntries(env) });
  const clearing = normalized.ok && normalized.list.length === 0;
  const action = clearing ? "ip_allowlist_clear" : "ip_allowlist_set";
  const audit = (ok, status, error) => logAudit(env, {
    actorType: "customer_user", customerUserId: actorUserId || null, organizationId: organizationId || null,
    endpoint, method, resource: "organization_security_policy", resourceId: organizationId || null,
    action: ok ? action : `${action}_refused`, success: ok, statusCode: status, errorMessage: ok ? null : error,
    reason: trimmed.slice(0, REASON_MAX) || null, requestId, ipHash
  });
  const refuse = async (status, error) => { await audit(false, status, error); return { ok: false, status, error }; };

  const membership = actorUserId && organizationId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!membership || membership.role !== "owner") return refuse(403, "forbidden");
  if (!normalized.ok) return refuse(422, normalized.error);
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) return refuse(422, "reason_required");

  if (!clearing) {
    if (!(await planIncludesAllowlist(env, organizationId))) return refuse(403, "feature_not_in_plan");
    const actorIp = clientIpFromRequest(request);
    if (!actorIp) return refuse(409, "client_ip_unknown");
    if (!ipAllowed(actorIp, normalized.list)) return refuse(409, "would_lock_out_actor");
  }

  const current = await repo.getPolicy(env, organizationId);
  const before = current ? safeList(current.ip_allowlist_json) : [];
  const nextJson = JSON.stringify(normalized.list);
  const view = (row, changed) => ({ ok: true, changed, enforcement: ipAllowlistMode(env), data: { organizationId, ipAllowlist: row ? safeList(row.ip_allowlist_json) : [], updatedAt: row ? row.updated_at : null } });
  if (JSON.stringify(before) === nextJson) return view(current, false);

  await repo.upsertIpAllowlist(env, organizationId, nextJson, new Date().toISOString());
  await audit(true, 200, null);
  const done = view(await repo.getPolicy(env, organizationId), true);
  return { ...done, data: { ...done.data, entitled: await planIncludesAllowlist(env, organizationId) } };
}

/**
 * Staff recovery path for an owner who is locked out by their own allowlist. Works whatever ORG_IP_ALLOWLIST says (recovery must never be dark).
 * The caller has already passed the super-admin gate. A reason is required; the audit row carries the staff id and the organization.
 * Who may ask for this, and how an owner's identity is checked first, is an owner decision (OPEN_ITEMS_v2.6.0.11, question 3).
 */
export async function clearIpAllowlistAsStaff(env, { organizationId, adminId, reason, requestId = null, ipHash = null, endpoint = null, method = null }) {
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  const audit = (ok, status, error) => logAudit(env, {
    adminId: adminId || null, organizationId: organizationId || null, endpoint, method,
    resource: "organization_security_policy", resourceId: organizationId || null,
    action: ok ? "ip_allowlist_staff_clear" : "ip_allowlist_staff_clear_refused", success: ok, statusCode: status, errorMessage: ok ? null : error,
    reason: trimmed.slice(0, REASON_MAX) || null, requestId, ipHash
  });
  const refuse = async (status, error) => { await audit(false, status, error); return { ok: false, status, error }; };

  if (!organizationId || !(await getOrganization(env, organizationId))) return refuse(404, "not_found");
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) return refuse(422, "reason_required");

  const current = await repo.getPolicy(env, organizationId);
  const had = !!(current && safeList(current.ip_allowlist_json).length);
  if (had) await repo.upsertIpAllowlist(env, organizationId, "[]", new Date().toISOString());
  await audit(true, 200, null);
  return { ok: true, cleared: had };
}

/**
 * SSO requirement: a flagged STUB. An owner can record that SSO is required (with a reason, audited), and the policy reads it back, but NOTHING
 * enforces it: enforcing "SSO required" without an identity provider would lock every member out. It stays a stub until the owner names an IdP
 * (BLOCKED, see OPEN_ITEMS_v2.6.0.11). The response says so explicitly so no client mistakes it for protection.
 */
export async function setRequireSso(env, { organizationId, actorUserId, requireSso, reason, requestId = null, ipHash = null, endpoint = null, method = null }) {
  if (ssoRequirementMode(env) === "off") return { ok: false, status: 404, error: "not_available" };

  const typed = typeof requireSso === "boolean";
  const action = typed ? `require_sso_${requireSso ? "enable" : "disable"}` : "require_sso_change";
  const trimmed = typeof reason === "string" ? reason.trim() : "";
  const audit = (ok, status, error) => logAudit(env, {
    actorType: "customer_user", customerUserId: actorUserId || null, organizationId: organizationId || null,
    endpoint, method, resource: "organization_security_policy", resourceId: organizationId || null,
    action: ok ? action : `${action}_refused`, success: ok, statusCode: status, errorMessage: ok ? null : error,
    reason: trimmed.slice(0, REASON_MAX) || null, requestId, ipHash
  });
  const refuse = async (status, error) => { await audit(false, status, error); return { ok: false, status, error }; };

  const membership = actorUserId && organizationId ? await getMembership(env, organizationId, actorUserId) : null;
  if (!membership || membership.role !== "owner") return refuse(403, "forbidden");
  if (!typed) return refuse(422, "invalid_value");
  if (trimmed.length < REASON_MIN || trimmed.length > REASON_MAX) return refuse(422, "reason_required");

  const current = await repo.getPolicy(env, organizationId);
  const before = !!(current && current.require_sso === 1);
  const stub = { enforced: false, status: SSO_STUB_STATUS };
  if (before === requireSso) return { ok: true, changed: false, policy: policyView(current), ...stub };
  await repo.upsertRequireSso(env, organizationId, requireSso, new Date().toISOString());
  await audit(true, 200, null);
  return { ok: true, changed: true, policy: policyView(await repo.getPolicy(env, organizationId)), ...stub };
}
