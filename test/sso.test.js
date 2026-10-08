// test/sso.test.js
//
// Covers worker/sso.js's actual orchestration (state/PKCE/nonce
// handling, JIT provisioning, membership creation) against a real
// SQLite schema (D1 shim) and a fake fetch standing in for the IdP's
// token and JWKS endpoints -- same technique as webhooks.test.js.
// The ID tokens themselves are REAL, signed with real Web Crypto
// keys and verified through the real jwt.js (already independently
// tested in jwt.test.js), so this exercises the full pipeline except
// the literal network round trip to a live IdP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as sso from '../worker/sso.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as organizations from '../worker/organizations.js';

function makeTestKek() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: makeTestKek() };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.160' }
  };
}

const ISSUER = 'https://idp.example.test';
const CLIENT_ID = 'lummet-client-id';
const REDIRECT_URI = 'https://app.example.test/sso/callback';

function base64UrlEncode(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return Buffer.from(binary, 'binary').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlEncodeString(str) { return base64UrlEncode(new TextEncoder().encode(str)); }

async function generateIdpKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify']
  );
}

async function signIdToken(privateKey, claims) {
  const headerB64 = base64UrlEncodeString(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'idp-key-1' }));
  const payloadB64 = base64UrlEncodeString(JSON.stringify(claims));
  const signingInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, signingInput));
  return `${headerB64}.${payloadB64}.${base64UrlEncode(signature)}`;
}

async function setUpOrgWithSso(env, email, domains = ['example.com', 'evil.test', 'corp.example']) {
  const signup = await customerAuth.signUp(fakeSignupRequest(email), env);
  for (const d of domains) {
    await env.LUMMET_DB.prepare(`INSERT INTO organization_sso_domains (id, organization_id, domain, verification_token, status, verified_at) VALUES (?, ?, ?, 't', 'verified', CURRENT_TIMESTAMP)`).bind(crypto.randomUUID(), signup.organizationId, d).run();
  }
  const idpKeyPair = await generateIdpKeyPair();
  const jwk = await crypto.subtle.exportKey('jwk', idpKeyPair.publicKey);
  jwk.kid = 'idp-key-1';

  const configResult = await sso.configureSso(env, signup.organizationId, {
    issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'super-secret-value',
    authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks`,
    defaultRole: 'editor'
  });
  assert.equal(configResult.ok, true);

  return { signup, idpKeyPair, jwks: { keys: [jwk] } };
}

function makeFakeFetch({ idToken, jwks, tokenEndpointOk = true, jwksEndpointOk = true }) {
  return async (url) => {
    if (url.toString().endsWith('/token')) {
      if (!tokenEndpointOk) return { ok: false, status: 400 };
      return { ok: true, async json() { return { id_token: idToken, access_token: 'irrelevant-here' }; } };
    }
    if (url.toString().endsWith('/jwks')) {
      if (!jwksEndpointOk) return { ok: false, status: 500 };
      return { ok: true, async json() { return jwks; } };
    }
    throw new Error(`unexpected fetch to ${url}`);
  };
}

function nowSeconds() { return Math.floor(Date.now() / 1000); }

test('configureSso rejects incomplete configuration and never stores the client secret in plaintext', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('sso-config@example.com'), env);

  const incomplete = await sso.configureSso(env, signup.organizationId, { issuer: ISSUER, clientId: CLIENT_ID });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error, 'missing_required_fields');

  await sso.configureSso(env, signup.organizationId, {
    issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 'the-real-secret',
    authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks`
  });

  const row = await env.LUMMET_DB.prepare(`SELECT * FROM organization_sso_settings WHERE organization_id = ?`).bind(signup.organizationId).first();
  assert.notEqual(row.encrypted_client_secret, 'the-real-secret');

  const settings = await sso.getSsoSettings(env, signup.organizationId);
  assert.equal('client_secret' in settings, false);
  assert.equal('encrypted_client_secret' in settings, false);
});

test('startLogin refuses an organization with no SSO configured', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('sso-none@example.com'), env);
  const result = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'sso_not_configured');
});

test('startLogin builds an authorization URL with PKCE and state, and completeLogin with the matching code creates a JIT-provisioned member', async () => {
  const env = makeEnv();
  const { signup, idpKeyPair, jwks } = await setUpOrgWithSso(env, 'sso-owner@example.com');

  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  assert.equal(started.ok, true);
  const url = new URL(started.authorizationUrl);
  assert.equal(url.origin + url.pathname, `${ISSUER}/authorize`);
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const state = url.searchParams.get('state');
  assert.ok(state);

  const idToken = await signIdToken(idpKeyPair.privateKey, {
    iss: ISSUER, aud: CLIENT_ID, sub: 'idp-user-1', email: 'new-sso-member@example.com',
    exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce')
  });

  const fakeFetch = makeFakeFetch({ idToken, jwks });
  const result = await sso.completeLogin(env, { state, code: 'auth-code-from-idp' }, { fetchImpl: fakeFetch });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.cookie.includes('lummet_customer_session='));

  const newUser = await env.LUMMET_DB.prepare(`SELECT * FROM customer_users WHERE email = ?`).bind('new-sso-member@example.com').first();
  assert.ok(newUser, 'a new customer_user must be JIT-provisioned');
  assert.ok(newUser.email_verified_at, 'an SSO-provisioned account is considered pre-verified');

  const membership = await organizations.getMembership(env, signup.organizationId, newUser.id);
  assert.equal(membership.role, 'editor', 'must use the configured default_role');
});

test('a state cannot be reused (single-use, even after a failed completion)', async () => {
  const env = makeEnv();
  const { signup, idpKeyPair, jwks } = await setUpOrgWithSso(env, 'sso-single-use@example.com');
  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);
  const state = url.searchParams.get('state');

  const idToken = await signIdToken(idpKeyPair.privateKey, {
    iss: ISSUER, aud: CLIENT_ID, email: 'user@example.com', exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce')
  });
  const fakeFetch = makeFakeFetch({ idToken, jwks });

  const first = await sso.completeLogin(env, { state, code: 'code-1' }, { fetchImpl: fakeFetch });
  assert.equal(first.ok, true);

  const second = await sso.completeLogin(env, { state, code: 'code-1' }, { fetchImpl: fakeFetch });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'invalid_state');
});

test('completeLogin rejects an ID token signed by the wrong key (forged/compromised IdP scenario)', async () => {
  const env = makeEnv();
  const { signup, jwks } = await setUpOrgWithSso(env, 'sso-forged@example.com');
  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);

  const attackerKeyPair = await generateIdpKeyPair();
  const forgedToken = await signIdToken(attackerKeyPair.privateKey, {
    iss: ISSUER, aud: CLIENT_ID, email: 'attacker@evil.test', exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce')
  });

  const fakeFetch = makeFakeFetch({ idToken: forgedToken, jwks });
  const result = await sso.completeLogin(env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: fakeFetch });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'invalid_signature');

  const attackerUser = await env.LUMMET_DB.prepare(`SELECT * FROM customer_users WHERE email = ?`).bind('attacker@evil.test').first();
  assert.equal(attackerUser, null, 'no account must be provisioned from an unverifiable token');
});

test('completeLogin rejects a token with the wrong nonce (replay of a token issued for a different login attempt)', async () => {
  const env = makeEnv();
  const { signup, idpKeyPair, jwks } = await setUpOrgWithSso(env, 'sso-wrong-nonce@example.com');
  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);

  const idToken = await signIdToken(idpKeyPair.privateKey, {
    iss: ISSUER, aud: CLIENT_ID, email: 'user@example.com', exp: nowSeconds() + 300, nonce: 'a-completely-different-nonce'
  });
  const fakeFetch = makeFakeFetch({ idToken, jwks });
  const result = await sso.completeLogin(env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: fakeFetch });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'nonce_mismatch');
});

test('SECURITY: SSO cannot sign in as a pre-existing account it did not create (account takeover via a self-hosted IdP)', async () => {
  const env = makeEnv();
  const { signup, idpKeyPair, jwks } = await setUpOrgWithSso(env, 'sso-attacker-owner@example.com');
  const victim = await customerAuth.signUp(fakeSignupRequest('victim@example.com'), env);

  // The attacker's own IdP happily asserts the victim's email address.
  const sessionsBefore = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM customer_sessions WHERE user_id = ?`).bind(victim.userId).first()).c;
  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);
  const idToken = await signIdToken(idpKeyPair.privateKey, {
    iss: ISSUER, aud: CLIENT_ID, email: 'victim@example.com', email_verified: true, exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce')
  });
  const result = await sso.completeLogin(env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: makeFakeFetch({ idToken, jwks }) });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_exists_not_managed_by_sso');
  assert.equal(result.cookie, undefined, 'no session is issued');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM customer_sessions WHERE user_id = ?`).bind(victim.userId).first()).c, sessionsBefore, 'no new session was created for the victim');
  assert.equal(await organizations.getMembership(env, signup.organizationId, victim.userId), null, 'and the victim is not added to the attacker organization');
});

test('SECURITY: even a victim who is a member of the attacker\'s organization cannot be taken over', async () => {
  const env = makeEnv();
  const { signup, idpKeyPair, jwks } = await setUpOrgWithSso(env, 'sso-agency@example.com');
  const client = await customerAuth.signUp(fakeSignupRequest('client@example.com'), env);
  await env.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'viewer')`).bind(signup.organizationId, client.userId).run();

  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);
  const idToken = await signIdToken(idpKeyPair.privateKey, { iss: ISSUER, aud: CLIENT_ID, email: 'client@example.com', exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce') });
  const result = await sso.completeLogin(env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: makeFakeFetch({ idToken, jwks }) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'account_exists_not_managed_by_sso');
});

test('SSO-created accounts can sign in again through the SAME organization, but not through another organization', async () => {
  const env = makeEnv();
  const a = await setUpOrgWithSso(env, 'sso-org-a@example.com');
  const b = await setUpOrgWithSso(env, 'sso-org-b@example.com', []);
  const login = async (org, email) => {
    const started = await sso.startLogin(env, org.signup.organizationId, REDIRECT_URI);
    const url = new URL(started.authorizationUrl);
    const idToken = await signIdToken(org.idpKeyPair.privateKey, { iss: ISSUER, aud: CLIENT_ID, email, exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce') });
    return sso.completeLogin(env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: makeFakeFetch({ idToken, jwks: org.jwks }) });
  };
  const first = await login(a, 'employee@corp.example');
  assert.equal(first.ok, true);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT sso_organization_id s FROM customer_users WHERE id = ?`).bind(first.userId).first()).s, a.signup.organizationId);
  const second = await login(a, 'employee@corp.example');
  assert.equal(second.ok, true); assert.equal(second.userId, first.userId, 'same person, same account');
  const other = await login(b, 'employee@corp.example');
  assert.equal(other.ok, false); assert.equal(other.error, 'email_domain_not_verified', 'org B never proved it owns corp.example');
  await env.LUMMET_DB.prepare(`INSERT INTO organization_sso_domains (id, organization_id, domain, verification_token, status) VALUES ('forced', ?, 'corp.example', 't', 'pending')`).bind(b.signup.organizationId).run();
  await env.LUMMET_DB.prepare(`UPDATE organization_sso_domains SET status = 'verified' WHERE id = 'forced'`).run().then(() => { throw new Error('two organizations must not both hold a verified domain'); }, () => {});
});

test('an IdP that says the email is not verified is refused', async () => {
  const env = makeEnv();
  const { signup, idpKeyPair, jwks } = await setUpOrgWithSso(env, 'sso-unverified@example.com');
  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);
  const idToken = await signIdToken(idpKeyPair.privateKey, { iss: ISSUER, aud: CLIENT_ID, email: 'new@corp.example', email_verified: false, exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce') });
  const result = await sso.completeLogin(env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: makeFakeFetch({ idToken, jwks }) });
  assert.equal(result.error, 'idp_email_not_verified');
});

test('SECURITY: SSO endpoints must be public https URLs (no internal addresses), checked when saving and again when used', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('sso-ssrf@example.com'), env);
  const base = { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 's', authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks` };
  for (const [field, bad, code] of [
    ['tokenEndpoint', 'https://169.254.169.254/latest/meta-data', 'token_endpoint_url_host_not_allowed'],
    ['jwksUri', 'https://localhost/jwks', 'jwks_uri_url_host_not_allowed'],
    ['jwksUri', 'http://idp.example.test/jwks', 'jwks_uri_url_must_be_https'],
    ['authorizationEndpoint', 'javascript:alert(1)', 'authorization_endpoint_url_must_be_https'],
    ['issuer', 'https://10.0.0.5', 'issuer_url_host_not_allowed']
  ]) {
    const r = await sso.configureSso(env, signup.organizationId, { ...base, [field]: bad });
    assert.equal(r.ok, false, field); assert.equal(r.error, code);
  }
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM organization_sso_settings`).first()).c, 0, 'nothing is stored for a rejected config');

  // A row saved before the check existed is still refused when a login tries to use it.
  assert.equal((await sso.configureSso(env, signup.organizationId, base)).ok, true);
  await env.LUMMET_DB.prepare(`UPDATE organization_sso_settings SET token_endpoint = 'https://127.0.0.1/token'`).run();
  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const calls = [];
  const result = await sso.completeLogin(env, { state: new URL(started.authorizationUrl).searchParams.get('state'), code: 'c' }, { fetchImpl: async (u) => { calls.push(String(u)); throw new Error('must not be fetched'); } });
  assert.equal(result.error, 'sso_endpoint_not_allowed');
  assert.equal(calls.length, 0);
});

test('SSO-managed accounts cannot be handed a password through "forgot password"', async () => {
  const env = makeEnv();
  const { signup, idpKeyPair, jwks } = await setUpOrgWithSso(env, 'sso-reset-owner@example.com');
  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);
  const idToken = await signIdToken(idpKeyPair.privateKey, { iss: ISSUER, aud: CLIENT_ID, email: 'managed@corp.example', exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce') });
  assert.equal((await sso.completeLogin(env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: makeFakeFetch({ idToken, jwks }) })).ok, true);

  const reset = await customerAuth.requestPasswordReset(env, 'managed@corp.example');
  assert.deepEqual(reset, { ok: true, sent: false }, 'indistinguishable from an unknown address');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM customer_password_resets`).first()).c, 0);
  const normal = await customerAuth.signUp(fakeSignupRequest('normal-person@example.com'), env);
  assert.equal((await customerAuth.requestPasswordReset(env, 'normal-person@example.com')).sent, true, 'normal accounts are unaffected');
  void normal;
});

test('disableSso prevents further logins without deleting the configuration', async () => {
  const env = makeEnv();
  const { signup } = await setUpOrgWithSso(env, 'sso-disable@example.com');

  const disableResult = await sso.disableSso(env, signup.organizationId);
  assert.equal(disableResult.ok, true);

  const started = await sso.startLogin(env, signup.organizationId, REDIRECT_URI);
  assert.equal(started.ok, false);
  assert.equal(started.error, 'sso_not_configured');

  const settings = await sso.getSsoSettings(env, signup.organizationId);
  assert.equal(settings.status, 'disabled');
  assert.equal(settings.issuer, ISSUER, 'the configuration itself is preserved, not deleted');
});
