// =====================================================
// LUMMET MASTER ADMIN AUTH
// Self-contained identity system for the control plane.
// Deliberately NOT connected to any tenant's `users` table
// (rule #27) — a tenant admin never inherits Lummet master
// access, and a Lummet admin never becomes a tenant user.
// =====================================================

import { getStaffTotpStatus, createChallenge, completeChallenge } from "./staff-2fa.js";
import { hashPasswordWith, hashPasswordForEnv, verifyPasswordHash, passwordHashNeedsUpgrade } from "./password-hash.js";
import { updateStaffPasswordHash } from "./repositories/password-hashes.js";

const SESSION_COOKIE = "lummet_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 12; // 12 hours

// -----------------------------------------------------
// Password hashing (PBKDF2-SHA256; formats and rehash in password-hash.js)
// -----------------------------------------------------

// Without an env this is the legacy format, byte-for-byte as in every earlier release (the tenant repo copies it and a test checks
// the two agree). With an env it follows PASSWORD_HASH_FORMAT (see password-hash.js).
export async function hashPassword(password, env = null) {
  return env ? hashPasswordForEnv(password, env) : hashPasswordWith(password);
}

// Workers don't expose Node's crypto.timingSafeEqual, so this is the
// same manual constant-time byte comparison already used for Super
// API HMAC signatures (see the tenant's en/worker/super/auth.js and
// this repo's signing.js) — kept identical here rather than
// reimplemented, so both trust-critical comparisons in this codebase
// share one verified pattern. Exported as a plain, immutable named
// export solely so the test suite can exercise its own edge-case
// behavior directly; verifyPassword() below calls this module-level
// function directly and has no dependency on the export.
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    // Still walk equal-ish length to avoid a cheap length-based
    // timing signal, then return false regardless.
    let dummy = 0;
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dummy |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function verifyPassword(password, storedHash) {
  return verifyPasswordHash(password, storedHash, constantTimeEqual);
}

/** Rewrite a staff hash in the target format after a correct password. A failure is logged and never blocks the login. */
async function upgradeStaffHashIfNeeded(env, admin, password) {
  if (!passwordHashNeedsUpgrade(admin.password_hash, env)) return;
  try {
    await updateStaffPasswordHash(env, admin.id, await hashPasswordForEnv(password, env));
  } catch (err) {
    console.error("password_rehash_failed", { scope: "staff", adminId: admin.id, message: String(err && err.message || err).slice(0, 120) });
  }
}

// -----------------------------------------------------
// Rate limiting (mirrors the tenant repo's auth_attempts pattern)
// -----------------------------------------------------

async function hashIP(ip) {
  if (!ip) return "";
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function checkRateLimit(env, ipHash, action) {
  const windowMinutes = 15;
  const maxAttempts = 5;
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  await env.LUMMET_DB.prepare(
    `DELETE FROM lummet_auth_attempts WHERE created_at < ?`
  ).bind(windowStart).run();

  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM lummet_auth_attempts WHERE ip_hash = ? AND action = ? AND created_at >= ?`
  ).bind(ipHash, action, windowStart).first();

  return (row?.c || 0) < maxAttempts;
}

async function logFailedAttempt(env, ipHash, action) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_auth_attempts (ip_hash, action, created_at) VALUES (?, ?, ?)`
  ).bind(ipHash, action, new Date().toISOString()).run();
}

// -----------------------------------------------------
// Bootstrap — creates the first admin, only when none exist.
// This is the only unauthenticated write this module allows.
// -----------------------------------------------------

export async function hasAnyAdmins(env) {
  const countRow = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM lummet_admins`
  ).first();
  return (countRow?.c || 0) > 0;
}

export async function bootstrapFirstAdmin(env, email, password) {
  const countRow = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM lummet_admins`
  ).first();

  if ((countRow?.c || 0) > 0) {
    return { ok: false, status: 403, error: "already_bootstrapped" };
  }

  if (!email || !password || password.length < 12) {
    return { ok: false, status: 422, error: "invalid_email_or_password" };
  }

  const passwordHash = await hashPassword(password, env);
  const trimmedEmail = email.trim();

  const inserted = await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_admins (email, password_hash, role) VALUES (?, ?, 'master_admin') RETURNING id`
  ).bind(trimmedEmail, passwordHash).first();

  return { ok: true, adminId: inserted?.id ?? null, email: trimmedEmail };
}

// -----------------------------------------------------
// Login / logout / session lookup
// -----------------------------------------------------

export async function hashIPForRateLimit(request) {
  return hashIP(request.headers.get("CF-Connecting-IP"));
}

export async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = (body.email || "").trim();
  const password = body.password || "";
  const ipHash = await hashIP(request.headers.get("CF-Connecting-IP"));
  return authenticateAdmin(env, email, password, ipHash);
}

/**
 * Core credential check, independent of how email/password were
 * obtained. Use this directly (instead of login()) whenever the
 * request body has already been consumed by something else — e.g.
 * a page route that parsed it as form data — since Request bodies
 * can only be read once.
 */
export async function authenticateAdmin(env, email, password, ipHash) {
  email = (email || "").trim();
  password = password || "";

  if (!email || !password) {
    return { ok: false, status: 400, error: "email_and_password_required", email };
  }

  const allowed = await checkRateLimit(env, ipHash, "login");
  if (!allowed) {
    return { ok: false, status: 429, error: "too_many_attempts", email };
  }

  const admin = await env.LUMMET_DB.prepare(
    `SELECT * FROM lummet_admins WHERE email = ?`
  ).bind(email).first();

  if (!admin) {
    await logFailedAttempt(env, ipHash, "login");
    return { ok: false, status: 401, error: "invalid_credentials", email };
  }

  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) {
    await logFailedAttempt(env, ipHash, "login");
    return { ok: false, status: 401, error: "invalid_credentials", email, adminId: admin.id };
  }

  if (admin.status === "disabled") {
    await logFailedAttempt(env, ipHash, "login");
    return { ok: false, status: 403, error: "account_disabled", email, adminId: admin.id };
  }

  await upgradeStaffHashIfNeeded(env, admin, password);

  // 2FA gate: a verified password alone is NOT a login for an admin with an
  // active second factor. Only a short-lived challenge is created; the session
  // is issued by completeAdminMfaLogin() once a valid code is presented.
  if ((await getStaffTotpStatus(env, admin.id)).enabled) {
    const challengeId = await createChallenge(env, admin.id);
    return { ok: true, mfaRequired: true, challengeId, adminId: admin.id, email: admin.email };
  }

  return createAdminSession(env, admin);
}

async function createAdminSession(env, admin) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_sessions (id, admin_id, expires_at) VALUES (?, ?, ?)`
  ).bind(sessionId, admin.id, expiresAt).run();

  return {
    ok: true,
    sessionId,
    adminId: admin.id,
    email: admin.email,
    cookie: `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DURATION_MS / 1000}`
  };
}

/**
 * Second step of a staff login. Wrong codes count against the same per-IP
 * limit as bad passwords, and each challenge dies after a few wrong tries.
 */
export async function completeAdminMfaLogin(env, challengeId, factor, ipHash) {
  if (!(await checkRateLimit(env, ipHash, "login_mfa"))) return { ok: false, status: 429, error: "too_many_attempts" };
  const result = await completeChallenge(env, challengeId, factor);
  if (!result.ok) {
    if (result.error !== "challenge_expired") await logFailedAttempt(env, ipHash, "login_mfa");
    return result;
  }
  const admin = await env.LUMMET_DB.prepare(`SELECT * FROM lummet_admins WHERE id = ?`).bind(result.adminId).first();
  if (!admin || admin.status === "disabled") return { ok: false, status: 403, error: "account_disabled" };
  return { ...(await createAdminSession(env, admin)), usedBackupCode: result.usedBackupCode };
}

export async function logout(request, env) {
  const sessionId = getSessionIdFromRequest(request);
  let adminId = null;

  if (sessionId) {
    const session = await env.LUMMET_DB.prepare(
      `SELECT admin_id FROM lummet_sessions WHERE id = ?`
    ).bind(sessionId).first();
    adminId = session?.admin_id ?? null;

    await env.LUMMET_DB.prepare(`DELETE FROM lummet_sessions WHERE id = ?`)
      .bind(sessionId)
      .run();
  }

  return {
    adminId,
    cookie: `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
  };
}

function getSessionIdFromRequest(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

/**
 * Resolves the current Lummet admin from the session cookie.
 * Returns null if there is no valid, unexpired session — callers
 * must treat that as unauthenticated.
 */
export async function getCurrentAdmin(request, env) {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) return null;

  const session = await env.LUMMET_DB.prepare(
    `SELECT * FROM lummet_sessions WHERE id = ?`
  ).bind(sessionId).first();

  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`DELETE FROM lummet_sessions WHERE id = ?`)
      .bind(sessionId)
      .run();
    return null;
  }

  const admin = await env.LUMMET_DB.prepare(
    `SELECT id, email, role, status, must_change_password,
            EXISTS(SELECT 1 FROM lummet_admin_totp t WHERE t.admin_id = lummet_admins.id AND t.status = 'active') AS two_factor_enabled
     FROM lummet_admins WHERE id = ?`
  ).bind(session.admin_id).first();

  if (!admin || admin.status === "disabled") {
    // A disabled admin's existing sessions are cut immediately, not
    // just blocked at the next login.
    await env.LUMMET_DB.prepare(`DELETE FROM lummet_sessions WHERE id = ?`)
      .bind(sessionId)
      .run();
    return null;
  }

  return { ...admin, sessionId, activeTenantId: session.active_tenant_id || null };
}

export async function setActiveTenant(env, sessionId, tenantId) {
  await env.LUMMET_DB.prepare(
    `UPDATE lummet_sessions SET active_tenant_id = ? WHERE id = ?`
  ).bind(tenantId, sessionId).run();
}

// -----------------------------------------------------
// Lummet admin management (Phase 10) — creating additional
// staff accounts, granting/revoking super admin, enabling/
// disabling accounts, and self-service password changes.
// Only ever called after a route handler has already
// confirmed the caller is a super admin (see rbac.js) —
// this module does not re-check that itself, matching how
// registry.js/client.js trust their own callers.
// -----------------------------------------------------

function randomTempPassword() {
  // 20 random bytes, base64url-ish, trimmed to a clean length —
  // long enough to comfortably clear the 12-char minimum below
  // and never re-typed by a human (shown once, then changed).
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, "").slice(0, 20);
}

export async function listAdmins(env) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT id, email, role, status, must_change_password, created_at,
            EXISTS(SELECT 1 FROM lummet_admin_totp t WHERE t.admin_id = lummet_admins.id AND t.status = 'active') AS two_factor_enabled
     FROM lummet_admins ORDER BY created_at`
  ).all();
  return result.results || [];
}

export async function getAdminById(env, id) {
  return env.LUMMET_DB.prepare(
    `SELECT id, email, role, status, must_change_password, created_at FROM lummet_admins WHERE id = ?`
  ).bind(id).first();
}

/**
 * Creates a new Lummet staff account with a random temporary
 * password, returned once (never persisted in plaintext, never
 * logged) — the same "shown exactly once" pattern this repo already
 * uses for tenant API credentials. The new admin must change it on
 * first login.
 */
export async function createAdmin(env, { email, role, createdBy }) {
  email = (email || "").trim();
  if (!email) return { ok: false, status: 422, error: "email_required" };
  if (role !== "super_admin" && role !== "staff") {
    return { ok: false, status: 422, error: "invalid_role" };
  }

  const existing = await env.LUMMET_DB.prepare(
    `SELECT id FROM lummet_admins WHERE email = ?`
  ).bind(email).first();
  if (existing) return { ok: false, status: 409, error: "email_already_registered" };

  const tempPassword = randomTempPassword();
  const passwordHash = await hashPassword(tempPassword, env);

  const inserted = await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_admins (email, password_hash, role, status, created_by, must_change_password)
     VALUES (?, ?, ?, 'active', ?, 1) RETURNING id`
  ).bind(email, passwordHash, role, createdBy || null).first();

  return { ok: true, adminId: inserted?.id ?? null, email, tempPassword };
}

export async function setAdminRole(env, adminId, role) {
  if (role !== "super_admin" && role !== "staff") {
    return { ok: false, status: 422, error: "invalid_role" };
  }
  await env.LUMMET_DB.prepare(`UPDATE lummet_admins SET role = ? WHERE id = ?`)
    .bind(role, adminId)
    .run();
  return { ok: true };
}

export async function setAdminStatus(env, adminId, status) {
  if (status !== "active" && status !== "disabled") {
    return { ok: false, status: 422, error: "invalid_status" };
  }
  await env.LUMMET_DB.prepare(`UPDATE lummet_admins SET status = ? WHERE id = ?`)
    .bind(status, adminId)
    .run();
  if (status === "disabled") {
    await env.LUMMET_DB.prepare(`DELETE FROM lummet_sessions WHERE admin_id = ?`)
      .bind(adminId)
      .run();
  }
  return { ok: true };
}

export async function deleteAdmin(env, adminId) {
  await env.LUMMET_DB.prepare(`DELETE FROM lummet_admins WHERE id = ?`).bind(adminId).run();
  return { ok: true };
}

export async function countSuperAdmins(env) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM lummet_admins WHERE role IN ('super_admin', 'master_admin') AND status = 'active'`
  ).first();
  return row?.c || 0;
}

export async function changeOwnPassword(env, adminId, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 12) {
    return { ok: false, status: 422, error: "password_too_short" };
  }
  const admin = await env.LUMMET_DB.prepare(`SELECT password_hash FROM lummet_admins WHERE id = ?`)
    .bind(adminId)
    .first();
  if (!admin) return { ok: false, status: 404, error: "not_found" };

  const valid = await verifyPassword(currentPassword || "", admin.password_hash);
  if (!valid) return { ok: false, status: 401, error: "invalid_current_password" };

  const newHash = await hashPassword(newPassword, env);
  await env.LUMMET_DB.prepare(
    `UPDATE lummet_admins SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ).bind(newHash, adminId).run();

  return { ok: true };
}

/**
 * Used only right after createAdmin(), when the caller already knows
 * the temp password out of band and just needs to set a real one —
 * no "current password" check, since there isn't a real one yet.
 */
export async function setPasswordDirect(env, adminId, newPassword) {
  if (!newPassword || newPassword.length < 12) {
    return { ok: false, status: 422, error: "password_too_short" };
  }
  const newHash = await hashPassword(newPassword, env);
  await env.LUMMET_DB.prepare(
    `UPDATE lummet_admins SET password_hash = ?, must_change_password = 0 WHERE id = ?`
  ).bind(newHash, adminId).run();
  return { ok: true };
}
