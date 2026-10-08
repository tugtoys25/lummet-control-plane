// =====================================================
// CUSTOMER IDENTITY & SESSIONS
//
// A completely separate identity/session system from
// auth.js (Lummet staff) — different cookie, different
// tables (customer_users/customer_sessions), but the SAME
// password-hashing primitives (imported, not reimplemented
// — master prompt rule against duplicate auth systems).
// =====================================================

import { hashPassword, verifyPassword } from "./auth.js";
import { createOrganization } from "./organizations.js";
import { getTotpStatus, verifyFactorForLogin } from "./totp.js";

const SESSION_COOKIE = "lummet_customer_session";
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const VERIFICATION_TTL_MS = 1000 * 60 * 60 * 24; // 24 hours
const RESET_TTL_MS = 1000 * 60 * 30; // 30 minutes
const MFA_CHALLENGE_TTL_MS = 1000 * 60 * 5; // 5 minutes

async function hashIP(ip) {
  if (!ip) return "";
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashToken(token) {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/[^a-zA-Z0-9]/g, "");
}

// -----------------------------------------------------
// Rate limiting — reuses lummet_auth_attempts (migration
// 0001), namespaced with a "customer_" action prefix so
// staff and customer attempt counts never mix or let one
// population exhaust the other's limit.
// -----------------------------------------------------

async function checkRateLimit(env, ipHash, action, maxAttempts = 5) {
  const windowMinutes = 15;
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  await env.LUMMET_DB.prepare(`DELETE FROM lummet_auth_attempts WHERE created_at < ?`)
    .bind(windowStart)
    .run();

  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM lummet_auth_attempts WHERE ip_hash = ? AND action = ? AND created_at >= ?`
  )
    .bind(ipHash, action, windowStart)
    .first();

  return (row?.c || 0) < maxAttempts;
}

async function logFailedAttempt(env, ipHash, action) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_auth_attempts (ip_hash, action, created_at) VALUES (?, ?, ?)`
  )
    .bind(ipHash, action, new Date().toISOString())
    .run();
}

/**
 * Count-every-request throttle for endpoints that cost us something even
 * when they "succeed" (sending email, creating a trial). Returns true if the
 * caller is still under `max` requests per 15 minutes for this action.
 */
export async function throttle(env, request, action, max) {
  const ipHash = await hashIP(request.headers.get("CF-Connecting-IP"));
  if (!(await checkRateLimit(env, ipHash, action, max))) return false;
  await logFailedAttempt(env, ipHash, action);
  return true;
}

/** Read-only check: has this IP stayed under `max` recorded attempts of `action` in the window? */
export async function isUnderLimit(env, ipHash, action, max) {
  const windowStart = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM lummet_auth_attempts WHERE ip_hash = ? AND action = ? AND created_at >= ?`
  ).bind(ipHash, action, windowStart).first();
  return (row?.c || 0) < max;   // SELECT only: expired rows are cleaned up by the other limiters
}

/** Records one attempt (use for failures only). */
export async function recordFailure(env, ipHash, action) {
  await logFailedAttempt(env, ipHash, action);
}

export async function hashIPForRateLimit(request) {
  return hashIP(request.headers.get("CF-Connecting-IP"));
}

export async function createSession(env, userId, activeOrganizationId) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_sessions (id, user_id, active_organization_id, expires_at) VALUES (?, ?, ?, ?)`
  )
    .bind(sessionId, userId, activeOrganizationId || null, expiresAt)
    .run();

  return {
    sessionId,
    cookie: `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DURATION_MS / 1000}`
  };
}

// -----------------------------------------------------
// Sign up — creates the person AND their first organization
// in one step. Someone invited into an EXISTING org instead
// signs up (or logs in) and then calls acceptInvitation()
// separately — see organizations.js.
// -----------------------------------------------------

export async function signUp(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const organizationName = (body.organizationName || "").trim();
  const ipHash = await hashIP(request.headers.get("CF-Connecting-IP"));

  if (!email || !password || password.length < 12) {
    return { ok: false, status: 422, error: "invalid_email_or_password" };
  }
  if (!organizationName) {
    return { ok: false, status: 422, error: "organization_name_required" };
  }

  const allowed = await checkRateLimit(env, ipHash, "customer_signup");
  if (!allowed) return { ok: false, status: 429, error: "too_many_attempts" };

  const existing = await env.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = ?`)
    .bind(email)
    .first();
  if (existing) {
    await logFailedAttempt(env, ipHash, "customer_signup");
    return { ok: false, status: 409, error: "email_already_registered" };
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);

  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_users (id, email, password_hash, full_name) VALUES (?, ?, ?, ?)`
  )
    .bind(userId, email, passwordHash, body.fullName || null)
    .run();

  const org = await createOrganization(env, { name: organizationName, ownerUserId: userId });
  if (!org.ok) return org;

  const verificationToken = randomToken();
  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)`
  )
    .bind(userId, await hashToken(verificationToken), new Date(Date.now() + VERIFICATION_TTL_MS).toISOString())
    .run();

  const session = await createSession(env, userId, org.organizationId);

  return {
    ok: true,
    userId,
    email,
    organizationId: org.organizationId,
    // Shown once — there is no outbound email delivery yet (master
    // prompt section 28); this is deliberately not faked as "email
    // sent". The caller (or a future notification job) delivers it.
    emailVerificationToken: verificationToken,
    cookie: session.cookie
  };
}

export async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = (body.email || "").trim().toLowerCase();
  const password = body.password || "";
  const ipHash = await hashIP(request.headers.get("CF-Connecting-IP"));

  if (!email || !password) return { ok: false, status: 400, error: "email_and_password_required" };

  const allowed = await checkRateLimit(env, ipHash, "customer_login");
  if (!allowed) return { ok: false, status: 429, error: "too_many_attempts" };

  const user = await env.LUMMET_DB.prepare(`SELECT * FROM customer_users WHERE email = ?`)
    .bind(email)
    .first();

  if (!user) {
    await logFailedAttempt(env, ipHash, "customer_login");
    return { ok: false, status: 401, error: "invalid_credentials" };
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    await logFailedAttempt(env, ipHash, "customer_login");
    return { ok: false, status: 401, error: "invalid_credentials", userId: user.id };
  }

  if (user.status === "disabled") {
    await logFailedAttempt(env, ipHash, "customer_login");
    return { ok: false, status: 403, error: "account_disabled", userId: user.id };
  }

  const firstOrg = await env.LUMMET_DB.prepare(
    `SELECT organization_id FROM organization_users WHERE user_id = ? ORDER BY created_at LIMIT 1`
  )
    .bind(user.id)
    .first();

  // 2FA gate — if the user has an ACTIVE factor, password verification
  // alone is not a completed login. No customer_sessions row is
  // created yet; only a short-lived challenge is, and the real
  // session is only issued by completeMfaLogin() below once the code
  // checks out.
  const totpStatus = await getTotpStatus(env, user.id);
  if (totpStatus.enabled) {
    const challengeId = crypto.randomUUID();
    await env.LUMMET_DB.prepare(
      `INSERT INTO customer_mfa_challenges (id, user_id, expires_at) VALUES (?, ?, ?)`
    )
      .bind(challengeId, user.id, new Date(Date.now() + MFA_CHALLENGE_TTL_MS).toISOString())
      .run();
    return { ok: true, mfaRequired: true, challengeId };
  }

  const session = await createSession(env, user.id, firstOrg?.organization_id || null);

  return { ok: true, userId: user.id, email: user.email, cookie: session.cookie };
}

/**
 * Completes a login that was interrupted by an active 2FA factor —
 * the ONLY path that turns a password-verified-but-MFA-pending
 * state into a real session. The challenge is single-use and
 * expires quickly; a wrong code does not consume it, so the user
 * can retry within the window.
 */
export async function completeMfaLogin(env, challengeId, { code, backupCode } = {}) {
  const challenge = await env.LUMMET_DB.prepare(`SELECT * FROM customer_mfa_challenges WHERE id = ?`)
    .bind(challengeId)
    .first();
  if (!challenge) return { ok: false, status: 404, error: "invalid_challenge" };

  if (new Date(challenge.expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`DELETE FROM customer_mfa_challenges WHERE id = ?`).bind(challengeId).run();
    return { ok: false, status: 410, error: "challenge_expired" };
  }

  const verified = await verifyFactorForLogin(env, challenge.user_id, { code, backupCode });
  if (!verified.ok) return verified;

  await env.LUMMET_DB.prepare(`DELETE FROM customer_mfa_challenges WHERE id = ?`).bind(challengeId).run();

  const user = await env.LUMMET_DB.prepare(`SELECT id, email FROM customer_users WHERE id = ?`).bind(challenge.user_id).first();
  const firstOrg = await env.LUMMET_DB.prepare(
    `SELECT organization_id FROM organization_users WHERE user_id = ? ORDER BY created_at LIMIT 1`
  )
    .bind(challenge.user_id)
    .first();
  const session = await createSession(env, challenge.user_id, firstOrg?.organization_id || null);

  return { ok: true, userId: user.id, email: user.email, cookie: session.cookie };
}

function getSessionIdFromRequest(request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match ? match[1] : null;
}

export async function logout(request, env) {
  const sessionId = getSessionIdFromRequest(request);
  if (sessionId) {
    await env.LUMMET_DB.prepare(`DELETE FROM customer_sessions WHERE id = ?`).bind(sessionId).run();
  }
  return { cookie: `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` };
}

/**
 * Resolves the current customer from the session cookie. Returns
 * null if there is no valid, unexpired session — callers must
 * treat that as unauthenticated. Never confused with
 * auth.getCurrentAdmin(), which reads a different cookie entirely.
 */
export async function getCurrentCustomer(request, env) {
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) return null;

  const session = await env.LUMMET_DB.prepare(`SELECT * FROM customer_sessions WHERE id = ?`)
    .bind(sessionId)
    .first();
  if (!session) return null;

  if (new Date(session.expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`DELETE FROM customer_sessions WHERE id = ?`).bind(sessionId).run();
    return null;
  }

  const user = await env.LUMMET_DB.prepare(
    `SELECT id, email, full_name, status, email_verified_at FROM customer_users WHERE id = ?`
  )
    .bind(session.user_id)
    .first();

  if (!user || user.status === "disabled") {
    await env.LUMMET_DB.prepare(`DELETE FROM customer_sessions WHERE id = ?`).bind(sessionId).run();
    return null;
  }

  return { ...user, sessionId, activeOrganizationId: session.active_organization_id || null };
}

export async function setActiveOrganization(env, sessionId, organizationId) {
  await env.LUMMET_DB.prepare(`UPDATE customer_sessions SET active_organization_id = ? WHERE id = ?`)
    .bind(organizationId, sessionId)
    .run();
}

// -----------------------------------------------------
// Email verification
// -----------------------------------------------------

export async function verifyEmail(env, userId, token) {
  const tokenHash = await hashToken(token || "");
  const row = await env.LUMMET_DB.prepare(
    `SELECT * FROM customer_email_verifications WHERE user_id = ? AND token_hash = ? AND used_at IS NULL`
  )
    .bind(userId, tokenHash)
    .first();

  if (!row) return { ok: false, status: 404, error: "invalid_token" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, status: 410, error: "token_expired" };

  await env.LUMMET_DB.prepare(`UPDATE customer_email_verifications SET used_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), row.id)
    .run();
  await env.LUMMET_DB.prepare(`UPDATE customer_users SET email_verified_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), userId)
    .run();

  return { ok: true };
}

// -----------------------------------------------------
// Password reset — deliberately returns { ok: true } whether
// or not the email is registered, so this endpoint can never
// be used to enumerate customer accounts.
// -----------------------------------------------------

export async function requestPasswordReset(env, email) {
  const trimmedEmail = (email || "").trim().toLowerCase();
  const user = await env.LUMMET_DB.prepare(`SELECT id, sso_organization_id FROM customer_users WHERE email = ?`)
    .bind(trimmedEmail)
    .first();

  // Same answer as "no such account" (no hint to the caller). Accounts created by an
  // organization's SSO sign in only through that SSO; letting a password be set here
  // would hand the account to whoever receives the email while the organization
  // that controls its identity provider could still sign in to it.
  if (!user || user.sso_organization_id) return { ok: true, sent: false };

  const token = randomToken();
  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)`
  )
    .bind(user.id, await hashToken(token), new Date(Date.now() + RESET_TTL_MS).toISOString())
    .run();

  // No outbound email delivery exists yet — returned here for the
  // caller to deliver out of band, same as invitations above.
  return { ok: true, sent: true, userId: user.id, token };
}

export async function resetPassword(env, userId, token, newPassword) {
  if (!newPassword || newPassword.length < 12) {
    return { ok: false, status: 422, error: "password_too_short" };
  }

  const tokenHash = await hashToken(token || "");
  const row = await env.LUMMET_DB.prepare(
    `SELECT * FROM customer_password_resets WHERE user_id = ? AND token_hash = ? AND used_at IS NULL`
  )
    .bind(userId, tokenHash)
    .first();

  if (!row) return { ok: false, status: 404, error: "invalid_token" };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, status: 410, error: "token_expired" };

  const newHash = await hashPassword(newPassword);
  await env.LUMMET_DB.prepare(`UPDATE customer_users SET password_hash = ? WHERE id = ?`)
    .bind(newHash, userId)
    .run();
  await env.LUMMET_DB.prepare(`UPDATE customer_password_resets SET used_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), row.id)
    .run();

  // Resetting a password revokes every existing session — the same
  // defensive behavior auth.js applies when a staff admin is disabled.
  await env.LUMMET_DB.prepare(`DELETE FROM customer_sessions WHERE user_id = ?`).bind(userId).run();

  return { ok: true };
}
