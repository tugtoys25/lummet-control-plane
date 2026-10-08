// =====================================================
// WEBAUTHN / PASSKEYS (master prompt Phase 7)
//
// Real registration and authentication ceremonies per the
// WebAuthn Level 2 spec, using only Web Crypto (ECDSA P-256/
// SHA-256, ES256 — algorithm -7, the one every platform
// authenticator and modern security key supports) and the
// minimal CBOR decoder in cbor.js. No third-party WebAuthn
// library — none is usable in this build-step-free Workers
// environment, and the binary parsing involved (authenticator
// data layout, COSE key extraction, DER-to-raw ECDSA signature
// conversion) is small and precisely bounded by the spec.
//
// See migration 0015's header for what this does NOT do
// (verify attestation certificate chains) and why that's an
// intentional, standard scope choice, not a shortcut.
//
// HONESTY NOTE: the registration/authentication logic below is
// fully unit-tested against self-constructed ceremony data
// (real Web Crypto P-256 keys, hand-built CBOR and authData
// byte layouts per spec) — see test/webauthn.test.js. It has
// not been exercised against a real browser/authenticator in
// this environment. The main real-world risk in a WebAuthn
// implementation is exactly this binary parsing, which the
// tests exercise directly; a live browser round-trip is still
// the right next step before shipping.
// =====================================================

import { decodeCbor, decodeCborAt } from "./cbor.js";
import { createSession } from "./customer-auth.js";

const CHALLENGE_TTL_MS = 1000 * 60 * 5; // 5 minutes

// -----------------------------------------------------
// base64url helpers
// -----------------------------------------------------

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(str) {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// -----------------------------------------------------
// DER (ASN.1) -> raw r||s ECDSA signature conversion.
// WebAuthn authenticators sign with DER-encoded ECDSA
// signatures (FIDO2/CTAP2); Web Crypto's verify() expects raw,
// fixed-length r||s (confirmed empirically: a P-256 signature
// from crypto.subtle.sign is exactly 64 bytes, not DER — see
// this module's test file for the check this claim is based on).
// -----------------------------------------------------

function readDerLength(bytes, offset) {
  const first = bytes[offset];
  if ((first & 0x80) === 0) return { length: first, offset: offset + 1 };
  const numBytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < numBytes; i++) length = (length << 8) | bytes[offset + 1 + i];
  return { length, offset: offset + 1 + numBytes };
}

function readDerInteger(bytes, offset) {
  if (bytes[offset] !== 0x02) throw new Error("expected DER INTEGER tag");
  const { length, offset: contentStart } = readDerLength(bytes, offset + 1);
  return { valueBytes: bytes.slice(contentStart, contentStart + length), offset: contentStart + length };
}

function toFixedLength(bytes, size) {
  let b = bytes;
  while (b.length > size && b[0] === 0) b = b.slice(1);
  if (b.length > size) throw new Error("DER integer too large for field size");
  if (b.length === size) return b;
  const padded = new Uint8Array(size);
  padded.set(b, size - b.length);
  return padded;
}

function derSignatureToRaw(der, fieldSizeBytes = 32) {
  if (der[0] !== 0x30) throw new Error("expected DER SEQUENCE tag");
  const { offset: contentStart } = readDerLength(der, 1);
  const r = readDerInteger(der, contentStart);
  const s = readDerInteger(der, r.offset);
  const raw = new Uint8Array(fieldSizeBytes * 2);
  raw.set(toFixedLength(r.valueBytes, fieldSizeBytes), 0);
  raw.set(toFixedLength(s.valueBytes, fieldSizeBytes), fieldSizeBytes);
  return raw;
}

function getRpConfig(env) {
  if (!env.WEBAUTHN_RP_ID || !env.WEBAUTHN_ORIGIN) return null;
  return { rpId: env.WEBAUTHN_RP_ID, origin: env.WEBAUTHN_ORIGIN };
}

// -----------------------------------------------------
// Registration
// -----------------------------------------------------

export async function generateRegistrationOptions(env, userId) {
  const rp = getRpConfig(env);
  if (!rp) return { ok: false, status: 500, error: "webauthn_not_configured" };

  const user = await env.LUMMET_DB.prepare(`SELECT id, email FROM customer_users WHERE id = ?`).bind(userId).first();
  if (!user) return { ok: false, status: 404, error: "user_not_found" };

  const existingResult = await env.LUMMET_DB.prepare(`SELECT credential_id FROM customer_webauthn_credentials WHERE user_id = ?`)
    .bind(userId)
    .all();
  const excludeCredentials = (existingResult.results || []).map((r) => ({ id: r.credential_id, type: "public-key" }));

  const challenge = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeId = crypto.randomUUID();

  await env.LUMMET_DB.prepare(
    `INSERT INTO webauthn_challenges (id, user_id, challenge, type, expires_at) VALUES (?, ?, ?, 'registration', ?)`
  )
    .bind(challengeId, userId, challenge, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString())
    .run();

  return {
    ok: true,
    options: {
      challenge,
      rp: { id: rp.rpId, name: "Lummet" },
      user: { id: bytesToBase64Url(new TextEncoder().encode(userId)), name: user.email, displayName: user.email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 only
      excludeCredentials,
      authenticatorSelection: { userVerification: "preferred" },
      timeout: 60000
    }
  };
}

/**
 * Verifies a browser's navigator.credentials.create() response.
 * `credential` is the JSON-serialized PublicKeyCredential the
 * customer portal's client-side JS sends: { id, response: {
 * clientDataJSON, attestationObject } }, each field base64url.
 */
export async function verifyRegistration(env, userId, credential, nickname) {
  const rp = getRpConfig(env);
  if (!rp) return { ok: false, status: 500, error: "webauthn_not_configured" };

  const clientDataBytes = base64UrlToBytes(credential.response.clientDataJSON);
  const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));

  if (clientData.type !== "webauthn.create") return { ok: false, status: 422, error: "invalid_ceremony_type" };
  if (clientData.origin !== rp.origin) return { ok: false, status: 422, error: "origin_mismatch" };

  const challengeRow = await env.LUMMET_DB.prepare(
    `SELECT * FROM webauthn_challenges WHERE challenge = ? AND user_id = ? AND type = 'registration'`
  )
    .bind(clientData.challenge, userId)
    .first();
  if (!challengeRow) return { ok: false, status: 422, error: "invalid_challenge" };
  if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(challengeRow.id).run();
    return { ok: false, status: 410, error: "challenge_expired" };
  }
  await env.LUMMET_DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(challengeRow.id).run();

  const attestationObject = decodeCbor(base64UrlToBytes(credential.response.attestationObject));
  const authData = attestationObject.get("authData");
  if (!authData) return { ok: false, status: 422, error: "missing_auth_data" };

  const rpIdHash = authData.slice(0, 32);
  if (!bytesEqual(rpIdHash, await sha256(new TextEncoder().encode(rp.rpId)))) {
    return { ok: false, status: 422, error: "rp_id_mismatch" };
  }

  const flags = authData[32];
  if ((flags & 0x01) === 0) return { ok: false, status: 422, error: "user_not_present" };
  if ((flags & 0x40) === 0) return { ok: false, status: 422, error: "no_attested_credential_data" };

  const signCount = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0, false);

  let cursor = 37 + 16; // past rpIdHash(32) + flags(1) + counter(4) + aaguid(16)
  const credIdLen = new DataView(authData.buffer, authData.byteOffset + cursor, 2).getUint16(0, false);
  cursor += 2;
  const credentialIdBytes = authData.slice(cursor, cursor + credIdLen);
  cursor += credIdLen;

  const { value: coseKey } = decodeCborAt(authData, cursor);
  // kty=2 (EC2), alg=-7 (ES256), crv=1 (P-256) — the only combination
  // this module supports, matching the single algorithm offered in
  // pubKeyCredParams above.
  if (coseKey.get(1) !== 2 || coseKey.get(3) !== -7 || coseKey.get(-1) !== 1) {
    return { ok: false, status: 422, error: "unsupported_key_type" };
  }

  const publicKeyRaw = new Uint8Array(65);
  publicKeyRaw[0] = 0x04; // uncompressed point marker
  publicKeyRaw.set(coseKey.get(-2), 1);
  publicKeyRaw.set(coseKey.get(-3), 33);

  const credentialId = bytesToBase64Url(credentialIdBytes);
  const alreadyRegistered = await env.LUMMET_DB.prepare(`SELECT id FROM customer_webauthn_credentials WHERE credential_id = ?`)
    .bind(credentialId)
    .first();
  if (alreadyRegistered) return { ok: false, status: 409, error: "credential_already_registered" };

  const id = crypto.randomUUID();
  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_webauthn_credentials (id, user_id, credential_id, public_key_raw, sign_count, nickname) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(id, userId, credentialId, bytesToBase64Url(publicKeyRaw), signCount, nickname || null)
    .run();

  return { ok: true, credentialId };
}

// -----------------------------------------------------
// Authentication (also used as passwordless login)
// -----------------------------------------------------

export async function generateAuthenticationOptions(env, userId) {
  const rp = getRpConfig(env);
  if (!rp) return { ok: false, status: 500, error: "webauthn_not_configured" };

  const credsResult = await env.LUMMET_DB.prepare(`SELECT credential_id FROM customer_webauthn_credentials WHERE user_id = ?`)
    .bind(userId)
    .all();
  const allowCredentials = (credsResult.results || []).map((r) => ({ id: r.credential_id, type: "public-key" }));
  if (allowCredentials.length === 0) return { ok: false, status: 404, error: "no_credentials_registered" };

  const challenge = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeId = crypto.randomUUID();

  await env.LUMMET_DB.prepare(
    `INSERT INTO webauthn_challenges (id, user_id, challenge, type, expires_at) VALUES (?, ?, ?, 'authentication', ?)`
  )
    .bind(challengeId, userId, challenge, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString())
    .run();

  return { ok: true, options: { challenge, rpId: rp.rpId, allowCredentials, userVerification: "preferred", timeout: 60000 } };
}

/**
 * Entry point for passwordless login: resolves email to a user
 * without ever revealing whether that was the failure reason (same
 * "don't leak account existence" posture as customer-auth.js's
 * requestPasswordReset).
 */
export async function generateLoginOptions(env, email) {
  const user = await env.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = ?`)
    .bind((email || "").trim().toLowerCase())
    .first();
  if (!user) return { ok: false, status: 401, error: "no_passkey_available" };

  const result = await generateAuthenticationOptions(env, user.id);
  if (!result.ok) return { ok: false, status: 401, error: "no_passkey_available" };
  return result;
}

/**
 * Verifies a navigator.credentials.get() response. `credential` is
 * { id, response: { clientDataJSON, authenticatorData, signature } },
 * each field base64url. Identifies the user from the challenge row,
 * not from anything the client claims — the same principle as never
 * trusting a browser-supplied id without verifying ownership.
 */
export async function verifyAuthentication(env, credential) {
  const rp = getRpConfig(env);
  if (!rp) return { ok: false, status: 500, error: "webauthn_not_configured" };

  const clientDataBytes = base64UrlToBytes(credential.response.clientDataJSON);
  const clientData = JSON.parse(new TextDecoder().decode(clientDataBytes));
  if (clientData.type !== "webauthn.get") return { ok: false, status: 422, error: "invalid_ceremony_type" };
  if (clientData.origin !== rp.origin) return { ok: false, status: 422, error: "origin_mismatch" };

  const challengeRow = await env.LUMMET_DB.prepare(`SELECT * FROM webauthn_challenges WHERE challenge = ? AND type = 'authentication'`)
    .bind(clientData.challenge)
    .first();
  if (!challengeRow) return { ok: false, status: 422, error: "invalid_challenge" };
  if (new Date(challengeRow.expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(challengeRow.id).run();
    return { ok: false, status: 410, error: "challenge_expired" };
  }
  await env.LUMMET_DB.prepare(`DELETE FROM webauthn_challenges WHERE id = ?`).bind(challengeRow.id).run();

  const credRow = await env.LUMMET_DB.prepare(`SELECT * FROM customer_webauthn_credentials WHERE credential_id = ? AND user_id = ?`)
    .bind(credential.id, challengeRow.user_id)
    .first();
  if (!credRow) return { ok: false, status: 404, error: "credential_not_found" };

  const authDataBytes = base64UrlToBytes(credential.response.authenticatorData);
  if (!bytesEqual(authDataBytes.slice(0, 32), await sha256(new TextEncoder().encode(rp.rpId)))) {
    return { ok: false, status: 422, error: "rp_id_mismatch" };
  }

  const flags = authDataBytes[32];
  if ((flags & 0x01) === 0) return { ok: false, status: 422, error: "user_not_present" };

  const counter = new DataView(authDataBytes.buffer, authDataBytes.byteOffset + 33, 4).getUint32(0, false);
  // A nonzero counter that hasn't advanced past what we last saw is
  // the standard WebAuthn signal for a cloned authenticator. Some
  // authenticators never implement counters and always send 0 —
  // that's explicitly allowed by the spec and not treated as cloning.
  if (counter !== 0 && counter <= credRow.sign_count) {
    return { ok: false, status: 422, error: "possible_cloned_authenticator" };
  }

  const clientDataHash = await sha256(clientDataBytes);
  const signedData = new Uint8Array(authDataBytes.length + clientDataHash.length);
  signedData.set(authDataBytes, 0);
  signedData.set(clientDataHash, authDataBytes.length);

  const signatureRaw = derSignatureToRaw(base64UrlToBytes(credential.response.signature), 32);
  const publicKey = await crypto.subtle.importKey(
    "raw",
    base64UrlToBytes(credRow.public_key_raw),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signatureRaw, signedData);
  if (!valid) return { ok: false, status: 422, error: "invalid_signature" };

  await env.LUMMET_DB.prepare(`UPDATE customer_webauthn_credentials SET sign_count = ?, last_used_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(counter, credRow.id)
    .run();

  return { ok: true, userId: challengeRow.user_id };
}

export async function completePasswordlessLogin(env, credential) {
  const verified = await verifyAuthentication(env, credential);
  if (!verified.ok) return verified;

  const user = await env.LUMMET_DB.prepare(`SELECT id, email, status FROM customer_users WHERE id = ?`)
    .bind(verified.userId)
    .first();
  if (!user || user.status === "disabled") return { ok: false, status: 403, error: "account_disabled" };

  const firstOrg = await env.LUMMET_DB.prepare(
    `SELECT organization_id FROM organization_users WHERE user_id = ? ORDER BY created_at LIMIT 1`
  )
    .bind(user.id)
    .first();
  const session = await createSession(env, user.id, firstOrg?.organization_id || null);

  return { ok: true, userId: user.id, email: user.email, cookie: session.cookie };
}

// -----------------------------------------------------
// Management
// -----------------------------------------------------

export async function listCredentials(env, userId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT id, nickname, created_at, last_used_at FROM customer_webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(userId)
    .all();
  return result.results || [];
}

export async function deleteCredential(env, userId, credentialRowId) {
  const existing = await env.LUMMET_DB.prepare(`SELECT id FROM customer_webauthn_credentials WHERE id = ? AND user_id = ?`)
    .bind(credentialRowId, userId)
    .first();
  if (!existing) return { ok: false, status: 404, error: "not_found" };

  await env.LUMMET_DB.prepare(`DELETE FROM customer_webauthn_credentials WHERE id = ?`).bind(credentialRowId).run();
  return { ok: true };
}
