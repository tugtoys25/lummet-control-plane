// Phase 10 B7: canary-first rollouts. Real schema and the real deployment engine with a fake Cloudflare provider (same fixture as rollouts.test.js).
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

function fakeR2() { const m = new Map(); return { async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; } }; }
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ...extra };
}
const signup = (email) => ({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.20' } });
let n = 0;
async function newSite(env, infra) {
  const s = await customerAuth.signUp(signup(`canary${++n}@example.com`), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: s.organizationId, name: 'Site ' + n, productId: 'prod_casino_news', actorUserId: s.userId });
  const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra), templateService: template });
  const start = await prov.startProvisioning(env, site.siteId);
  assert.equal((await prov.runJob(env, start.jobId)).ok, true);
  return site.siteId;
}
const publish = (env, version) => template.publishRelease(env, { version, scriptContent: `export default {/*${version}*/}`, migrations: [] });
const versionOf = async (env, id) => (await sites.getSite(env, id)).app_version;

async function fleet(t, size, extraEnv = {}) {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(extraEnv);
  assert.ok((await publish(env, '1.0.0')).ok);
  const ids = []; for (let i = 0; i < size; i++) ids.push(await newSite(env, infra));
  assert.ok((await publish(env, '2.0.0')).ok);
  const dispatch = (jobId) => jobRunner.runJobById(env, jobId);
  const finish = async (rolloutId) => { for (let i = 0; i < 15; i++) { const r = await rollouts.advanceRollout(env, rolloutId, { dispatch }); if (r.done) return r; } throw new Error('rollout did not finish'); };
  return { env, ids, dispatch, finish };
}

test('canaryRequired is off unless ROLLOUT_REQUIRE_CANARY is set to an on spelling', () => {
  assert.equal(rollouts.canaryRequired({}), false);
  assert.equal(rollouts.canaryRequired(undefined), false);
  for (const v of ['on', 'ON', ' 1 ', 'true', 'yes', 'enforce', 'required']) assert.equal(rollouts.canaryRequired({ ROLLOUT_REQUIRE_CANARY: v }), true, v);
  for (const v of ['', 'off', '0', 'false', 'no', 'maybe']) assert.equal(rollouts.canaryRequired({ ROLLOUT_REQUIRE_CANARY: v }), false, v);
});

test('startCanaryRollout validates its input before touching anything', async (t) => {
  const { env, ids } = await fleet(t, 1);
  assert.deepEqual(await rollouts.startCanaryRollout(env, {}), { ok: false, status: 422, error: 'canary_site_required' });
  assert.equal((await rollouts.startCanaryRollout(env, { canarySiteId: '' })).error, 'canary_site_required');
  assert.equal((await rollouts.startCanaryRollout(env, { canarySiteId: 'x'.repeat(65) })).error, 'canary_site_required');
  assert.equal((await rollouts.startCanaryRollout(env, { canarySiteId: 42 })).error, 'canary_site_required');
  assert.deepEqual(await rollouts.startCanaryRollout(env, { canarySiteId: 'no-such-site' }), { ok: false, status: 404, error: 'canary_site_not_found' });
  assert.equal((await rollouts.startCanaryRollout(env, { canarySiteId: ids[0], notes: 'n'.repeat(201) })).error, 'notes_too_long');
  await env.LUMMET_DB.prepare(`UPDATE sites SET tenant_id = NULL WHERE id = ?`).bind(ids[0]).run();
  assert.deepEqual(await rollouts.startCanaryRollout(env, { canarySiteId: ids[0] }), { ok: false, status: 409, error: 'canary_site_not_live' });
  const rows = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM tenant_rollouts`).first();
  assert.equal(rows.n, 0, 'a refused canary leaves no rollout behind');
});

test('canary happy path: one site is updated, the others are not, then a normal rollout skips the canary and does the rest', async (t) => {
  const { env, ids, finish } = await fleet(t, 3);
  const started = await rollouts.startCanaryRollout(env, { canarySiteId: ids[0], notes: 'check the news page', startedBy: 'admin:1' });
  assert.equal(started.ok, true, JSON.stringify(started));
  assert.equal(started.total, 1);
  const row = await env.LUMMET_DB.prepare(`SELECT notes, started_by FROM tenant_rollouts WHERE id = ?`).bind(started.rolloutId).first();
  assert.equal(row.notes, `canary:${ids[0]} check the news page`);

  let st = await rollouts.canaryState(env, '2.0.0');
  assert.equal(st.passed, false, 'a running canary has not passed');
  assert.equal(st.status, 'running'); assert.equal(st.siteId, ids[0]);

  assert.equal((await finish(started.rolloutId)).status, 'completed');
  assert.equal(await versionOf(env, ids[0]), '2.0.0');
  assert.equal(await versionOf(env, ids[1]), '1.0.0');
  assert.equal(await versionOf(env, ids[2]), '1.0.0');
  st = await rollouts.canaryState(env, '2.0.0');
  assert.equal(st.passed, true); assert.equal(st.siteId, ids[0]); assert.equal(st.rolloutId, started.rolloutId);

  const rest = await rollouts.startRollout(env, { startedBy: 'admin:1' });
  assert.equal(rest.ok, true); assert.equal(rest.total, 2, 'the canary site is not deployed twice');
  assert.equal((await finish(rest.rolloutId)).status, 'completed');
  for (const id of ids) assert.equal(await versionOf(env, id), '2.0.0');
});

test('canaryState: unknown or missing version is not passed; another version is not borrowed', async (t) => {
  const { env, ids, finish } = await fleet(t, 1);
  for (const v of [null, '', '9.9.9']) assert.deepEqual(await rollouts.canaryState(env, v), { passed: false, rolloutId: null, status: null, siteId: null });
  const s = await rollouts.startCanaryRollout(env, { canarySiteId: ids[0] });
  await finish(s.rolloutId);
  assert.equal((await rollouts.canaryState(env, '2.0.0')).passed, true);
  assert.equal((await rollouts.canaryState(env, '1.0.0')).passed, false, 'a canary of 2.0.0 says nothing about 1.0.0');
});

test('default (switch off): a rollout to every site needs no canary', async (t) => {
  const { env, finish } = await fleet(t, 2);
  const r = await rollouts.startRollout(env, { startedBy: 'admin:1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await finish(r.rolloutId)).status, 'completed');
});

test('ROLLOUT_REQUIRE_CANARY=on: a rollout to every site is refused until a canary of the same release has finished', async (t) => {
  const { env, ids, finish } = await fleet(t, 2, { ROLLOUT_REQUIRE_CANARY: 'on' });
  const refused = await rollouts.startRollout(env, { startedBy: 'admin:1' });
  assert.equal(refused.ok, false); assert.equal(refused.status, 409); assert.equal(refused.error, 'canary_required');
  assert.equal(refused.canary.passed, false); assert.equal(refused.canary.rolloutId, null);
  assert.equal((await rollouts.startRollout(env, { siteIds: [] })).error, 'canary_required', 'an empty list means everyone');
  assert.equal((await rollouts.startRollout(env, { siteIds: null })).error, 'canary_required');

  // A rollout limited to chosen sites is not a rollout to everyone, so it is allowed (that is how a canary is made by hand).
  const chosen = await rollouts.startRollout(env, { siteIds: [ids[0]], startedBy: 'admin:1' });
  assert.equal(chosen.ok, true, JSON.stringify(chosen));
  await finish(chosen.rolloutId);
  assert.equal((await rollouts.startRollout(env, {})).error, 'canary_required', 'a hand-made rollout is not marked as a canary, so it does not count');

  const canary = await rollouts.startCanaryRollout(env, { canarySiteId: ids[1] });
  assert.equal(canary.ok, true, JSON.stringify(canary));
  assert.equal((await rollouts.startRollout(env, {})).error, 'canary_required', 'a running canary has not passed');
  await finish(canary.rolloutId);
  const all = await rollouts.startRollout(env, { startedBy: 'admin:1' });
  assert.equal(all.ok, true, JSON.stringify(all));
  assert.equal(all.nothingToDo, true, 'both sites are already on 2.0.0');
});

test('a failed or cancelled canary does not pass', async (t) => {
  const { env, ids } = await fleet(t, 2, { ROLLOUT_REQUIRE_CANARY: 'on' });
  const c = await rollouts.startCanaryRollout(env, { canarySiteId: ids[0] });
  assert.equal(c.ok, true);
  assert.equal((await rollouts.cancelRollout(env, c.rolloutId)).ok, true);
  let st = await rollouts.canaryState(env, '2.0.0');
  assert.equal(st.passed, false); assert.equal(st.status, 'cancelled');
  assert.equal((await rollouts.startRollout(env, {})).error, 'canary_required');

  const c2 = await rollouts.startCanaryRollout(env, { canarySiteId: ids[1] });
  assert.equal(c2.ok, true);
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollouts SET status = 'failed' WHERE id = ?`).bind(c2.rolloutId).run();
  st = await rollouts.canaryState(env, '2.0.0');
  assert.equal(st.passed, false); assert.equal(st.status, 'failed');
  assert.equal((await rollouts.startRollout(env, {})).error, 'canary_required');
});

test('a second rollout while one runs is still refused with rollout_in_progress (switch off)', async (t) => {
  const { env, ids } = await fleet(t, 2);
  assert.equal((await rollouts.startCanaryRollout(env, { canarySiteId: ids[0] })).ok, true);
  const second = await rollouts.startRollout(env, {});
  assert.equal(second.ok, false); assert.equal(second.error, 'rollout_in_progress');
});

test('dashboard().canary: required flag, state, and candidates that are live, not on the release, with no secrets', async (t) => {
  const { env, ids, finish } = await fleet(t, 2, { ROLLOUT_REQUIRE_CANARY: 'on' });
  let d = await rollouts.dashboard(env);
  assert.equal(d.canary.required, true);
  assert.deepEqual(d.canary.state, { passed: false, rolloutId: null, status: null, siteId: null });
  assert.equal(d.canary.candidates.length, 2);
  assert.deepEqual(Object.keys(d.canary.candidates[0]).sort(), ['id', 'name', 'slug', 'version']);
  assert.equal(d.canary.candidates[0].version, '1.0.0');
  const s = await rollouts.startCanaryRollout(env, { canarySiteId: ids[0] });
  await finish(s.rolloutId);
  d = await rollouts.dashboard(env);
  assert.equal(d.canary.state.passed, true);
  assert.deepEqual(d.canary.candidates.map((c) => c.id), [ids[1]], 'the canary site is on the release now, so it is no candidate');
  assert.equal(d.outdated, 1);

  const off = await rollouts.dashboard({ ...env, ROLLOUT_REQUIRE_CANARY: undefined });
  assert.equal(off.canary.required, false);
});

test('dashboard() with no release published has no canary state and no candidates', async () => {
  const env = makeEnv();
  const d = await rollouts.dashboard(env);
  assert.equal(d.active, null);
  assert.deepEqual(d.canary, { required: false, state: null, candidates: [] });
});

test('a canary marked completed does not pass unless its site succeeded or was already on the release', async (t) => {
  const { env, ids } = await fleet(t, 2);
  const c = await rollouts.startCanaryRollout(env, { canarySiteId: ids[0] });
  assert.equal(c.ok, true);
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollouts SET status = 'completed' WHERE id = ?`).bind(c.rolloutId).run();
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollout_items SET status = 'failed' WHERE rollout_id = ?`).bind(c.rolloutId).run();
  assert.equal((await rollouts.canaryState(env, '2.0.0')).passed, false, 'completed but the site failed');
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollout_items SET status = 'skipped', detail = 'site_not_live' WHERE rollout_id = ?`).bind(c.rolloutId).run();
  assert.equal((await rollouts.canaryState(env, '2.0.0')).passed, false, 'skipped for another reason is not a pass');
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollout_items SET status = 'skipped', detail = 'already_on_version' WHERE rollout_id = ?`).bind(c.rolloutId).run();
  assert.equal((await rollouts.canaryState(env, '2.0.0')).passed, true, 'already on the release counts as proven');
});
