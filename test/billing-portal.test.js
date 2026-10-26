// Billing portal: "Update payment method & invoices".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider } from './support/fake-billing-provider.js';
import worker from '../worker/index.js';
import { createBillingService, __setBillingProviderForTests } from '../worker/billing.js';
import * as stripe from '../worker/billing-stripe.js';
import * as plans from '../worker/plans.js';
import { renderBillingPage } from '../worker/views/customer-pages/billing.js';

const ctx = { waitUntil() {} };
let n = 1;
function makeEnv() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${n++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(env, email) {
  const s = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } });
  return { orgId: s.json.organizationId, cookie: s.cookie };
}

test('stripe adapter: createPortalSession posts the customer and return_url to the portal endpoint', async () => {
  const realFetch = globalThis.fetch; let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response(JSON.stringify({ url: 'https://billing.stripe.test/p/abc' }), { status: 200 }); };
  try {
    const r = await stripe.createPortalSession({ STRIPE_SECRET_KEY: 'sk_test_x' }, { providerCustomerId: 'cus_123', returnUrl: 'https://cp.test/app/billing' });
    assert.equal(r.portalUrl, 'https://billing.stripe.test/p/abc');
  } finally { globalThis.fetch = realFetch; }
  assert.equal(seen.url, 'https://api.stripe.com/v1/billing_portal/sessions');
  assert.equal(seen.init.method, 'POST');
  const form = new URLSearchParams(seen.init.body);
  assert.equal(form.get('customer'), 'cus_123');
  assert.equal(form.get('return_url'), 'https://cp.test/app/billing');
});

test('service: no provider customer -> 409; provider failure -> portal_unavailable without leaking details', async () => {
  const env = makeEnv();
  const fake = createFakeBillingProvider();
  const svc = createBillingService(fake);
  const a = await signup(env, 'svc@example.com');
  assert.deepEqual(await svc.openBillingPortal(env, a.orgId, { returnUrl: 'https://x.test/b' }), { ok: false, status: 409, error: 'no_billing_customer' });
  assert.equal((await svc.openBillingPortal(env, a.orgId, {})).error, 'return_url_required');

  await env.LUMMET_DB.prepare(`INSERT INTO billing_customers (organization_id, provider, provider_customer_id) VALUES (?, 'fake', 'fake_cus_9')`).bind(a.orgId).run();
  const ok = await svc.openBillingPortal(env, a.orgId, { returnUrl: 'https://x.test/b' });
  assert.deepEqual(ok, { ok: true, portalUrl: 'https://fake.test/portal/fake_cus_9' });

  fake._failPortal = true;
  const bad = await svc.openBillingPortal(env, a.orgId, { returnUrl: 'https://x.test/b' });
  assert.deepEqual(bad, { ok: false, status: 502, error: 'portal_unavailable' });
});

test('route: admins get a portal URL with a server-built return URL; only their own organization\'s customer is used', async (t) => {
  const fake = createFakeBillingProvider(); __setBillingProviderForTests(fake); t.after(() => __setBillingProviderForTests(null));
  const env = makeEnv();
  const a = await signup(env, 'a@example.com');
  const b = await signup(env, 'b@example.com');
  await env.LUMMET_DB.prepare(`INSERT INTO billing_customers (organization_id, provider, provider_customer_id) VALUES (?, 'fake', 'cus_A')`).bind(a.orgId).run();
  await env.LUMMET_DB.prepare(`INSERT INTO billing_customers (organization_id, provider, provider_customer_id) VALUES (?, 'fake', 'cus_B')`).bind(b.orgId).run();

  const r = await call(env, 'POST', `/api/organizations/${a.orgId}/billing/portal`, { cookie: a.cookie, body: { returnUrl: 'https://evil.example/' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.portalUrl, 'https://fake.test/portal/cus_A');
  const c = fake._calls.find((x) => x.method === 'createPortalSession');
  assert.equal(c.returnUrl, 'https://cp.test/app/billing');

  // Org B's admin cannot reach org A's portal.
  const cross = await call(env, 'POST', `/api/organizations/${a.orgId}/billing/portal`, { cookie: b.cookie });
  assert.ok([403, 404].includes(cross.status), String(cross.status));
  assert.equal(fake._calls.filter((x) => x.method === 'createPortalSession').length, 1);

  const audit = await env.LUMMET_DB.prepare(`SELECT action, success FROM lummet_audit_logs WHERE resource = 'billing_portal'`).first();
  assert.deepEqual({ ...audit }, { action: 'open', success: 1 });

  // Org with no customer yet
  const fresh = await signup(env, 'fresh@example.com');
  assert.equal((await call(env, 'POST', `/api/organizations/${fresh.orgId}/billing/portal`, { cookie: fresh.cookie })).status, 409);
});

test('pause route is authenticated, tenant-scoped, audited, and disabled by default', async (t) => {
  __setBillingProviderForTests(createFakeBillingProvider()); t.after(() => __setBillingProviderForTests(null));
  const env = makeEnv();
  const a = await signup(env, 'pause-owner@example.com');
  const b = await signup(env, 'pause-other@example.com');
  const body = { resumesAt: new Date(Date.now() + 86400000).toISOString() };
  const own = await call(env, 'POST', `/api/organizations/${a.orgId}/billing/pause`, { cookie: a.cookie, body });
  assert.equal(own.status, 404); assert.equal(own.json.error, 'save_flow_disabled');
  const cross = await call(env, 'POST', `/api/organizations/${a.orgId}/billing/pause`, { cookie: b.cookie, body });
  assert.ok([403, 404].includes(cross.status));
  const rows = await env.LUMMET_DB.prepare(`SELECT success, status_code FROM lummet_audit_logs WHERE resource='subscription' AND action='pause' ORDER BY created_at DESC`).all();
  assert.equal(rows.results.length, 1); assert.equal(rows.results[0].success, 0);
});

test('view: the portal button and a past-due warning appear for paid subscriptions, only to managers', () => {
  const sub = { status: 'past_due', provider: 'stripe', plan_id: 'p', cancel_at_period_end: 0 };
  const mgr = renderBillingPage({ subscription: sub, plan: { name: 'P' }, invoices: [], availablePlans: [], canManage: true });
  assert.match(mgr, /Update payment method &amp; invoices/);
  assert.match(mgr, /last payment failed/);
  const active = renderBillingPage({ subscription: { ...sub, status: 'active' }, plan: { name: 'P' }, invoices: [], availablePlans: [], canManage: true });
  assert.doesNotMatch(active, /last payment failed/);
  const viewer = renderBillingPage({ subscription: sub, plan: { name: 'P' }, invoices: [], availablePlans: [], canManage: false });
  assert.doesNotMatch(viewer, /Update payment method &amp; invoices/);
  const restricted = renderBillingPage({ subscription: { ...sub, status: 'active' }, access: { state: 'restricted' }, plan: { name: 'P' }, invoices: [], availablePlans: [], canManage: false });
  assert.match(restricted, /read-only until payment is resolved/);
  const suspended = renderBillingPage({ subscription: { ...sub, status: 'active' }, access: { state: 'suspended' }, plan: { name: 'P' }, invoices: [], availablePlans: [], canManage: false });
  assert.match(suspended, /suspended for non-payment/);
  const usage = renderBillingPage({ subscription: sub, access: { state: 'past_due' }, usage: { sites: { used: 1, limit: 2 }, users: { used: 3, limit: 5 }, customDomains: { used: 0, limit: 1 }, storageBytes: null }, aiCredits: 12, plan: { name: 'P' }, invoices: [], availablePlans: [], canManage: true });
  assert.match(usage, /Storage/); assert.match(usage, /Unknown/); assert.match(usage, /AI credits/); assert.match(usage, /billing-invoices/);
});
