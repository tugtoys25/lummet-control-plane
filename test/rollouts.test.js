// Tenant release rollouts (v1.2): deploy the active release to every live site, one at a time, stopping on failure.
// Real schema + the real deployment engine, with a fake Cloudflare provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService, __setInfraProviderForTests } from '../worker/deployments.js';
import * as jobRunner from '../worker/job-runner.js';
import * as rollouts from '../worker/rollouts.js';
import * as template from '../worker/tenant-template.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';

function fakeR2() {
  const m = new Map();
  return { async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; } };
}
function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') };
}
const signup = (email) => ({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.20' } });
let n = 0;
async function newSite(env, infra) {
  const s = await customerAuth.signUp(signup(`rollout${++n}@example.com`), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: s.organizationId, name: 'Site ' + n, productId: 'prod_casino_news', actorUserId: s.userId });
  const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra), templateService: template });
  const start = await prov.startProvisioning(env, site.siteId);
  const run = await prov.runJob(env, start.jobId);
  assert.equal(run.ok, true, JSON.stringify(run));
  return site.siteId;
}
const publish = (env, version, code = `export default {/*${version}*/}`) => template.publishRelease(env, { version, scriptContent: code, migrations: [] });
const versionOf = async (env, id) => (await sites.getSite(env, id)).app_version;
const count = async (env, sql, ...b) => (await env.LUMMET_DB.prepare(sql).bind(...b).first()).n;

async function fleet(t, size) {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv();
  assert.ok((await publish(env, '1.0.0')).ok);
  const ids = []; for (let i = 0; i < size; i++) ids.push(await newSite(env, infra));
  for (const id of ids) assert.equal(await versionOf(env, id), '1.0.0');
  assert.ok((await publish(env, '2.0.0')).ok); // becomes the active release
  const uploads = () => infra._calls.filter((c) => c.method === 'uploadWorkerScript' && c.scriptContent.includes('2.0.0')).length;
  // dispatch that runs the deployment job to completion before returning
  const dispatch = (jobId) => jobRunner.runJobById(env, jobId);
  return { infra, env, ids, uploads, dispatch };
}

test('a rollout deploys the active release to every live site, one at a time, and completes', async (t) => {
  const { env, ids, uploads, dispatch } = await fleet(t, 3);
  const started = await rollouts.startRollout(env, { startedBy: 'admin:1' });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.total, 3); assert.equal(started.version, '2.0.0');
  assert.equal(uploads(), 0, 'starting a rollout deploys nothing by itself');

  let seen = [];
  for (let i = 0; i < 12; i++) {
    const r = await rollouts.advanceRollout(env, started.rolloutId, { dispatch });
    seen.push(r.status);
    assert.ok(r.counts.running <= 1, 'never more than one site in flight');
    if (r.done) break;
  }
  assert.equal(seen[seen.length - 1], 'completed');
  for (const id of ids) assert.equal(await versionOf(env, id), '2.0.0');
  assert.equal(uploads(), 3);
  const row = await env.LUMMET_DB.prepare(`SELECT status, completed_at FROM tenant_rollouts WHERE id = ?`).bind(started.rolloutId).first();
  assert.equal(row.status, 'completed'); assert.ok(row.completed_at);
});

test('the next site is not started until the previous deployment has finished', async (t) => {
  const { env, ids, uploads } = await fleet(t, 3);
  const queued = []; const dispatch = async (jobId) => { queued.push(jobId); }; // jobs are created but do not run yet
  const s = await rollouts.startRollout(env, {});
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  for (let i = 0; i < 5; i++) await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(queued.length, 1, 'while the first deployment is unfinished, no second one is started');
  assert.equal(await count(env, `SELECT COUNT(*) n FROM deployments WHERE version = '2.0.0'`), 1);
  await jobRunner.runJobById(env, queued[0]); // the first finishes
  const after = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(queued.length, 2, 'now the second one starts');
  assert.equal(after.counts.succeeded, 1);
  assert.equal(uploads(), 1);
  assert.equal(ids.length, 3);
});

test('a failed deployment stops the rollout: the remaining sites are not touched, and the failed site keeps serving', async (t) => {
  const { infra, env, ids, dispatch } = await fleet(t, 3);
  const s = await rollouts.startRollout(env, {});
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch });          // starts + runs the first site
  infra._failNextCall('uploadWorkerScript', 'cloudflare said no');
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch });          // first one succeeded; the second starts and fails
  const r = await rollouts.advanceRollout(env, s.rolloutId, { dispatch }); // sees the failure
  assert.equal(r.status, 'failed'); assert.equal(r.done, true);
  assert.match(r.error, /cloudflare said no/);
  assert.equal(r.counts.succeeded, 1); assert.equal(r.counts.failed, 1); assert.equal(r.counts.pending, 1);
  const by = (st) => rollouts.getRollout(env, s.rolloutId).then((x) => x.items.find((i) => i.status === st).site_id);
  const [okSite, badSite, untouched] = [await by('succeeded'), await by('failed'), await by('pending')];
  assert.equal(await versionOf(env, okSite), '2.0.0');
  assert.equal(await versionOf(env, badSite), '1.0.0', 'the failed site still runs the old version');
  assert.equal((await sites.getSite(env, badSite)).status, 'active', 'and stays active');
  assert.equal(await versionOf(env, untouched), '1.0.0', 'the remaining site was never touched');
  assert.equal(await count(env, `SELECT COUNT(*) n FROM deployments WHERE site_id = ? AND version = '2.0.0'`, untouched), 0);
  assert.deepEqual([okSite, badSite, untouched].sort(), [...ids].sort());
  const again = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(again.status, 'failed', 'further calls do nothing');
  assert.equal(await count(env, `SELECT COUNT(*) n FROM deployments WHERE version = '2.0.0'`), 2);
});

test('resume retries the failed site with a new deployment and carries on to the end', async (t) => {
  const { infra, env, ids, dispatch } = await fleet(t, 3);
  const s = await rollouts.startRollout(env, {});
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  infra._failNextCall('uploadWorkerScript', 'transient');
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal((await rollouts.advanceRollout(env, s.rolloutId, { dispatch })).status, 'failed');
  const resumed = await rollouts.resumeRollout(env, s.rolloutId);
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  for (let i = 0; i < 12; i++) { const r = await rollouts.advanceRollout(env, s.rolloutId, { dispatch }); if (r.done) break; }
  for (const id of ids) assert.equal(await versionOf(env, id), '2.0.0');
  assert.equal((await rollouts.getRollout(env, s.rolloutId)).status, 'completed');
  assert.equal((await rollouts.resumeRollout(env, s.rolloutId)).status, 409, 'only a failed rollout can be resumed');
});

test('sites already on the version, and sites that are not live, are skipped and never touched', async (t) => {
  const { env, ids, dispatch } = await fleet(t, 4);
  await env.LUMMET_DB.prepare(`UPDATE sites SET app_version = '2.0.0' WHERE id = ?`).bind(ids[0]).run();           // already current
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'suspended' WHERE id = ?`).bind(ids[1]).run();            // not live
  const s = await rollouts.startRollout(env, {});
  assert.equal(s.total, 2, 'only the two live, outdated sites are counted');
  for (let i = 0; i < 10; i++) { const r = await rollouts.advanceRollout(env, s.rolloutId, { dispatch }); if (r.done) break; }
  assert.equal(await versionOf(env, ids[1]), '1.0.0');
  assert.equal(await count(env, `SELECT COUNT(*) n FROM deployments WHERE site_id = ? AND version = '2.0.0'`, ids[1]), 0);
  assert.equal(await versionOf(env, ids[2]), '2.0.0'); assert.equal(await versionOf(env, ids[3]), '2.0.0');
  const items = (await rollouts.getRollout(env, s.rolloutId)).items;
  assert.equal(items.length, 3, 'the suspended site is not part of the rollout at all');
  const skipped = items.filter((i) => i.status === 'skipped');
  assert.equal(skipped.length, 1, 'the up-to-date site is listed, as skipped');
  assert.equal(skipped[0].detail, 'already_on_version');
});

test('only one rollout can run at a time; a finished one does not block the next', async (t) => {
  const { env, dispatch } = await fleet(t, 2);
  const a = await rollouts.startRollout(env, {});
  const b = await rollouts.startRollout(env, {});
  assert.equal(b.ok, false); assert.equal(b.status, 409); assert.equal(b.error, 'rollout_in_progress'); assert.equal(b.rolloutId, a.rolloutId);
  for (let i = 0; i < 10; i++) { if ((await rollouts.advanceRollout(env, a.rolloutId, { dispatch })).done) break; }
  const c = await rollouts.startRollout(env, {});
  assert.equal(c.ok, true); assert.equal(c.nothingToDo, true, 'everyone is current, so there is nothing to do');
  assert.equal(c.status, 'completed');
});

test('two advancers at the same moment deploy a site once, not twice', async (t) => {
  const { env, uploads, dispatch } = await fleet(t, 2);
  const s = await rollouts.startRollout(env, {});
  const results = await Promise.all([1, 2, 3, 4].map(() => rollouts.advanceRollout(env, s.rolloutId, { dispatch })));
  assert.ok(results.some((r) => r.busy), 'at least one caller was turned away by the lock');
  assert.equal(await count(env, `SELECT COUNT(*) n FROM deployments WHERE version = '2.0.0'`), 1);
  assert.equal(uploads(), 1);
});

test('a lock left by a dead Worker expires, so the rollout is never stuck', async (t) => {
  const { env, dispatch } = await fleet(t, 1);
  const s = await rollouts.startRollout(env, {});
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollouts SET lock_until = ? WHERE id = ?`).bind(Date.now() + 60000, s.rolloutId).run();
  assert.equal((await rollouts.advanceRollout(env, s.rolloutId, { dispatch })).busy, true);
  const later = await rollouts.advanceRollout(env, s.rolloutId, { dispatch, now: Date.now() + 120000 });
  assert.ok(!later.busy);
});

test('cancel: nothing waiting is deployed afterwards', async (t) => {
  const { env, dispatch } = await fleet(t, 3);
  const s = await rollouts.startRollout(env, {});
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  const c = await rollouts.cancelRollout(env, s.rolloutId);
  assert.equal(c.ok, true);
  const r = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(r.status, 'cancelled');
  const items = (await rollouts.getRollout(env, s.rolloutId)).items;
  const cancelled = items.filter((i) => i.detail === 'rollout_cancelled');
  assert.ok(cancelled.length >= 1, 'sites that were still waiting are marked cancelled');
  for (const i of cancelled) {
    assert.equal(await versionOf(env, i.site_id), '1.0.0', 'and were never deployed');
    assert.equal(await count(env, `SELECT COUNT(*) n FROM deployments WHERE site_id = ? AND version = '2.0.0'`, i.site_id), 0);
  }
  assert.equal((await rollouts.cancelRollout(env, s.rolloutId)).status, 409);
  const again = await rollouts.startRollout(env, {}); // a new rollout can start afterwards
  assert.equal(again.ok, true);
});

test('canary: a rollout limited to chosen sites touches only those', async (t) => {
  const { env, ids, dispatch } = await fleet(t, 3);
  const s = await rollouts.startRollout(env, { siteIds: [ids[1]] });
  assert.equal(s.total, 1);
  for (let i = 0; i < 6; i++) { if ((await rollouts.advanceRollout(env, s.rolloutId, { dispatch })).done) break; }
  assert.equal(await versionOf(env, ids[1]), '2.0.0');
  assert.equal(await versionOf(env, ids[0]), '1.0.0'); assert.equal(await versionOf(env, ids[2]), '1.0.0');
  assert.equal((await rollouts.startRollout(env, { siteIds: 'nope' })).status, 422);
});

test('a deployment already under way for the same version is followed, not duplicated', async (t) => {
  const { env, ids, dispatch } = await fleet(t, 1);
  const { deployments } = await import('../worker/deployments.js');
  const rel = await template.getCurrentRelease(env);
  const pre = await deployments.startDeployment(env, { siteId: ids[0], version: rel.version, migrations: [], scriptContent: rel.scriptContent, actorUserId: 'customer' });
  assert.ok(pre.ok);
  const s = await rollouts.startRollout(env, {});
  const r1 = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(r1.counts.running, 1);
  assert.equal(await count(env, `SELECT COUNT(*) n FROM deployments WHERE site_id = ? AND version = '2.0.0'`, ids[0]), 1, 'no second deployment was created');
  await jobRunner.runJobById(env, pre.jobId);
  const done = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(done.status, 'completed');
  assert.equal(await versionOf(env, ids[0]), '2.0.0');
});

test('a different deployment in flight (another version) makes the site skipped, not overwritten', async (t) => {
  const { env, ids, dispatch } = await fleet(t, 1);
  const { deployments } = await import('../worker/deployments.js');
  const old = await template.getReleaseByVersion(env, '1.0.0');
  const pre = await deployments.startDeployment(env, { siteId: ids[0], version: '1.0.0', migrations: [], scriptContent: old.scriptContent, actorUserId: 'customer' });
  assert.ok(pre.ok);
  const s = await rollouts.startRollout(env, {});
  const r = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(r.status, 'completed');
  const item = (await rollouts.getRollout(env, s.rolloutId)).items[0];
  assert.equal(item.status, 'skipped'); assert.equal(item.detail, 'busy_with_another_deployment');
});

test('a deployment that never finishes fails the rollout after the timeout instead of waiting forever', async (t) => {
  const { env, dispatch } = await fleet(t, 2);
  const s = await rollouts.startRollout(env, {});
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch: async () => {} }); // started, never runs
  const early = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(early.status, 'running');
  const late = await rollouts.advanceRollout(env, s.rolloutId, { dispatch, now: Date.now() + (rollouts.ITEM_TIMEOUT_MINUTES + 5) * 60000 });
  assert.equal(late.status, 'failed'); assert.match(late.error, /timed out/);
});

test('a job the system gave up on (dead-lettered) fails the rollout', async (t) => {
  const { env, dispatch } = await fleet(t, 2);
  const s = await rollouts.startRollout(env, {});
  await rollouts.advanceRollout(env, s.rolloutId, { dispatch: async () => {} });
  const item = (await rollouts.getRollout(env, s.rolloutId)).items.find((i) => i.status === 'running');
  await env.LUMMET_DB.prepare(`UPDATE jobs SET dead_lettered_at = CURRENT_TIMESTAMP, dead_reason = 'used up' WHERE site_id = ? AND type = 'site_deployment' AND status = 'queued'`).bind(item.site_id).run();
  const r = await rollouts.advanceRollout(env, s.rolloutId, { dispatch });
  assert.equal(r.status, 'failed'); assert.match(r.error, /gave up/);
});

test('the maintenance tick continues a running rollout and is a no-op when there is none', async (t) => {
  const { env, ids, dispatch } = await fleet(t, 2);
  assert.equal((await rollouts.advanceRunning(env, { dispatch })).idle, true);
  await rollouts.startRollout(env, {});
  for (let i = 0; i < 8; i++) await rollouts.advanceRunning(env, { dispatch });
  for (const id of ids) assert.equal(await versionOf(env, id), '2.0.0');
});

test('an explicit older version can be rolled out; an unknown version is refused', async (t) => {
  const { env, ids, dispatch } = await fleet(t, 1);
  assert.equal((await rollouts.startRollout(env, { version: '9.9.9' })).status, 404);
  const s = await rollouts.startRollout(env, { version: '1.0.0' });
  assert.equal(s.ok, true); assert.equal(s.nothingToDo, true, 'the site already runs 1.0.0');
  assert.equal(await versionOf(env, ids[0]), '1.0.0');
  void dispatch;
});

test('the dashboard summarises the fleet and the latest rollout', async (t) => {
  const { env, ids, dispatch } = await fleet(t, 2);
  let d = await rollouts.dashboard(env);
  assert.equal(d.active.version, '2.0.0'); assert.equal(d.totalLive, 2); assert.equal(d.outdated, 2); assert.equal(d.running, null);
  const s = await rollouts.startRollout(env, {});
  d = await rollouts.dashboard(env);
  assert.equal(d.running.id, s.rolloutId); assert.equal(d.shown.items.length, 2);
  for (let i = 0; i < 8; i++) { if ((await rollouts.advanceRollout(env, s.rolloutId, { dispatch })).done) break; }
  d = await rollouts.dashboard(env);
  assert.equal(d.outdated, 0); assert.equal(d.recent[0].status, 'completed');
  assert.equal(ids.length, 2);
});
