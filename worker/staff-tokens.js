// =====================================================
// STAFF API TOKENS (v1.2)
//
// The tenant publish script used to need a staff SESSION COOKIE: it expires, and a CI job cannot sign in
// with a password and a second factor. A staff API token is the unattended alternative.
//
// Safety properties (same pattern as customer API keys, worker/api-keys.js):
//   * the full token is shown ONCE, only its SHA-256 hash is stored (the token is 192 random bits, so a fast
//     hash is appropriate; there is nothing to brute-force);
//   * scopes: a token can only do what it was created for. Today: publish releases, run rollouts. It cannot
//     reach any other staff screen or API, and it cannot sign in to the console;
//   * tokens expire (default 365 days, at most 730) and can be revoked at any time, effective immediately;
//   * a missing / malformed / unknown / revoked / expired token is simply "not authenticated", never an error.
// =====================================================
import * as repo from "./repositories/staff-tokens.js";

export const STAFF_TOKEN_SCOPES = ["release:publish", "rollout:run"];
export const TOKEN_PREFIX = "lmst_";
export const DEFAULT_EXPIRY_DAYS = 365;
export const MAX_EXPIRY_DAYS = 730;

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength) {
  return [...crypto.getRandomValues(new Uint8Array(byteLength))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Creates a token and returns the plaintext ONCE. */
export async function createStaffToken(env, { name, scopes, createdBy, expiresInDays }) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return { ok: false, status: 422, error: "name_required" };
  if (trimmed.length > 80) return { ok: false, status: 422, error: "name_too_long" };
  const wanted = Array.isArray(scopes) ? [...new Set(scopes)] : [];
  const invalid = wanted.filter((s) => !STAFF_TOKEN_SCOPES.includes(s));
  if (!wanted.length || invalid.length) return { ok: false, status: 422, error: "invalid_scopes", invalidScopes: invalid };

  let days = DEFAULT_EXPIRY_DAYS;
  if (expiresInDays !== undefined && expiresInDays !== null && expiresInDays !== "") {
    days = Number(expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > MAX_EXPIRY_DAYS) return { ok: false, status: 422, error: "invalid_expiry" };
  }
  const expiresAt = new Date(Date.now() + days * 86400000).toISOString();

  const id = crypto.randomUUID();
  const prefix = randomHex(4);
  const token = `${TOKEN_PREFIX}${prefix}_${randomHex(24)}`;
  await repo.insert(env, { id, name: trimmed, prefix, hash: await sha256Hex(token), scopes: wanted, createdBy, expiresAt });
  return { ok: true, tokenId: id, token, prefix, expiresAt, scopes: wanted };
}

export async function listStaffTokens(env) {
  return (await repo.list(env)).map((r) => ({ ...r, scopes: safeScopes(r.scopes) }));
}

function safeScopes(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch (_) { return []; }
}

export async function revokeStaffToken(env, id) {
  const row = await repo.getById(env, id);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  if (row.status !== "active") return { ok: false, status: 409, error: "already_revoked", prefix: row.token_prefix };
  await repo.markRevoked(env, id);
  return { ok: true, prefix: row.token_prefix };
}

/** Bearer token -> { tokenId, prefix, name, scopes } or null. Never throws for bad input. */
export async function verifyStaffToken(env, token) {
  if (!token || typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  const row = await repo.findByHash(env, await sha256Hex(token));
  if (!row || row.status !== "active") return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) return null;
  await repo.touchLastUsed(env, row.id).catch(() => {});
  return { tokenId: row.id, prefix: row.token_prefix, name: row.name, scopes: safeScopes(row.scopes) };
}

export function hasStaffScope(auth, scope) {
  return !!auth && Array.isArray(auth.scopes) && auth.scopes.includes(scope);
}
