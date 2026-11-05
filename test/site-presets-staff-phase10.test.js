// Phase 10 A5: the staff Site presets screen and its read-only overview route, driven through worker.fetch. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import { hashPassword } from '../worker/auth.js';
import { NAV } from '../worker/views/layout.js';
import { renderSitePresetsBody } from '../worker/views/pages/site-presets-admin.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 30;
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce', ...extra };
}
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, res, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function superStaff(env) {
  assert.equal((await call(env, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
  const l = await call(env, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(l.status, 200, l.text);
  return l.cookie;
}
async function plainStaff(env) {
  const hash = await hashPassword('Correct-Horse-Battery-9');
  await env.LUMMET_DB.prepare(`INSERT INTO lummet_admins (email, password_hash, role) VALUES ('plain@example.com', ?, 'admin')`).bind(hash).run();
  const l = await call(env, 'POST', '/api/auth/login', { body: { email: 'plain@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(l.status, 200, l.text);
  return l.cookie;
}
async function customer(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, 'plan_agency_30').catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
const run = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).run();
async function seedRequests(env) {
  await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t-1', 'T1', 't1.example.test', 'https://t1.example.test')`);
  const rows = [
    ['r-pend', 'pending', 0, null], ['r-app', 'applied', 1, null], ['r-fail', 'failed', 2, 'unavailable'], ['r-gave', 'failed', 99, 'unavailable']
  ];
  for (const [id, status, attempts, err] of rows) {
    await run(env, `INSERT INTO site_setup_requests (id, tenant_id, kind, preset_id, source_tenant_id, sections, status, attempts, last_error, requested_by) VALUES (?, 't-1', 'preset', 'news', 'secret-source-tenant', '["SECRET_SECTION_PAYLOAD"]', ?, ?, ?, 'staff:1')`, id, status, attempts, err);
  }
}

test('GET /api/platform/saas/site-setups: 401 without a session, refused for a customer cookie and for staff who are not super admins', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/api/platform/saas/site-setups')).status, 401);
  const c = await customer(env, 'c@example.com');
  const asCustomer = await call(env, 'GET', '/api/platform/saas/site-setups', { cookie: c.cookie });
  assert.ok([401, 403].includes(asCustomer.status), `customer cookie got ${asCustomer.status}`);
  assert.notEqual(asCustomer.json?.success, true);
  await superStaff(env);
  const plain = await plainStaff(env);
  const asPlain = await call(env, 'GET', '/api/platform/saas/site-setups', { cookie: plain });
  assert.equal(asPlain.status, 403);
});

test('GET /api/platform/saas/site-setups: super admin gets overview, rows and presets; ?status= filters; a bad status is 422; no secrets', async () => {
  const env = makeEnv(); const cookie = await superStaff(env); await seedRequests(env);
  const all = await call(env, 'GET', '/api/platform/saas/site-setups', { cookie });
  assert.equal(all.status, 200, all.text);
  assert.equal(all.json.success, true);
  assert.equal(all.json.overview.byStatus.pending, 1);
  assert.equal(all.json.overview.byStatus.applied, 1);
  assert.equal(all.json.overview.byStatus.failed, 2);
  assert.equal(all.json.overview.gaveUp, 1, 'only the request at the attempt ceiling counts as given up');
  assert.equal(typeof all.json.overview.sweep.enabled, 'boolean');
  assert.equal(all.json.data.length, 4);
  assert.ok(Array.isArray(all.json.presets) && all.json.presets.some((p) => p.id === 'news'));
  const gave = all.json.data.find((r) => r.id === 'r-gave'); const failed = all.json.data.find((r) => r.id === 'r-fail');
  assert.equal(gave.gaveUp, true); assert.equal(failed.gaveUp, false);
  for (const needle of ['SECRET_SECTION_PAYLOAD', 'secret-source-tenant', 'sourceTenantId', 'sections', 'requestedBy', 'staff:1']) {
    assert.equal(all.text.includes(needle), false, `the answer never carries ${needle}`);
  }

  const only = await call(env, 'GET', '/api/platform/saas/site-setups?status=failed', { cookie });
  assert.equal(only.status, 200);
  assert.deepEqual(only.json.data.map((r) => r.status), ['failed', 'failed']);
  assert.equal((await call(env, 'GET', '/api/platform/saas/site-setups?status=pending', { cookie })).json.data.length, 1);

  const bad = await call(env, 'GET', '/api/platform/saas/site-setups?status=nonsense', { cookie });
  assert.equal(bad.status, 422); assert.equal(bad.json.error, 'invalid_status');
  const limited = await call(env, 'GET', '/api/platform/saas/site-setups?limit=1', { cookie });
  assert.equal(limited.json.data.length, 1);
  const huge = await call(env, 'GET', '/api/platform/saas/site-setups?limit=999999', { cookie });
  assert.equal(huge.status, 200, 'an oversized limit is clamped, not an error');
});

test('GET /api/platform/saas/site-setups is read-only: other methods never change anything', async () => {
  const env = makeEnv(); const cookie = await superStaff(env); await seedRequests(env);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await call(env, method, '/api/platform/saas/site-setups', { cookie, body: {} });
    assert.notEqual(r.json?.success, true, `${method} is not a write path`);
  }
  const n = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM site_setup_requests`).first();
  assert.equal(n.n, 4);
});

test('/platform/saas/site-presets: login redirect without a session, 403 for non-super staff, a real page with a nonce for a super admin', async () => {
  const env = makeEnv();
  const anon = await call(env, 'GET', '/platform/saas/site-presets');
  assert.equal(anon.status, 302); assert.match(anon.res.headers.get('Location') || '', /\/login/);
  const c = await customer(env, 'c2@example.com');
  const asCustomer = await call(env, 'GET', '/platform/saas/site-presets', { cookie: c.cookie });
  assert.ok(asCustomer.status === 302 || asCustomer.status === 401 || asCustomer.status === 403, `customer got ${asCustomer.status}`);
  assert.equal(asCustomer.text.includes('Setup requests'), false, 'a customer never sees the staff screen');
  const cookie = await superStaff(env);
  const plain = await plainStaff(env);
  assert.equal((await call(env, 'GET', '/platform/saas/site-presets', { cookie: plain })).status, 403);

  await seedRequests(env);
  const page = await call(env, 'GET', '/platform/saas/site-presets', { cookie });
  assert.equal(page.status, 200, page.text.slice(0, 300));
  assert.match(page.res.headers.get('Content-Type') || '', /html/);
  const csp = page.res.headers.get('Content-Security-Policy') || '';
  const nonce = (csp.match(/script-src 'nonce-([^']+)'/) || [])[1];
  assert.ok(nonce, 'the response carries a script nonce');
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(page.text, /<h1>Site presets<\/h1>/);
  assert.match(page.text, /Setup requests/);
  assert.match(page.text, /Given up/);
  assert.equal(page.text.includes('SECRET_SECTION_PAYLOAD'), false);
  assert.equal(page.text.includes('secret-source-tenant'), false);
  assert.equal(/lnt[0-9a-f]{32}/.test(page.text), false, 'the secret token stays in the Worker');
});

test('/platform/saas/site-presets: every inline script has the nonce, no inline handler, and every data-on handler is defined', async () => {
  const env = makeEnv(); const cookie = await superStaff(env); await seedRequests(env);
  const page = await call(env, 'GET', '/platform/saas/site-presets', { cookie });
  const nonce = ((page.res.headers.get('Content-Security-Policy') || '').match(/script-src 'nonce-([^']+)'/) || [])[1];
  const scripts = [...page.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].filter((m) => !/application\/(ld\+)?json/.test(m[1]));
  assert.ok(scripts.length >= 1, 'the page really carries its script');
  for (const [, attrs, code] of scripts) {
    assert.ok(attrs.includes(`nonce="${nonce}"`), `script without this response's nonce: ${attrs}`);
    assert.doesNotMatch(code, /\$\{/, 'template text left in a script');
  }
  assert.equal(/<[^>]*(?<![\w.-])on(click|submit|change|input|load|error)=/.test(page.text), false, 'no inline on* attribute');
  const defined = scripts.map((s) => s[2]).join('\n');
  const used = [...page.text.matchAll(/\sdata-on(?:click|submit|change|input)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(used.length > 0, 'the seeded page really uses handlers (Retry buttons, the save form)');
  for (const name of used) assert.match(defined, new RegExp(`function\\s+${name}\\s*\\(|window\\.${name}\\s*=`), `${name} is defined on the page`);
  assert.equal(page.text.includes('nonceToken'), false, 'no unrendered template call');
});

test('Retry shows only for pending or failed requests that belong to a site; the status filter is echoed safely', () => {
  const base = { overview: { byStatus: {}, sweep: { enabled: true, maxAttempts: 5, maxPerTick: 10 } }, defaults: [], plansList: [], productsList: [] };
  const mk = (status, siteId) => ({ id: 'x', siteId, siteName: siteId ? 'Site' : null, tenantId: 't', kind: 'preset', presetId: 'news', status, attempts: 1, lastError: '', gaveUp: false });
  const body = renderSitePresetsBody({ ...base, requests: [mk('pending', 's1'), mk('failed', 's2'), mk('applied', 's3'), mk('failed', null)] });
  assert.equal((body.match(/lummetStaffSetupRetry/g) || []).length >= 2, true);
  const buttons = [...body.matchAll(/data-onclick="lummetStaffSetupRetry"[^>]*>/g)];
  assert.equal(buttons.length, 2, 'two retry buttons: pending and failed with a site; not applied, not siteless');
  const xss = renderSitePresetsBody({ ...base, requests: [{ ...mk('failed', 's"><img src=x onerror=alert(1)>'), lastError: '<script>alert(2)</script>' }] });
  assert.equal(xss.includes('<script>alert(2)</script>'), false);
  assert.equal(xss.includes('<img src=x'), false);
});

test('navigation: Site presets sits in the Tenants group (super admin only) and nowhere else; the page is in the admin route inventory', async () => {
  const tenants = NAV.find((g) => g.id === 'tenants');
  assert.ok(tenants && tenants.superAdminOnly === true, 'the Tenants group is super admin only');
  assert.ok(tenants.items.some((i) => i.href === '/platform/saas/site-presets' && i.key === 'saas-site-presets'));
  const elsewhere = NAV.filter((g) => g.id !== 'tenants').flatMap((g) => g.items.filter((i) => i.href === '/platform/saas/site-presets'));
  assert.equal(elsewhere.length, 0, 'one nav entry only');
  const env = makeEnv(); const cookie = await superStaff(env);
  const dash = await call(env, 'GET', '/dashboard', { cookie });
  assert.match(dash.text, /href="\/platform\/saas\/site-presets"/);
  const plain = await plainStaff(env);
  const plainDash = await call(env, 'GET', '/dashboard', { cookie: plain });
  assert.equal(plainDash.text.includes('/platform/saas/site-presets'), false, 'the link is hidden from non-super staff (the route refuses them too)');
});
