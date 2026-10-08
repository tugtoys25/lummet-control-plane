// =====================================================
// JWT VERIFICATION (RFC 7519 / RFC 7518)
//
// Supports RS256 and ES256 — the two algorithms virtually
// every OIDC identity provider (Okta, Azure AD, Google
// Workspace, Auth0, OneLogin) issues ID tokens with. Signature
// verification uses Web Crypto directly against a JWK
// (imported via the "jwk" key format Web Crypto supports
// natively — no custom key-parsing needed here, unlike
// WebAuthn's COSE keys).
//
// IMPORTANT DISTINCTION from webauthn.js: JOSE (JWT) ES256
// signatures are the raw r||s concatenation per RFC 7518 —
// NOT the DER encoding WebAuthn/CBOR/COSE signatures use. No
// DER-to-raw conversion happens here; Web Crypto's verify()
// takes this format directly for both RS256 and ES256. Mixing
// these two signature encodings up is a real, documented
// source of bugs in JWT/WebAuthn implementations that share
// code carelessly — this module and webauthn.js deliberately
// do NOT share a signature-conversion helper.
// =====================================================

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function base64UrlDecodeToString(str) {
  return new TextDecoder().decode(base64UrlToBytes(str));
}

const ALG_TO_WEBCRYPTO = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  ES256: { name: "ECDSA", hash: "SHA-256" }
};

async function importJwk(jwk, alg) {
  if (alg === "RS256") return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  if (alg === "ES256") return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  throw new Error(`unsupported JWT algorithm ${alg}`);
}

/** Reads the header/payload WITHOUT verifying anything — only safe for picking which JWK to try (`kid`), never for trusting any claim. */
export function decodeJwtUnverified(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed JWT");
  return { header: JSON.parse(base64UrlDecodeToString(parts[0])), payload: JSON.parse(base64UrlDecodeToString(parts[1])) };
}

/**
 * Full verification: signature (against a matching key in `jwks` by
 * `kid`), expiry, issuer, audience, and — for OIDC — nonce, all
 * required for the result to be trusted. Returns {ok:false, error}
 * for any failure, never throws for ordinary malformed/invalid
 * input (only for a genuinely unexpected internal error).
 */
export async function verifyJwt(token, jwks, { issuer, audience, nonce, clockToleranceSeconds = 60 } = {}) {
  const parts = (token || "").split(".");
  if (parts.length !== 3) return { ok: false, error: "malformed_token" };
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(base64UrlDecodeToString(headerB64));
    payload = JSON.parse(base64UrlDecodeToString(payloadB64));
  } catch (_) {
    return { ok: false, error: "malformed_token" };
  }

  if (!ALG_TO_WEBCRYPTO[header.alg]) return { ok: false, error: "unsupported_algorithm" };

  const jwk = (jwks?.keys || []).find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, error: "unknown_signing_key" };

  let publicKey;
  try {
    publicKey = await importJwk(jwk, header.alg);
  } catch (_) {
    return { ok: false, error: "invalid_signing_key" };
  }

  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let signatureValid;
  try {
    signatureValid = await crypto.subtle.verify(ALG_TO_WEBCRYPTO[header.alg], publicKey, base64UrlToBytes(signatureB64), signedInput);
  } catch (_) {
    return { ok: false, error: "invalid_signature" };
  }
  if (!signatureValid) return { ok: false, error: "invalid_signature" };

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp + clockToleranceSeconds < now) {
    return { ok: false, error: "token_expired" };
  }
  if (issuer && payload.iss !== issuer) return { ok: false, error: "issuer_mismatch" };
  if (audience) {
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(audience)) return { ok: false, error: "audience_mismatch" };
  }
  if (nonce && payload.nonce !== nonce) return { ok: false, error: "nonce_mismatch" };

  return { ok: true, claims: payload };
}
