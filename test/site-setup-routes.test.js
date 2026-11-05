// Phase 9: the HTTP routes of the site setup feature (customer and staff), driven through worker.fetch with a fake tenant client
// (env.SETUP_TENANT_REQUEST). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
const PLAN = 'plan_agency_30';
let ipn = 10;

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra };
}
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function customer(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, PLAN).catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
async function staff(env) {
  assert.equal((await call(env, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
  const l = await call(env, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(l.status, 200, l.text);
  return l.cookie;
}
const run = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).run();
const one = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).first();
async function liveSite(env, orgId, n) {
  await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, ?, ?, ?)`, `t-${n}`, `T${n}`, `t${n}.example.test`, `https://t${n}.example.test`);
  await run(env, `INSERT INTO sites (id, organization_id, name, slug, product_id, status, tenant_id) VALUES (?, ?, ?, ?, 'prod_casino_news', 'active', ?)`, `s-${n}`, orgId, `S${n}`, `s${n}`, `t-${n}`);
  return { siteId: `s-${n}`, tenantId: `t-${n}` };
}
function fakeTenant(answer = {}) {
  const calls = [];
  const f = async (env, tenant, { method, path, body }) => { calls.push({ tenant: typeof tenant === 'string' ? tenant : tenant.id, method, path, body }); return answer[`${method} ${path.split('?')[0]}`] || { ok: true, status: 200, data: { success: true, applied: true } }; };
  f.calls = calls; return f;
}

test('customer POST /sites: a preset or clone source is validated before anything is created; a valid one is stored as a pending request', async () => {
  const env = makeEnv(); const a = await customer(env, 'a@example.com');
  const bad = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'X', productId: 'prod_casino_news', preset: 'nonsense' } });
  assert.equal(bad.status, 422); assert.equal(bad.json.error, 'unknown_preset');
  const both = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'X', productId: 'prod_casino_news', preset: 'news', cloneFromSiteId: 'whatever' } });
  assert.equal(both.status, 422); assert.equal(both.json.error, 'choose_one');
  assert.equal((await one(env, `SELECT COUNT(*) AS n FROM sites`)).n, 0, 'a refused choice creates no site');
  const ok = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'News One', productId: 'prod_casino_news', preset: 'news' } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.setup, { kind: 'preset', presetId: 'news', status: 'pending' });
  const none = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Plain', productId: 'prod_casino_news' } });
  assert.equal(none.status, 200, none.text);
  assert.equal(none.json.setup.presetId, 'full', 'no preset means the full platform, with the wizard pending');
});

test('customer GET setup and POST retry: org members read, admins retry; another organization gets 404 for both', async () => {
  const env = makeEnv(); env.SETUP_TENANT_REQUEST = fakeTenant({ 'POST /en/api/super/site-setup': { ok: false, status: 502, reason: 'unavailable', message: 'x' } });
  const a = await customer(env, 'a2@example.com'); const b = await customer(env, 'b2@example.com');
  const created = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Mine', productId: 'prod_casino_news', preset: 'static' } });
  const siteId = created.json.siteId;
  await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t-x', 'X', 'x.example.test', 'https://x.example.test')`);
  await run(env, `UPDATE sites SET status = 'active', tenant_id = 't-x' WHERE id = ?`, siteId);

  const read = await call(env, 'GET', `/api/organizations/${a.orgId}/sites/${siteId}/setup`, { cookie: a.cookie });
  assert.equal(read.status, 200); assert.equal(read.json.data.status, 'pending'); assert.equal(read.json.data.presetId, 'static');
  assert.equal(read.json.data.sourceTenantId, undefined, 'a customer never sees staff fields');

  const failed = await call(env, 'POST', `/api/organizations/${a.orgId}/sites/${siteId}/setup/retry`, { cookie: a.cookie, body: {} });
  assert.equal(failed.status, 502); assert.equal(failed.json.success, false);
  assert.equal((await call(env, 'GET', `/api/organizations/${a.orgId}/sites/${siteId}/setup`, { cookie: a.cookie })).json.data.status, 'failed');

  env.SETUP_TENANT_REQUEST = fakeTenant();
  const good = await call(env, 'POST', `/api/organizations/${a.orgId}/sites/${siteId}/setup/retry`, { cookie: a.cookie, body: {} });
  assert.equal(good.status, 200, good.text); assert.equal(good.json.data.status, 'applied');
  assert.equal((await call(env, 'POST', `/api/organizations/${a.orgId}/sites/${siteId}/setup/retry`, { cookie: a.cookie, body: {} })).status, 409, 'nothing to retry once applied');

  // organization B using its own org id with A's site id, and A's org id without membership
  assert.equal((await call(env, 'GET', `/api/organizations/${b.orgId}/sites/${siteId}/setup`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(env, 'POST', `/api/organizations/${b.orgId}/sites/${siteId}/setup/retry`, { cookie: b.cookie, body: {} })).status, 404);
  assert.ok([401, 403, 404].includes((await call(env, 'GET', `/api/organizations/${a.orgId}/sites/${siteId}/setup`, { cookie: b.cookie })).status));
  assert.equal((await call(env, 'GET', `/api/organizations/${a.orgId}/sites/${siteId}/setup`)).status, 401);
});

test('customer clone: only from a site of the SAME organization', async () => {
  const env = makeEnv(); const a = await customer(env, 'a3@example.com'); const b = await customer(env, 'b3@example.com');
  const srcA = await liveSite(env, a.orgId, 1); const srcB = await liveSite(env, b.orgId, 2);
  const own = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Copy', productId: 'prod_casino_news', cloneFromSiteId: srcA.siteId, sections: ['site-profile'] } });
  assert.equal(own.status, 200, own.text); assert.equal(own.json.setup.kind, 'clone');
  const other = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Steal', productId: 'prod_casino_news', cloneFromSiteId: srcB.siteId } });
  assert.equal(other.status, 404); assert.equal(other.json.error, 'clone_source_not_found');
  const sitesOfA = (await one(env, `SELECT COUNT(*) AS n FROM sites WHERE organization_id = ?`, a.orgId)).n;
  assert.equal(sitesOfA, 2, 'the live source and the one copy only');
  const asTenant = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'T', productId: 'prod_casino_news', cloneFromTenantId: srcB.tenantId } });
  assert.equal(asTenant.status, 403); assert.equal(asTenant.json.error, 'forbidden'); assert.equal(await one(env, `SELECT 1 AS x FROM sites WHERE name = 'T'`), null, 'customers cannot use tenant ids to clone');
});

test('staff defaults: GET/PUT need a super admin, validate ids, and are audited', async () => {
  const env = makeEnv();
  assert.equal((await call(env, 'GET', '/api/platform/site-presets/defaults')).status, 401);
  const c = await customer(env, 'c4@example.com');
  assert.ok([401, 403].includes((await call(env, 'GET', '/api/platform/site-presets/defaults', { cookie: c.cookie })).status));
  const s = await staff(env);
  const empty = await call(env, 'GET', '/api/platform/site-presets/defaults', { cookie: s });
  assert.equal(empty.status, 200); assert.deepEqual(empty.json.data, []); assert.equal(empty.json.fallback, 'full'); assert.equal(empty.json.presets.length, 8);
  assert.equal((await call(env, 'PUT', '/api/platform/site-presets/defaults', { cookie: s, body: { scopeKind: 'plan', scopeId: PLAN, presetId: 'bogus' } })).status, 422);
  assert.equal((await call(env, 'PUT', '/api/platform/site-presets/defaults', { cookie: s, body: { scopeKind: 'plan', scopeId: 'no-such-plan', presetId: 'news' } })).status, 404);
  assert.equal((await call(env, 'PUT', '/api/platform/site-presets/defaults', { cookie: s, body: { scopeKind: 'org', scopeId: 'x', presetId: 'news' } })).status, 422);
  const set = await call(env, 'PUT', '/api/platform/site-presets/defaults', { cookie: s, body: { scopeKind: 'plan', scopeId: PLAN, presetId: 'news' } });
  assert.equal(set.status, 200, set.text); assert.equal(set.json.data[0].preset_id, 'news');
  // the next site of a customer on that plan starts from it
  const c2 = await customer(env, 'c5@example.com');
  const made = await call(env, 'POST', `/api/organizations/${c2.orgId}/sites`, { cookie: c2.cookie, body: { name: 'Plan default', productId: 'prod_casino_news' } });
  assert.equal(made.json.setup.presetId, 'news');
  const cleared = await call(env, 'PUT', '/api/platform/site-presets/defaults', { cookie: s, body: { scopeKind: 'plan', scopeId: PLAN, presetId: null } });
  assert.deepEqual(cleared.json.data, []);
  const audits = (await env.LUMMET_DB.prepare(`SELECT action, success FROM lummet_audit_logs WHERE resource = 'site_preset_default' ORDER BY rowid`).all()).results;
  assert.ok(audits.length >= 4, JSON.stringify(audits));
});

test('staff site setup: apply a preset, clone from any tenant by id, retry; closed to non-staff', async () => {
  const env = makeEnv(); const fake = fakeTenant({ 'GET /en/api/super/site-config-export': { ok: true, status: 200, data: { success: true, envelope: { format: 'lummet-config', meta: { host: 'src' }, sections: {} } } } });
  env.SETUP_TENANT_REQUEST = fake;
  const a = await customer(env, 'a6@example.com'); const b = await customer(env, 'b6@example.com');
  const target = await liveSite(env, a.orgId, 3); const source = await liveSite(env, b.orgId, 4);
  const path = `/api/platform/saas/sites/${target.siteId}/setup`;
  assert.equal((await call(env, 'GET', path)).status, 401);
  assert.ok([401, 403].includes((await call(env, 'POST', path, { cookie: a.cookie, body: { preset: 'news' } })).status));
  const s = await staff(env);
  assert.equal((await call(env, 'GET', path, { cookie: s })).json.data.status, 'none');
  assert.equal((await call(env, 'POST', path, { cookie: s, body: { preset: 'x' } })).status, 422);
  assert.equal((await call(env, 'POST', path, { cookie: s, body: { preset: 'news', cloneFromTenantId: source.tenantId } })).status, 422);
  const applied = await call(env, 'POST', path, { cookie: s, body: { preset: 'news' } });
  assert.equal(applied.status, 200, applied.text); assert.equal(applied.json.data.status, 'applied'); assert.equal(applied.json.data.presetId, 'news');
  assert.deepEqual(fake.calls.at(-1), { tenant: target.tenantId, method: 'POST', path: '/en/api/super/site-setup', body: { preset: 'news' } });
  const cloned = await call(env, 'POST', path, { cookie: s, body: { cloneFromTenantId: source.tenantId, sections: ['site-profile'] } });
  assert.equal(cloned.status, 200, cloned.text); assert.equal(cloned.json.data.kind, 'clone'); assert.equal(cloned.json.data.sourceTenantId, source.tenantId);
  assert.equal(fake.calls.at(-2).tenant, source.tenantId); assert.equal(fake.calls.at(-1).tenant, target.tenantId);
  assert.equal((await call(env, 'POST', path, { cookie: s, body: { cloneFromTenantId: 'nope' } })).status, 404);
  assert.equal((await call(env, 'POST', path, { cookie: s, body: { retry: true } })).status, 409, 'applied: nothing to retry');
  assert.equal((await call(env, 'POST', `/api/platform/saas/sites/missing/setup`, { cookie: s, body: { preset: 'news' } })).status, 404);
});

test('POST /api/tenants: no preset registers as before; a preset is applied when reachable, recorded failed when not, and a bad one registers nothing', async () => {
  const env = makeEnv(); const s = await staff(env);
  const plain = await call(env, 'POST', '/api/tenants', { cookie: s, body: { name: 'Plain', host: 'plain.example.test', apiBaseUrl: 'https://plain.example.test', api_base_url: 'https://plain.example.test' } });
  assert.equal(plain.status, 201, plain.text); assert.equal(plain.json.setup, undefined);
  assert.equal((await one(env, `SELECT COUNT(*) AS n FROM site_setup_requests`)).n, 0);

  const bad = await call(env, 'POST', '/api/tenants', { cookie: s, body: { name: 'Bad', host: 'bad.example.test', api_base_url: 'https://bad.example.test', preset: 'nope' } });
  assert.equal(bad.status, 422); assert.equal(await one(env, `SELECT 1 AS x FROM tenants WHERE host = 'bad.example.test'`), null);

  env.SETUP_TENANT_REQUEST = fakeTenant();
  const good = await call(env, 'POST', '/api/tenants', { cookie: s, body: { name: 'Good', host: 'good.example.test', api_base_url: 'https://good.example.test', preset: 'research' } });
  assert.equal(good.status, 201, good.text); assert.equal(good.json.setup.status, 'applied'); assert.equal(good.json.setup.presetId, 'research');

  env.SETUP_TENANT_REQUEST = fakeTenant({ 'POST /en/api/super/site-setup': { ok: false, status: 502, reason: 'unavailable', message: 'x' } });
  const down = await call(env, 'POST', '/api/tenants', { cookie: s, body: { name: 'Down', host: 'down.example.test', api_base_url: 'https://down.example.test', preset: 'news' } });
  assert.equal(down.status, 201, 'registration never fails because the tenant is not reachable yet'); assert.equal(down.json.setup.status, 'failed');
  const row = await one(env, `SELECT status, last_error FROM site_setup_requests WHERE tenant_id = ?`, down.json.data.id);
  assert.equal(row.status, 'failed'); assert.match(row.last_error, /unavailable/);
});
