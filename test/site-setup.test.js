// Phase 9: first configuration of a new site (preset or copy of another site). Worker module, createSite hook, provisioning hook,
// first-deploy seed. No network: the tenant is a fake requestTenant that records what it was asked and answers from a script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import * as template from '../worker/tenant-template.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as setup from '../worker/site-setup.js';
import { newTenantSeedMigrations } from '../worker/tenant-defaults.js';

function fakeR2() { const m = new Map(); return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; } }; }
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ...extra };
}
const run = (env, sql, ...args) => env.LUMMET_DB.prepare(sql).bind(...args).run();
const one = (env, sql, ...args) => env.LUMMET_DB.prepare(sql).bind(...args).first();
const all = async (env, sql, ...args) => (await env.LUMMET_DB.prepare(sql).bind(...args).all()).results;

let seq = 0;
async function newOrg(env, name = 'Org', planId = 'plan_casino_news_starter') {
  seq += 1;
  const email = `setup${seq}@example.com`;
  const signup = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: name }; }, headers: { get: () => '203.0.113.20' } }, env);
  await plans.startTrialSubscription(env, signup.organizationId, planId);
  return { organizationId: signup.organizationId, userId: signup.userId };
}
/** A site that is live with a tenant, inserted directly (what provisioning + deployment would leave behind). */
async function liveSite(env, organizationId, name = 'Live') {
  seq += 1;
  const tenantId = `t-live-${seq}`;
  await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, ?, ?, ?)`, tenantId, name, `${tenantId}.example.test`, `https://${tenantId}.example.test`);
  const siteId = `s-live-${seq}`;
  await run(env, `INSERT INTO sites (id, organization_id, name, slug, product_id, status, tenant_id) VALUES (?, ?, ?, ?, 'prod_casino_news', 'active', ?)`, siteId, organizationId, name, `live-${seq}`, tenantId);
  return { siteId, tenantId };
}

/** A tenant that answers from a script. Each answer is keyed "METHOD path-without-query" and may be an array (used in order) or a function. */
function fakeTenants(script = {}) {
  const calls = [];
  const request = async (env, tenantOrId, { method, path, body, timeoutMs }) => {
    const tenantId = typeof tenantOrId === 'string' ? tenantOrId : tenantOrId.id;
    calls.push({ tenantId, method, path, body, timeoutMs });
    const key = `${method} ${path.split('?')[0]}`;
    let answer = script[key];
    if (Array.isArray(answer)) answer = answer.length > 1 ? answer.shift() : answer[0];
    if (typeof answer === 'function') answer = answer({ tenantId, body });
    return answer || { ok: true, status: 200, data: { success: true, applied: true } };
  };
  request.calls = calls;
  return request;
}
const failure = (status, reason) => ({ ok: false, status, reason, message: 'x', meta: { data: { secret: 'must-not-be-stored' } } });
const EXPORT_OK = (envelope = { format: 'lummet-config', meta: { host: 'src.example.test' }, sections: {} }) => ({ ok: true, status: 200, data: { success: true, envelope, included: ['site-profile'], notes: [] } });
const SETUP = 'POST /en/api/super/site-setup';
const EXPORT = 'GET /en/api/super/site-config-export';

// ------------------------------------------------------------------ validation

test('the preset list mirrors the tenant and validatePresetId only accepts those ids', () => {
  assert.deepEqual([...setup.SITE_PRESET_IDS], ['full', 'news', 'casino-list', 'casino-only', 'list-reviews', 'sportsbook', 'research', 'static']);
  for (const p of setup.SITE_PRESETS) assert.ok(p.label && typeof p.label === 'string');
  assert.deepEqual(setup.validatePresetId('news'), { ok: true, id: 'news' });
  assert.deepEqual(setup.validatePresetId(' static '), { ok: true, id: 'static' });
  for (const bad of ['News', 'everything', '', null, undefined, 5, {}, ['full'], '__proto__']) assert.equal(setup.validatePresetId(bad).ok, false, String(bad));
});

test('sections are plain strings only; anything else is refused, never coerced', () => {
  assert.deepEqual(setup.cleanSections(undefined), { ok: true, sections: null });
  assert.deepEqual(setup.cleanSections([]), { ok: true, sections: null });
  assert.deepEqual(setup.cleanSections(['site-profile', 'site-profile', 'header_hero']), { ok: true, sections: ['site-profile', 'header_hero'] });
  for (const bad of ['site-profile', [1], [{}], [['a']], ['a b'], ['../x'], ['a,b'], new Array(41).fill('a')]) assert.equal(setup.cleanSections(bad).ok, false, JSON.stringify(bad));
});

// ------------------------------------------------------------------ default preset resolution

test('default preset: explicit > plan > product > "full"', async () => {
  const env = makeEnv();
  const { organizationId } = await newOrg(env);
  const ctx = { organizationId, productId: 'prod_casino_news' };
  assert.deepEqual(await setup.resolveDefaultPreset(env, ctx), { presetId: 'full', source: 'fallback' });

  assert.equal((await setup.setDefault(env, { scopeKind: 'product', scopeId: 'prod_casino_news', presetId: 'casino-list', updatedBy: 'staff:1' })).ok, true);
  assert.deepEqual(await setup.resolveDefaultPreset(env, ctx), { presetId: 'casino-list', source: 'product' });

  assert.equal((await setup.setDefault(env, { scopeKind: 'plan', scopeId: 'plan_casino_news_starter', presetId: 'news', updatedBy: 'staff:1' })).ok, true);
  assert.deepEqual(await setup.resolveDefaultPreset(env, ctx), { presetId: 'news', source: 'plan' }, 'the plan beats the product');

  assert.deepEqual(await setup.resolveDefaultPreset(env, { ...ctx, explicit: 'static' }), { presetId: 'static', source: 'explicit' }, 'an explicit choice beats both');
  assert.equal((await setup.resolveDefaultPreset(env, { ...ctx, explicit: 'nope' })).presetId, null, 'an unknown explicit choice is not replaced by a default');

  // clearing falls back down the chain
  assert.equal((await setup.setDefault(env, { scopeKind: 'plan', scopeId: 'plan_casino_news_starter', presetId: null })).cleared, true);
  assert.deepEqual(await setup.resolveDefaultPreset(env, ctx), { presetId: 'casino-list', source: 'product' });
});

test('plan default follows the organization\'s CURRENT subscription plan, and another organization on another plan is unaffected', async () => {
  const env = makeEnv();
  const a = await newOrg(env, 'A', 'plan_casino_news_starter');
  const plan2 = await one(env, `SELECT id FROM plans WHERE id <> 'plan_casino_news_starter' LIMIT 1`);
  assert.ok(plan2, 'the catalog has a second plan');
  const b = await newOrg(env, 'B', plan2.id);
  await setup.setDefault(env, { scopeKind: 'plan', scopeId: 'plan_casino_news_starter', presetId: 'news' });
  assert.equal((await setup.resolveDefaultPreset(env, { organizationId: a.organizationId, productId: 'prod_casino_news' })).presetId, 'news');
  assert.equal((await setup.resolveDefaultPreset(env, { organizationId: b.organizationId, productId: 'prod_casino_news' })).presetId, 'full');
});

test('setDefault validates scope, ids and preset; a stored id that is no longer a preset is ignored', async () => {
  const env = makeEnv();
  assert.equal((await setup.setDefault(env, { scopeKind: 'org', scopeId: 'x', presetId: 'news' })).error, 'invalid_scope_kind');
  assert.equal((await setup.setDefault(env, { scopeKind: 'plan', scopeId: '', presetId: 'news' })).error, 'scope_id_required');
  assert.equal((await setup.setDefault(env, { scopeKind: 'plan', scopeId: 'no_such_plan', presetId: 'news' })).error, 'plan_not_found');
  assert.equal((await setup.setDefault(env, { scopeKind: 'product', scopeId: 'no_such_product', presetId: 'news' })).error, 'product_not_found');
  assert.equal((await setup.setDefault(env, { scopeKind: 'plan', scopeId: 'plan_casino_news_starter', presetId: 'bogus' })).error, 'unknown_preset');
  assert.equal((await setup.listDefaults(env)).length, 0, 'nothing was stored by a refused call');
  await run(env, `INSERT INTO site_preset_defaults (scope_kind, scope_id, preset_id) VALUES ('product', 'prod_casino_news', 'retired-preset')`);
  const { organizationId } = await newOrg(env);
  assert.equal((await setup.resolveDefaultPreset(env, { organizationId, productId: 'prod_casino_news' })).presetId, 'full');
});

// ------------------------------------------------------------------ createSite hook

test('no preset given: the site is created with a request for the resolved default ("full"), pending, so it starts the wizard', async () => {
  const env = makeEnv();
  const { organizationId, userId } = await newOrg(env);
  const r = await sites.createSite(env, { organizationId, name: 'Plain', productId: 'prod_casino_news', actorUserId: userId });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual({ kind: r.setup.kind, presetId: r.setup.presetId, status: r.setup.status }, { kind: 'preset', presetId: 'full', status: 'pending' });
  const rows = await all(env, `SELECT * FROM site_setup_requests WHERE site_id = ?`, r.siteId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending'); assert.equal(rows[0].preset_id, 'full'); assert.equal(rows[0].kind, 'preset'); assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].requested_by, userId);
});

test('createSite uses the plan default, and an explicit preset beats it', async () => {
  const env = makeEnv();
  const { organizationId, userId } = await newOrg(env);
  await setup.setDefault(env, { scopeKind: 'plan', scopeId: 'plan_casino_news_starter', presetId: 'news' });
  const a = await sites.createSite(env, { organizationId, name: 'A', productId: 'prod_casino_news', actorUserId: userId });
  assert.equal(a.setup.presetId, 'news'); assert.equal(a.setup.presetSource, 'plan');
  const b = await sites.createSite(env, { organizationId, name: 'B', productId: 'prod_casino_news', actorUserId: userId, preset: 'research' });
  assert.equal(b.setup.presetId, 'research'); assert.equal(b.setup.presetSource, 'explicit');
});

test('createSite refuses a bad preset or a bad clone source BEFORE creating anything', async () => {
  const env = makeEnv();
  const a = await newOrg(env, 'A');
  const b = await newOrg(env, 'B');
  const own = await liveSite(env, a.organizationId, 'Own');
  const foreign = await liveSite(env, b.organizationId, 'Foreign');
  const before = (await one(env, `SELECT COUNT(*) n FROM sites`)).n;
  const args = { organizationId: a.organizationId, name: 'New', productId: 'prod_casino_news', actorUserId: a.userId };

  assert.deepEqual(await sites.createSite(env, { ...args, preset: 'everything' }), { ok: false, status: 422, error: 'unknown_preset' });
  assert.deepEqual(await sites.createSite(env, { ...args, preset: 'news', cloneFromSiteId: own.siteId }), { ok: false, status: 422, error: 'choose_one' });
  assert.deepEqual(await sites.createSite(env, { ...args, cloneFromSiteId: 'no-such-site' }), { ok: false, status: 404, error: 'clone_source_not_found' });
  assert.deepEqual(await sites.createSite(env, { ...args, cloneFromSiteId: foreign.siteId }), { ok: false, status: 404, error: 'clone_source_not_found' }, 'another organization\'s site looks exactly like a missing one');
  assert.deepEqual(await sites.createSite(env, { ...args, cloneFromSiteId: own.siteId, sections: ['ok', 7] }), { ok: false, status: 422, error: 'invalid_sections' });
  assert.equal((await one(env, `SELECT COUNT(*) n FROM sites`)).n, before, 'no site row was created by any refused call');
  assert.equal((await one(env, `SELECT COUNT(*) n FROM site_setup_requests`)).n, 0);
});

test('clone source must be ACTIVE and have a tenant', async () => {
  const env = makeEnv();
  const a = await newOrg(env);
  const args = { organizationId: a.organizationId, name: 'New', productId: 'prod_casino_news', actorUserId: a.userId };
  const pending = await sites.createSite(env, { ...args, name: 'NotLive' });
  assert.equal((await sites.createSite(env, { ...args, cloneFromSiteId: pending.siteId })).error, 'clone_source_not_active');
  const s = await liveSite(env, a.organizationId);
  await run(env, `UPDATE sites SET status = 'suspended' WHERE id = ?`, s.siteId);
  assert.equal((await sites.createSite(env, { ...args, cloneFromSiteId: s.siteId })).error, 'clone_source_not_active');
  await run(env, `UPDATE sites SET status = 'active', tenant_id = NULL WHERE id = ?`, s.siteId);
  assert.equal((await sites.createSite(env, { ...args, cloneFromSiteId: s.siteId })).error, 'clone_source_not_active');
});

test('same-organization clone: stored as a clone request naming the source tenant, with sections', async () => {
  const env = makeEnv();
  const a = await newOrg(env);
  const src = await liveSite(env, a.organizationId, 'Source');
  const r = await sites.createSite(env, { organizationId: a.organizationId, name: 'Copy', productId: 'prod_casino_news', actorUserId: a.userId, cloneFromSiteId: src.siteId, sections: ['site-profile'] });
  assert.equal(r.ok, true, JSON.stringify(r));
  const row = await one(env, `SELECT * FROM site_setup_requests WHERE site_id = ?`, r.siteId);
  assert.equal(row.kind, 'clone'); assert.equal(row.source_tenant_id, src.tenantId); assert.equal(row.preset_id, null);
  assert.deepEqual(JSON.parse(row.sections), ['site-profile']);
});

// ------------------------------------------------------------------ staff clone by tenant id

test('staff may clone from ANY registered, enabled tenant by id; a customer may not use tenant ids at all', async () => {
  const env = makeEnv();
  const a = await newOrg(env, 'A'); const b = await newOrg(env, 'B');
  const foreign = await liveSite(env, b.organizationId, 'Foreign');
  const mine = await liveSite(env, a.organizationId, 'Mine');

  const asStaff = await setup.createSetupRequest(env, { siteId: mine.siteId, cloneFromTenantId: foreign.tenantId, staff: true, organizationId: a.organizationId, productId: 'prod_casino_news', targetSiteId: mine.siteId, requestedBy: 'staff:1' });
  assert.equal(asStaff.ok, true, JSON.stringify(asStaff));
  assert.equal(asStaff.sourceTenantId, foreign.tenantId);

  const asCustomer = await setup.planSetup(env, { cloneFromTenantId: foreign.tenantId, staff: false, organizationId: a.organizationId, productId: 'prod_casino_news' });
  assert.deepEqual({ ok: asCustomer.ok, status: asCustomer.status, error: asCustomer.error }, { ok: false, status: 403, error: 'forbidden' });
  const asCustomerSite = await setup.planSetup(env, { cloneFromSiteId: foreign.siteId, staff: false, organizationId: a.organizationId, productId: 'prod_casino_news' });
  assert.equal(asCustomerSite.status, 404);

  assert.equal((await setup.planSetup(env, { cloneFromTenantId: 'nope', staff: true })).error, 'clone_source_not_found');
  await run(env, `UPDATE tenants SET status = 'disabled' WHERE id = ?`, foreign.tenantId);
  assert.equal((await setup.planSetup(env, { cloneFromTenantId: foreign.tenantId, staff: true })).error, 'clone_source_not_active');
  await run(env, `UPDATE tenants SET status = 'active' WHERE id = ?`, foreign.tenantId);
  await run(env, `UPDATE sites SET status = 'suspended' WHERE id = ?`, foreign.siteId);
  assert.equal((await setup.planSetup(env, { cloneFromTenantId: foreign.tenantId, staff: true })).error, 'clone_source_not_active', 'a suspended customer site is not a source');
  assert.equal((await setup.planSetup(env, { cloneFromTenantId: mine.tenantId, staff: true, targetSiteId: mine.siteId })).error, 'clone_source_is_target');
});

test('a newer request for the same site supersedes (skips) the open ones; nothing is deleted', async () => {
  const env = makeEnv();
  const a = await newOrg(env);
  const s = await liveSite(env, a.organizationId);
  const first = await setup.createSetupRequest(env, { siteId: s.siteId, preset: 'news', organizationId: a.organizationId, productId: 'prod_casino_news' });
  const second = await setup.createSetupRequest(env, { siteId: s.siteId, preset: 'static', organizationId: a.organizationId, productId: 'prod_casino_news' });
  const rows = await all(env, `SELECT id, status, last_error FROM site_setup_requests WHERE site_id = ? ORDER BY rowid`, s.siteId);
  assert.deepEqual(rows.map((r) => [r.id, r.status, r.last_error]), [[first.requestId, 'skipped', 'superseded'], [second.requestId, 'pending', null]]);
});

// ------------------------------------------------------------------ applySetup

async function pendingPreset(env, preset = 'news') {
  const a = await newOrg(env);
  const s = await liveSite(env, a.organizationId);
  const r = await setup.createSetupRequest(env, { siteId: s.siteId, preset, organizationId: a.organizationId, productId: 'prod_casino_news' });
  return { ...a, ...s, requestId: r.requestId };
}

test('preset: POSTs {preset} to the site\'s tenant, records applied, counts the attempt', async () => {
  const env = makeEnv(); const t = await pendingPreset(env, 'news');
  const request = fakeTenants({ [SETUP]: { ok: true, status: 200, data: { success: true, applied: true, version: 3 } } });
  const r = await setup.applySetup(env, t.requestId, { request });
  assert.deepEqual({ ok: r.ok, status: r.status }, { ok: true, status: 'applied' });
  assert.equal(request.calls.length, 1);
  assert.deepEqual(request.calls[0], { tenantId: t.tenantId, method: 'POST', path: '/en/api/super/site-setup', body: { preset: 'news' }, timeoutMs: undefined });
  const row = await one(env, `SELECT * FROM site_setup_requests WHERE id = ?`, t.requestId);
  assert.equal(row.status, 'applied'); assert.equal(row.attempts, 1); assert.equal(row.last_error, null); assert.ok(row.applied_at);
});

test('every tenant error code is recorded as a short code; none is ever an exception, and no tenant body is stored', async () => {
  const cases = [
    ['choose_one', 422], ['unknown_preset', 422], ['invalid_envelope', 422], ['needs_migration', 503],
    ['import_failed', 422], ['publish_failed', 409], ['unauthorized', 401], ['tenant_not_configured', 503], ['unavailable', 502], ['timeout', 504]
  ];
  for (const [code, status] of cases) {
    const env = makeEnv(); const t = await pendingPreset(env);
    const r = await setup.applySetup(env, t.requestId, { request: fakeTenants({ [SETUP]: failure(status, code) }) });
    assert.equal(r.status, 'failed', code); assert.equal(r.ok, false, code);
    const row = await one(env, `SELECT * FROM site_setup_requests WHERE id = ?`, t.requestId);
    assert.equal(row.status, 'failed', code);
    assert.equal(row.last_error, `${code} (HTTP ${status})`);
    assert.equal(JSON.stringify(row).includes('must-not-be-stored'), false, 'the tenant response body is never stored');
  }
});

test('a reason that does not look like a code is not stored verbatim', async () => {
  const env = makeEnv(); const t = await pendingPreset(env);
  await setup.applySetup(env, t.requestId, { request: fakeTenants({ [SETUP]: failure(500, 'Bearer abc123 <script>') }) });
  assert.equal((await one(env, `SELECT last_error FROM site_setup_requests WHERE id = ?`, t.requestId)).last_error, 'tenant_error (HTTP 500)');
});

test('409 setup_not_pending and 409 already_configured become "skipped": not an error, nothing overwritten', async () => {
  for (const code of ['setup_not_pending', 'already_configured']) {
    const env = makeEnv(); const t = await pendingPreset(env);
    const request = fakeTenants({ [SETUP]: failure(409, code) });
    const r = await setup.applySetup(env, t.requestId, { request });
    assert.deepEqual({ ok: r.ok, status: r.status }, { ok: true, status: 'skipped' }, code);
    assert.equal((await one(env, `SELECT last_error FROM site_setup_requests WHERE id = ?`, t.requestId)).last_error, code);
    assert.equal(request.calls.length, 1, 'one call, no follow-up that could overwrite');
    assert.equal((await setup.retrySetup(env, t.siteId, { request })).error, 'nothing_to_retry', 'a skipped request is final');
  }
});

test('any other 409 is a failure, not a skip', async () => {
  const env = makeEnv(); const t = await pendingPreset(env);
  const r = await setup.applySetup(env, t.requestId, { request: fakeTenants({ [SETUP]: failure(409, 'conflict') }) });
  assert.equal(r.status, 'failed');
});

test('idempotent: an applied or skipped request never calls the tenant again; "alreadyApplied" from the tenant counts as applied', async () => {
  const env = makeEnv(); const t = await pendingPreset(env);
  const request = fakeTenants({ [SETUP]: { ok: true, status: 200, data: { success: true, alreadyApplied: true } } });
  assert.equal((await setup.applySetup(env, t.requestId, { request })).status, 'applied');
  const again = await setup.applySetup(env, t.requestId, { request });
  assert.deepEqual({ ok: again.ok, status: again.status, alreadyDone: again.alreadyDone }, { ok: true, status: 'applied', alreadyDone: true });
  assert.equal(request.calls.length, 1);
  assert.equal((await one(env, `SELECT attempts FROM site_setup_requests WHERE id = ?`, t.requestId)).attempts, 1);
  assert.equal((await setup.applySetup(env, 'no-such-request', { request })).error, 'request_not_found');
});

test('fail-open: an unreachable tenant (and even a requester that throws) only marks the request failed', async () => {
  const env = makeEnv(); const t = await pendingPreset(env);
  const r1 = await setup.applySetup(env, t.requestId, { request: fakeTenants({ [SETUP]: failure(502, 'unavailable') }) });
  assert.equal(r1.status, 'failed');
  const r2 = await setup.applySetup(env, t.requestId, { request: async () => { throw new Error('boom: secret-token'); } });
  assert.equal(r2.status, 'failed');
  const row = await one(env, `SELECT * FROM site_setup_requests WHERE id = ?`, t.requestId);
  assert.equal(row.last_error, 'internal_error'); assert.equal(row.attempts, 2);
  assert.equal(JSON.stringify(row).includes('secret-token'), false);
});

test('a request whose site has no tenant fails with "no_tenant" without calling anyone', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const site = await sites.createSite(env, { organizationId: a.organizationId, name: 'NoTenant', productId: 'prod_casino_news', actorUserId: a.userId });
  const request = fakeTenants();
  const r = await setup.applySetup(env, site.setup.requestId, { request });
  assert.equal(r.status, 'failed'); assert.equal(request.calls.length, 0);
  assert.equal((await one(env, `SELECT last_error FROM site_setup_requests WHERE id = ?`, site.setup.requestId)).last_error, 'no_tenant');
});

// ------------------------------------------------------------------ clone apply

async function pendingClone(env, sections) {
  const a = await newOrg(env);
  const src = await liveSite(env, a.organizationId, 'Source');
  const dst = await liveSite(env, a.organizationId, 'Target');
  const r = await setup.createSetupRequest(env, { siteId: dst.siteId, cloneFromSiteId: src.siteId, sections, organizationId: a.organizationId, productId: 'prod_casino_news', targetSiteId: dst.siteId });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { a, src, dst, requestId: r.requestId };
}

test('clone happy path: GET the export on the SOURCE tenant, then POST {envelope, sections} to the TARGET', async () => {
  const env = makeEnv(); const c = await pendingClone(env, ['site-profile', 'header_hero']);
  const envelope = { format: 'lummet-config', meta: { host: 'src.example.test' }, sections: { 'site-profile': { v: 2, preset: 'news' } } };
  const request = fakeTenants({ [EXPORT]: EXPORT_OK(envelope), [SETUP]: { ok: true, status: 200, data: { success: true, applied: true } } });
  const r = await setup.applySetup(env, c.requestId, { request });
  assert.deepEqual({ ok: r.ok, status: r.status }, { ok: true, status: 'applied' });
  assert.equal(request.calls.length, 2);
  assert.deepEqual([request.calls[0].tenantId, request.calls[0].method, request.calls[0].path], [c.src.tenantId, 'GET', '/en/api/super/site-config-export?sections=site-profile,header_hero']);
  assert.deepEqual([request.calls[1].tenantId, request.calls[1].method, request.calls[1].path], [c.dst.tenantId, 'POST', '/en/api/super/site-setup']);
  assert.deepEqual(request.calls[1].body, { envelope, sections: ['site-profile', 'header_hero'] });
  assert.ok(request.calls[0].timeoutMs >= 15000, 'clone calls get a longer timeout');
  const row = await one(env, `SELECT * FROM site_setup_requests WHERE id = ?`, c.requestId);
  assert.equal(JSON.stringify(row).includes('lummet-config'), false, 'the envelope is forwarded, never stored');
});

test('clone without sections exports everything (no query string) and sends no sections key', async () => {
  const env = makeEnv(); const c = await pendingClone(env);
  const request = fakeTenants({ [EXPORT]: EXPORT_OK() });
  assert.equal((await setup.applySetup(env, c.requestId, { request })).status, 'applied');
  assert.equal(request.calls[0].path, '/en/api/super/site-config-export');
  assert.equal('sections' in request.calls[1].body, false);
});

test('clone: a failing SOURCE is a failure and the target is never called', async () => {
  const env = makeEnv(); const c = await pendingClone(env);
  const request = fakeTenants({ [EXPORT]: failure(502, 'unavailable') });
  const r = await setup.applySetup(env, c.requestId, { request });
  assert.equal(r.status, 'failed'); assert.equal(request.calls.length, 1);
  assert.equal((await one(env, `SELECT last_error FROM site_setup_requests WHERE id = ?`, c.requestId)).last_error, 'source_unavailable (HTTP 502)');
});

test('clone: an empty or oversized export is refused before anything is sent to the target', async () => {
  let env = makeEnv(); let c = await pendingClone(env);
  let request = fakeTenants({ [EXPORT]: { ok: true, status: 200, data: { success: true } } });
  assert.equal((await setup.applySetup(env, c.requestId, { request })).status, 'failed');
  assert.equal((await one(env, `SELECT last_error FROM site_setup_requests WHERE id = ?`, c.requestId)).last_error, 'source_empty_export');
  assert.equal(request.calls.length, 1);

  env = makeEnv(); c = await pendingClone(env);
  request = fakeTenants({ [EXPORT]: EXPORT_OK({ blob: 'x'.repeat(setup.MAX_ENVELOPE_BYTES + 10) }) });
  assert.equal((await setup.applySetup(env, c.requestId, { request })).status, 'failed');
  assert.equal((await one(env, `SELECT last_error FROM site_setup_requests WHERE id = ?`, c.requestId)).last_error, 'envelope_too_large');
  assert.equal(request.calls.length, 1, 'the oversized envelope was never forwarded');

  env = makeEnv(); c = await pendingClone(env);
  request = fakeTenants({ [EXPORT]: EXPORT_OK({ blob: 'x'.repeat(setup.MAX_ENVELOPE_BYTES - 1000) }) });
  assert.equal((await setup.applySetup(env, c.requestId, { request })).status, 'applied', 'just under the cap is forwarded');
});

test('clone: the target\'s refusals map the same way (invalid_envelope failed, already_configured skipped)', async () => {
  let env = makeEnv(); let c = await pendingClone(env);
  assert.equal((await setup.applySetup(env, c.requestId, { request: fakeTenants({ [EXPORT]: EXPORT_OK(), [SETUP]: failure(422, 'invalid_envelope') }) })).status, 'failed');
  env = makeEnv(); c = await pendingClone(env);
  assert.equal((await setup.applySetup(env, c.requestId, { request: fakeTenants({ [EXPORT]: EXPORT_OK(), [SETUP]: failure(409, 'already_configured') }) })).status, 'skipped');
});

// ------------------------------------------------------------------ retry and read

test('retry: a failed request is re-run and can then succeed; the attempt count grows; applied cannot be retried', async () => {
  const env = makeEnv(); const t = await pendingPreset(env);
  const request = fakeTenants({ [SETUP]: [failure(502, 'unavailable'), { ok: true, status: 200, data: { success: true, applied: true } }] });
  assert.equal((await setup.applySetup(env, t.requestId, { request })).status, 'failed');
  const view1 = await setup.getSetupForSite(env, t.siteId);
  assert.deepEqual({ status: view1.status, attempts: view1.attempts, lastError: view1.lastError, presetLabel: view1.presetLabel }, { status: 'failed', attempts: 1, lastError: 'unavailable (HTTP 502)', presetLabel: 'News site only' });

  const retried = await setup.retrySetup(env, t.siteId, { request });
  assert.deepEqual({ ok: retried.ok, status: retried.status, httpStatus: retried.httpStatus }, { ok: true, status: 'applied', httpStatus: 200 });
  assert.equal((await setup.getSetupForSite(env, t.siteId)).attempts, 2);
  const again = await setup.retrySetup(env, t.siteId, { request });
  assert.deepEqual({ ok: again.ok, httpStatus: again.httpStatus, error: again.error }, { ok: false, httpStatus: 409, error: 'nothing_to_retry' });
  assert.equal(request.calls.length, 2);
});

test('retry refuses a site that is not live yet, has no request, or does not exist', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const site = await sites.createSite(env, { organizationId: a.organizationId, name: 'Early', productId: 'prod_casino_news', actorUserId: a.userId });
  assert.equal((await setup.retrySetup(env, site.siteId, { request: fakeTenants() })).error, 'site_not_ready');
  assert.equal((await setup.retrySetup(env, 'nope', { request: fakeTenants() })).httpStatus, 404);
  const legacy = await liveSite(env, a.organizationId, 'Legacy');
  assert.equal((await setup.retrySetup(env, legacy.siteId, { request: fakeTenants() })).error, 'no_setup_request');
});

test('getSetupForSite: "none" for a site with no request; customers do not see source tenants or staff ids, staff do', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const legacy = await liveSite(env, a.organizationId, 'Legacy');
  assert.deepEqual(await setup.getSetupForSite(env, legacy.siteId), { status: 'none' });
  const src = await liveSite(env, a.organizationId, 'Src');
  const r = await setup.createSetupRequest(env, { siteId: legacy.siteId, cloneFromSiteId: src.siteId, organizationId: a.organizationId, requestedBy: 'staff:9', targetSiteId: legacy.siteId, staff: true });
  assert.equal(r.ok, true, JSON.stringify(r));
  const customerView = await setup.getSetupForSite(env, legacy.siteId);
  assert.equal(JSON.stringify(customerView).includes(src.tenantId), false); assert.equal('requestedBy' in customerView, false);
  const staffView = await setup.getSetupForSite(env, legacy.siteId, { staff: true });
  assert.equal(staffView.sourceTenantId, src.tenantId); assert.equal(staffView.requestedBy, 'staff:9');
});

// ------------------------------------------------------------------ provisioning hook

const REAL_MIGS = [{ name: '0001_x.sql', sql: 'CREATE TABLE x (id INTEGER);' }];
async function provisionWith(env, { setupService, siteId, infra = createFakeInfraProvider(), failDeploy = false }) {
  const deploymentService = createDeploymentService(infra);
  const provisioning = createProvisioningService(infra, { deploymentService, templateService: template, setupService });
  const start = await provisioning.startProvisioning(env, siteId);
  assert.equal(start.ok, true, JSON.stringify(start));
  if (failDeploy) infra._failNextCall('uploadWorkerScript', 'upload rejected');
  return { infra, run: await provisioning.runJob(env, start.jobId) };
}
async function releaseEnv() {
  const env = makeEnv({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default {}', migrations: REAL_MIGS });
  return env;
}

test('provisioning: after a successful first deploy the pending request is applied and the result is in attemptAutoDeploy\'s return value', async () => {
  const env = await releaseEnv(); const a = await newOrg(env);
  const created = await sites.createSite(env, { organizationId: a.organizationId, name: 'Fresh', productId: 'prod_casino_news', actorUserId: a.userId, preset: 'news' });
  const request = fakeTenants();
  const setupService = { applyPendingSetupForSite: (e, id) => setup.applyPendingSetupForSite(e, id, { request }) };
  const { run: ran } = await provisionWith(env, { setupService, siteId: created.siteId });
  assert.equal(ran.ok, true, JSON.stringify(ran));
  assert.equal(ran.result.autoDeploy.ok, true);
  assert.equal(ran.result.autoDeploy.setup.status, 'applied');
  assert.equal(ran.result.autoDeploy.setup.requestId, created.setup.requestId);
  assert.deepEqual(request.calls.map((c) => [c.method, c.body]), [['POST', { preset: 'news' }]]);
  assert.equal((await sites.getSite(env, created.siteId)).status, 'active');
});

test('provisioning is fail-open: a tenant that cannot be reached leaves the site ACTIVE, provisioning successful, the request failed and retryable', async () => {
  const env = await releaseEnv(); const a = await newOrg(env);
  const created = await sites.createSite(env, { organizationId: a.organizationId, name: 'Fresh', productId: 'prod_casino_news', actorUserId: a.userId, preset: 'research' });
  const request = fakeTenants({ [SETUP]: failure(502, 'unavailable') });
  const { run: ran } = await provisionWith(env, { setupService: { applyPendingSetupForSite: (e, id) => setup.applyPendingSetupForSite(e, id, { request }) }, siteId: created.siteId });
  assert.equal(ran.ok, true); assert.equal(ran.result.autoDeploy.ok, true);
  assert.equal(ran.result.autoDeploy.setup.status, 'failed');
  assert.equal((await sites.getSite(env, created.siteId)).status, 'active');
  assert.equal((await setup.getSetupForSite(env, created.siteId)).status, 'failed');
  const ok = fakeTenants();
  assert.equal((await setup.retrySetup(env, created.siteId, { request: ok })).status, 'applied');
});

test('provisioning is fail-open even when the setup service itself throws', async () => {
  const env = await releaseEnv(); const a = await newOrg(env);
  const created = await sites.createSite(env, { organizationId: a.organizationId, name: 'Fresh', productId: 'prod_casino_news', actorUserId: a.userId });
  const { run: ran } = await provisionWith(env, { setupService: { applyPendingSetupForSite: async () => { throw new Error('nope'); } }, siteId: created.siteId });
  assert.equal(ran.ok, true); assert.equal(ran.result.autoDeploy.ok, true); assert.equal(ran.result.autoDeploy.setup.status, 'failed');
  assert.equal((await sites.getSite(env, created.siteId)).status, 'active');
});

test('a FAILED deployment never applies a setup', async () => {
  const env = await releaseEnv(); const a = await newOrg(env);
  const created = await sites.createSite(env, { organizationId: a.organizationId, name: 'Fresh', productId: 'prod_casino_news', actorUserId: a.userId });
  const request = fakeTenants();
  const { run: ran } = await provisionWith(env, { setupService: { applyPendingSetupForSite: (e, id) => setup.applyPendingSetupForSite(e, id, { request }) }, siteId: created.siteId, failDeploy: true });
  assert.equal(ran.ok, true, 'provisioning itself still succeeded');
  assert.equal(ran.result.autoDeploy.ok, false);
  assert.equal('setup' in ran.result.autoDeploy, false);
  assert.equal(request.calls.length, 0);
  assert.equal((await setup.getSetupForSite(env, created.siteId)).status, 'pending');
});

test('no template published: no deployment, no setup call, the request stays pending', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const created = await sites.createSite(env, { organizationId: a.organizationId, name: 'Fresh', productId: 'prod_casino_news', actorUserId: a.userId });
  const request = fakeTenants();
  const { run: ran } = await provisionWith(env, { setupService: { applyPendingSetupForSite: (e, id) => setup.applyPendingSetupForSite(e, id, { request }) }, siteId: created.siteId });
  assert.equal(ran.result.autoDeploy.attempted, false);
  assert.equal(request.calls.length, 0);
  assert.equal((await setup.getSetupForSite(env, created.siteId)).status, 'pending');
});

test('applyPendingSetupForSite: nothing to do without a request, and a request that is not pending is left alone', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const legacy = await liveSite(env, a.organizationId);
  const request = fakeTenants();
  assert.deepEqual(await setup.applyPendingSetupForSite(env, legacy.siteId, { request }), { attempted: false, reason: 'no_request' });
  const t = await pendingPreset(env);
  await setup.applySetup(env, t.requestId, { request });
  assert.equal((await setup.applyPendingSetupForSite(env, t.siteId, { request })).attempted, false);
  assert.equal(request.calls.length, 1);
});

// ------------------------------------------------------------------ first-deploy seed

test('the setup-pending seed runs on a site\'s FIRST deploy only, after the release migrations, and never on a redeploy', async () => {
  const env = await releaseEnv(); const a = await newOrg(env);
  const created = await sites.createSite(env, { organizationId: a.organizationId, name: 'Seeded', productId: 'prod_casino_news', actorUserId: a.userId });
  const noSetup = { applyPendingSetupForSite: async () => ({ attempted: false, reason: 'test' }) };
  const { infra } = await provisionWith(env, { setupService: noSetup, siteId: created.siteId });
  const queries = infra._calls.filter((c) => c.method === 'runD1Query').map((c) => c.sql);
  const seedAt = queries.findIndex((q) => /site_setup_state/.test(q));
  assert.ok(seedAt > 0, 'seed present, after the release migrations');
  assert.match(queries[0], /CREATE TABLE x/);
  assert.match(queries[seedAt], /INSERT OR REPLACE INTO settings/);
  assert.ok(queries[seedAt].includes("('site_setup_state','pending')") && queries[seedAt].includes("('site_setup_source','new')"));
  assert.deepEqual(newTenantSeedMigrations().map((m) => m.name).slice(-1), ['provision_0002_site_setup_pending']);

  const deploymentService = createDeploymentService(infra);
  const before = infra._calls.length;
  const again = await deploymentService.startDeployment(env, { siteId: created.siteId, version: '1.0.1', migrations: [], scriptContent: 'v1b', actorType: 'system' });
  assert.equal(again.ok, true, JSON.stringify(again));
  await deploymentService.runJob(env, again.jobId);
  assert.equal(infra._calls.slice(before).filter((c) => c.method === 'runD1Query' && /site_setup_state/.test(c.sql)).length, 0, 'a redeploy must not put a configured site back into the wizard');
});

// ------------------------------------------------------------------ isolation

test('org isolation: organization A cannot clone organization B\'s site, and nothing about B is created or revealed', async () => {
  const env = makeEnv();
  const a = await newOrg(env, 'A'); const b = await newOrg(env, 'B');
  const bs = await liveSite(env, b.organizationId, 'B-secret-site');
  const before = JSON.stringify(await all(env, `SELECT * FROM sites ORDER BY id`));
  const r = await sites.createSite(env, { organizationId: a.organizationId, name: 'Thief', productId: 'prod_casino_news', actorUserId: a.userId, cloneFromSiteId: bs.siteId });
  assert.deepEqual(r, { ok: false, status: 404, error: 'clone_source_not_found' });
  assert.equal(JSON.stringify(r).includes(bs.tenantId), false);
  assert.equal(JSON.stringify(await all(env, `SELECT * FROM sites ORDER BY id`)), before);
  assert.equal((await one(env, `SELECT COUNT(*) n FROM site_setup_requests`)).n, 0);
});
