// Release 2.6.0.16: the customer authenticator enrollment page (/app/security/2fa), through the real Worker entry point.
// Covers: flag off is a 404 and shows no link; flag on serves static HTML to a signed-in customer; unauthenticated is sent to login;
// a session an organization policy restricts can reach the page and complete enrollment through the existing API, then is unblocked;
// no secret is in the page; the inline script is nonce-tokened and parses; config-check refuses an invalid flag; the shipped default is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../worker/index.js';
import * as totp from '../worker/totp.js';
import { configIssues as checkConfig } from '../worker/config-check.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
function env(flag = 'on', extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  const e = { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ORG_SECURITY_POLICY: 'enforce', PORTAL_BASE_URL: 'https://app.example.test',
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }), ...extra };
  if (flag !== null) e.CUSTOMER_2FA_ENROLL_PAGE = flag;
  return e;
}
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.77' });
  if (cookie) h.set('Cookie', cookie);
  if (body != null) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (err) { json = null; }
  return { status: response.status, json, text, location: response.headers.get('Location'), cache: response.headers.get('Cache-Control'), cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(e, email) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: 'Org ' + email });
  assert.equal(r.status, 200, r.text);
  return { cookie: r.cookie, organizationId: r.json.organizationId, userId: (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id };
}
async function restrictedMember(e) {
  const owner = await signup(e, 'owner@example.test');
  const s = await call(e, 'POST', '/api/customer/2fa/setup', {}, owner.cookie);
  await call(e, 'POST', '/api/customer/2fa/confirm', { code: await totp.generateTotpCode(s.json.secret) }, owner.cookie);
  const member = await signup(e, 'member@example.test');
  await e.LUMMET_DB.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(owner.organizationId, member.userId, 'editor').run();
  const on = await call(e, 'PUT', `/api/organizations/${owner.organizationId}/security-policy`, { require2fa: true, reason: 'Org rule from the security review' }, owner.cookie);
  assert.equal(on.status, 200, on.text);
  return { owner, member };
}

test('flag off (set, unset or invalid): the page is not served and the org notice has no link', async () => {
  for (const flag of ['off', null, 'maybe']) {
    const e = env(flag); const { member } = await restrictedMember(e);
    // A restricted session gets the existing notice for every /app path (unchanged behaviour), with no link.
    const page = await call(e, 'GET', '/app/security/2fa', null, member.cookie);
    assert.equal(page.status, 403, `flag ${flag}`); assert.ok(!page.text.includes('/app/security/2fa'));
    // An unrestricted signed-in customer is not served the page: the route does not exist while the flag is off.
    const free = await signup(e, `free-${flag}@example.test`);
    const none = await call(e, 'GET', '/app/security/2fa', null, free.cookie);
    assert.notEqual(none.status, 200, `flag ${flag}`); assert.ok(!none.text.includes('Set up two-factor authentication'));
    const notice = await call(e, 'GET', '/app/overview', null, member.cookie);
    assert.equal(notice.status, 403); assert.ok(!notice.text.includes('/app/security/2fa'));
  }
});

test('flag on: signed-in customer gets static HTML with no secret; unauthenticated is sent to login', async () => {
  const e = env('on'); const a = await signup(e, 'a@example.test');
  const page = await call(e, 'GET', '/app/security/2fa', null, a.cookie);
  assert.equal(page.status, 200); assert.equal(page.cache, 'no-store');
  assert.ok(page.text.includes('Set up two-factor authentication') && page.text.includes('/api/customer/2fa/setup'));
  assert.ok(!/secret=|otpauth:\/\/totp/.test(page.text), 'no secret or otpauth URI is rendered into the page');
  assert.ok(!page.text.includes('innerHTML'), 'dynamic text is written with textContent');
  const anon = await call(e, 'GET', '/app/security/2fa');
  assert.equal(anon.status, 302); assert.equal(anon.location, '/app/login');
});

test('a restricted session sees the notice with the link, reaches the page, enrolls through the API and is unblocked', async () => {
  const e = env('on'); const { member } = await restrictedMember(e);
  const blocked = await call(e, 'GET', '/app/overview', null, member.cookie);
  assert.equal(blocked.status, 403); assert.ok(blocked.text.includes('href="/app/security/2fa"'));
  const page = await call(e, 'GET', '/app/security/2fa', null, member.cookie);
  assert.equal(page.status, 200);
  const s = await call(e, 'POST', '/api/customer/2fa/setup', {}, member.cookie);
  assert.equal(s.status, 200, s.text);
  const bad = await call(e, 'POST', '/api/customer/2fa/confirm', { code: '000000' }, member.cookie);
  assert.notEqual(bad.status, 200);
  const ok = await call(e, 'POST', '/api/customer/2fa/confirm', { code: await totp.generateTotpCode(s.json.secret) }, member.cookie);
  assert.equal(ok.status, 200, ok.text); assert.ok(Array.isArray(ok.json.backupCodes) && ok.json.backupCodes.length > 0);
  const after = await call(e, 'GET', '/app/overview', null, member.cookie);
  assert.notEqual(after.status, 403, 'after enrollment the policy no longer blocks this account');
});

test('the inline script carries the nonce token and parses as JavaScript', async () => {
  const e = env('on'); const a = await signup(e, 'b@example.test');
  const page = await call(e, 'GET', '/app/security/2fa', null, a.cookie);
  const m = page.text.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g) || [];
  assert.ok(m.length >= 1);
  for (const tag of m) { const code = tag.replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''); assert.doesNotThrow(() => new Function(code)); }
});

test('config-check refuses an invalid flag; the shipped defaults are off', () => {
  const bad = checkConfig({ ENVIRONMENT: 'production', CUSTOMER_2FA_ENROLL_PAGE: 'yes' });
  assert.ok(JSON.stringify(bad).includes('CUSTOMER_2FA_ENROLL_PAGE'));
  assert.ok(!JSON.stringify(checkConfig({ ENVIRONMENT: 'production', CUSTOMER_2FA_ENROLL_PAGE: 'on' })).includes('CUSTOMER_2FA_ENROLL_PAGE'));
  for (const f of ['wrangler.jsonc', 'wrangler.example.jsonc']) assert.match(readFileSync(new URL('../' + f, import.meta.url), 'utf8'), /"CUSTOMER_2FA_ENROLL_PAGE":\s*"off"/);
});
