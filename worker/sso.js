// =====================================================
// SSO — OIDC (master prompt Phase 7)
//
// See migration 0016's header for why this is OIDC and not
// SAML. Standard authorization-code flow with PKCE (RFC 7636)
// and nonce binding — the token exchange and JWKS fetch are
// real HTTP calls (injectable via `fetchImpl`, same pattern as
// billing.js/webhooks.js's provider injection) that have not
// been exercised against a live IdP in this environment; the
// orchestration logic and JWT verification ARE fully tested
// against fakes and self-signed tokens — see test/sso.test.js.
//
// Just-in-time provisioning: a customer_user who doesn't exist
// yet is created on first successful SSO login, with a random,
// never-revealed password hash (password login is therefore
// cryptographically infeasible for that account — the standard
// "SSO-only account" pattern) and email_verified_at set
// immediately, since the IdP is the trust source for that.
// =====================================================

import { emailKey } from "./email-key.js";
import { encryptSecret, decryptSecret } from "./crypto.js";
import { verifyJwt } from "./jwt.js";
import { hashPassword } from "./auth.js";
import { createSession } from "./customer-auth.js";
import { checkOutboundUrl, checkOutboundUrlResolved } from "./url-safety.js";
import { emailDomainAllowed } from "./sso-domains.js";

const STATE_TTL_MS = 1000 * 60 * 10; // 10 minutes — long enough for a real IdP redirect round trip

function randomHex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Stores (or replaces) an organization's OIDC configuration. All
 * five endpoint/id fields are required — no partial configuration
 * that would fail confusingly later at login time.
 */
export async function configureSso(env, organizationId, { issuer, clientId, clientSecret, authorizationEndpoint, tokenEndpoint, jwksUri, defaultRole }) {
  if (!issuer || !clientId || !clientSecret || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    return { ok: false, status: 422, error: "missing_required_fields" };
  }

  // These URLs are fetched by this server (token exchange, key set) or sent to
  // the browser (authorization), and the token request carries the client
  // secret. Customer-supplied, so they get the same safety check as webhook URLs.
  for (const [field, value] of [["issuer", issuer], ["authorization_endpoint", authorizationEndpoint], ["token_endpoint", tokenEndpoint], ["jwks_uri", jwksUri]]) {
    const check = field === "authorization_endpoint" ? checkOutboundUrl(value) : await checkOutboundUrlResolved(value, env);   // the browser, not this server, fetches the authorization endpoint
    if (!check.ok) return { ok: false, status: 422, error: `${field}_${check.error}` };
  }

  const { encryptedSecret, secretIv } = await encryptSecret(env, clientSecret);

  await env.LUMMET_DB.prepare(
    `INSERT INTO organization_sso_settings
       (organization_id, issuer, client_id, encrypted_client_secret, client_secret_iv, authorization_endpoint, token_endpoint, jwks_uri, default_role)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id) DO UPDATE SET
       issuer = excluded.issuer, client_id = excluded.client_id,
       encrypted_client_secret = excluded.encrypted_client_secret, client_secret_iv = excluded.client_secret_iv,
       authorization_endpoint = excluded.authorization_endpoint, token_endpoint = excluded.token_endpoint,
       jwks_uri = excluded.jwks_uri, default_role = excluded.default_role,
       status = 'active', updated_at = CURRENT_TIMESTAMP`
  )
    .bind(organizationId, issuer, clientId, encryptedSecret, secretIv, authorizationEndpoint, tokenEndpoint, jwksUri, defaultRole || "viewer")
    .run();

  return { ok: true };
}

/** Never returns the client secret — not even encrypted. */
export async function getSsoSettings(env, organizationId) {
  return env.LUMMET_DB.prepare(
    `SELECT organization_id, provider, issuer, client_id, authorization_endpoint, token_endpoint, jwks_uri, default_role, status, updated_at
     FROM organization_sso_settings WHERE organization_id = ?`
  )
    .bind(organizationId)
    .first();
}

export async function disableSso(env, organizationId) {
  await env.LUMMET_DB.prepare(`UPDATE organization_sso_settings SET status = 'disabled', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
    .bind(organizationId)
    .run();
  return { ok: true };
}

/** Builds the redirect URL to send the browser to the IdP, with PKCE + nonce state stored for completeLogin() to verify. */
export async function startLogin(env, organizationId, redirectUri) {
  const settings = await env.LUMMET_DB.prepare(`SELECT * FROM organization_sso_settings WHERE organization_id = ? AND status = 'active'`)
    .bind(organizationId)
    .first();
  if (!settings) return { ok: false, status: 404, error: "sso_not_configured" };

  const state = crypto.randomUUID();
  const nonce = randomHex(16);
  const codeVerifier = randomHex(32); // 64 chars — within PKCE's required 43-128
  const codeChallenge = bytesToBase64Url(await sha256(new TextEncoder().encode(codeVerifier)));

  await env.LUMMET_DB.prepare(
    `INSERT INTO sso_login_states (id, organization_id, nonce, code_verifier, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(state, organizationId, nonce, codeVerifier, redirectUri, new Date(Date.now() + STATE_TTL_MS).toISOString())
    .run();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: settings.client_id,
    redirect_uri: redirectUri,
    scope: "openid email profile",
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  });

  return { ok: true, authorizationUrl: `${settings.authorization_endpoint}?${params.toString()}` };
}

/**
 * Completes the flow after the IdP redirects back with `code` and
 * `state`. `fetchImpl` is injectable so the token-exchange and JWKS
 * calls can be faked in tests — production code never passes it,
 * defaulting to the real global fetch.
 */
export async function completeLogin(env, { state, code }, { fetchImpl = fetch } = {}) {
  const stateRow = await env.LUMMET_DB.prepare(`SELECT * FROM sso_login_states WHERE id = ?`).bind(state).first();
  if (!stateRow) return { ok: false, status: 422, error: "invalid_state" };
  await env.LUMMET_DB.prepare(`DELETE FROM sso_login_states WHERE id = ?`).bind(state).run();

  if (new Date(stateRow.expires_at).getTime() < Date.now()) return { ok: false, status: 410, error: "state_expired" };

  const settings = await env.LUMMET_DB.prepare(`SELECT * FROM organization_sso_settings WHERE organization_id = ? AND status = 'active'`)
    .bind(stateRow.organization_id)
    .first();
  if (!settings) return { ok: false, status: 404, error: "sso_not_configured" };

  // Re-checked at use time (rows saved before the check existed), and never
  // follow redirects: a redirect could bounce the client secret to another host.
  if (!(await checkOutboundUrlResolved(settings.token_endpoint, env)).ok || !(await checkOutboundUrlResolved(settings.jwks_uri, env)).ok) {
    return { ok: false, status: 422, error: "sso_endpoint_not_allowed" };
  }

  const clientSecret = await decryptSecret(env, settings.encrypted_client_secret, settings.client_secret_iv);

  const tokenResponse = await fetchImpl(settings.token_endpoint, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: stateRow.redirect_uri,
      client_id: settings.client_id,
      client_secret: clientSecret,
      code_verifier: stateRow.code_verifier
    }).toString()
  });
  if (!tokenResponse.ok) return { ok: false, status: 502, error: "token_exchange_failed" };
  const tokenBody = await tokenResponse.json();
  if (!tokenBody.id_token) return { ok: false, status: 502, error: "no_id_token_returned" };

  const jwksResponse = await fetchImpl(settings.jwks_uri, { redirect: "manual", signal: AbortSignal.timeout(10000) });
  if (!jwksResponse.ok) return { ok: false, status: 502, error: "jwks_fetch_failed" };
  const jwks = await jwksResponse.json();

  const verified = await verifyJwt(tokenBody.id_token, jwks, {
    issuer: settings.issuer,
    audience: settings.client_id,
    nonce: stateRow.nonce
  });
  if (!verified.ok) return { ok: false, status: 401, error: verified.error };

  const email = (verified.claims.email || "").trim().toLowerCase();
  if (!email) return { ok: false, status: 422, error: "id_token_missing_email" };
  if (verified.claims.email_verified === false || verified.claims.email_verified === "false") {
    return { ok: false, status: 403, error: "idp_email_not_verified" };
  }

  // SECURITY: an organization may only assert addresses in domains it has proven it owns.
  if (!(await emailDomainAllowed(env, stateRow.organization_id, email))) {
    return { ok: false, status: 403, error: "email_domain_not_verified" };
  }

  // SECURITY: the identity provider is controlled by the organization admin who
  // configured it, so its claims are only trusted for accounts that belong to
  // that organization's SSO. An email that already belongs to anyone else (a
  // normal account, or another organization's SSO account) is refused, never
  // matched. Otherwise any org admin could host their own IdP, assert a
  // victim's email, and be signed in as the victim.
  let user = await env.LUMMET_DB.prepare(`SELECT id, status, sso_organization_id FROM customer_users WHERE email = ?`).bind(email).first();
  if (user && user.sso_organization_id !== stateRow.organization_id) {
    return { ok: false, status: 409, error: "account_exists_not_managed_by_sso" };
  }
  if (!user) {
    const userId = crypto.randomUUID();
    const unusablePasswordHash = await hashPassword(randomHex(32));
    await env.LUMMET_DB.prepare(
      `INSERT INTO customer_users (id, email, email_key, password_hash, email_verified_at, sso_organization_id) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`
    )
      .bind(userId, email, emailKey(email), unusablePasswordHash, stateRow.organization_id)
      .run();
    user = { id: userId, status: "active" };
  }
  if (user.status === "disabled") return { ok: false, status: 403, error: "account_disabled" };

  const membership = await env.LUMMET_DB.prepare(`SELECT 1 FROM organization_users WHERE organization_id = ? AND user_id = ?`)
    .bind(stateRow.organization_id, user.id)
    .first();
  if (!membership) {
    await env.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)`)
      .bind(stateRow.organization_id, user.id, settings.default_role)
      .run();
  }

  const session = await createSession(env, user.id, stateRow.organization_id);
  return { ok: true, userId: user.id, email, cookie: session.cookie };
}
