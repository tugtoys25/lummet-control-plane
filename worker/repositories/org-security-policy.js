// Organization security policy table (migration 0072): organization_security_policies. All SQL for it belongs here.
// Each upsert writes ONE control's column (plus updated_at) and leaves every other column of an existing row exactly as it is,
// so the 2FA requirement, the IP allowlist and the SSO requirement can never overwrite each other.
// Plain data in, plain data out. What a policy MEANS (who may change it, what it blocks) lives in worker/org-security-policy.js.

/** The stored policy row of one organization, or null when none was ever set (null means every control is off). */
export async function getPolicy(env, organizationId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM organization_security_policies WHERE organization_id = ?`).bind(organizationId).first()) || null;
}

/**
 * Sets require_2fa and updated_at for one organization. Creates the row on first use; every other column of an existing row is left
 * exactly as it is (this function never writes require_sso or ip_allowlist_json).
 */
export async function upsertRequire2fa(env, organizationId, require2fa, nowIso) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_security_policies (organization_id, require_2fa, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET require_2fa = excluded.require_2fa, updated_at = excluded.updated_at`
  ).bind(organizationId, require2fa ? 1 : 0, nowIso).run();
}

/** Ids of the organizations that require 2FA and that this user is a member of (at most 25, ordered by id). */
export async function enforcingOrganizationIdsForUser(env, userId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT p.organization_id AS id
       FROM organization_security_policies p
       JOIN organization_users m ON m.organization_id = p.organization_id
      WHERE m.user_id = ? AND p.require_2fa = 1
      ORDER BY p.organization_id LIMIT 25`
  ).bind(userId).all();
  return (r.results || []).map((x) => x.id);
}

/** How many members of the organization have no ACTIVE authenticator factor (a pending setup does not count). */
export async function countMembersWithout2fa(env, organizationId, { passkeysCount = false } = {}) {
  // With ORG_2FA_PASSKEY_COUNTS=on a member who has registered a passkey is not counted as lacking a second factor.
  const passkeyClause = passkeysCount ? "AND NOT EXISTS (SELECT 1 FROM customer_webauthn_credentials w WHERE w.user_id = m.user_id)" : "";
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) AS n
       FROM organization_users m
       LEFT JOIN customer_totp t ON t.user_id = m.user_id AND t.status = 'active'
      WHERE m.organization_id = ? AND t.user_id IS NULL ${passkeyClause}`
  ).bind(organizationId).first();
  return Number(row?.n || 0);
}

/** How many passkeys a person has registered. */
export async function countPasskeys(env, userId) {
  const row = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM customer_webauthn_credentials WHERE user_id = ?`).bind(userId).first();
  return Number(row?.n || 0);
}

/** Sets ip_allowlist_json (an already normalized JSON array text) and updated_at. Creates the row on first use. Round 6.4C. */
export async function upsertIpAllowlist(env, organizationId, allowlistJson, nowIso) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_security_policies (organization_id, ip_allowlist_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET ip_allowlist_json = excluded.ip_allowlist_json, updated_at = excluded.updated_at`
  ).bind(organizationId, allowlistJson, nowIso).run();
}

/** Sets require_sso and updated_at. Creates the row on first use. Stored only: nothing enforces it (Round 6.4C stub). */
export async function upsertRequireSso(env, organizationId, requireSso, nowIso) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_security_policies (organization_id, require_sso, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET require_sso = excluded.require_sso, updated_at = excluded.updated_at`
  ).bind(organizationId, requireSso ? 1 : 0, nowIso).run();
}
