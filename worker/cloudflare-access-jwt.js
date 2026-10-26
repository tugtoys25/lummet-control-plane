// =====================================================
// CLOUDFLARE ACCESS JWT VERIFICATION FOR PLATFORM ROUTES (Round 6.3B, release 2.6.0.7)
//
// Cloudflare Access sits in front of /platform/* and /api/platform/* and adds a signed JWT to every request it lets
// through (header Cf-Access-Jwt-Assertion). A request can still reach the Worker directly (a workers.dev hostname, a
// misconfigured route), so the Worker checks that JWT itself instead of trusting the header's presence.
//
// This is ADDITIVE: staff sessions, staff 2FA and RBAC are unchanged and still run after this check.
//
// PLATFORM_ACCESS_JWT_MODE: off (default; nothing here runs) | shadow (verify and log a reason code, never block)
//                           | enforce (a missing, invalid or unverifiable JWT is refused; fails closed).
// Any other value is refused too: a typo must not silently switch a security control off.
//
// Verification: RS256 only, key chosen by `kid` from the team's JWKS, issuer and audience matched exactly, exp required,
// nbf and iat checked. The signature is checked before any claim is trusted. The JWT, its claims and the subject are
// never logged or returned.
// =====================================================

const JWKS_TTL_MS = 5 * 60 * 1000;
const JWKS_FORCED_REFRESH_MIN_MS = 30 * 1000; // an unknown `kid` may refresh the key set, but not on every request
const MAX_JWT_CHARS = 8192;
const LEEWAY_SECONDS = 30;
const jwksCache = new Map(); // issuer -> { keys, expiresAt, fetchedAt }

/** Test helper: forget cached key sets. */
export function resetAccessJwksCache() { jwksCache.clear(); }

export function parsePlatformAccessMode(env) {
  const raw = env && env.PLATFORM_ACCESS_JWT_MODE;
  if (raw === undefined || raw === null || String(raw).trim() === "") return "off";
  const mode = String(raw).trim().toLowerCase();
  return ["off", "shadow", "enforce"].includes(mode) ? mode : "invalid";
}

/** True for /platform, /platform/*, /api/platform and /api/platform/* (case-insensitive, repeated slashes ignored). */
export function isPlatformAccessPath(pathname) {
  const path = String(pathname || "").replace(/\/{2,}/g, "/").toLowerCase();
  return path === "/platform" || path.startsWith("/platform/") || path === "/api/platform" || path.startsWith("/api/platform/");
}

/** The Access team domain as an origin, or null when it is not an https <team>.cloudflareaccess.com origin. */
export function normalizeAccessIssuer(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(raw); } catch (_) { return null; }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/i.test(url.hostname)) return null;
  return url.origin;
}

export const isValidAccessAudience = (value) => /^[A-Za-z0-9_-]{8,256}$/.test(String(value || "").trim());

function decodeBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("not base64url");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
const decodeJsonPart = (value) => JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));

async function loadJwks(issuer, fetchImpl, nowMs, forceRefresh) {
  const cached = jwksCache.get(issuer);
  if (cached && !forceRefresh && cached.expiresAt > nowMs) return { ok: true, keys: cached.keys };
  if (cached && forceRefresh && nowMs - cached.fetchedAt < JWKS_FORCED_REFRESH_MIN_MS) return { ok: true, keys: cached.keys };
  let response;
  try { response = await fetchImpl(`${issuer}/cdn-cgi/access/certs`, { method: "GET", headers: { Accept: "application/json" } }); }
  catch (error) { console.warn("cloudflare_access_jwks_fetch_failed", JSON.stringify({ error: String(error && error.name || "error") })); return { ok: false, reason: "jwks_unavailable" }; }
  if (!response || !response.ok) return { ok: false, reason: "jwks_unavailable" };
  let document;
  try { document = await response.json(); }
  catch (error) { console.warn("cloudflare_access_jwks_parse_failed", JSON.stringify({ error: String(error && error.name || "error") })); return { ok: false, reason: "jwks_unavailable" }; }
  const keys = Array.isArray(document && document.keys)
    ? document.keys.filter((key) => key && typeof key.kid === "string" && key.kid && key.kty === "RSA" && (!key.alg || key.alg === "RS256") && (!key.use || key.use === "sig"))
    : [];
  if (!keys.length) return { ok: false, reason: "jwks_unavailable" };
  jwksCache.set(issuer, { keys, expiresAt: nowMs + JWKS_TTL_MS, fetchedAt: nowMs });
  return { ok: true, keys };
}

/**
 * Verify the Cloudflare Access assertion on a request.
 * Returns { ok: true } or { ok: false, reason } where reason is one of: configuration, missing, malformed, algorithm,
 * jwks_unavailable, key_not_found, signature, issuer, audience, expired, not_yet_valid, issued_in_future.
 * Only the dedicated Cf-Access-Jwt-Assertion header is read; Authorization is deliberately not (staff API tokens use it).
 */
export async function verifyCloudflareAccessJwt(request, env, options = {}) {
  const issuer = normalizeAccessIssuer(env && env.CF_ACCESS_ISSUER);
  const audience = String((env && env.CF_ACCESS_AUD) || "").trim();
  if (!issuer || !isValidAccessAudience(audience)) return { ok: false, reason: "configuration" };

  const jwt = String(request.headers.get("Cf-Access-Jwt-Assertion") || "").trim();
  if (!jwt) return { ok: false, reason: "missing" };
  if (jwt.length > MAX_JWT_CHARS) return { ok: false, reason: "malformed" };
  const parts = jwt.split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) return { ok: false, reason: "malformed" };
  let header, claims, signature;
  try { header = decodeJsonPart(parts[0]); claims = decodeJsonPart(parts[1]); signature = decodeBase64Url(parts[2]); }
  catch (_) { return { ok: false, reason: "malformed" }; }
  if (!header || typeof header !== "object" || !claims || typeof claims !== "object" || Array.isArray(claims)) return { ok: false, reason: "malformed" };
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid) return { ok: false, reason: "algorithm" };

  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, reason: "jwks_unavailable" };
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  let jwks = await loadJwks(issuer, fetchImpl, nowMs, false);
  if (!jwks.ok) return jwks;
  let jwk = jwks.keys.find((key) => key.kid === header.kid);
  if (!jwk) { // keys rotate: look once more, rate limited, before giving up
    jwks = await loadJwks(issuer, fetchImpl, nowMs, true);
    if (!jwks.ok) return jwks;
    jwk = jwks.keys.find((key) => key.kid === header.kid);
  }
  if (!jwk) return { ok: false, reason: "key_not_found" };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch (error) {
    console.warn("cloudflare_access_jwt_verify_error", JSON.stringify({ error: String(error && error.name || "error") }));
    return { ok: false, reason: "signature" };
  }
  if (!valid) return { ok: false, reason: "signature" };

  // Claims are only trusted after the signature checked out.
  if (claims.iss !== issuer) return { ok: false, reason: "issuer" };
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(audience) : claims.aud === audience;
  if (!audOk) return { ok: false, reason: "audience" };
  const nowSeconds = Number.isFinite(options.nowSeconds) ? options.nowSeconds : Math.floor(nowMs / 1000);
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > nowSeconds + LEEWAY_SECONDS)) return { ok: false, reason: "not_yet_valid" };
  if (claims.iat !== undefined && (typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > nowSeconds + LEEWAY_SECONDS)) return { ok: false, reason: "issued_in_future" };
  return { ok: true, reason: "valid" };
}

/**
 * The request gate used by the Worker. Returns null to let the request continue, or { status, error } to refuse it.
 * off: null without reading anything else. shadow: logs a reason code and continues. enforce or invalid mode: refuses.
 */
export async function platformAccessGate(request, env, pathname, options = {}) {
  if (!isPlatformAccessPath(pathname)) return null;
  const mode = parsePlatformAccessMode(env);
  if (mode === "off") return null;
  if (mode === "invalid") {
    console.warn("cloudflare_access_jwt_check", JSON.stringify({ path: pathname, mode: "invalid", reason: "configuration" }));
    return { status: 503, error: "platform_access_unavailable" };
  }
  const verdict = await verifyCloudflareAccessJwt(request, env, options);
  if (verdict.ok) return null;
  console.warn("cloudflare_access_jwt_check", JSON.stringify({ path: pathname, mode, reason: verdict.reason }));
  if (mode === "shadow") return null;
  const unavailable = verdict.reason === "configuration" || verdict.reason === "jwks_unavailable";
  return unavailable ? { status: 503, error: "platform_access_unavailable" } : { status: 403, error: "platform_access_required" };
}
