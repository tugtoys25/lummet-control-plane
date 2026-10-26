// Round 6.4A (release 2.6.0.9): the HTTP surface of the organization security policy, through the real Worker entry point.
// Covers: the owner-only policy route, the restricted session at sign-in and on session use, the 2FA setup routes staying reachable
// as the way out, the portal notice page, and that the flag off changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import * as totp from '../worker/totp.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
function env(mode = 'enforce', extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ORG_SECURITY_POLICY: mode, PORTAL_BASE_URL: 'https://app.example.test',
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }), ...extra };
}
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.77' });
  if (cookie) h.set('Cookie', cookie);
  if (body != null) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: response.status, json, text, cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(e, email) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: 'Org ' + email });
  assert.equal(r.status, 200, r.text);
  return { cookie: r.cookie, organizationId: r.json.organizationId, userId: (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id };
}
async function enable2faViaApi(e, cookie) {
  const s = await call(e, 'POST', '/api/customer/2fa/setup', {}, cookie);
  assert.equal(s.status, 200, s.text);
  const c = await call(e, 'POST', '/api/customer/2fa/confirm', { code: await totp.generateTotpCode(s.json.secret) }, cookie);
  assert.equal(c.status, 200, c.text);
  return s.json.secret;
}
async function addMember(e, organizationId, userId, role) {
  await e.LUMMET_DB.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(organizationId, userId, role).run();
}
async function setup(e) {
  const owner = await signup(e, 'owner@example.test'); await enable2faViaApi(e, owner.cookie);
  const member = await signup(e, 'member@example.test'); await addMember(e, owner.organizationId, member.userId, 'editor');
  const on = await call(e, 'PUT', `/api/organizations/${owner.organizationId}/security-policy`, { require2fa: true, reason: 'Org rule from the security review' }, owner.cookie);
  assert.equal(on.status, 200, on.text);
  return { owner, member, on };
}

test('PUT /security-policy: owner with a reason turns it on; the response says who is affected; it is audited', async () => {
  const e = env(); const { on, owner } = await setup(e);
  assert.equal(on.json.changed, true); assert.equal(on.json.data.require2fa, true); assert.equal(on.json.enforcement, 'enforce'); assert.equal(on.json.membersWithout2fa, 1);
  const get = await call(e, 'GET', `/api/organizations/${owner.organizationId}/security-policy`, null, owner.cookie);
  assert.equal(get.status, 200); assert.equal(get.json.data.require2fa, true);
  const audit = (await e.LUMMET_DB.prepare(`SELECT reason, endpoint, method, organization_id FROM lummet_audit_logs WHERE action = 'require_2fa_enable'`).all()).results;
  assert.equal(audit.length, 1); assert.deepEqual([audit[0].reason, audit[0].endpoint, audit[0].method, audit[0].organization_id], ['Org rule from the security review', `/api/organizations/${owner.organizationId}/security-policy`, 'PUT', owner.organizationId]);
});

test('PUT /security-policy: no reason is 422; an editor is 403; an outsider is 403; unauthenticated is 401', async () => {
  const e = env(); const { owner, member } = await setup(e);
  const path = `/api/organizations/${owner.organizationId}/security-policy`;
  assert.equal((await call(e, 'PUT', path, { require2fa: false }, owner.cookie)).status, 422);
  assert.equal((await call(e, 'PUT', path, { require2fa: false, reason: 'cannot do this' }, member.cookie)).status, 403, 'a restricted editor is stopped by the policy itself');
  const outsider = await signup(e, 'out@example.test');
  const o = await call(e, 'PUT', path, { require2fa: false, reason: 'not my organization' }, outsider.cookie);
  assert.equal(o.status, 403); assert.equal((await call(e, 'GET', path, null, outsider.cookie)).status, 403);
  assert.equal((await call(e, 'PUT', path, { require2fa: false, reason: 'no cookie here' })).status, 401);
  const still = await call(e, 'GET', path, null, owner.cookie);
  assert.equal(still.json.data.require2fa, true, 'nothing above changed it');
});

test('SIGN-IN over HTTP: a member without 2FA is told to enroll and holds only a restricted session', async () => {
  const e = env(); const { owner } = await setup(e);
  const login = await call(e, 'POST', '/api/customer/login', { email: 'member@example.test', password: PW });
  assert.equal(login.status, 200); assert.equal(login.json.twoFactorEnrollmentRequired, true); assert.equal(login.json.reason, 'org_2fa_required'); assert.ok(login.cookie);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'login_org_2fa_enrollment_only'`).first()).n, 1);
  for (const [m, p] of [['GET', '/api/organizations'], ['GET', `/api/organizations/${owner.organizationId}/members`], ['GET', '/api/products'], ['GET', '/api/customer/account/export'], ['GET', '/api/customer/webauthn/credentials']]) {
    const r = await call(e, m, p, null, login.cookie);
    assert.equal(r.status, 403, `${p} -> ${r.status}`); assert.equal(r.json.error, 'org_2fa_required');
  }
  const page = await call(e, 'GET', '/app/overview', null, login.cookie);
  assert.equal(page.status, 403); assert.match(page.text, /requires two-factor authentication/i);
  assert.doesNotMatch(page.text, /member@example\.test/, 'the notice shows no account data');
});

test('SESSION USE over HTTP: a session issued before the policy is blocked the moment it is on', async () => {
  const e = env(); const owner = await signup(e, 'o@example.test'); await enable2faViaApi(e, owner.cookie);
  const m = await signup(e, 'm@example.test'); await addMember(e, owner.organizationId, m.userId, 'viewer');
  assert.equal((await call(e, 'GET', '/api/organizations', null, m.cookie)).status, 200);
  await call(e, 'PUT', `/api/organizations/${owner.organizationId}/security-policy`, { require2fa: true, reason: 'switching it on now' }, owner.cookie);
  const blocked = await call(e, 'GET', '/api/organizations', null, m.cookie);
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error, 'org_2fa_required');
  assert.equal((await call(e, 'GET', '/api/organizations', null, owner.cookie)).status, 200);
});

test('THE WAY OUT: a restricted session can set up 2FA over HTTP, and then the same session works', async () => {
  const e = env(); await setup(e);
  const login = await call(e, 'POST', '/api/customer/login', { email: 'member@example.test', password: PW });
  assert.equal((await call(e, 'GET', '/api/customer/2fa/status', null, login.cookie)).json.data.enabled, false);
  await enable2faViaApi(e, login.cookie);
  assert.equal((await call(e, 'GET', '/api/organizations', null, login.cookie)).status, 200);
  const out = await call(e, 'POST', '/api/customer/logout', {}, login.cookie);
  assert.equal(out.status, 200);
});

test('portal: a restricted session sees the notice, the login page still renders, and a signed-out visitor is redirected as before', async () => {
  const e = env(); await setup(e);
  const login = await call(e, 'POST', '/api/customer/login', { email: 'member@example.test', password: PW });
  assert.equal((await call(e, 'GET', '/app/login', null, login.cookie)).status, 200, 'a blocked session may reach the login form to sign in again');
  assert.equal((await call(e, 'GET', '/app/overview')).status, 302);
});

test('flag off: the route is dark and a stored policy blocks nothing', async () => {
  const e = env('off'); const owner = await signup(e, 'off-owner@example.test'); await enable2faViaApi(e, owner.cookie);
  const m = await signup(e, 'off-member@example.test'); await addMember(e, owner.organizationId, m.userId, 'viewer');
  await e.LUMMET_DB.prepare('INSERT INTO organization_security_policies (organization_id, require_2fa) VALUES (?, 1)').bind(owner.organizationId).run();
  assert.equal((await call(e, 'PUT', `/api/organizations/${owner.organizationId}/security-policy`, { require2fa: false, reason: 'dark route test' }, owner.cookie)).status, 404);
  assert.equal((await call(e, 'GET', `/api/organizations/${owner.organizationId}/security-policy`, null, owner.cookie)).status, 404);
  const login = await call(e, 'POST', '/api/customer/login', { email: 'off-member@example.test', password: PW });
  assert.equal(login.json.twoFactorEnrollmentRequired, undefined);
  assert.equal((await call(e, 'GET', '/api/organizations', null, login.cookie)).status, 200);
});

test('shadow: the policy can be set but nobody is blocked', async () => {
  const e = env('shadow'); const { member } = await setup(e);
  const login = await call(e, 'POST', '/api/customer/login', { email: 'member@example.test', password: PW });
  assert.equal(login.json.twoFactorEnrollmentRequired, undefined);
  assert.equal((await call(e, 'GET', '/api/organizations', null, login.cookie)).status, 200);
  assert.ok(member.userId);
});
