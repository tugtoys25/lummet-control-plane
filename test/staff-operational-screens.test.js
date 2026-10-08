// Roadmap 1.4: staff cross-organization screens for domains, deployments,
// webhooks, API keys and backups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
let ip = 1;
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.19.0.' + (ip++ % 250 + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(e) {
  assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).status, 200);
  return (await call(e, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;
}
async function customer(e, email) {
  const s = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org <b>' + email });
  return { id: s.json.organizationId, cookie: s.cookie };
}
async function seed(e, orgId) {
  const db = e.LUMMET_DB;
  const prod = await db.prepare(`SELECT id FROM products LIMIT 1`).first();
  await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) VALUES ('site1', ?, ?, 'My Site', 'my-site', 'active')`).bind(orgId, prod.id).run();
  await db.prepare(`INSERT INTO domains (id, site_id, hostname, status, verification_token, ssl_status) VALUES ('dom1','site1','www.example.com','active','tok','active')`).run();
  await db.prepare(`INSERT INTO deployments (id, site_id, version, status, is_current) VALUES ('dep1','site1','v7','failed',0)`).run();
  await db.prepare(`INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types) VALUES ('wh1', ?, 'https://hook.example/x', 'SECRET_CIPHER', 'iv', '["site.deployed"]')`).bind(orgId).run();
  await db.prepare(`INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status) VALUES ('wd1','wh1','site.deployed','{"private":"PAYLOAD_DATA"}','failed')`).run();
  await db.prepare(`INSERT INTO customer_api_keys (id, organization_id, name, key_prefix, key_hash, scopes) VALUES ('key1', ?, 'Report', 'lk_abc123', 'HASH_VALUE', '["sites:read"]')`).bind(orgId).run();
  await db.prepare(`INSERT INTO site_backups (id, organization_id, site_id, status, size_bytes) VALUES ('bk1', ?, 'site1', 'complete', 2048)`).bind(orgId).run();
}

const PAGES = ['domains', 'deployments', 'webhooks', 'api-keys', 'backups'];

test('all five staff screens render with cross-organization data and never leak secrets', async () => {
  const e = env(); const staff = await staffLogin(e); const c = await customer(e, 'a@example.com'); await seed(e, c.id);
  const out = {};
  for (const p of PAGES) { const r = await call(e, 'GET', '/platform/saas/' + p, null, staff); assert.equal(r.status, 200, p + ' ' + r.text.slice(0, 200)); out[p] = r.text; }
  assert.match(out.domains, /www\.example\.com/);
  assert.match(out.deployments, /v7/);
  assert.match(out.deployments, /failed/);
  assert.match(out.webhooks, /hook\.example/);
  assert.match(out['api-keys'], /lk_abc123/);
  assert.match(out.backups, /2\.0 KB/);
  const all = Object.values(out).join('');
  for (const secret of ['SECRET_CIPHER', 'PAYLOAD_DATA', 'HASH_VALUE']) assert.equal(all.includes(secret), false, secret);
  assert.equal(all.includes('Org <b>'), false, 'organization names are escaped');
});

test('status filters narrow the lists', async () => {
  const e = env(); const staff = await staffLogin(e); const c = await customer(e, 'f@example.com'); await seed(e, c.id);
  assert.match((await call(e, 'GET', '/platform/saas/deployments?status=failed', null, staff)).text, /v7/);
  assert.doesNotMatch((await call(e, 'GET', '/platform/saas/deployments?status=active', null, staff)).text, /v7/);
});

test('screens and actions are closed to anonymous callers and customer sessions', async () => {
  const e = env(); const c = await customer(e, 'x@example.com'); await seed(e, c.id);
  for (const p of PAGES) {
    assert.ok([301, 302, 303].includes((await call(e, 'GET', '/platform/saas/' + p)).status), p);
    assert.ok([301, 302, 303, 401, 403].includes((await call(e, 'GET', '/platform/saas/' + p, null, c.cookie)).status), p);
  }
  assert.equal((await call(e, 'POST', '/api/platform/saas/api-keys/key1/revoke', {}, c.cookie)).status, 401);
  assert.equal((await call(e, 'POST', '/api/platform/saas/webhooks/wh1/status', { status: 'disabled' })).status, 401);
  const key = await e.LUMMET_DB.prepare(`SELECT status FROM customer_api_keys WHERE id='key1'`).first();
  assert.equal(key.status, 'active');
});

test('staff can revoke an API key (once) and disable/enable a webhook; each is audited against the organization', async () => {
  const e = env(); const staff = await staffLogin(e); const c = await customer(e, 'r@example.com'); await seed(e, c.id);

  assert.equal((await call(e, 'POST', '/api/platform/saas/api-keys/key1/revoke', {}, staff)).status, 200);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT status FROM customer_api_keys WHERE id='key1'`).first()).status, 'revoked');
  assert.equal((await call(e, 'POST', '/api/platform/saas/api-keys/key1/revoke', {}, staff)).status, 409);
  assert.equal((await call(e, 'POST', '/api/platform/saas/api-keys/nope/revoke', {}, staff)).status, 404);

  assert.equal((await call(e, 'POST', '/api/platform/saas/webhooks/wh1/status', { status: 'bogus' }, staff)).status, 422);
  assert.equal((await call(e, 'POST', '/api/platform/saas/webhooks/wh1/status', { status: 'disabled' }, staff)).status, 200);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT status FROM webhooks WHERE id='wh1'`).first()).status, 'disabled');
  assert.equal((await call(e, 'POST', '/api/platform/saas/webhooks/wh1/status', { status: 'active' }, staff)).status, 200);
  assert.equal((await call(e, 'POST', '/api/platform/saas/webhooks/nope/status', { status: 'active' }, staff)).status, 404);

  const audit = await e.LUMMET_DB.prepare(`SELECT action, organization_id, success FROM lummet_audit_logs WHERE resource IN ('api_key','webhook') ORDER BY id`).all();
  assert.ok(audit.results.some((r) => r.action === 'staff_revoke' && r.organization_id === c.id && r.success === 1));
  assert.ok(audit.results.some((r) => r.action === 'staff_set_status:disabled' && r.organization_id === c.id));
});

test('webhooks are sorted by recent failures and show the failure ratio', async () => {
  const e = env(); const staff = await staffLogin(e); const c = await customer(e, 'w@example.com'); await seed(e, c.id);
  await e.LUMMET_DB.prepare(`INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types) VALUES ('wh2', ?, 'https://quiet.example/y', 'c', 'iv', '[]')`).bind(c.id).run();
  const page = (await call(e, 'GET', '/platform/saas/webhooks', null, staff)).text;
  assert.match(page, /1 \/ 1/);
  assert.ok(page.indexOf('hook.example') < page.indexOf('quiet.example'), 'failing webhook listed first');
});
