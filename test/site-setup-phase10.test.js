// Phase 10 (control plane): the pieces added after Phase 9. Repository SQL run against the D1 shim, tenant 409 config_system_off
// = skipped, the retry sweep (backoff, cap, flag, newest request only, inactive site, one failing site), the picker data, and the
// read-only master switch lookup. No network: the tenant is a fake requestTenant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as setup from '../worker/site-setup.js';
import * as repo from '../worker/repositories/site-setup.js';

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ...extra };
}
const run = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).run();
const one = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).first();

let seq = 0;
async function newOrg(env, name = 'Org') {
  seq += 1;
  const signup = await customerAuth.signUp({ async json() { return { email: `p10-${seq}@example.com`, password: 'correct-horse-battery', organizationName: name }; }, headers: { get: () => '203.0.113.30' } }, env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  return signup.organizationId;
}
/** A site with (or without) a tenant, in any status. */
async function site(env, orgId, { status = 'active', tenant = true, name } = {}) {
  seq += 1;
  const siteId = `p10-s-${seq}`; let tenantId = null;
  if (tenant) {
    tenantId = `p10-t-${seq}`;
    await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, ?, ?, ?)`, tenantId, `T${seq}`, `${tenantId}.example.test`, `https://${tenantId}.example.test`);
  }
  await run(env, `INSERT INTO sites (id, organization_id, name, slug, product_id, status, tenant_id) VALUES (?, ?, ?, ?, 'prod_casino_news', ?, ?)`, siteId, orgId, name || `Site ${seq}`, `p10-${seq}`, status, tenantId);
  return { siteId, tenantId };
}
/** A request row with explicit clock values (UTC, SQLite format). */
async function req(env, siteId, { status = 'failed', attempts = 1, requestedAt = '2026-01-01 00:00:00', updatedAt = requestedAt, kind = 'preset', preset = 'news', lastError = null } = {}) {
  const id = crypto.randomUUID();
  await run(env, `INSERT INTO site_setup_requests (id, site_id, kind, preset_id, status, attempts, last_error, requested_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, siteId, kind, kind === 'preset' ? preset : null, status, attempts, lastError, requestedAt, updatedAt);
  return id;
}
const T0 = Date.parse('2026-01-01T00:00:00Z');
const minutes = (m) => T0 + m * 60000;

function fakeTenants(script = {}) {
  const calls = [];
  const request = async (env, tenantOrId, { method, path, body }) => {
    const tenantId = typeof tenantOrId === 'string' ? tenantOrId : tenantOrId.id;
    calls.push({ tenantId, method, path, body });
    let answer = script[`${method} ${path.split('?')[0]}`];
    if (typeof answer === 'function') answer = answer({ tenantId, body });
    if (answer instanceof Error) throw answer;
    return answer || { ok: true, status: 200, data: { success: true, applied: true } };
  };
  request.calls = calls;
  return request;
}
const failure = (status, reason) => ({ ok: false, status, reason, message: 'x', meta: { data: { secret: 'must-not-be-stored' } } });
const SETUP = 'POST /en/api/super/site-setup';

// ------------------------------------------------------------------ repository SQL (never run before this file)

test('listCloneSources: only ACTIVE sites WITH a tenant of the asked organization, oldest first, names only', async () => {
  const env = makeEnv(); const a = await newOrg(env, 'A'); const b = await newOrg(env, 'B');
  const live1 = await site(env, a, { name: 'First' }); const live2 = await site(env, a, { name: 'Second' });
  await site(env, a, { status: 'pending', tenant: false, name: 'Pending' });
  await site(env, a, { status: 'suspended', name: 'Suspended' });
  await site(env, b, { name: 'Other org' });
  const rows = await repo.listCloneSources(env, a);
  assert.deepEqual(rows.map((r) => r.id).sort(), [live1.siteId, live2.siteId].sort());
  assert.ok(rows.every((r) => r.product_name), 'the product name is joined');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['id', 'name', 'product_name'], 'names only: nothing about the tenant leaves the query');
  assert.equal((await repo.listCloneSources(env, 'no-such-org')).length, 0);
});

test('latestRequestsForOrganization: the newest request of each site in one query; other organizations and deleted sites are not included', async () => {
  const env = makeEnv(); const a = await newOrg(env, 'A'); const b = await newOrg(env, 'B');
  const s1 = await site(env, a); const s2 = await site(env, a); const gone = await site(env, a, { status: 'deleted' }); const other = await site(env, b);
  await req(env, s1.siteId, { status: 'skipped', requestedAt: '2026-01-01 00:00:00' });
  const newest = await req(env, s1.siteId, { status: 'failed', requestedAt: '2026-01-02 00:00:00' });
  const only = await req(env, s2.siteId, { status: 'applied', attempts: 1 });
  await req(env, gone.siteId); await req(env, other.siteId);
  const rows = await repo.latestRequestsForOrganization(env, a);
  assert.deepEqual(rows.map((r) => r.id).sort(), [newest, only].sort());
  const views = await setup.getSetupViewsForOrganization(env, a);
  assert.deepEqual(Object.keys(views).sort(), [s1.siteId, s2.siteId].sort());
  assert.equal(views[s1.siteId].status, 'failed');
  assert.equal(views[s1.siteId].sourceTenantId, undefined, 'the customer view has no staff fields');
  assert.equal(views[s1.siteId].tenantId, undefined);
  assert.deepEqual(await setup.getSetupViewsForOrganization(env, 'no-such-org'), {});
});

test('listRetryCandidates: newest request only, pending or failed, under the cap, live site with a tenant, oldest update first, limited', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const s1 = await site(env, a); const s2 = await site(env, a); const s3 = await site(env, a);
  const capped = await site(env, a); const suspended = await site(env, a, { status: 'suspended' }); const maint = await site(env, a, { status: 'maintenance' });
  const noTenant = await site(env, a, { status: 'pending', tenant: false });
  const superseded = await req(env, s1.siteId, { status: 'failed', requestedAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' });
  const newest1 = await req(env, s1.siteId, { status: 'failed', requestedAt: '2026-01-02 00:00:00', updatedAt: '2026-01-02 00:00:00' });
  const old2 = await req(env, s2.siteId, { status: 'pending', attempts: 0, requestedAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' });
  await req(env, s3.siteId, { status: 'applied' });
  await req(env, capped.siteId, { status: 'failed', attempts: 6 });
  await req(env, suspended.siteId, { status: 'failed' }); await req(env, noTenant.siteId, { status: 'pending', attempts: 0 });
  const m = await req(env, maint.siteId, { status: 'failed', requestedAt: '2026-01-03 00:00:00', updatedAt: '2026-01-03 00:00:00' });
  const rows = await repo.listRetryCandidates(env, { maxAttempts: 6, limit: 50 });
  assert.deepEqual(rows.map((r) => r.id), [old2, newest1, m], 'oldest update first');
  assert.ok(!rows.some((r) => r.id === superseded), 'an older request of a site is never a candidate');
  assert.equal((await repo.listRetryCandidates(env, { maxAttempts: 6, limit: 2 })).length, 2);
  assert.ok(rows.every((r) => !('preset_id' in r) && !('sections' in r)), 'only what the sweep needs');
});

test('countByStatus and listRecentRequests: counts, give-ups, status filter, limit, site name', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const s1 = await site(env, a, { name: 'Alpha' }); const s2 = await site(env, a, { name: 'Beta' }); const s3 = await site(env, a);
  await req(env, s1.siteId, { status: 'failed', attempts: 6, requestedAt: '2026-01-01 00:00:00' });
  await req(env, s2.siteId, { status: 'failed', attempts: 2, requestedAt: '2026-01-02 00:00:00' });
  await req(env, s3.siteId, { status: 'applied', attempts: 1, requestedAt: '2026-01-03 00:00:00' });
  assert.deepEqual(await repo.countByStatus(env, 6), { byStatus: { failed: 2, applied: 1 }, gaveUp: 1 });
  const overview = await setup.getSetupOverview(env);
  assert.equal(overview.gaveUp, 1); assert.equal(overview.sweep.maxAttempts, 6); assert.equal(overview.sweep.enabled, true);
  const all = await setup.listRecentSetupRequests(env);
  assert.deepEqual(all.map((r) => r.status), ['applied', 'failed', 'failed'], 'newest first');
  assert.equal(all[2].siteName, 'Alpha'); assert.equal(all[2].gaveUp, true); assert.equal(all[1].gaveUp, false);
  assert.deepEqual((await setup.listRecentSetupRequests(env, { status: 'failed' })).map((r) => r.siteName), ['Beta', 'Alpha']);
  assert.equal((await setup.listRecentSetupRequests(env, { status: 'bogus' })).length, 3, 'an unknown status filter is ignored, not injected');
  assert.equal((await setup.listRecentSetupRequests(env, { limit: 1 })).length, 1);
  assert.equal((await setup.listRecentSetupRequests(env, { limit: 'x' })).length, 3);
});

// ------------------------------------------------------------------ tenant 409 config_system_off

test('tenant 409 config_system_off ends the request as skipped, with that code, and it is never retried', async () => {
  const env = makeEnv(); const a = await newOrg(env); const s = await site(env, a);
  const id = await req(env, s.siteId, { status: 'pending', attempts: 0 });
  const tenant = fakeTenants({ [SETUP]: failure(409, 'config_system_off') });
  const r = await setup.applySetup(env, id, { request: tenant });
  assert.equal(r.status, 'skipped'); assert.equal(r.ok, true);
  const row = await one(env, `SELECT status, last_error, attempts FROM site_setup_requests WHERE id = ?`, id);
  assert.deepEqual({ ...row }, { status: 'skipped', last_error: 'config_system_off', attempts: 1 });
  assert.deepEqual([...setup.SKIP_REASONS].sort(), ['already_configured', 'config_system_off', 'setup_not_pending']);
  const again = await setup.applySetup(env, id, { request: tenant });
  assert.equal(again.alreadyDone, true); assert.equal(tenant.calls.length, 1, 'a skipped request does not call the tenant again');
  const sweep = await setup.sweepSetupRetries(env, { request: tenant, now: minutes(100000) });
  assert.equal(sweep.due, 0); assert.equal(tenant.calls.length, 1);
  assert.equal((await setup.retrySetup(env, s.siteId, { request: tenant })).httpStatus, 409, 'a customer retry says there is nothing to retry');
  // another 409 code is NOT a skip: it is a failure with its code
  const id2 = await req(env, (await site(env, a)).siteId, { status: 'pending', attempts: 0 });
  const odd = await setup.applySetup(env, id2, { request: fakeTenants({ [SETUP]: failure(409, 'something_else') }) });
  assert.equal(odd.status, 'failed'); assert.match(odd.error, /something_else/);
});

// ------------------------------------------------------------------ backoff

test('backoffMinutes: grace, then 5, 10, 20, 40, 80, capped at 6 hours; isDue follows it', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(setup.backoffMinutes), [10, 5, 10, 20, 40, 80]);
  assert.equal(setup.backoffMinutes(12), 360); assert.equal(setup.backoffMinutes(40), 360); assert.equal(setup.backoffMinutes('x'), 10);
  const never = { status: 'pending', attempts: 0, requested_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 00:00:00' };
  assert.equal(setup.isDue(never, minutes(9)), false); assert.equal(setup.isDue(never, minutes(10)), true);
  const second = { status: 'failed', attempts: 1, requested_at: '2026-01-01 00:00:00', updated_at: '2026-01-01 01:00:00' };
  assert.equal(setup.isDue(second, minutes(60 + 4)), false); assert.equal(setup.isDue(second, minutes(60 + 5)), true);
  assert.equal(setup.isDue({ ...second, attempts: 6 }, minutes(100000)), false, 'the cap');
  assert.equal(setup.isDue({ ...second, status: 'applied' }, minutes(100000)), false);
  assert.equal(setup.isDue({ ...second, status: 'skipped' }, minutes(100000)), false);
  assert.equal(setup.isDue({ ...second, updated_at: 'not a date' }, minutes(100000)), false, 'an unreadable time is never guessed');
  assert.equal(setup.isDue(null), false);
});

// ------------------------------------------------------------------ the sweep

test('sweep: waits for the backoff, then applies; a never-attempted request waits the grace period', async () => {
  const env = makeEnv(); const a = await newOrg(env); const s = await site(env, a);
  const id = await req(env, s.siteId, { status: 'pending', attempts: 0 });
  const tenant = fakeTenants();
  assert.equal((await setup.sweepSetupRetries(env, { request: tenant, now: minutes(9) })).due, 0);
  assert.equal(tenant.calls.length, 0);
  const done = await setup.sweepSetupRetries(env, { request: tenant, now: minutes(11) });
  assert.deepEqual({ looked: done.looked, due: done.due, applied: done.applied, failed: done.failed }, { looked: 1, due: 1, applied: 1, failed: 0 });
  assert.equal((await one(env, `SELECT status FROM site_setup_requests WHERE id = ?`, id)).status, 'applied');
  assert.equal((await setup.sweepSetupRetries(env, { request: tenant, now: minutes(500) })).looked, 0, 'applied is final');
});

test('sweep: a failing request backs off 5, 10, 20, 40, 80 minutes and stops after 6 attempts, staying failed', async () => {
  const env = makeEnv(); const a = await newOrg(env); const s = await site(env, a);
  const id = await req(env, s.siteId, { status: 'pending', attempts: 0 });
  const tenant = fakeTenants({ [SETUP]: failure(502, 'unavailable') });
  let clock = minutes(10);
  const waits = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const before = tenant.calls.length;
    const r = await setup.sweepSetupRetries(env, { request: tenant, now: clock });
    assert.equal(r.failed, 1, `attempt ${attempt}`); assert.equal(tenant.calls.length, before + 1);
    // the row now says when it was last tried (SQLite CURRENT_TIMESTAMP is real time); move that into the test clock
    await run(env, `UPDATE site_setup_requests SET updated_at = ? WHERE id = ?`, new Date(clock).toISOString().slice(0, 19).replace('T', ' '), id);
    const row = await one(env, `SELECT attempts FROM site_setup_requests WHERE id = ?`, id);
    assert.equal(row.attempts, attempt);
    if (attempt < 6) {
      const wait = setup.backoffMinutes(attempt); waits.push(wait);
      assert.equal((await setup.sweepSetupRetries(env, { request: tenant, now: clock + (wait - 1) * 60000 })).due, 0, `too early after attempt ${attempt}`);
      clock += wait * 60000;
    }
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 80]);
  const calls = tenant.calls.length;
  const final = await setup.sweepSetupRetries(env, { request: tenant, now: clock + 10 * 86400000 });
  assert.equal(final.looked, 0); assert.equal(tenant.calls.length, calls, 'attempt 7 never happens');
  const row = await one(env, `SELECT status, attempts, last_error FROM site_setup_requests WHERE id = ?`, id);
  assert.equal(row.status, 'failed'); assert.equal(row.attempts, 6); assert.match(row.last_error, /unavailable/);
  assert.equal((await setup.listRecentSetupRequests(env))[0].gaveUp, true);
  // staff or the customer can still retry by hand
  const manual = await setup.retrySetup(env, s.siteId, { request: fakeTenants() });
  assert.equal(manual.ok, true); assert.equal(manual.status, 'applied');
});

test('sweep: SETUP_RETRY_SWEEP=off (and its spellings) does nothing; any other value or none means on', async () => {
  const a0 = makeEnv(); const org = await newOrg(a0); const s = await site(a0, org); await req(a0, s.siteId, { status: 'pending', attempts: 0 });
  for (const off of ['off', 'OFF', ' 0 ', 'false', 'disabled', 'no']) {
    const env = { ...a0, SETUP_RETRY_SWEEP: off }; const tenant = fakeTenants();
    const r = await setup.sweepSetupRetries(env, { request: tenant, now: minutes(1000) });
    assert.equal(r.enabled, false, off); assert.equal(tenant.calls.length, 0, off);
  }
  for (const on of [undefined, '', 'on', 'yes', 'whatever']) {
    assert.equal(setup.sweepEnabled({ SETUP_RETRY_SWEEP: on }), true, String(on));
  }
  assert.equal(setup.sweepEnabled(undefined), true);
  assert.equal((await setup.getSetupOverview({ ...a0, SETUP_RETRY_SWEEP: 'off' })).sweep.enabled, false);
});

test('sweep: only the NEWEST request of a site is retried, and a site that is not live is ignored', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const s = await site(env, a); const susp = await site(env, a, { status: 'suspended' }); const deleted = await site(env, a, { status: 'deleted' }); const noTenant = await site(env, a, { status: 'pending', tenant: false });
  const oldFailed = await req(env, s.siteId, { status: 'failed', preset: 'news', requestedAt: '2026-01-01 00:00:00', updatedAt: '2026-01-01 00:00:00' });
  const newest = await req(env, s.siteId, { status: 'failed', preset: 'static', requestedAt: '2026-01-02 00:00:00', updatedAt: '2026-01-02 00:00:00' });
  for (const x of [susp, deleted, noTenant]) await req(env, x.siteId, { status: 'failed', requestedAt: '2026-01-01 00:00:00' });
  const tenant = fakeTenants();
  const r = await setup.sweepSetupRetries(env, { request: tenant, now: minutes(60 * 24 * 30) });
  assert.equal(r.due, 1); assert.equal(tenant.calls.length, 1);
  assert.deepEqual(tenant.calls[0].body, { preset: 'static' }, 'the newest request, not the older one');
  assert.equal((await one(env, `SELECT status FROM site_setup_requests WHERE id = ?`, newest)).status, 'applied');
  assert.equal((await one(env, `SELECT status FROM site_setup_requests WHERE id = ?`, oldFailed)).status, 'failed', 'the older request is left alone');
  for (const x of [susp, deleted, noTenant]) assert.equal((await one(env, `SELECT attempts FROM site_setup_requests WHERE site_id = ?`, x.siteId)).attempts, 1, 'never attempted by the sweep');
});

test('sweep: at most 5 per run (oldest first); the rest wait for the next run', async () => {
  const env = makeEnv(); const a = await newOrg(env); const ids = [];
  for (let i = 0; i < 8; i++) { const s = await site(env, a); ids.push(await req(env, s.siteId, { status: 'pending', attempts: 0, requestedAt: `2026-01-01 00:0${i}:00`, updatedAt: `2026-01-01 00:0${i}:00` })); }
  const tenant = fakeTenants();
  const r1 = await setup.sweepSetupRetries(env, { request: tenant, now: minutes(120) });
  assert.equal(r1.looked, 8); assert.equal(r1.due, 5); assert.equal(r1.applied, 5);
  const r2 = await setup.sweepSetupRetries(env, { request: tenant, now: minutes(125) });
  assert.equal(r2.due, 3); assert.equal(r2.applied, 3);
  assert.equal((await setup.sweepSetupRetries(env, { request: tenant, now: minutes(130) })).looked, 0);
});

test('sweep: one failing or crashing site never stops the run; counts are right', async () => {
  const env = makeEnv(); const a = await newOrg(env);
  const ok1 = await site(env, a); const boom = await site(env, a); const bad = await site(env, a); const ok2 = await site(env, a);
  for (const [i, x] of [ok1, boom, bad, ok2].entries()) await req(env, x.siteId, { status: 'pending', attempts: 0, requestedAt: `2026-01-01 00:0${i}:00`, updatedAt: `2026-01-01 00:0${i}:00` });
  const request = async (e, tenantId, o) => {
    if (tenantId === boom.tenantId) throw new Error('network exploded with a secret token=abc123');
    if (tenantId === bad.tenantId) return failure(500, 'tenant_error');
    return { ok: true, status: 200, data: { success: true } };
  };
  const r = await setup.sweepSetupRetries(env, { request, now: minutes(60) });
  assert.deepEqual({ due: r.due, applied: r.applied, failed: r.failed }, { due: 4, applied: 2, failed: 2 });
  assert.equal(r.error, undefined);
  const status = async (x) => one(env, `SELECT status, last_error FROM site_setup_requests WHERE site_id = ?`, x.siteId);
  assert.equal((await status(ok1)).status, 'applied'); assert.equal((await status(ok2)).status, 'applied');
  assert.equal((await status(boom)).last_error, 'internal_error', 'a thrown error is stored as a code, never its text');
});

test('sweep: a broken database read is reported as sweep_failed and never thrown', async () => {
  const env = { SETUP_RETRY_SWEEP: 'on', LUMMET_DB: { prepare() { throw new Error('db down'); } } };
  const r = await setup.sweepSetupRetries(env, { request: fakeTenants() });
  assert.equal(r.error, 'sweep_failed'); assert.equal(r.applied, 0);
  assert.equal((await setup.sweepSetupRetries(undefined)).enabled, true);
});

test('nothing secret is stored: a failed request keeps a short code and the HTTP status, never a tenant body or an envelope', async () => {
  const env = makeEnv(); const a = await newOrg(env); const s = await site(env, a);
  await req(env, s.siteId, { status: 'pending', attempts: 0 });
  await setup.sweepSetupRetries(env, { request: fakeTenants({ [SETUP]: failure(500, 'tenant_error') }), now: minutes(60) });
  const rows = (await env.LUMMET_DB.prepare(`SELECT * FROM site_setup_requests`).all()).results;
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes('must-not-be-stored')); assert.ok(!/envelope|secret|token/i.test(dump));
  assert.match(rows[0].last_error, /^[a-z0-9_]+ \(HTTP \d+\)$/);
});

// ------------------------------------------------------------------ the picker (A1 data)

test('getSetupOptions: all presets, the default that applies, and only this organization\'s active sites', async () => {
  const env = makeEnv(); const a = await newOrg(env, 'A'); const b = await newOrg(env, 'B');
  const mine = await site(env, a, { name: 'Mine' }); await site(env, a, { status: 'suspended', name: 'Gone' }); const theirs = await site(env, b, { name: 'Theirs' });
  const o = await setup.getSetupOptions(env, { organizationId: a, productId: 'prod_casino_news' });
  assert.equal(o.presets.length, 8); assert.deepEqual(o.presets[0], { id: 'full', label: 'Full platform' });
  assert.deepEqual(o.default, { presetId: 'full', label: 'Full platform', source: 'fallback' });
  assert.deepEqual(o.cloneSources.map((c) => c.id), [mine.siteId]);
  assert.ok(!JSON.stringify(o).includes(theirs.siteId) && !JSON.stringify(o).includes('Theirs'));
  await setup.setDefault(env, { scopeKind: 'product', scopeId: 'prod_casino_news', presetId: 'casino-list' });
  assert.deepEqual((await setup.getSetupOptions(env, { organizationId: a, productId: 'prod_casino_news' })).default, { presetId: 'casino-list', label: 'Casino listing only', source: 'product' });
  await setup.setDefault(env, { scopeKind: 'plan', scopeId: 'plan_casino_news_starter', presetId: 'news' });
  assert.equal((await setup.getSetupOptions(env, { organizationId: a })).default.source, 'plan');
  assert.deepEqual((await setup.getSetupOptions(env, {})).cloneSources, [], 'no organization, no sources');
});

// ------------------------------------------------------------------ master switch (B7), read-only

test('getSiteSystem: reads the tenant switch, never changes it; an older tenant is "not updated"; bad answers are refused', async () => {
  const env = makeEnv(); const a = await newOrg(env); const s = await site(env, a); const pend = await site(env, a, { status: 'pending', tenant: false });
  const GET = 'GET /en/api/super/site-system';
  const on = fakeTenants({ [GET]: { ok: true, status: 200, data: { success: true, system: { enabled: true, source: 'default', envOverride: false, env: null, setting: null } } } });
  assert.deepEqual(await setup.getSiteSystem(env, s.siteId, { request: on }), { ok: true, system: { enabled: true, source: 'default', envOverride: false } });
  assert.deepEqual(on.calls.map((c) => `${c.method} ${c.path}`), [GET], 'one read-only call');
  const off = fakeTenants({ [GET]: { ok: true, status: 200, data: { system: { enabled: false, source: 'env', envOverride: true, extra: 'ignored' } } } });
  assert.deepEqual((await setup.getSiteSystem(env, s.siteId, { request: off })).system, { enabled: false, source: 'env', envOverride: true });
  assert.equal((await setup.getSiteSystem(env, s.siteId, { request: fakeTenants({ [GET]: { ok: true, status: 200, data: { system: { enabled: 'yes', source: 'weird' } } } }) })).error, 'unexpected_answer');
  assert.equal((await setup.getSiteSystem(env, s.siteId, { request: fakeTenants({ [GET]: { ok: true, status: 200, data: { system: { enabled: true, source: 'weird' } } } }) })).system.source, 'unknown');
  for (const st of [404, 405, 501]) {
    const r = await setup.getSiteSystem(env, s.siteId, { request: fakeTenants({ [GET]: failure(st, 'not_found') }) });
    assert.deepEqual({ ok: r.ok, httpStatus: r.httpStatus, error: r.error }, { ok: false, httpStatus: 409, error: 'tenant_not_updated' }, String(st));
  }
  const down = await setup.getSiteSystem(env, s.siteId, { request: fakeTenants({ [GET]: failure(502, 'unavailable') }) });
  assert.equal(down.httpStatus, 502); assert.match(down.error, /unavailable/); assert.ok(!JSON.stringify(down).includes('must-not-be-stored'));
  assert.equal((await setup.getSiteSystem(env, 'nope', { request: on })).httpStatus, 404);
  assert.equal((await setup.getSiteSystem(env, pend.siteId, { request: on })).error, 'site_has_no_tenant');
  assert.equal((await setup.getSiteSystem(env, s.siteId, { request: async () => { throw new Error('boom'); } })).error, 'internal_error');
});
