// =====================================================
// CUSTOMER API KEYS (master prompt section 30)
//
// Authenticates THIRD-PARTY callers of this control plane's
// developer API (/api/v1/*, see index.js) — deliberately
// separate from the internal HMAC-signed tenant Super API
// credentials (registry.js/client.js), which authenticate
// THIS control plane calling a TENANT, a completely different
// direction and trust relationship.
//
// Scopes are intentionally read-only in this phase — the
// /api/v1/* surface built alongside this (index.js) only
// exposes GET endpoints, so a write scope would be a promise
// this phase doesn't keep. Extending to write scopes is
// straightforward once a write endpoint actually exists.
// =====================================================

const VALID_SCOPES = ["sites:read", "domains:read", "analytics:read", "usage:read"];

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function listValidScopes() {
  return [...VALID_SCOPES];
}

/**
 * Creates a key and returns the full plaintext token ONCE — only
 * its hash is ever stored, and key_prefix (safe, non-secret) is
 * kept so the UI can show "lmk_a1b2c3d4…" for identification
 * without ever displaying the real secret again.
 */
export async function createApiKey(env, { organizationId, siteId, name, scopes, actorUserId, expiresAt }) {
  const trimmedName = (name || "").trim();
  if (!trimmedName) return { ok: false, status: 422, error: "name_required" };

  const requestedScopes = Array.isArray(scopes) ? scopes : [];
  const invalidScopes = requestedScopes.filter((s) => !VALID_SCOPES.includes(s));
  if (requestedScopes.length === 0 || invalidScopes.length > 0) {
    return { ok: false, status: 422, error: "invalid_scopes", invalidScopes };
  }

  if (siteId) {
    const site = await env.LUMMET_DB.prepare(`SELECT id FROM sites WHERE id = ? AND organization_id = ?`)
      .bind(siteId, organizationId)
      .first();
    if (!site) return { ok: false, status: 422, error: "invalid_site" };
  }

  const id = crypto.randomUUID();
  const prefix = randomHex(4); // 8 hex chars, safe to display
  const secret = randomHex(24); // 48 hex chars
  const token = `lmk_${prefix}_${secret}`;
  const tokenHash = await sha256Hex(token);

  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_api_keys (id, organization_id, site_id, name, key_prefix, key_hash, scopes, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, organizationId, siteId || null, trimmedName, prefix, tokenHash, JSON.stringify(requestedScopes), actorUserId || null, expiresAt || null)
    .run();

  return { ok: true, keyId: id, token, prefix };
}

export async function listApiKeys(env, organizationId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT id, site_id, name, key_prefix, scopes, status, created_at, last_used_at, expires_at
     FROM customer_api_keys WHERE organization_id = ? ORDER BY created_at DESC`
  )
    .bind(organizationId)
    .all();
  return (result.results || []).map((row) => ({ ...row, scopes: JSON.parse(row.scopes) }));
}

export async function revokeApiKey(env, organizationId, keyId) {
  const key = await env.LUMMET_DB.prepare(`SELECT id FROM customer_api_keys WHERE id = ? AND organization_id = ?`)
    .bind(keyId, organizationId)
    .first();
  if (!key) return { ok: false, status: 404, error: "not_found" };

  await env.LUMMET_DB.prepare(`UPDATE customer_api_keys SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(keyId)
    .run();
  return { ok: true };
}

/**
 * Verifies a bearer token from the Authorization header and returns
 * its organization/site scope, or null if it's missing, malformed,
 * unknown, revoked, or expired. Never throws — a malformed token is
 * just "not authenticated", not a server error.
 */
export async function verifyApiKey(env, token) {
  if (!token || !token.startsWith("lmk_")) return null;

  const tokenHash = await sha256Hex(token);
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM customer_api_keys WHERE key_hash = ?`).bind(tokenHash).first();
  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  await env.LUMMET_DB.prepare(`UPDATE customer_api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(row.id)
    .run();

  return { keyId: row.id, organizationId: row.organization_id, siteId: row.site_id, scopes: JSON.parse(row.scopes) };
}

export function hasScope(authResult, scope) {
  return !!authResult && Array.isArray(authResult.scopes) && authResult.scopes.includes(scope);
}
