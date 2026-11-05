// Phase 10 A4 (hooks) and the double-driver decision. The retry sweep runs from TWO drivers: the 5 minute tick
// (worker.scheduled, TICK_CRON) and POST /api/ops/alert-check. Both reach the tenant only through env.SETUP_TENANT_REQUEST here.
// Decision: bumpAttempts is a compare-and-swap on updated_at, so two drivers that picked the same request count ONE attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as scheduler from '../worker/scheduler.js';
import * as setup from '../worker/site-setup.js';
import * as repo from '../worker/repositories/site-setup.js';

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ALERT_CHECK_TOKEN: 'hook-token-value', ...extra };
}
const run = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).run();
const one = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).first();
function fakeCtx() { const ps = []; return { waitUntil(p) { ps.push(Promise.resolve(p).catch(() => {})); }, done: () => Promise.all(ps) }; }

let seq = 0;
/** An active site with a tenant and a stale request (2020, so the real-clock sweep finds it due). */
async function staleSite(env, { status = 'pending', attempts = 0 } = {}) {
  seq += 1;
  const tenantId = `hk-t-${seq}`; const siteId = `hk-s-${seq}`; const orgId = `hk-o-${seq}`;
  await run(env, `INSERT INTO organizations (id, name, slug, status) VALUES (?, ?, ?, 'active')`, orgId, `Org ${seq}`, `hk-org-${seq}`);
  await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, ?, ?, ?)`, tenantId, `T${seq}`, `${tenantId}.example.test`, `https://${tenantId}.example.test`);
  await run(env, `INSERT INTO sites (id, organization_id, name, slug, product_id, status, tenant_id) VALUES (?, ?, ?, ?, 'prod_casino_news', 'active', ?)`, siteId, orgId, `Site ${seq}`, `hk-${seq}`, tenantId);
  const id = crypto.randomUUID();
  await run(env, `INSERT INTO site_setup_requests (id, site_id, kind, preset_id, status, attempts, requested_at, updated_at) VALUES (?, ?, 'preset', 'news', ?, ?, '2020-01-01 00:00:00', '2020-01-01 00:00:00')`, id, siteId, status, attempts);
  return { id, siteId, tenantId };
}
function tenantStub(answer) {
  const calls = [];
  const f = async (_env, tenantOrId, { method, path, body }) => { calls.push({ tenantId: typeof tenantOrId === 'string' ? tenantOrId : tenantOrId.id, method, path, body }); return answer || { ok: true, status: 200, data: { success: true } }; };
  f.calls = calls; return f;
}
const status = (env, id) => one(env, `SELECT status, attempts, last_error FROM site_setup_requests WHERE id = ?`, id);
async function alertCheck(env, method = 'POST') {
  const ctx = fakeCtx();
  const res = await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method, headers: { Authorization: 'Bearer hook-token-value', 'CF-Connecting-IP': '203.0.113.9' } }), env, ctx);
  await ctx.done();
  return res;
}
async function tick(env) { const c = fakeCtx(); await worker.scheduled({ cron: scheduler.TICK_CRON }, env, c); await c.done(); }

// ------------------------------------------------------------------ the two hooks

test('tick: worker.scheduled(TICK_CRON) applies a stale pending request through env.SETUP_TENANT_REQUEST', async () => {
  const t = tenantStub(); const env = makeEnv({ SETUP_TENANT_REQUEST: t });
  const r = await staleSite(env);
  await tick(env);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].tenantId, r.tenantId);
  assert.equal(t.calls[0].method, 'POST');
  assert.equal(t.calls[0].path, '/en/api/super/site-setup');
  assert.deepEqual(t.calls[0].body, { preset: 'news' });
  const row = await status(env, r.id);
  assert.equal(row.status, 'applied'); assert.equal(row.attempts, 1);
});

test('tick: SETUP_RETRY_SWEEP=off leaves the stale request pending and calls no tenant', async () => {
  for (const off of ['off', 'OFF', '0', 'false', 'disabled', 'no']) {
    const t = tenantStub(); const env = makeEnv({ SETUP_TENANT_REQUEST: t, SETUP_RETRY_SWEEP: off });
    const r = await staleSite(env);
    await tick(env);
    assert.equal(t.calls.length, 0, `off spelling ${off}`);
    const row = await status(env, r.id);
    assert.equal(row.status, 'pending'); assert.equal(row.attempts, 0);
  }
});

test('tick: a failing tenant leaves the request failed with a short code, and the tick still finishes', async () => {
  const t = tenantStub({ ok: false, status: 503, reason: 'tenant_unavailable', meta: { data: { secret: 'must-not-be-stored' } } });
  const env = makeEnv({ SETUP_TENANT_REQUEST: t });
  const r = await staleSite(env);
  await tick(env);
  const row = await status(env, r.id);
  assert.equal(row.status, 'failed'); assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'tenant_unavailable (HTTP 503)');
  assert.ok(!JSON.stringify(row).includes('must-not-be-stored'));
});

test('alert-check: POST with the token applies a stale pending request; GET too; the answer still has the normal shape', async () => {
  const t = tenantStub(); const env = makeEnv({ SETUP_TENANT_REQUEST: t });
  const r = await staleSite(env);
  const res = await alertCheck(env, 'POST');
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.success, true);
  assert.equal(t.calls.length, 1);
  assert.equal((await status(env, r.id)).status, 'applied');
  const r2 = await staleSite(env);
  assert.equal((await alertCheck(env, 'GET')).status, 200);
  assert.equal((await status(env, r2.id)).status, 'applied');
});

test('alert-check: without the token it is 404 and nothing is applied; SETUP_RETRY_SWEEP=off leaves the request', async () => {
  const t = tenantStub(); const env = makeEnv({ SETUP_TENANT_REQUEST: t });
  const r = await staleSite(env);
  const ctx = fakeCtx();
  const res = await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.9' } }), env, ctx);
  await ctx.done();
  assert.equal(res.status, 404);
  assert.equal(t.calls.length, 0);
  assert.equal((await status(env, r.id)).status, 'pending');

  const t2 = tenantStub(); const env2 = makeEnv({ SETUP_TENANT_REQUEST: t2, SETUP_RETRY_SWEEP: 'off' });
  const r2 = await staleSite(env2);
  assert.equal((await alertCheck(env2)).status, 200);
  assert.equal(t2.calls.length, 0);
  assert.equal((await status(env2, r2.id)).status, 'pending');
});

// ------------------------------------------------------------------ double driver: one attempt, not two

test('repository bumpAttempts: with expectedUpdatedAt it counts once; a second driver holding the same value is refused; without it, it always counts', async () => {
  const env = makeEnv(); const r = await staleSite(env);
  assert.equal(await repo.bumpAttempts(env, r.id, '2020-01-01 00:00:00'), true);
  assert.equal(await repo.bumpAttempts(env, r.id, '2020-01-01 00:00:00'), false, 'updated_at moved, so the old value no longer matches');
  assert.equal((await status(env, r.id)).attempts, 1);
  assert.equal(await repo.bumpAttempts(env, r.id), true, 'deploy and manual retry pass nothing and always count');
  assert.equal((await status(env, r.id)).attempts, 2);
  assert.equal(await repo.bumpAttempts(env, 'no-such-request', '2020-01-01 00:00:00'), false);
});

test('repository bumpAttempts: an applied or skipped request is never bumped by a driver holding an old value', async () => {
  const env = makeEnv(); const r = await staleSite(env, { status: 'applied' });
  assert.equal(await repo.bumpAttempts(env, r.id, '2020-01-01 00:00:00'), false);
  assert.equal((await status(env, r.id)).attempts, 0);
});

test('two drivers on the same request: the second one steps aside as "busy", the tenant is called once and attempts is 1', async () => {
  const env = makeEnv(); const t = tenantStub(); const r = await staleSite(env);
  const first = await setup.applySetup(env, r.id, { request: t, expectedUpdatedAt: '2020-01-01 00:00:00' });
  assert.equal(first.status, 'applied');
  // The second driver read the same row before the first one wrote; the request is applied by now, so it is answered as done.
  const second = await setup.applySetup(env, r.id, { request: t, expectedUpdatedAt: '2020-01-01 00:00:00' });
  assert.equal(second.ok, true); assert.equal(second.alreadyDone, true);
  assert.equal(t.calls.length, 1);
  assert.equal((await status(env, r.id)).attempts, 1);
});

test('two drivers racing on a request that fails: only one counts the attempt and calls the tenant', async () => {
  const env = makeEnv(); const fail = tenantStub({ ok: false, status: 502, reason: 'bad_gateway' }); const r = await staleSite(env);
  const [a, b] = await Promise.all([
    setup.applySetup(env, r.id, { request: fail, expectedUpdatedAt: '2020-01-01 00:00:00' }),
    setup.applySetup(env, r.id, { request: fail, expectedUpdatedAt: '2020-01-01 00:00:00' })
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, ['busy', 'failed']);
  assert.equal(fail.calls.length, 1, 'the loser never calls the tenant');
  const row = await status(env, r.id);
  assert.equal(row.attempts, 1); assert.equal(row.status, 'failed');
});

test('two sweeps at once (tick + alert-check): one applies, the other reports busy or already done; the tenant is called once; attempts is 1', async () => {
  const env = makeEnv(); const t = tenantStub(); const r = await staleSite(env);
  const [x, y] = await Promise.all([setup.sweepSetupRetries(env, { request: t }), setup.sweepSetupRetries(env, { request: t })]);
  assert.equal(t.calls.length, 1);
  assert.equal(x.failed + y.failed, 0, 'stepping aside is never counted as a failure');
  assert.equal(x.applied + y.applied + x.busy + y.busy >= 1, true);
  const row = await status(env, r.id);
  assert.equal(row.attempts, 1); assert.equal(row.status, 'applied');
});

test('the swap does not affect a manual retry or the deploy path: they pass no expected value and always run', async () => {
  const env = makeEnv(); const t = tenantStub(); const r = await staleSite(env, { status: 'failed', attempts: 2 });
  const manual = await setup.retrySetup(env, r.siteId, { request: t });
  assert.equal(manual.ok, true);
  assert.equal((await status(env, r.id)).attempts, 3);
  const r2 = await staleSite(env);
  const deploy = await setup.applyPendingSetupForSite(env, r2.siteId, { request: t });
  assert.equal(deploy.attempted, true); assert.equal(deploy.status, 'applied');
});

test('sweep summary has a busy counter (0 when nothing was contended)', async () => {
  const env = makeEnv();
  const s = await setup.sweepSetupRetries(env, { request: tenantStub() });
  assert.equal(s.busy, 0);
  assert.equal((await setup.sweepSetupRetries(makeEnv({ SETUP_RETRY_SWEEP: 'off' }))).enabled, false);
});
