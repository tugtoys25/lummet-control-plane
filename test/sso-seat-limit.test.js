// Release 2.6.1.6, gap G3: SSO just-in-time sign-in takes a seat. Real SSO flow (state, PKCE, a real RS256-signed ID token verified by jwt.js),
// real database. The IdP's network round trip is the only thing faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as sso from '../worker/sso.js';
import * as customerAuth from '../worker/customer-auth.js';

const ISSUER = 'https://idp.example.test', CLIENT_ID = 'lummet-client-id', REDIRECT_URI = 'https://app.example.test/sso/callback';
const b64u = (bytes) => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uStr = (s) => b64u(new TextEncoder().encode(s));
const nowSeconds = () => Math.floor(Date.now() / 1000);
async function signIdToken(privateKey, claims) {
  const input = `${b64uStr(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'idp-key-1' }))}.${b64uStr(JSON.stringify(claims))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, new TextEncoder().encode(input)));
  return `${input}.${b64u(sig)}`;
}
function fetchFor({ idToken, jwks }) {
  return async (url) => {
    if (url.toString().endsWith('/token')) return { ok: true, async json() { return { id_token: idToken, access_token: 'x' }; } };
    if (url.toString().endsWith('/jwks')) return { ok: true, async json() { return jwks; } };
    throw new Error(`unexpected fetch to ${url}`);
  };
}

/** An organization on the Starter plan (users.max = 2; the owner holds seat 1) with SSO configured for example.com. */
async function setup(billingMode) {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), BILLING_ENFORCE: billingMode };
  const signup = await customerAuth.signUp({ async json() { return { email: 'owner@seats.example', password: 'correct-horse-battery', organizationName: 'Seats Org' }; }, headers: { get: () => '203.0.113.170' } }, env);
  await db.prepare(`INSERT INTO subscriptions (id, organization_id, plan_id, status) VALUES ('sub-seats', ?, 'plan_casino_news_starter', 'active')`).bind(signup.organizationId).run();
  await db.prepare(`INSERT INTO organization_sso_domains (id, organization_id, domain, verification_token, status, verified_at) VALUES (?, ?, 'example.com', 't', 'verified', CURRENT_TIMESTAMP)`).bind(crypto.randomUUID(), signup.organizationId).run();
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey); jwk.kid = 'idp-key-1';
  const configured = await sso.configureSso(env, signup.organizationId, { issuer: ISSUER, clientId: CLIENT_ID, clientSecret: 's3cret-value', authorizationEndpoint: `${ISSUER}/authorize`, tokenEndpoint: `${ISSUER}/token`, jwksUri: `${ISSUER}/jwks`, defaultRole: 'editor' });
  assert.equal(configured.ok, true);
  return { env, db, org: signup.organizationId, keys, jwks: { keys: [jwk] } };
}
async function ssoLogin(w, email) {
  const started = await sso.startLogin(w.env, w.org, REDIRECT_URI);
  const url = new URL(started.authorizationUrl);
  const idToken = await signIdToken(w.keys.privateKey, { iss: ISSUER, aud: CLIENT_ID, sub: `idp-${email}`, email, exp: nowSeconds() + 300, nonce: url.searchParams.get('nonce') });
  return sso.completeLogin(w.env, { state: url.searchParams.get('state'), code: 'code' }, { fetchImpl: fetchFor({ idToken, jwks: w.jwks }) });
}
const users = async (w, email) => (await w.db.prepare('SELECT COUNT(*) n FROM customer_users WHERE email = ?').bind(email).first()).n;
const members = async (w) => (await w.db.prepare('SELECT COUNT(*) n FROM organization_users WHERE organization_id = ?').bind(w.org).first()).n;

test('G3 enforce: SSO sign-in takes a seat; at the limit a new person is refused before any account is created', async () => {
  const w = await setup('enforce');
  const first = await ssoLogin(w, 'one@example.com');
  assert.equal(first.ok, true, JSON.stringify(first));                                   // seat 2 of 2
  assert.equal(await members(w), 2);
  const second = await ssoLogin(w, 'two@example.com');
  assert.equal(second.ok, false); assert.equal(second.status, 402); assert.equal(second.error, 'seat_limit_reached');
  assert.equal(second.limit, 2);
  assert.equal(await users(w, 'two@example.com'), 0, 'no half-created account');
  assert.equal(await members(w), 2);
});

test('G3 a person who is already a member signs in again at the limit: no new seat is needed', async () => {
  const w = await setup('enforce');
  assert.equal((await ssoLogin(w, 'one@example.com')).ok, true);
  const again = await ssoLogin(w, 'one@example.com');
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(await members(w), 2);
  const owner = await ssoLogin(w, 'owner@seats.example').catch((e) => ({ ok: false, error: String(e.message) }));
  assert.notEqual(owner.error, 'seat_limit_reached', 'the existing owner is never refused for seats');
});

test('G3 a removed member who signs in through SSO again needs a seat, and an account not managed by this SSO is still refused outright', async () => {
  const w = await setup('enforce');
  assert.equal((await ssoLogin(w, 'one@example.com')).ok, true);                         // seat 2 of 2
  const one = await w.db.prepare(`SELECT id FROM customer_users WHERE email = 'one@example.com'`).first();
  await w.db.prepare('DELETE FROM organization_users WHERE organization_id = ? AND user_id = ?').bind(w.org, one.id).run();   // removed by an admin
  assert.equal((await ssoLogin(w, 'two@example.com')).ok, true, 'their seat went to someone else');
  const back = await ssoLogin(w, 'one@example.com');
  assert.equal(back.status, 402); assert.equal(back.error, 'seat_limit_reached');
  assert.equal(await members(w), 2, 'not re-added');
  // An account that already exists outside this organization's SSO is refused before seats are even considered (takeover protection).
  await w.db.prepare(`INSERT INTO customer_users (id, email, email_key, password_hash, status) VALUES ('u-existing', 'existing@example.com', 'existing@example.com', 'x', 'active')`).run();
  const other = await ssoLogin(w, 'existing@example.com');
  assert.equal(other.status, 409); assert.equal(other.error, 'account_exists_not_managed_by_sso');
});

test('G3 off never blocks, shadow only logs', async () => {
  for (const mode of ['off', 'shadow']) {
    const w = await setup(mode);
    const logged = []; const orig = console.log; console.log = (...a) => logged.push(a.join(' '));
    let r1, r2;
    try { r1 = await ssoLogin(w, 'one@example.com'); r2 = await ssoLogin(w, 'two@example.com'); } finally { console.log = orig; }
    assert.equal(r1.ok && r2.ok, true, `${mode}: ${JSON.stringify(r2)}`);
    assert.equal(await members(w), 3);
    assert.equal(logged.some((l) => l.includes('sso_seat_limit_would_refuse')), mode === 'shadow', mode);
  }
});
