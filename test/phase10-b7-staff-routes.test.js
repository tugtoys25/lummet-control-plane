// Phase 10 B7 (and two A5 extras) through worker.fetch: the site-system route, the canary start, the Deployments canary controls,
// "Check switch" and the CI canary start. A fake tenant client (env.SETUP_TENANT_REQUEST), no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import * as staffTokens from '../worker/staff-tokens.js';
import * as template from '../worker/tenant-template.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
const PLAN = 'plan_agency_30';
let ipn = 20;
function fakeR2() { const m = new Map(); return { async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return String(m.get(k)); } } : null; } }; }
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ASSETS: createAssets(), TENANT_TEMPLATES: fakeR2(), ENVIRONMENT: 'production', CSP_MODE: 'enforce', CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra };
}
async function call(env, method, path, { body, cookie, bearer } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  if (bearer) h.set('Authorization', `Bearer ${bearer}`);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staff(env) {
  assert.equal((await call(env, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
  const l = await call(env, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(l.status, 200, l.text); return l.cookie;
}
async function customer(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, PLAN).catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
const run = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).run();
const one = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).first();
let seq = 0;
/** A live site with a tenant. appVersion null = behind every release. */
async function liveSite(env, orgId, { name, tenant = true, status = 'active', appVersion = null } = {}) {
  seq += 1;
  if (tenant) await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, ?, ?, ?)`, `pt-${seq}`, `T${seq}`, `pt${seq}.example.test`, `https://pt${seq}.example.test`);
  await run(env, `INSERT INTO sites (id, organization_id, name, slug, product_id, status, tenant_id, app_version) VALUES (?, ?, ?, ?, 'prod_casino_news', ?, ?, ?)`, `ps-${seq}`, orgId, name || `Site ${seq}`, `ps${seq}`, status, tenant ? `pt-${seq}` : null, appVersion);
  return { siteId: `ps-${seq}`, tenantId: tenant ? `pt-${seq}` : null };
}
async function setupRow(env, siteId, { status, attempts = 0, lastError = null, kind = 'preset', preset = 'news' }) {
  const id = crypto.randomUUID();
  await run(env, `INSERT INTO site_setup_requests (id, site_id, kind, preset_id, status, attempts, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, siteId, kind, preset, status, attempts, lastError);
  return id;
}
function stub(answerFor) {
  const calls = [];
  const f = async (_e, tenant, req) => { calls.push({ tenant: typeof tenant === 'string' ? tenant : tenant.id, method: req.method, path: req.path }); return answerFor(req); };
  f.calls = calls; return f;
}

// the same page checks as csp.test.js, for the pages touched here
function checkPage(label, res) {
  const csp = res.headers.get('Content-Security-Policy') || '';
  const n = csp.match(/'nonce-([^']+)'/)?.[1];
  assert.ok(n, `${label}: has a nonce`);
  assert.equal(/lnt[0-9a-f]{32}/.test(res.text), false, `${label}: secret token never leaves the Worker`);
  assert.equal(/<[^>]*(?<![\w.-])on(click|submit|change|input|load|error)=/.test(res.text), false, `${label}: no inline handler`);
  const scripts = [...res.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  for (const [, attrs, code] of scripts) { if (/application\/(ld\+)?json/.test(attrs)) continue; assert.ok(attrs.includes(`nonce="${n}"`), `${label}: script without nonce`); assert.doesNotMatch(code, /\$\{/, `${label}: template text left in a script`); }
  const defined = scripts.map((s) => s[2]).join('\n');
  const handlers = [...res.text.matchAll(/\sdata-on(?:click|submit|change|input)="([^"]+)"/g)].map((m) => m[1]);
  for (const hn of handlers) assert.match(defined, new RegExp(`function\\s+${hn}\\s*\\(`), `${label}: ${hn} is defined on the page`);
  return handlers;
}

// ------------------------------------------------------------------ A5 extras (the main A5 tests are in site-presets-staff-phase10.test.js)

test('A5 extra: a failed request at the attempt limit is reported as given up, in the route and on the page', async () => {
  const env = makeEnv(); const cookie = await staff(env); const c = await customer(env, 'd@example.com');
  const s = await liveSite(env, c.orgId);
  await setupRow(env, s.siteId, { status: 'failed', attempts: 50, lastError: 'tenant_unavailable (HTTP 503)' });
  const r = await call(env, 'GET', '/api/platform/saas/site-setups', { cookie });
  assert.equal(r.json.data[0].gaveUp, true); assert.equal(r.json.overview.gaveUp, 1);
  const page = await call(env, 'GET', '/platform/saas/site-presets', { cookie });
  assert.match(page.text, /given up/);
});

test('A5 extra: a saved default shows with a Clear button; the retry sweep text follows SETUP_RETRY_SWEEP', async () => {
  const env = makeEnv(); const cookie = await staff(env);
  const put = await call(env, 'PUT', '/api/platform/site-presets/defaults', { cookie, body: { scopeKind: 'plan', scopeId: PLAN, presetId: 'news' } });
  assert.equal(put.status, 200, put.text);
  const on = await call(env, 'GET', '/platform/saas/site-presets', { cookie });
  assert.ok(checkPage('site-presets (default)', on).includes('lummetClearPresetDefault'));
  assert.match(on.text, /The retry sweep is on/);
  const env2 = makeEnv({ SETUP_RETRY_SWEEP: 'off' }); const cookie2 = await staff(env2);
  assert.match((await call(env2, 'GET', '/platform/saas/site-presets', { cookie: cookie2 })).text, /The retry sweep is OFF \(SETUP_RETRY_SWEEP\)/);
});

// ------------------------------------------------------------------ B7: GET /api/platform/saas/sites/:id/site-system

test('site-system route: staff only; one tenant call; only enabled, source and envOverride come back', async () => {
  const t = stub(() => ({ ok: true, status: 200, data: { system: { enabled: true, source: 'setting', envOverride: false, secret: 'must-not-leak' }, token: 'nope' } }));
  const env = makeEnv({ SETUP_TENANT_REQUEST: t }); const cookie = await staff(env); const c = await customer(env, 'g@example.com');
  const s = await liveSite(env, c.orgId);
  assert.ok([401, 403].includes((await call(env, 'GET', `/api/platform/saas/sites/${s.siteId}/site-system`)).status));
  assert.ok([401, 403].includes((await call(env, 'GET', `/api/platform/saas/sites/${s.siteId}/site-system`, { cookie: c.cookie })).status));
  assert.equal(t.calls.length, 0);
  const r = await call(env, 'GET', `/api/platform/saas/sites/${s.siteId}/site-system`, { cookie });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { success: true, data: { enabled: true, source: 'setting', envOverride: false } });
  assert.equal(t.calls.length, 1); assert.equal(t.calls[0].method, 'GET'); assert.equal(t.calls[0].path, '/en/api/super/site-system'); assert.equal(t.calls[0].tenant, s.tenantId);
  assert.equal(r.text.includes('must-not-leak'), false);
});

test('site-system route: unknown source becomes "unknown"; envOverride only when exactly true', async () => {
  let answer;
  const env = makeEnv({ SETUP_TENANT_REQUEST: stub(() => answer) }); const cookie = await staff(env); const c = await customer(env, 'h@example.com');
  const s = await liveSite(env, c.orgId);
  answer = { ok: true, status: 200, data: { system: { enabled: false, source: 'something-else', envOverride: 'yes' } } };
  assert.deepEqual((await call(env, 'GET', `/api/platform/saas/sites/${s.siteId}/site-system`, { cookie })).json.data, { enabled: false, source: 'unknown', envOverride: false });
  answer = { ok: true, status: 200, data: { system: { enabled: true, source: 'env', envOverride: true } } };
  assert.deepEqual((await call(env, 'GET', `/api/platform/saas/sites/${s.siteId}/site-system`, { cookie })).json.data, { enabled: true, source: 'env', envOverride: true });
});

test('site-system route: 404 unknown site, 409 site_has_no_tenant, 409 tenant_not_updated on 404/405/501, 502 otherwise', async () => {
  let answer = { ok: false, status: 404 };
  const t = stub(() => answer); const env = makeEnv({ SETUP_TENANT_REQUEST: t }); const cookie = await staff(env); const c = await customer(env, 'i@example.com');
  const s = await liveSite(env, c.orgId); const noTenant = await liveSite(env, c.orgId, { tenant: false });
  const url = (id) => `/api/platform/saas/sites/${id}/site-system`;
  const nf = await call(env, 'GET', url('no-such-site'), { cookie }); assert.equal(nf.status, 404); assert.equal(nf.json.error, 'not_found');
  const nt = await call(env, 'GET', url(noTenant.siteId), { cookie }); assert.equal(nt.status, 409); assert.equal(nt.json.error, 'site_has_no_tenant');
  assert.equal(t.calls.length, 0, 'neither of those reached a tenant');
  for (const st of [404, 405, 501]) { answer = { ok: false, status: st }; const r = await call(env, 'GET', url(s.siteId), { cookie }); assert.equal(r.status, 409, String(st)); assert.equal(r.json.error, 'tenant_not_updated'); }
  answer = { ok: false, status: 500, reason: 'boom' };
  const bad = await call(env, 'GET', url(s.siteId), { cookie }); assert.equal(bad.status, 502); assert.equal(bad.json.success, false);
  answer = { ok: true, status: 200, data: { system: { enabled: 'maybe' } } };
  const odd = await call(env, 'GET', url(s.siteId), { cookie }); assert.equal(odd.status, 502); assert.equal(odd.json.error, 'unexpected_answer');
  answer = { ok: true, status: 200, data: {} };
  assert.equal((await call(env, 'GET', url(s.siteId), { cookie })).json.error, 'unexpected_answer');
});

test('site-system route: the tenant client throwing is a 502 internal_error, not a crash', async () => {
  const env = makeEnv({ SETUP_TENANT_REQUEST: async () => { throw new Error('connection reset with secret'); } }); const cookie = await staff(env); const c = await customer(env, 'j@example.com');
  const s = await liveSite(env, c.orgId);
  const r = await call(env, 'GET', `/api/platform/saas/sites/${s.siteId}/site-system`, { cookie });
  assert.equal(r.status, 502); assert.equal(r.json.error, 'internal_error'); assert.equal(r.text.includes('secret'), false);
});

// ------------------------------------------------------------------ B7: canary over HTTP, Deployments page

async function withRelease(env, version = '2.0.0') { assert.ok((await template.publishRelease(env, { version, scriptContent: `export default {/*${version}*/}`, migrations: [] })).ok); }

test('canary route: POST /api/platform/saas/rollouts with canarySiteId starts a one-site rollout marked canary; bad input is refused', async () => {
  const env = makeEnv(); const cookie = await staff(env); const c = await customer(env, 'k@example.com');
  await withRelease(env);
  const a = await liveSite(env, c.orgId, { name: 'A', appVersion: '1.0.0' }); const b = await liveSite(env, c.orgId, { name: 'B', appVersion: '1.0.0' });
  const noTenant = await liveSite(env, c.orgId, { tenant: false });
  const unknown = await call(env, 'POST', '/api/platform/saas/rollouts', { cookie, body: { canarySiteId: 'nope' } });
  assert.equal(unknown.status, 404); assert.equal(unknown.json.error, 'canary_site_not_found');
  const notLive = await call(env, 'POST', '/api/platform/saas/rollouts', { cookie, body: { canarySiteId: noTenant.siteId } });
  assert.equal(notLive.status, 409); assert.equal(notLive.json.error, 'canary_site_not_live');
  const longNote = await call(env, 'POST', '/api/platform/saas/rollouts', { cookie, body: { canarySiteId: a.siteId, notes: 'n'.repeat(201) } });
  assert.equal(longNote.status, 422); assert.equal(longNote.json.error, 'notes_too_long');
  const ok = await call(env, 'POST', '/api/platform/saas/rollouts', { cookie, body: { canarySiteId: a.siteId, notes: 'look at /news' } });
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.success, true); assert.equal(ok.json.total, 1);
  const row = await one(env, `SELECT notes FROM tenant_rollouts WHERE id = ?`, ok.json.rolloutId);
  assert.equal(row.notes, `canary:${a.siteId} look at /news`);
  const items = await env.LUMMET_DB.prepare(`SELECT site_id FROM tenant_rollout_items WHERE rollout_id = ?`).bind(ok.json.rolloutId).all();
  assert.deepEqual((items.results || []).map((i) => i.site_id), [a.siteId], 'only the canary site is in it');
  assert.ok(b.siteId);
});

test('canary route: with ROLLOUT_REQUIRE_CANARY=on a rollout to everyone is 409 canary_required; without it, 409 rollout_in_progress while the canary runs', async () => {
  for (const [flag, expected] of [['on', 'canary_required'], [undefined, 'rollout_in_progress']]) {
    const env = makeEnv(flag ? { ROLLOUT_REQUIRE_CANARY: flag } : {}); const cookie = await staff(env); const c = await customer(env, `l${flag || 'off'}@example.com`);
    await withRelease(env);
    const a = await liveSite(env, c.orgId, { appVersion: '1.0.0' }); await liveSite(env, c.orgId, { appVersion: '1.0.0' });
    if (flag) assert.equal((await call(env, 'POST', '/api/platform/saas/rollouts', { cookie, body: {} })).json.error, 'canary_required', 'refused before any canary exists');
    assert.equal((await call(env, 'POST', '/api/platform/saas/rollouts', { cookie, body: { canarySiteId: a.siteId } })).status, 200);
    const all = await call(env, 'POST', '/api/platform/saas/rollouts', { cookie, body: {} });
    assert.equal(all.status, 409, all.text); assert.equal(all.json.error, expected);
  }
});

test('canary route: refused for a customer session and without a session', async () => {
  const env = makeEnv(); const c = await customer(env, 'm@example.com');
  assert.ok([401, 403].includes((await call(env, 'POST', '/api/platform/saas/rollouts', { body: { canarySiteId: 'x' } })).status));
  assert.ok([401, 403].includes((await call(env, 'POST', '/api/platform/saas/rollouts', { cookie: c.cookie, body: { canarySiteId: 'x' } })).status));
});

test('GET /api/platform/saas/rollouts: the dashboard carries canary { required, state, candidates }', async () => {
  const env = makeEnv({ ROLLOUT_REQUIRE_CANARY: 'on' }); const cookie = await staff(env); const c = await customer(env, 'n@example.com');
  await withRelease(env);
  const a = await liveSite(env, c.orgId, { name: 'Cand', appVersion: '1.0.0' });
  const r = await call(env, 'GET', '/api/platform/saas/rollouts', { cookie });
  assert.equal(r.status, 200);
  assert.equal(r.json.data.canary.required, true); assert.equal(r.json.data.canary.state.passed, false);
  assert.deepEqual(r.json.data.canary.candidates, [{ id: a.siteId, name: 'Cand', slug: `ps${seq}`, version: '1.0.0' }]);
});

test('Deployments page: canary form lists candidates (escaped); required note and disabled button follow ROLLOUT_REQUIRE_CANARY; passed canary re-enables it', async () => {
  const env = makeEnv({ ROLLOUT_REQUIRE_CANARY: 'on' }); const cookie = await staff(env); const c = await customer(env, 'o@example.com');
  await withRelease(env);
  const hostile = '<script>alert(1)</script>';
  const a = await liveSite(env, c.orgId, { name: hostile, appVersion: '1.0.0' }); await liveSite(env, c.orgId, { name: 'Other', appVersion: '1.0.0' });
  const page = await call(env, 'GET', '/platform/saas/deployments', { cookie });
  assert.equal(page.status, 200);
  const handlers = checkPage('deployments (canary required)', page);
  assert.ok(handlers.includes('lummetCanaryStart'));
  assert.match(page.text, /id="canary-site"/);
  assert.equal(page.text.includes(hostile), false); assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.match(page.text, /Canary first is required/);
  assert.match(page.text, /<button class="btn" disabled[^>]*data-onclick="act"[^>]*>Roll out 2\.0\.0 to 2 sites<\/button>/, 'the all-sites button is disabled until a canary passed');

  const off = makeEnv(); const cookieOff = await staff(off); const co = await customer(off, 'p@example.com');
  await withRelease(off); await liveSite(off, co.orgId, { appVersion: '1.0.0' });
  const pageOff = await call(off, 'GET', '/platform/saas/deployments', { cookie: cookieOff });
  assert.match(pageOff.text, /Safer: roll out to one site first/);
  assert.doesNotMatch(pageOff.text, /<button class="btn" disabled/);
  assert.ok(a.siteId);
});

test('Deployments page: with no candidates there is no canary form; after the release is current there are no controls to roll out', async () => {
  const env = makeEnv(); const cookie = await staff(env); const c = await customer(env, 'q@example.com');
  await withRelease(env);
  await liveSite(env, c.orgId, { appVersion: '2.0.0' });
  const page = await call(env, 'GET', '/platform/saas/deployments', { cookie });
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /id="canary-site"/);
  assert.match(page.text, /Every live site is on the active release/);
});

test('staff sites page: "Check switch" is offered only for a site with a tenant, and its handler is defined', async () => {
  const env = makeEnv(); const cookie = await staff(env); const c = await customer(env, 'r@example.com');
  await liveSite(env, c.orgId, { name: 'With tenant' }); await liveSite(env, c.orgId, { name: 'Without tenant', tenant: false });
  const r = await call(env, 'GET', `/platform/saas/organizations/${c.orgId}`, { cookie });
  assert.equal(r.status, 200, r.text.slice(0, 200));
  const handlers = checkPage('organization', r);
  assert.equal(handlers.filter((x) => x === 'lummetCheckSwitch').length, 1);
});

// ------------------------------------------------------------------ B7: the CI path

test('CI: a token with rollout:run starts a canary; a token with only release:publish cannot; required canary is enforced for CI too', async () => {
  const env = makeEnv({ ROLLOUT_REQUIRE_CANARY: 'on' }); const c = await customer(env, 's@example.com');
  await withRelease(env);
  const a = await liveSite(env, c.orgId, { appVersion: '1.0.0' }); await liveSite(env, c.orgId, { appVersion: '1.0.0' });
  const run = (await staffTokens.createStaffToken(env, { name: 'CI', scopes: ['rollout:run'], createdBy: '1' })).token;
  const pub = (await staffTokens.createStaffToken(env, { name: 'CI pub', scopes: ['release:publish'], createdBy: '1' })).token;
  const denied = await call(env, 'POST', '/api/ci/tenant-release/rollouts', { bearer: pub, body: { canarySiteId: a.siteId } });
  assert.equal(denied.status, 403); assert.equal(denied.json.error, 'forbidden_scope');
  const everyone = await call(env, 'POST', '/api/ci/tenant-release/rollouts', { bearer: run, body: {} });
  assert.equal(everyone.status, 409, everyone.text); assert.equal(everyone.json.error, 'canary_required');
  const canary = await call(env, 'POST', '/api/ci/tenant-release/rollouts', { bearer: run, body: { canarySiteId: a.siteId } });
  assert.equal(canary.status, 202, canary.text); assert.equal(canary.json.success, true);
  const row = await one(env, `SELECT notes, started_by FROM tenant_rollouts ORDER BY created_at DESC LIMIT 1`);
  assert.equal(row.notes, `canary:${a.siteId}`); assert.match(row.started_by, /^token:/);
  const bad = await call(env, 'POST', '/api/ci/tenant-release/rollouts', { bearer: run, body: { canarySiteId: 'nope' } });
  assert.equal(bad.status, 404); assert.equal(bad.json.error, 'canary_site_not_found');
});
