// =====================================================
// STAFF TWO-FACTOR AUTHENTICATION (TOTP)
//
// Staff accounts control every customer, so a stolen password alone must not
// be enough. Flow:
//   password OK + 2FA active  ->  challenge (no session yet)
//   challenge + valid code    ->  session
// A challenge allows 5 wrong tries then dies, lasts 5 minutes, and is single
// use. A code that was already accepted cannot be reused (replay guard). Backup
// codes are single use. Enrolment is not active until a real code confirms it.
//
// STAFF_2FA_REQUIRED=true makes every staff session unusable (except for
// setting 2FA up) until that admin has enrolled.
// =====================================================
import { encryptSecret, decryptSecret } from "./crypto.js";
import { generateBase32Secret, generateTotpCode, buildOtpAuthUrl, generateBackupCodes, sha256Hex } from "./totp.js";

export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const MAX_CHALLENGE_ATTEMPTS = 5;
const STEP_MS = 30000;

export function twoFactorRequired(env) { return String(env.STAFF_2FA_REQUIRED || "").toLowerCase() === "true"; }

export async function getStaffTotpStatus(env, adminId) {
  const row = await env.LUMMET_DB.prepare(`SELECT status, confirmed_at, backup_codes_hash FROM lummet_admin_totp WHERE admin_id = ?`).bind(adminId).first();
  return { enabled: row?.status === "active", pending: row?.status === "pending", backupCodesLeft: row?.status === "active" ? JSON.parse(row.backup_codes_hash || "[]").length : 0 };
}

/** Returns the time-step number a code matches (within one step either side), or null. */
async function matchStep(secret, code, now = Date.now()) {
  const clean = String(code || "").replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return null;
  const nowStep = Math.floor(now / STEP_MS);
  let found = null;
  for (const offset of [-1, 0, 1]) {            // always checks all three: constant work
    const step = nowStep + offset;
    if ((await generateTotpCode(secret, step * STEP_MS)) === clean && found === null) found = step;
  }
  return found;
}

export async function startStaffTotpSetup(env, admin) {
  const existing = await env.LUMMET_DB.prepare(`SELECT status FROM lummet_admin_totp WHERE admin_id = ?`).bind(admin.id).first();
  if (existing?.status === "active") return { ok: false, status: 409, error: "already_enabled" };
  const secret = generateBase32Secret();
  const enc = await encryptSecret(env, secret);
  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_admin_totp (admin_id, encrypted_secret, secret_iv, status) VALUES (?, ?, ?, 'pending')
     ON CONFLICT(admin_id) DO UPDATE SET encrypted_secret = excluded.encrypted_secret, secret_iv = excluded.secret_iv, status = 'pending', confirmed_at = NULL, last_used_step = 0`
  ).bind(admin.id, enc.encryptedSecret, enc.secretIv).run();
  return { ok: true, secret, otpauthUrl: buildOtpAuthUrl({ secret, accountLabel: admin.email, issuer: "Lummet staff" }) };
}

export async function confirmStaffTotpSetup(env, adminId, code) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_admin_totp WHERE admin_id = ? AND status = 'pending'`).bind(adminId).first();
  if (!row) return { ok: false, status: 404, error: "no_pending_setup" };
  const step = await matchStep(await decryptSecret(env, row.encrypted_secret, row.secret_iv), code);
  if (step === null) return { ok: false, status: 422, error: "invalid_code" };
  const { codes, hashes } = await generateBackupCodes(10);
  await env.LUMMET_DB.prepare(
    `UPDATE lummet_admin_totp SET status = 'active', confirmed_at = CURRENT_TIMESTAMP, backup_codes_hash = ?, last_used_step = ? WHERE admin_id = ?`
  ).bind(JSON.stringify(hashes), step, adminId).run();
  return { ok: true, backupCodes: codes };      // shown once
}

/** Verifies a live code (with replay guard) or an unused backup code for an ACTIVE factor. */
async function verifyFactor(env, row, { code, backupCode }) {
  if (code) {
    const step = await matchStep(await decryptSecret(env, row.encrypted_secret, row.secret_iv), code);
    if (step === null) return { ok: false, status: 422, error: "invalid_code" };
    // Replay guard: only accept a step newer than the last accepted one. Done as
    // a single conditional UPDATE so two simultaneous uses of the same code
    // cannot both succeed.
    const upd = await env.LUMMET_DB.prepare(`UPDATE lummet_admin_totp SET last_used_step = ? WHERE admin_id = ? AND last_used_step < ?`).bind(step, row.admin_id, step).run();
    return upd.meta.changes ? { ok: true } : { ok: false, status: 422, error: "code_already_used" };
  }
  if (backupCode) {
    const hashes = JSON.parse(row.backup_codes_hash || "[]");
    const provided = await sha256Hex(String(backupCode).trim().toLowerCase());
    if (!hashes.includes(provided)) return { ok: false, status: 422, error: "invalid_backup_code" };
    const remaining = JSON.stringify(hashes.filter((h) => h !== provided));
    const upd = await env.LUMMET_DB.prepare(`UPDATE lummet_admin_totp SET backup_codes_hash = ? WHERE admin_id = ? AND backup_codes_hash = ?`).bind(remaining, row.admin_id, row.backup_codes_hash).run();
    return upd.meta.changes ? { ok: true, usedBackupCode: true } : { ok: false, status: 422, error: "invalid_backup_code" };
  }
  return { ok: false, status: 422, error: "code_or_backup_code_required" };
}

export async function disableStaffTotp(env, adminId, factor) {
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_admin_totp WHERE admin_id = ? AND status = 'active'`).bind(adminId).first();
  if (!row) return { ok: false, status: 404, error: "not_enabled" };
  const v = await verifyFactor(env, row, factor || {});
  if (!v.ok) return v;
  await env.LUMMET_DB.prepare(`DELETE FROM lummet_admin_totp WHERE admin_id = ?`).bind(adminId).run();
  return { ok: true };
}

/** A super admin removes another admin's 2FA (lost phone). Also ends that admin's sessions. */
export async function resetStaffTotp(env, targetAdminId) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM lummet_admin_totp WHERE admin_id = ?`).bind(targetAdminId).run();
  await env.LUMMET_DB.prepare(`DELETE FROM lummet_sessions WHERE admin_id = ?`).bind(targetAdminId).run();
  await env.LUMMET_DB.prepare(`DELETE FROM lummet_mfa_challenges WHERE admin_id = ?`).bind(targetAdminId).run();
  return r.meta.changes ? { ok: true } : { ok: false, status: 404, error: "not_enabled" };
}

export async function createChallenge(env, adminId) {
  const id = crypto.randomUUID();
  await env.LUMMET_DB.prepare(`DELETE FROM lummet_mfa_challenges WHERE expires_at < ?`).bind(new Date().toISOString()).run();
  await env.LUMMET_DB.prepare(`INSERT INTO lummet_mfa_challenges (id, admin_id, expires_at) VALUES (?, ?, ?)`).bind(id, adminId, new Date(Date.now() + CHALLENGE_TTL_MS).toISOString()).run();
  return id;
}

/** Checks a code for a challenge. On success the challenge is consumed and { ok, adminId } returned. */
export async function completeChallenge(env, challengeId, factor) {
  const ch = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_mfa_challenges WHERE id = ?`).bind(String(challengeId || "")).first();
  if (!ch) return { ok: false, status: 404, error: "invalid_challenge" };
  if (new Date(ch.expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`DELETE FROM lummet_mfa_challenges WHERE id = ?`).bind(ch.id).run();
    return { ok: false, status: 410, error: "challenge_expired" };
  }
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_admin_totp WHERE admin_id = ? AND status = 'active'`).bind(ch.admin_id).first();
  if (!row) { await env.LUMMET_DB.prepare(`DELETE FROM lummet_mfa_challenges WHERE id = ?`).bind(ch.id).run(); return { ok: false, status: 404, error: "invalid_challenge" }; }

  const v = await verifyFactor(env, row, factor || {});
  if (!v.ok) {
    const attempts = ch.attempts + 1;
    if (attempts >= MAX_CHALLENGE_ATTEMPTS) {
      await env.LUMMET_DB.prepare(`DELETE FROM lummet_mfa_challenges WHERE id = ?`).bind(ch.id).run();
      return { ok: false, status: 429, error: "too_many_attempts" };
    }
    await env.LUMMET_DB.prepare(`UPDATE lummet_mfa_challenges SET attempts = ? WHERE id = ?`).bind(attempts, ch.id).run();
    return v;
  }
  const del = await env.LUMMET_DB.prepare(`DELETE FROM lummet_mfa_challenges WHERE id = ?`).bind(ch.id).run();
  if (!del.meta.changes) return { ok: false, status: 404, error: "invalid_challenge" };   // used by a parallel request
  return { ok: true, adminId: ch.admin_id, usedBackupCode: !!v.usedBackupCode };
}
