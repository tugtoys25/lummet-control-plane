// =====================================================
// CUSTOMER IDENTITY & SESSIONS
//
// A completely separate identity/session system from
// auth.js (Lummet staff) — different cookie, different
// tables (customer_users/customer_sessions), but the SAME
// password-hashing primitives (imported, not reimplemented
// — master prompt rule against duplicate auth systems).
// =====================================================

import { onEmailVerified } from "./billing-notifications.js";
import { emailKey } from "./email-key.js";
import { hashPassword, verifyPassword } from "./auth.js";
import { hashPasswordForEnv, passwordHashNeedsUpgrade } from "./password-hash.js";
import { updateCustomerPasswordHash } from "./repositories/password-hashes.js";
import { createOrganization } from "./organizations.js";
import { getTotpStatus, verifyFactorForLogin } from "./totp.js";
import { evaluateSessionUse } from "./org-security-policy.js";
import * as commercialRepo from "./repositories/commercial.js";

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

// authMethod (migration 0077): how this session was authenticated ('password', 'password_totp', 'passkey', 'passkey_uv', 'sso').
// Recorded for every new session; only read for a decision while ORG_2FA_PASSKEY_COUNTS=on.
export async function createSession(env, userId, activeOrganizationId, { authMethod = null } = {}) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS).toISOString();

  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_sessions (id, user_id, active_organization_id, expires_at, auth_method) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(sessionId, userId, activeOrganizationId || null, expiresAt, authMethod)
    .run();

  // Round 6.4A: every sign-in path (password, passkey, SSO, sign-up) issues its session here. If an organization this person belongs to
  // requires 2FA and they have none, the session is restricted (see getCustomerSession) and the caller is told so it can say why.
  // With ORG_SECURITY_POLICY=off this is a no-op and never queries.
  const policy = await evaluateSessionUse(env, userId, { authMethod, activeOrganizationId: activeOrganizationId || null });

  return {
    sessionId,
    cookie: `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DURATION_MS / 1000}`,
    twoFactorEnrollmentRequired: policy.blocked
  };
}

// -----------------------------------------------------
// Sign up — creates the person AND their first organization
// in one step. Someone invited into an EXISTING org instead
// signs up (or logs in) and then calls acceptInvitation()
// separately — see organizations.js.
// -----------------------------------------------------

export async function verifyCustomerTurnstile(request, env, token) {
  if (String(env.CUSTOMER_TURNSTILE_REQUIRED || "off").toLowerCase() !== "on") return { ok: true, skipped: true };
  if (!env.TURNSTILE_SECRET_KEY || !env.TURNSTILE_SITE_KEY || !token) return { ok: false, status: 422, error: "turnstile_required" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: String(token), remoteip: request.headers.get("CF-Connecting-IP") || "" }),
      signal: controller.signal
    });
    if (!response.ok) return { ok: false, status: 503, error: "turnstile_verification_unavailable" };
    const result = await response.json();
    const host = new URL(request.url).hostname;
    if (result.success !== true || (Array.isArray(result["error-codes"]) && result["error-codes"].includes("invalid-input-secret")) || result.hostname !== host) return { ok: false, status: 422, error: "turnstile_failed" };
    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: "turnstile_verification_unavailable" };
  } finally { clearTimeout(timeout); }
}

/** Rewrite a customer hash in the target format after a correct password (PASSWORD_HASH_FORMAT=v2 only). Never blocks the login. */
async function upgradeCustomerHashIfNeeded(env, user, password) {
  if (!passwordHashNeedsUpgrade(user.password_hash, env)) return;
  try {
    await updateCustomerPasswordHash(env, user.id, await hashPasswordForEnv(password, env));
  } catch (err) {
    console.error("password_rehash_failed", { scope: "customer", userId: user.id, message: String(err && err.message || err).slice(0, 120) });
  }
}

export async function signUp(request, env) {
  const body = await request.json().catch(() => ({}));
  const challenge = await verifyCustomerTurnstile(request, env, body.turnstileToken);
  if (!challenge.ok) return challenge;
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
  const requestedPlan = body.planId ? String(body.planId).trim() : null;
  const requestedPeriod = body.billingPeriod ? String(body.billingPeriod).trim().toLowerCase() : null;
  if (requestedPlan || requestedPeriod) {
    if (!requestedPlan || !['monthly','annual'].includes(requestedPeriod)) return { ok:false,status:422,error:'invalid_signup_intent' };
    const plan = await commercialRepo.signupPlan(env,requestedPlan,requestedPeriod);
    if (!plan || plan.status !== 'active' || plan.billing_period !== requestedPeriod || plan.price_cents == null || String(plan.billing_period)==='custom') return {ok:false,status:422,error:'invalid_signup_intent'};
    const price = await commercialRepo.activePlanPrice(env,plan.id,requestedPeriod==='annual'?'year':'month');
    if (!price?.stripe_price_id) return {ok:false,status:409,error:'plan_not_billing_configured'};
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
  const passwordHash = await hashPassword(password, env);

  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_users (id, email, email_key, password_hash, full_name, signup_plan_id, signup_billing_period) VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(userId, email, emailKey(email), passwordHash, body.fullName || null, requestedPlan, requestedPeriod)
    .run();

  const org = await createOrganization(env, { name: organizationName, ownerUserId: userId });
  if (!org.ok) return org;

  const verificationToken = randomToken();
  await env.LUMMET_DB.prepare(
    `INSERT INTO customer_email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)`
  )
    .bind(userId, await hashToken(verificationToken), new Date(Date.now() + VERIFICATION_TTL_MS).toISOString())
    .run();

  const session = await createSession(env, userId, org.organizationId, { authMethod: "password" });

  return {
    ok: true,
    userId,
    email,
    organizationId: org.organizationId,
    // Shown once — there is no outbound email delivery yet (master
    // prompt section 28); this is deliberately not faked as "email
    // sent". The caller (or a future notification job) delivers it.
    emailVerificationToken: verificationToken,
    signupIntent: requestedPlan ? { planId: requestedPlan, period: requestedPeriod } : null,
    cookie: session.cookie
  };
}

export async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const challenge = await verifyCustomerTurnstile(request, env, body.turnstileToken);
  if (!challenge.ok) return challenge;
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

  await upgradeCustomerHashIfNeeded(env, user, password);

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
    return { ok: true, mfaRequired: true, challengeId, signupIntent: user.signup_plan_id ? { planId:user.signup_plan_id, period:user.signup_billing_period } : null };
  }

  const session = await createSession(env, user.id, firstOrg?.organization_id || null, { authMethod: "password" });

  // Round 6.4A: password alone is not enough for a member of an organization that requires 2FA. The session exists so the person can
  // reach the 2FA setup routes (the only way out), but getCustomerSession refuses it everywhere else.
  if (session.twoFactorEnrollmentRequired) {
    return { ok: true, userId: user.id, email: user.email, cookie: session.cookie, twoFactorEnrollmentRequired: true, reason: "org_2fa_required", signupIntent: null };
  }

  return { ok: true, userId: user.id, email: user.email, cookie: session.cookie, signupIntent: user.signup_plan_id ? { planId:user.signup_plan_id, period:user.signup_billing_period } : null };
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

  const user = await commercialRepo.customerLoginIdentity(env,challenge.user_id);
  const firstOrg = await env.LUMMET_DB.prepare(
    `SELECT organization_id FROM organization_users WHERE user_id = ? ORDER BY created_at LIMIT 1`
  )
    .bind(challenge.user_id)
    .first();
  const session = await createSession(env, challenge.user_id, firstOrg?.organization_id || null, { authMethod: "password_totp" });

  return { ok: true, userId: user.id, email: user.email, cookie: session.cookie, signupIntent: user.signup_plan_id ? { planId:user.signup_plan_id, period:user.signup_billing_period } : null };
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
 *
 * Round 6.4A: a session that an organization policy blocks (the person has no 2FA but belongs to an organization that requires it)
 * is treated as NO session here, so every existing caller fails closed. Only the 2FA setup routes and the portal notice page use
 * getCustomerSession, which says why.
 */
export async function getCurrentCustomer(request, env) {
  const { customer, policy } = await getCustomerSession(request, env);
  return customer && !policy.blocked ? customer : null;
}

/**
 * Like getCurrentCustomer, but also returns the organization-policy verdict: { customer, policy }.
 * customer is null when there is no valid session. policy is { mode, blocked, wouldBlock, reason, organizationIds }; when blocked is true
 * the caller must allow nothing except 2FA enrollment, the portal notice and logout. This is the single place sessions are checked
 * against organization policy, on every use, so a session issued before the policy existed is covered at once.
 */
export async function getCustomerSession(request, env) {
  const none = { customer: null, policy: { mode: "off", blocked: false, wouldBlock: false, reason: null, organizationIds: [] } };
  const sessionId = getSessionIdFromRequest(request);
  if (!sessionId) return none;

  // One round trip for session + user (was two). Same rules as before: unknown session, expired session, missing or
  // disabled user all end in "no customer", and the last two also delete the session row.
  const row = await env.LUMMET_DB.prepare(
    `SELECT s.expires_at AS session_expires_at, s.active_organization_id AS session_active_organization_id, s.auth_method AS session_auth_method,
            u.id AS user_id, u.email AS user_email, u.full_name AS user_full_name, u.status AS user_status,
            u.email_verified_at AS user_email_verified_at
     FROM customer_sessions s
     LEFT JOIN customer_users u ON u.id = s.user_id
     WHERE s.id = ?`
  )
    .bind(sessionId)
    .first();
  if (!row) return none;

  if (new Date(row.session_expires_at).getTime() < Date.now()) {
    await env.LUMMET_DB.prepare(`DELETE FROM customer_sessions WHERE id = ?`).bind(sessionId).run();
    return none;
  }

  if (row.user_id == null || row.user_status === "disabled") {
    await env.LUMMET_DB.prepare(`DELETE FROM customer_sessions WHERE id = ?`).bind(sessionId).run();
    return none;
  }

  const user = { id: row.user_id, email: row.user_email, full_name: row.user_full_name, status: row.user_status, email_verified_at: row.user_email_verified_at };
  const session = { active_organization_id: row.session_active_organization_id };

  const policy = await evaluateSessionUse(env, user.id, { authMethod: row.session_auth_method || null, activeOrganizationId: session.active_organization_id || null });
  return { customer: { ...user, sessionId, activeOrganizationId: session.active_organization_id || null }, policy };
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

  // Phase 2.1: the trial welcome waits for a verified address. Logged, never fatal: verification itself succeeded.
  try { await onEmailVerified(env, userId); } catch (e) { console.error(JSON.stringify({ msg: "billing_welcome_failed", error: e?.message || String(e) })); }

  const intent = await commercialRepo.customerSignupIntent(env,userId);
  return { ok: true, signupIntent: intent?.signup_plan_id ? { planId:intent.signup_plan_id, period:intent.signup_billing_period } : null };
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

  const newHash = await hashPassword(newPassword, env);
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
