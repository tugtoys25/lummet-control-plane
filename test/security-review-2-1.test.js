// Security review 2.1: fixes found while reading the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { checkOutboundUrl } from '../worker/url-safety.js';
import * as webhooks from '../worker/webhooks.js';
import * as template from '../worker/tenant-template.js';

function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; }, async delete(k) { m.delete(k); } };
}
function env() { const db = createTestDb(); applyMigrations(db); return { OUTBOUND_DNS_RESOLVER: async () => ({ ok: true, addresses: ['93.184.216.34'] }), LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, { cookie, ip = '203.0.113.50', headers = {} } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': ip, ...headers });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('outbound URL check blocks local, private, metadata and credentialed targets and allows normal public ones', () => {
  const bad = [
    'http://example.com/x', 'https://localhost/x', 'https://intranet/x', 'https://127.0.0.1/x', 'https://10.1.2.3/x',
    'https://172.16.0.1/x', 'https://172.31.255.255/x', 'https://192.168.1.1/x', 'https://169.254.169.254/latest/meta-data',
    'https://100.64.0.1/x', 'https://0.0.0.0/x', 'https://[::1]/x', 'https://[fd00::1]/x', 'https://[fe80::1]/x',
    'https://[::ffff:127.0.0.1]/x', 'https://[::ffff:a00:1]/x', 'https://2130706433/x', 'https://0x7f.1/x', 'https://017700000001/x',
    'https://printer.local/x', 'https://db.internal/x', 'https://user:pw@example.com/x', 'https://example.com:8443/x', 'not a url'
  ];
  for (const u of bad) assert.equal(checkOutboundUrl(u).ok, false, u);
  for (const u of ['https://example.com/hook', 'https://hooks.example.co.uk/a/b?c=1', 'https://8.8.8.8/x', 'https://example.com:443/x', 'https://172.32.0.1/x']) {
    assert.equal(checkOutboundUrl(u).ok, true, u);
  }
});

test('createWebhook rejects unsafe URLs with a specific error', async () => {
  const e = env();
  const r = await webhooks.createWebhook(e, { organizationId: 'o', url: 'https://169.254.169.254/x', eventTypes: ['site.deployed'] });
  assert.equal(r.ok, false); assert.equal(r.status, 422); assert.equal(r.error, 'url_host_not_allowed');
});

test('delivery never follows redirects and refuses a stored unsafe URL', async () => {
  const e = env();
  const org = (await call(e, 'POST', '/api/customer/signup', { email: 'wh@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'O' })).json.organizationId;
  const created = await webhooks.createWebhook(e, { organizationId: org, url: 'https://hook.example.com/x', eventTypes: ['site.deployed'] });
  assert.equal(created.ok, true);

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push({ url: String(url), redirect: init && init.redirect }); return new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/admin' } }); };
  try {
    await webhooks.dispatchEvent(e, org, 'site.deployed', { a: 1 });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].redirect, 'manual');
    const d = await e.LUMMET_DB.prepare(`SELECT status FROM webhook_deliveries`).first();
    assert.equal(d.status, 'failed', 'a redirect response is a failed delivery, not followed');

    await e.LUMMET_DB.prepare(`UPDATE webhooks SET url = 'https://127.0.0.1/x'`).run();
    seen.length = 0;
    await webhooks.dispatchEvent(e, org, 'site.deployed', { a: 2 });
    assert.equal(seen.length, 0, 'no request is made to an unsafe stored URL');
  } finally { globalThis.fetch = realFetch; }
});

test('customers cannot supply deploy scripts: body script is ignored on deploy, and rollback needs a stored release', async () => {
  const e = env();
  const s = await call(e, 'POST', '/api/customer/signup', { email: 'dep@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'O' });
  const org = s.json.organizationId;
  const prod = await e.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first();
  await e.LUMMET_DB.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('tenant-sx', 'T', 'sx.example.com', 'https://sx.example.com')`).run();
  await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, tenant_id) VALUES ('sx', ?, ?, 'S', 's-x', 'active', 'tenant-sx')`).bind(org, prod.id).run();

  // No published release: the customer's own script must NOT be used as a fallback.
  const noRelease = await call(e, 'POST', `/api/organizations/${org}/sites/sx/deployments`, { scriptContent: 'evil()', version: '9.9.9', migrations: ['DROP TABLE x'] }, { cookie: s.cookie });
  assert.notEqual(noRelease.status, 202);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM deployments`).first()).n, 0);

  assert.equal((await template.publishRelease(e, { version: '1.0.0', scriptContent: 'export default {}', migrations: [] })).ok, true);
  assert.equal((await template.activateRelease(e, '1.0.0')).ok, true);
  const ok = await call(e, 'POST', `/api/organizations/${org}/sites/sx/deployments`, { scriptContent: 'evil()', version: '9.9.9', migrations: ['DROP TABLE x'] }, { cookie: s.cookie });
  assert.equal(ok.status, 202, ok.text);
  const dep = await e.LUMMET_DB.prepare(`SELECT version FROM deployments WHERE site_id = 'sx'`).first();
  assert.equal(dep.version, '1.0.0', 'version comes from the published release, not the request');
  const job = await e.LUMMET_DB.prepare(`SELECT payload FROM jobs WHERE site_id = 'sx' ORDER BY rowid DESC LIMIT 1`).first();
  assert.equal(job.payload.includes('evil()'), false);
  assert.equal(job.payload.includes('DROP TABLE'), false);

  // Rollback to a deployment whose release was never stored: refused, supplied script ignored.
  await e.LUMMET_DB.prepare(`INSERT INTO deployments (id, site_id, version, status) VALUES ('old', 'sx', '0.0.1', 'active')`).run();
  const rb = await call(e, 'POST', `/api/organizations/${org}/sites/sx/deployments/old/rollback`, { scriptContent: 'evil()' }, { cookie: s.cookie });
  assert.equal(rb.status, 409); assert.equal(rb.json.error, 'release_unavailable');
  assert.equal((await call(e, 'POST', `/api/organizations/${org}/sites/sx/deployments/missing/rollback`, {}, { cookie: s.cookie })).status, 404);
});

test('developer API throttles repeated bad keys per IP but does not count valid use', async () => {
  const e = env();
  for (let i = 0; i < 20; i++) {
    const r = await call(e, 'GET', '/api/v1/sites', null, { ip: '198.51.100.77', headers: { Authorization: 'Bearer lk_wrong_' + i } });
    assert.equal(r.status, 401, 'attempt ' + i);
  }
  const blocked = await call(e, 'GET', '/api/v1/sites', null, { ip: '198.51.100.77', headers: { Authorization: 'Bearer lk_wrong_x' } });
  assert.equal(blocked.status, 429); assert.equal(blocked.json.error, 'rate_limited');
  const other = await call(e, 'GET', '/api/v1/sites', null, { ip: '198.51.100.78', headers: { Authorization: 'Bearer lk_wrong' } });
  assert.equal(other.status, 401, 'a different IP is unaffected');
});
