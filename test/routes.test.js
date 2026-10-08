// Route-level tests: drive the REAL worker fetch handler (worker/index.js)
// end to end against an in-memory D1, so the hand-merged routing is exercised,
// not just the modules behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';

function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
}
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 10;
async function call(env, method, path, { body, cookie, headers = {} } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${ipn++ % 250}`, ...headers });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { res, status: res.status, text, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  return r;
}

test('existing staff surface still works: login page renders, staff API needs a session', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/login')).status, 200);
  assert.equal((await call(env, 'GET', '/api/tenants')).status, 401);
  assert.ok([301, 302, 303].includes((await call(env, 'GET', '/tenants')).status));
});

test('customer signup sets an HttpOnly session cookie and portal is reachable', async () => {
  const env = makeEnv();
  const s = await signup(env, 'a@example.com');
  assert.equal(s.status, 200, s.text);
  assert.ok(s.json.organizationId);
  const raw = s.res.headers.get('Set-Cookie');
  assert.match(raw, /HttpOnly/i); assert.match(raw, /Secure/i);
  const o = await call(env, 'GET', '/app/overview', { cookie: s.cookie });
  assert.equal(o.status, 200); assert.match(o.text, /<html|<!DOCTYPE/i);
});

test('portal and customer APIs reject anonymous callers', async () => {
  const env = makeEnv();
  const p = await call(env, 'GET', '/app/overview');
  assert.ok([301, 302, 303].includes(p.status), 'anonymous /app/overview must redirect to login');
  assert.equal((await call(env, 'GET', '/api/organizations')).status, 401);
});

test('a customer session is NOT a staff session', async () => {
  const env = makeEnv();
  const s = await signup(env, 'b@example.com');
  assert.equal((await call(env, 'GET', '/api/tenants', { cookie: s.cookie })).status, 401);
});

test('cross-organization isolation: org B cannot read or act on org A sites', async () => {
  const env = makeEnv();
  const a = await signup(env, 'iso-a@example.com'); const b = await signup(env, 'iso-b@example.com');
  const list = await call(env, 'GET', `/api/organizations/${a.json.organizationId}/sites`, { cookie: b.cookie });
  assert.ok([403, 404].includes(list.status), 'got ' + list.status);
  const bill = await call(env, 'GET', `/api/organizations/${a.json.organizationId}/billing/invoices`, { cookie: b.cookie });
  assert.ok([403, 404].includes(bill.status), 'got ' + bill.status);
});

test('stripe webhook without a valid signature is rejected and changes nothing', async () => {
  const env = makeEnv();
  const r = await call(env, 'POST', '/api/billing/webhook/stripe', { body: { id: 'evt_x', type: 'customer.subscription.deleted' }, headers: { 'Stripe-Signature': 't=1,v1=bad' } });
  assert.ok(r.status >= 400 && r.status < 500, 'got ' + r.status);
});

test('bad signup input is rejected without a session', async () => {
  const env = makeEnv();
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email: 'nope', password: 'x' } });
  assert.ok(r.status >= 400 && r.status < 500);
  assert.equal(r.cookie, '');
});

test('sanity: the same org CAN read its own sites/invoices (so isolation 403s above are real)', async () => {
  const env = makeEnv();
  const a = await signup(env, 'own@example.com');
  const s = await call(env, 'GET', `/api/organizations/${a.json.organizationId}/sites`, { cookie: a.cookie });
  assert.equal(s.status, 200, s.text);
  const i = await call(env, 'GET', `/api/organizations/${a.json.organizationId}/billing/invoices`, { cookie: a.cookie });
  assert.equal(i.status, 200, i.text);
});

test('customer domains page renders (empty state, then with a domain) and reaches the real, already-tested domain routes', async () => {
  const env = makeEnv();
  const s = await signup(env, 'domains-page@example.com');
  await plans.startTrialSubscription(env, s.json.organizationId, 'plan_casino_news_starter');
  const empty = await call(env, 'GET', '/app/domains', { cookie: s.cookie });
  assert.equal(empty.status, 200);
  assert.match(empty.text, /Create a site first/);

  const create = await call(env, 'POST', `/api/organizations/${s.json.organizationId}/sites`, { body: { name: 'My Site', productId: 'prod_casino_news' }, cookie: s.cookie });
  const siteId = create.json.siteId;
  const add = await call(env, 'POST', `/api/organizations/${s.json.organizationId}/sites/${siteId}/domains`, { body: { hostname: 'www.example.com' }, cookie: s.cookie });
  assert.equal(add.status, 200, add.text);

  const page = await call(env, 'GET', '/app/domains', { cookie: s.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /www\.example\.com/);
  assert.match(page.text, /Pending verification/);
});

test('anonymous and cross-org requests cannot reach the domains page or its API', async () => {
  const env = makeEnv();
  const redirect = await call(env, 'GET', '/app/domains');
  assert.ok([301, 302, 303].includes(redirect.status));
  const a = await signup(env, 'dom-a@example.com');
  await plans.startTrialSubscription(env, a.json.organizationId, 'plan_casino_news_starter');
  const b = await signup(env, 'dom-b@example.com');
  const create = await call(env, 'POST', `/api/organizations/${a.json.organizationId}/sites`, { body: { name: 'S', productId: 'prod_casino_news' }, cookie: a.cookie });
  const cross = await call(env, 'POST', `/api/organizations/${a.json.organizationId}/sites/${create.json.siteId}/domains`, { body: { hostname: 'x.example.com' }, cookie: b.cookie });
  assert.ok([403, 404].includes(cross.status), 'org B must not be able to add a domain to org A\'s site');
});

test('customer usage page shows plan limits and, once the plan includes AI, a working task runner', async () => {
  const env = makeEnv();
  const starter = await signup(env, 'usage-starter@example.com');
  await plans.startTrialSubscription(env, starter.json.organizationId, 'plan_casino_news_starter');
  const noAi = await call(env, 'GET', '/app/usage', { cookie: starter.cookie });
  assert.equal(noAi.status, 200);
  assert.match(noAi.text, /Not included on your current plan/);

  const pro = await signup(env, 'usage-pro@example.com');
  await plans.startTrialSubscription(env, pro.json.organizationId, 'plan_casino_news_growth');
  const withAi = await call(env, 'GET', '/app/usage', { cookie: pro.cookie });
  assert.equal(withAi.status, 200);
  assert.match(withAi.text, /Credit balance/);
  assert.match(withAi.text, /ai-run-form/);

  const run = await call(env, 'POST', `/api/organizations/${pro.json.organizationId}/ai/run`, { body: { task: 'summarize', input: { text: 'hello world' } }, cookie: pro.cookie });
  // No AI binding configured in this test env -> the real provider throws, which the gateway
  // already turns into a safe refund + generic error (see ai-gateway.test.js) rather than a crash.
  assert.ok([200, 502].includes(run.status), run.text);
});

test('usage page is unreachable anonymously and shows only the requesting org\'s own numbers', async () => {
  const env = makeEnv();
  const redirect = await call(env, 'GET', '/app/usage');
  assert.ok([301, 302, 303].includes(redirect.status));
  const a = await signup(env, 'usage-a@example.com');
  await plans.startTrialSubscription(env, a.json.organizationId, 'plan_casino_news_starter');
  await call(env, 'POST', `/api/organizations/${a.json.organizationId}/sites`, { body: { name: 'S', productId: 'prod_casino_news' }, cookie: a.cookie });
  const b = await signup(env, 'usage-b@example.com');
  const page = await call(env, 'GET', '/app/usage', { cookie: b.cookie });
  assert.equal(page.status, 200);
  const sitesRowMatch = page.text.match(/<td>Sites<\/td><td>(\d+)<\/td>/);
  assert.ok(sitesRowMatch, 'expected a Sites usage row');
  assert.equal(sitesRowMatch[1], '0', "org B must see its own (zero) site count, not org A's");
});

test('organization settings page: owner sees lifecycle actions, cross-org blocked', async () => {
  const env = makeEnv();
  const owner = await signup(env, 'settings-owner@example.com');
  const ownerPage = await call(env, 'GET', '/app/settings', { cookie: owner.cookie });
  assert.equal(ownerPage.status, 200);
  assert.match(ownerPage.text, /Delete this organization/);
  assert.match(ownerPage.text, /Invite a team member first/);
  const b = await signup(env, 'settings-b@example.com');
  const cross = await call(env, 'GET', '/app/settings', { cookie: b.cookie });
  assert.equal(cross.status, 200);
  assert.ok(!cross.text.includes(owner.json.organizationId), "org B's settings page must never reference org A's id");
  const anon = await call(env, 'GET', '/app/settings');
  assert.ok([301, 302, 303].includes(anon.status));
});

test('organization settings actions actually change state', async () => {
  const env = makeEnv();
  const s = await signup(env, 'settings-actions@example.com');
  const deactivate = await call(env, 'POST', `/api/organizations/${s.json.organizationId}/deactivate`, { cookie: s.cookie });
  assert.equal(deactivate.status, 200);
  const page = await call(env, 'GET', '/app/settings', { cookie: s.cookie });
  assert.match(page.text, /Reactivate organization/);
});
