// =====================================================
// TWO-FACTOR AUTHENTICATION (TOTP, RFC 6238)
//
// A real, standard TOTP implementation (compatible with
// Google Authenticator / Authy / 1Password, etc.) — Base32
// encoding (RFC 4648 §6) and HOTP (RFC 4226) via HMAC-SHA1,
// both implemented directly against the Workers runtime's Web
// Crypto (SHA-1 is still required for TOTP interoperability
// even though it's avoided elsewhere in this codebase for new
// designs — this is what every authenticator app expects).
//
// The secret is encrypted at rest via crypto.js — the same
// mechanism already protecting tenant Super API credentials
// and webhook signing secrets (rule against duplicate secret
// storage).
// =====================================================

import { encryptSecret, decryptSecret } from "./crypto.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TIME_STEP_SECONDS = 30;
const CODE_DIGITS = 6;
const VERIFICATION_WINDOW = 1; // accept the code from 1 step before/after, for clock drift

function base32Encode(bytes) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");

  let output = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) {
    output += BASE32_ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  }
  const remainder = bits.length % 5;
  if (remainder > 0) {
    const lastChunk = bits.slice(bits.length - remainder).padEnd(5, "0");
    output += BASE32_ALPHABET[parseInt(lastChunk, 2)];
  }
  return output;
}

function base32Decode(encoded) {
  const cleaned = encoded.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = "";
  for (const char of cleaned) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return new Uint8Array(bytes);
}

export function generateBase32Secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(20)); // 160 bits, standard TOTP secret length
  return base32Encode(bytes);
}

async function hotp(secretBytes, counter) {
  const counterBytes = new ArrayBuffer(8);
  const counterView = new DataView(counterBytes);
  // Counter is a 64-bit big-endian integer; JS numbers are safe up to
  // 2^53, and a Unix-time-derived counter will never approach that.
  counterView.setUint32(4, counter, false);

  const key = await crypto.subtle.importKey("raw", secretBytes, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counterBytes));

  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) | ((hmac[offset + 1] & 0xff) << 16) | ((hmac[offset + 2] & 0xff) << 8) | (hmac[offset + 3] & 0xff);

  return String(binary % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, "0");
}

export async function generateTotpCode(base32Secret, forTimeMs = Date.now()) {
  const counter = Math.floor(forTimeMs / 1000 / TIME_STEP_SECONDS);
  return hotp(base32Decode(base32Secret), counter);
}

/**
 * Accepts a code from the current time step or up to
 * VERIFICATION_WINDOW steps before/after it, to tolerate ordinary
 * clock drift between the user's device and this server — the same
 * tolerance every standard TOTP implementation applies.
 */
export async function verifyTotpCode(base32Secret, code, forTimeMs = Date.now()) {
  if (!code || !/^\d{6}$/.test(code)) return false;

  const secretBytes = base32Decode(base32Secret);
  const currentCounter = Math.floor(forTimeMs / 1000 / TIME_STEP_SECONDS);

  for (let delta = -VERIFICATION_WINDOW; delta <= VERIFICATION_WINDOW; delta++) {
    const candidate = await hotp(secretBytes, currentCounter + delta);
    if (candidate === code) return true;
  }
  return false;
}

export function buildOtpAuthUrl({ secret, accountLabel, issuer = "Lummet" }) {
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: String(CODE_DIGITS), period: String(TIME_STEP_SECONDS) });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}?${params.toString()}`;
}

// -----------------------------------------------------
// Backup codes — single-use, shown once, only hashes stored.
// -----------------------------------------------------

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateBackupCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}

export async function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) codes.push(generateBackupCode());
  const hashes = await Promise.all(codes.map(sha256Hex));
  return { codes, hashes };
}

// -----------------------------------------------------
// Customer-facing service
// -----------------------------------------------------

export async function getTotpStatus(env, userId) {
  const row = await env.LUMMET_DB.prepare(`SELECT status FROM customer_totp WHERE user_id = ?`).bind(userId).first();
  return { enabled: row?.status === "active" };
}

/** Starts setup: generates a new secret, stores it encrypted as 'pending' (not yet protecting the account). */
export async function startTotpSetup(env, userId) {
  const existing = await env.LUMMET_DB.prepare(`SELECT status FROM customer_totp WHERE user_id = ?`).bind(userId).first();
  if (existing?.status === "active") return { ok: false, status: 409, error: "already_enabled" };

  const user = await env.LUMMET_DB.prepare(`SELECT email FROM customer_users WHERE id = ?`).bind(userId).first();
  if (!user) return { ok: false, status: 404, error: "user_not_found" };

  const secret = generateBase32Secret();
  const { encryptedSecret, secretIv } = await encryptSecret(env, secret);

  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_totp (user_id, encrypted_secret, secret_iv, status) VALUES (?, ?, ?, 'pending')
     ON CONFLICT(user_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, secret_iv = excluded.secret_iv, status = 'pending', confirmed_at = NULL`
  )
    .bind(userId, encryptedSecret, secretIv)
    .run();

  return { ok: true, secret, otpauthUrl: buildOtpAuthUrl({ secret, accountLabel: user.email }) };
}

/** Confirms setup with a real code from the user's authenticator app — 2FA is not active until this succeeds. */
export async function confirmTotpSetup(env, userId, code) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM customer_totp WHERE user_id = ? AND status = 'pending'`).bind(userId).first();
  if (!row) return { ok: false, status: 404, error: "no_pending_setup" };

  const secret = await decryptSecret(env, row.encrypted_secret, row.secret_iv);
  const valid = await verifyTotpCode(secret, code);
  if (!valid) return { ok: false, status: 422, error: "invalid_code" };

  const { codes, hashes } = await generateBackupCodes();
  await env.LUMMET_DB.prepare(
    `UPDATE customer_totp SET status = 'active', confirmed_at = CURRENT_TIMESTAMP, backup_codes_hash = ? WHERE user_id = ?`
  )
    .bind(JSON.stringify(hashes), userId)
    .run();

  // Shown once — same pattern as every other generated secret in
  // this codebase.
  return { ok: true, backupCodes: codes };
}

/** Disabling requires proving current possession — either a live code or an unused backup code. */
export async function disableTotp(env, userId, { code, backupCode } = {}) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM customer_totp WHERE user_id = ? AND status = 'active'`).bind(userId).first();
  if (!row) return { ok: false, status: 404, error: "not_enabled" };

  const verified = await verifyEitherFactor(env, row, { code, backupCode });
  if (!verified.ok) return verified;

  await env.LUMMET_DB.prepare(`DELETE FROM customer_totp WHERE user_id = ?`).bind(userId).run();
  return { ok: true };
}

async function verifyEitherFactor(env, row, { code, backupCode }) {
  if (code) {
    const secret = await decryptSecret(env, row.encrypted_secret, row.secret_iv);
    if (await verifyTotpCode(secret, code)) return { ok: true };
    return { ok: false, status: 422, error: "invalid_code" };
  }
  if (backupCode) {
    const hashes = JSON.parse(row.backup_codes_hash || "[]");
    const providedHash = await sha256Hex(backupCode.trim());
    if (hashes.includes(providedHash)) {
      const remaining = hashes.filter((h) => h !== providedHash);
      await env.LUMMET_DB.prepare(`UPDATE customer_totp SET backup_codes_hash = ? WHERE user_id = ?`)
        .bind(JSON.stringify(remaining), row.user_id)
        .run();
      return { ok: true };
    }
    return { ok: false, status: 422, error: "invalid_backup_code" };
  }
  return { ok: false, status: 422, error: "code_or_backup_code_required" };
}

/** Used by customer-auth.js's login flow to check a code/backup code against an ACTIVE user's factor. */
export async function verifyFactorForLogin(env, userId, { code, backupCode }) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM customer_totp WHERE user_id = ? AND status = 'active'`).bind(userId).first();
  if (!row) return { ok: false, status: 404, error: "not_enabled" };
  return verifyEitherFactor(env, row, { code, backupCode });
}
