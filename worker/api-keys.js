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

import * as apiKeysRepo from "./repositories/api-keys.js";
import { evaluateWriteGate, refusalFor, resolveAccess } from "./access.js";
import { requireEntitlement } from "./entitlements.js";
import { billingConfig } from "./billing-config.js";

const VALID_SCOPES = ["sites:read", "domains:read", "analytics:read", "usage:read"];

// -----------------------------------------------------
// api.enabled (release 2.6.1.6, gap G1). The entitlement used to be displayed but never enforced, so a plan without API access
// could create and use API keys. API_ENTITLEMENT=off (default) | shadow (log only) | enforce.
//   create  refused (403 api_not_enabled) when the plan has no api.enabled.
//   use     refused the same way, EXCEPT while the organization is read-only for non-payment: that state resolves every entitlement to
//           the zero floor, and its keys keep reading exactly as its public sites keep serving. A downgrade to a plan without API
//           access therefore ends key use; a payment lapse does not.
// -----------------------------------------------------
export const API_ENTITLEMENT_MODES = ["off", "shadow", "enforce"];
export function apiEntitlementMode(env) {
  const v = String((env && env.API_ENTITLEMENT) || "off").trim().toLowerCase();
  return API_ENTITLEMENT_MODES.includes(v) ? v : "off";
}

/** Returns { blocked, mode }. Never throws on a refusal; a failed lookup fails the request rather than letting a key through. */
export async function apiEntitlementCheck(env, organizationId, entryPoint, { forUse = false } = {}) {
  const mode = apiEntitlementMode(env);
  if (mode === "off") return { blocked: false, mode };
  if (forUse && billingConfig(env).mode === "enforce") {
    const access = await resolveAccess(env, organizationId);
    if (!access.canMutate) return { blocked: false, mode };      // read-only for non-payment: the floor is not a plan decision
  }
  if (await requireEntitlement(env, organizationId, "api.enabled")) return { blocked: false, mode };
  if (mode === "shadow") {
    console.log(JSON.stringify({ msg: "api_entitlement_would_refuse", organizationId, entryPoint }));
    return { blocked: false, mode };
  }
  return { blocked: true, mode };
}

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
  const gate = await evaluateWriteGate(env, { organizationId, method: "POST", subPath: "/api-keys" });
  if (gate.blocked) return { ok: false, status: 402, ...refusalFor(gate.access) };
  const entitled = await apiEntitlementCheck(env, organizationId, "api-keys:create");
  if (entitled.blocked) return { ok: false, status: 403, error: "api_not_enabled" };
  const trimmedName = (name || "").trim();
  if (!trimmedName) return { ok: false, status: 422, error: "name_required" };

  const requestedScopes = Array.isArray(scopes) ? scopes : [];
  const invalidScopes = requestedScopes.filter((s) => !VALID_SCOPES.includes(s));
  if (requestedScopes.length === 0 || invalidScopes.length > 0) {
    return { ok: false, status: 422, error: "invalid_scopes", invalidScopes };
  }

  if (siteId && !(await apiKeysRepo.siteBelongsToOrganization(env, siteId, organizationId))) {
    return { ok: false, status: 422, error: "invalid_site" };
  }

  const id = crypto.randomUUID();
  const prefix = randomHex(4); // 8 hex chars, safe to display
  const secret = randomHex(24); // 48 hex chars
  const token = `lmk_${prefix}_${secret}`;
  const tokenHash = await sha256Hex(token);

  await apiKeysRepo.insert(env, { id, organizationId, siteId, name: trimmedName, prefix, keyHash: tokenHash, scopes: requestedScopes, createdBy: actorUserId, expiresAt });

  return { ok: true, keyId: id, token, prefix };
}

export async function listApiKeys(env, organizationId) {
  const rows = await apiKeysRepo.listForOrganization(env, organizationId);
  return rows.map((row) => ({ ...row, scopes: JSON.parse(row.scopes) }));
}

export async function revokeApiKey(env, organizationId, keyId) {
  const gate = await evaluateWriteGate(env, { organizationId, method: "DELETE", subPath: "/api-keys/:id" });
  if (gate.blocked) return { ok: false, status: 402, ...refusalFor(gate.access) };
  if (!(await apiKeysRepo.existsInOrganization(env, keyId, organizationId))) return { ok: false, status: 404, error: "not_found" };

  await apiKeysRepo.markRevoked(env, keyId);
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
  const row = await apiKeysRepo.findByHash(env, tokenHash);
  if (!row) return null;
  if (row.status !== "active") return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  await apiKeysRepo.touchLastUsed(env, row.id);

  return { keyId: row.id, organizationId: row.organization_id, siteId: row.site_id, scopes: JSON.parse(row.scopes) };
}

export function hasScope(authResult, scope) {
  return !!authResult && Array.isArray(authResult.scopes) && authResult.scopes.includes(scope);
}
