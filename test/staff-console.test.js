import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import * as entitlements from '../worker/entitlements.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(e) {
  const b = await call(e, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  assert.equal(b.status, 200, b.text);
  const l = await call(e, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  assert.equal(l.status, 200, l.text);
  return l.cookie;
}
async function customer(e, email) {
  const s = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email });
  return { id: s.json.organizationId, cookie: s.cookie };
}
const SAAS_PAGES = ['/platform/saas', '/platform/saas/organizations', '/platform/saas/subscriptions', '/platform/saas/plans', '/platform/saas/jobs', '/platform/saas/email'];

test('staff SaaS pages render for a super admin', async () => {
  const e = env(); const staff = await staffLogin(e); await customer(e, 'c@example.com');
  for (const p of SAAS_PAGES) { const r = await call(e, 'GET', p, null, staff); assert.equal(r.status, 200, p + ' ' + r.text.slice(0, 200)); }
  const list = await call(e, 'GET', '/platform/saas/organizations?q=Org', null, staff);
  assert.match(list.text, /Org c@example\.com/);
});

test('staff SaaS pages and API are closed to anonymous callers and to customer sessions', async () => {
  const e = env(); const c = await customer(e, 'x@example.com');
  for (const p of SAAS_PAGES) {
    const anon = await call(e, 'GET', p); assert.ok([301, 302, 303].includes(anon.status), p);
    const cust = await call(e, 'GET', p, null, c.cookie); assert.ok([301, 302, 303, 401, 403].includes(cust.status), p + ' ' + cust.status);
  }
  const api = await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/status`, { status: 'suspended', reason: 'x' }, c.cookie);
  assert.equal(api.status, 401);
  assert.equal((await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/status`, { status: 'suspended', reason: 'x' })).status, 401);
});

test('suspending an org makes it read-only for the customer, reactivating restores it; both are audited', async () => {
  const e = env(); const staff = await staffLogin(e); const c = await customer(e, 's@example.com');
  const noReason = await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/status`, { status: 'suspended' }, staff);
  assert.equal(noReason.status, 422);
  const sus = await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/status`, { status: 'suspended', reason: 'chargeback' }, staff);
  assert.equal(sus.status, 200, sus.text);
  assert.equal((await call(e, 'GET', `/api/organizations/${c.id}/sites`, null, c.cookie)).status, 200, 'reads still allowed');
  const blocked = await call(e, 'POST', `/api/organizations/${c.id}/invitations`, { email: 'a@b.test', role: 'viewer' }, c.cookie);
  assert.equal(blocked.status, 403); assert.equal(blocked.json.error, 'organization_suspended');
  await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/status`, { status: 'active' }, staff);
  const ok = await call(e, 'POST', `/api/organizations/${c.id}/invitations`, { email: 'a@b.test', role: 'viewer' }, c.cookie);
  assert.equal(ok.status, 200, ok.text);
  const audit = await e.LUMMET_DB.prepare(`SELECT action, organization_id, admin_id FROM lummet_audit_logs WHERE resource = 'organization' ORDER BY id`).all();
  assert.deepEqual(audit.results.map((a) => a.action), ['set_status:suspended', 'set_status:active']);
  assert.ok(audit.results.every((a) => a.organization_id === c.id && a.admin_id));
});

test('entitlement override changes what the org can do, needs a reason, and cannot cross organizations', async () => {
  const e = env(); const staff = await staffLogin(e);
  const a = await customer(e, 'oa@example.com'); const b = await customer(e, 'ob@example.com');
  await plans.startTrialSubscription(e, a.id, 'plan_casino_news_starter');
  await plans.startTrialSubscription(e, b.id, 'plan_casino_news_starter');
  const sub = await e.LUMMET_DB.prepare('SELECT id FROM subscriptions WHERE organization_id = ?').bind(a.id).first();
  assert.equal(await entitlements.checkEntitlement(e, a.id, 'sites.max'), 1);
  const noReason = await call(e, 'POST', `/api/platform/saas/organizations/${a.id}/override`, { subscriptionId: sub.id, key: 'sites.max', valueType: 'number', value: '5' }, staff);
  assert.equal(noReason.status, 422);
  const bad = await call(e, 'POST', `/api/platform/saas/organizations/${a.id}/override`, { subscriptionId: sub.id, key: 'sites.max', valueType: 'number', value: 'lots', reason: 'r' }, staff);
  assert.equal(bad.status, 422);
  const ok = await call(e, 'POST', `/api/platform/saas/organizations/${a.id}/override`, { subscriptionId: sub.id, key: 'sites.max', valueType: 'number', value: '5', reason: 'enterprise deal' }, staff);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(await entitlements.checkEntitlement(e, a.id, 'sites.max'), 5);
  assert.equal(await entitlements.checkEntitlement(e, b.id, 'sites.max'), 1, 'other org untouched');
  const cross = await call(e, 'POST', `/api/platform/saas/organizations/${b.id}/override`, { subscriptionId: sub.id, key: 'sites.max', valueType: 'number', value: '99', reason: 'r' }, staff);
  assert.equal(cross.status, 404, 'a subscription belonging to org A cannot be edited via org B');
  const rm = await call(e, 'POST', `/api/platform/saas/organizations/${a.id}/override/remove`, { subscriptionId: sub.id, key: 'sites.max' }, staff);
  assert.equal(rm.status, 200); assert.equal(await entitlements.checkEntitlement(e, a.id, 'sites.max'), 1);
});

test('staff can grant AI credits (reason required) and the ledger records it', async () => {
  const e = env(); const staff = await staffLogin(e); const c = await customer(e, 'ai@example.com');
  assert.equal((await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/ai-credits`, { amount: 50 }, staff)).status, 422);
  assert.equal((await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/ai-credits`, { amount: -5, reason: 'x' }, staff)).status, 400);
  assert.equal((await call(e, 'POST', `/api/platform/saas/organizations/${c.id}/ai-credits`, { amount: 50, reason: 'goodwill' }, staff)).status, 200);
  const r = await call(e, 'GET', `/api/organizations/${c.id}/ai/credits`, null, c.cookie);
  assert.equal(r.json.data.balance, 50);
});

test('plan editing validates input and is audited', async () => {
  const e = env(); const staff = await staffLogin(e);
  const bad = await call(e, 'POST', '/api/platform/saas/plans/plan_casino_news_growth', { priceCents: -1 }, staff);
  assert.equal(bad.status, 422);
  assert.equal((await call(e, 'POST', '/api/platform/saas/plans/plan_casino_news_growth', { stripePriceId: 'not-a-price' }, staff)).status, 422);
  assert.equal((await call(e, 'POST', '/api/platform/saas/plans/plan_casino_news_growth', { stripePriceId: 'price_1AbC' , priceCents: 900 }, staff)).status, 200);
  const row = await e.LUMMET_DB.prepare('SELECT price_cents, stripe_price_id FROM plans WHERE id = ?').bind('plan_casino_news_growth').first();
  assert.equal(row.price_cents, 900); assert.equal(row.stripe_price_id, 'price_1AbC');
  assert.equal((await call(e, 'POST', '/api/platform/saas/plans/nope', { priceCents: 1 }, staff)).status, 404);
  const a = await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource = 'plan'`).first();
  assert.equal(a.n, 4);
});

test('job detail page shows history; retry refuses non-failed jobs', async () => {
  const e = env(); const staff = await staffLogin(e);
  const jobs = await import('../worker/jobs.js');
  const { jobId } = await jobs.createJob(e, { type: 'tenant_provisioning', stepKeys: ['a'] });
  await jobs.markJobRunning(e, jobId); await jobs.startStep(e, jobId, 'a'); await jobs.failStep(e, jobId, 'a', 'cf down'); await jobs.markJobFailed(e, jobId, 'cf down');
  const page = await call(e, 'GET', `/platform/saas/jobs/${jobId}`, null, staff);
  assert.equal(page.status, 200); assert.match(page.text, /cf down/);
  const noSite = await call(e, 'POST', `/api/platform/saas/jobs/${jobId}/retry`, {}, staff);
  assert.equal(noSite.status, 409, 'no site attached => not retryable');
  assert.equal((await call(e, 'GET', '/platform/saas/jobs/does-not-exist', null, staff)).status, 404);
});

test('HTML in organization names is escaped in the staff console', async () => {
  const e = env(); const staff = await staffLogin(e);
  const s = await call(e, 'POST', '/api/customer/signup', { email: 'xss@example.com', password: 'Correct-Horse-Battery-9', organizationName: '<script>alert(1)</script>' });
  const list = await call(e, 'GET', '/platform/saas/organizations', null, staff);
  assert.ok(!list.text.includes('<script>alert(1)</script>'));
  const detail = await call(e, 'GET', `/platform/saas/organizations/${s.json.organizationId}`, null, staff);
  assert.ok(!detail.text.includes('<script>alert(1)</script>'));
});

test('staff tenant-template routes: publish, list, activate, page renders, all audited, closed to non-staff', async () => {
  const e = env(); e.TENANT_TEMPLATES = { m: new Map(), async put(k, v) { this.m.set(k, v); }, async get(k) { return this.m.has(k) ? { async text() { return this.m.get(k); } } : null; } };
  const staff = await staffLogin(e); const c = await customer(e, 'rel@example.com');
  const pub = await call(e, 'POST', '/api/platform/saas/tenant-template/publish', { version: '1.0.0', scriptContent: 'export default {fetch(){}}', migrations: [] }, staff);
  assert.equal(pub.status, 200, pub.text);
  assert.equal((await call(e, 'POST', '/api/platform/saas/tenant-template/publish', { version: '1.0.0', scriptContent: 'x', migrations: [] }, staff)).status, 409);
  const list = await call(e, 'GET', '/api/platform/saas/tenant-template', null, staff);
  assert.equal(list.json.data.length, 1);
  assert.equal((await call(e, 'GET', '/api/platform/saas/tenant-template', null, c.cookie)).status, 401);
  assert.equal((await call(e, 'GET', '/api/platform/saas/tenant-template')).status, 401);
  await call(e, 'POST', '/api/platform/saas/tenant-template/publish', { version: '1.1.0', scriptContent: 'y', migrations: [] }, staff);
  const activate = await call(e, 'POST', '/api/platform/saas/tenant-template/1.0.0/activate', {}, staff);
  assert.equal(activate.status, 200, activate.text);
  const page = await call(e, 'GET', '/platform/saas/releases', null, staff);
  assert.equal(page.status, 200); assert.match(page.text, /1\.0\.0/); assert.match(page.text, /1\.1\.0/);
  const n = await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource='tenant_template_release'`).first();
  assert.equal(n.n, 4);
});
