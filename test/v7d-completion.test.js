// v7D completion: what the v7D notes promised customers and staff, now actually reachable from the UI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { renderDeveloperPage } from '../worker/views/customer-pages/developer.js';
import * as jobs from '../worker/jobs.js';
import { configIssues } from '../worker/config-check.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'staging' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(e) {
  await call(e, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  return (await call(e, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;
}

/** Runs the page's inline script against a stub browser and returns the deliveries HTML it renders. */
async function renderDeliveries(canManage, rows) {
  const html = renderDeveloperPage({ apiKeys: [], webhooks: [{ id: 'w1', url: 'https://example.com/h', event_types: ['site.active'], status: 'active' }], eventTypes: ['site.active'], canManage });
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const box = { innerHTML: '' }; const posted = [];
  const sandbox = {
    document: { getElementById: (id) => (id === 'deliveries' ? box : { value: '', addEventListener() {}, style: {}, innerHTML: '' }), addEventListener() {}, querySelectorAll: () => [],
      createElement: () => { let t = ''; return { set textContent(v) { t = String(v); }, get innerHTML() { return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); } }; } },
    location: { reload() {}, pathname: '/app/developer', search: '', href: '' }, confirm: () => true, alert() {},
    fetch: async (url, opts) => { if (opts && opts.method === 'POST') posted.push(url); return { json: async () => ({ success: true, data: rows }), ok: true, status: 200 }; },
    console, setTimeout, Promise, JSON, encodeURIComponent, String, Array, Object
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  sandbox.lummetWebhookDeliveries('w1');
  await new Promise((r) => setTimeout(r, 20));
  return { html: box.innerHTML, posted, sandbox };
}

const ROWS = [
  { id: 'd-dead', event_type: 'site.<b>x</b>', status: 'dead', attempt: 6, next_attempt_at: null, response_code: 500, created_at: '2026-10-01 10:00:00' },
  { id: 'd-fail', event_type: 'site.active', status: 'failed', attempt: 2, next_attempt_at: '2026-10-01T10:35:00.000Z', error_message: 'http_500', created_at: '2026-10-01 10:00:00' },
  { id: 'd-ok', event_type: 'site.active', status: 'delivered', attempt: 1, next_attempt_at: null, response_code: 200, created_at: '2026-10-01 10:00:00' }
];

test('customer deliveries table shows attempt and next attempt, and admins get Re-send on failed and dead rows only', async () => {
  const { html, sandbox } = await renderDeliveries(true, ROWS);
  assert.match(html, /<th>Attempt<\/th><th>Next attempt<\/th>/);
  assert.match(html, /2026-10-01T10:35:00.000Z/);
  assert.match(html, /gave up/, 'a dead delivery says so');
  assert.equal((html.match(/Re-send<\/button>/g) || []).length, 2, 'dead + failed, not delivered');
  assert.match(html, /data-onclick="lummetRedeliver" data-args="\[&quot;w1&quot;,&quot;d-dead&quot;\]"/);
  assert.doesNotMatch(html, /d-ok/);
  assert.doesNotMatch(html, /\sonclick=/, 'no inline handler attribute is generated');
  assert.equal(html.includes('<b>x</b>'), false, 'event types are escaped');
  assert.equal(typeof sandbox.lummetRedeliver, 'function');
});

test('non-admins get no webhook script at all, so no Re-send control exists for them (the endpoint also demands the admin role)', () => {
  const viewer = renderDeveloperPage({ apiKeys: [], webhooks: [{ id: 'w1', url: 'https://example.com/h', event_types: [], status: 'active' }], eventTypes: [], canManage: false });
  assert.doesNotMatch(viewer, /lummetRedeliver/);
  assert.match(viewer, /Only organization admins/);
});

test('the redeliver endpoint refuses a member below admin', async () => {
  const e = env();
  const owner = await call(e, 'POST', '/api/customer/signup', { email: 'own@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Own' });
  const orgId = owner.json.organizationId;
  await e.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'viewer' WHERE organization_id = ?`).bind(orgId).run();
  const r = await call(e, 'POST', `/api/organizations/${orgId}/webhooks/w1/deliveries/d1/redeliver`, {}, owner.cookie);
  assert.equal(r.status, 403, r.text);
});

test('clicking Re-send posts to the redeliver endpoint and reloads the list', async () => {
  const { posted, sandbox } = await renderDeliveries(true, ROWS);
  sandbox.lummetRedeliver('w1', 'd-dead');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(posted.length, 1);
  assert.match(posted[0], /\/webhooks\/w1\/deliveries\/d-dead\/redeliver$/);
});

test('staff can retry a failed site deployment job: the dead-letter is cleared, the automatic retries reset, and it is audited', async () => {
  const e = env(); const staff = await staffLogin(e);
  const { jobId } = await jobs.createJob(e, { type: 'site_deployment', stepKeys: ['a'] });
  await e.LUMMET_DB.prepare(`UPDATE jobs SET site_id = NULL WHERE id = ?`).bind(jobId).run();
  // The route requires a site on the job; give it a real one.
  const s = await call(e, 'POST', '/api/customer/signup', { email: 'dep@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Dep Org' });
  await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) VALUES ('s-dep', ?, (SELECT id FROM products LIMIT 1), 'S', 's-dep', 'active')`).bind(s.json.organizationId).run();
  await e.LUMMET_DB.prepare(`UPDATE jobs SET site_id = 's-dep', status = 'failed', error_message = 'x', auto_retries = 5, dead_lettered_at = CURRENT_TIMESTAMP, dead_reason = 'stopped repeatedly' WHERE id = ?`).bind(jobId).run();
  const r = await call(e, 'POST', `/api/platform/saas/jobs/${jobId}/retry`, {}, staff);
  assert.equal(r.status, 200, r.text);
  const row = await e.LUMMET_DB.prepare(`SELECT dead_lettered_at, dead_reason, auto_retries FROM jobs WHERE id = ?`).bind(jobId).first();
  assert.equal(row.dead_lettered_at, null); assert.equal(row.dead_reason, null); assert.equal(row.auto_retries, 0);
  const audit = await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource = 'job' AND resource_id = ?`).bind(jobId).first();
  assert.equal(audit.n, 1);
  // A job that has not failed is still refused, and an unsupported type still says so.
  await e.LUMMET_DB.prepare(`UPDATE jobs SET status = 'success' WHERE id = ?`).bind(jobId).run();
  assert.equal((await call(e, 'POST', `/api/platform/saas/jobs/${jobId}/retry`, {}, staff)).status, 409);
});

test('the ALERT_CHECK_TOKEN configuration message says what actually stops working', () => {
  const issue = configIssues({ ENVIRONMENT: 'production' }).find((i) => i.key === 'ALERT_CHECK_TOKEN');
  assert.match(issue.impact, /pinger/);
  assert.match(issue.impact, /Cron Trigger/);
  assert.match(issue.impact, /webhook retries/);
});
