// Per-site route + cron schedule on deploy, and their clean-up on deletion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import * as erasure from '../worker/erasure.js';
import * as organizations from '../worker/organizations.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as infraCf from '../worker/infra-cloudflare.js';

const ctx = { waitUntil() {} };
function makeEnv() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }
async function provisioned(env, infra, email = 'route@example.com') {
  const s = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' }) }), env, ctx);
  const sj = await s.json();
  const user = await env.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = ?`).bind(email).first();
  await plans.startTrialSubscription(env, sj.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: sj.organizationId, name: 'Routed', productId: 'prod_casino_news', actorUserId: user.id });
  const prov = createProvisioningService(infra);
  const start = await prov.startProvisioning(env, site.siteId);
  await prov.runJob(env, start.jobId);
  return { orgId: sj.organizationId, userId: user.id, siteId: site.siteId };
}
const deploy = async (svc, env, siteId, version) => {
  const d = await svc.startDeployment(env, { siteId, version, migrations: [], scriptContent: 'export default {}', actorType: 'system' });
  return { d, ran: await svc.runJob(env, d.jobId) };
};
const stepOutput = async (env, jobId) => JSON.parse((await env.LUMMET_DB.prepare(`SELECT output FROM job_steps WHERE job_id = ? AND step_key = 'deploy_worker_script'`).bind(jobId).first()).output);

test('deploy routes the platform hostname to the site once, and registers the tenant cron every time', async () => {
  const infra = createFakeInfraProvider(); const env = makeEnv();
  const { siteId } = await provisioned(env, infra);
  const host = (await env.LUMMET_DB.prepare(`SELECT primary_domain FROM sites WHERE id = ?`).bind(siteId).first()).primary_domain;
  assert.ok(host);
  const svc = createDeploymentService(infra);

  const first = await deploy(svc, env, siteId, '1.0.0');
  assert.ok(first.ran.ok, JSON.stringify(first.ran));
  const routes = infra._calls.filter((c) => c.method === 'ensureWorkerRoute');
  assert.equal(routes.length, 1);
  assert.equal(routes[0].pattern, `${host}/*`);
  assert.match(routes[0].workerName, /./);
  const rec = await env.LUMMET_DB.prepare(`SELECT resource_id, status FROM site_resources WHERE site_id = ? AND resource_type = 'route'`).bind(siteId).first();
  assert.equal(rec.status, 'active');
  assert.equal((await stepOutput(env, first.d.jobId)).routeId, rec.resource_id);

  const second = await deploy(svc, env, siteId, '1.0.1');
  assert.ok(second.ran.ok);
  assert.equal(infra._calls.filter((c) => c.method === 'ensureWorkerRoute').length, 1, 'no second route');
  const crons = infra._calls.filter((c) => c.method === 'setWorkerSchedule');
  assert.equal(crons.length, 2);
  assert.deepEqual(crons[0].crons, ['0 */6 * * *']);
  // Upload happens before routing: the route never points at a missing Worker.
  const order = infra._calls.map((c) => c.method);
  assert.ok(order.indexOf('uploadWorkerScript') < order.indexOf('ensureWorkerRoute'));
});

test('a routing failure fails the deployment with the real reason; the site is not reported active', async () => {
  const infra = createFakeInfraProvider(); const env = makeEnv();
  const { siteId } = await provisioned(env, infra);
  infra._routeFailure = 'CF_ZONE_ID is not configured on this Worker, so x/* cannot be routed to the site';
  const { ran } = await deploy(createDeploymentService(infra), env, siteId, '1.0.0');
  assert.equal(ran.ok, false);
  assert.match(ran.error, /CF_ZONE_ID is not configured/);
  assert.notEqual((await env.LUMMET_DB.prepare(`SELECT status FROM sites WHERE id = ?`).bind(siteId).first()).status, 'active');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM site_resources WHERE site_id = ? AND resource_type = 'route'`).bind(siteId).first()).n, 0);
});

test('a cron-registration failure does not fail the deploy but is recorded on the step', async () => {
  const infra = createFakeInfraProvider(); const env = makeEnv();
  const { siteId } = await provisioned(env, infra);
  infra._scheduleFailure = 'schedules API unavailable';
  const { d, ran } = await deploy(createDeploymentService(infra), env, siteId, '1.0.0');
  assert.ok(ran.ok, JSON.stringify(ran));
  assert.equal((await stepOutput(env, d.jobId)).scheduleError, 'schedules API unavailable');
});

test('deleting an organization removes the route before the Worker', async () => {
  const infra = createFakeInfraProvider(); const env = makeEnv();
  const a = await provisioned(env, infra);
  assert.ok((await deploy(createDeploymentService(infra), env, a.siteId, '1.0.0')).ran.ok);
  await organizations.requestDeletion(env, a.orgId, a.userId, {});
  const r = await erasure.eraseOrganization(env, a.orgId, { infra, now: Date.now() + 40 * 86400000 });
  assert.equal(r.ok, true, JSON.stringify(r));
  const del = infra._calls.filter((c) => c.method.startsWith('delete')).map((c) => c.method);
  assert.deepEqual(del.slice(del.indexOf('deleteWorkerRoute')), ['deleteWorkerRoute', 'deleteWorkerScript', 'deleteDatabase', 'deleteKVNamespace', 'deleteR2Bucket']);
});

// ---- Cloudflare adapter request shapes (mocked fetch) ----
function mockCf(handler) {
  const reqs = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { reqs.push({ url: String(url), init }); return handler(String(url), init, reqs) ; };
  return { reqs, restore: () => { globalThis.fetch = real; } };
}
const ok = (result) => new Response(JSON.stringify({ success: true, result }));
const fail = (msg) => new Response(JSON.stringify({ success: false, errors: [{ message: msg }] }), { status: 400 });
const cfEnv = { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct', CF_ZONE_ID: 'zone1' };

test('adapter: ensureWorkerRoute posts the pattern and script to the platform zone; needs CF_ZONE_ID', async () => {
  const m = mockCf(() => ok({ id: 'route-1' }));
  try {
    assert.deepEqual(await infraCf.ensureWorkerRoute(cfEnv, { pattern: 'a.sites.example.com/*', workerName: 'w-a' }), { routeId: 'route-1' });
    await assert.rejects(infraCf.ensureWorkerRoute({ ...cfEnv, CF_ZONE_ID: undefined }, { pattern: 'x/*', workerName: 'w' }), /CF_ZONE_ID is not configured/);
  } finally { m.restore(); }
  assert.equal(m.reqs[0].url, 'https://api.cloudflare.com/client/v4/zones/zone1/workers/routes');
  assert.equal(m.reqs[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(m.reqs[0].init.body), { pattern: 'a.sites.example.com/*', script: 'w-a' });
});

test('adapter: a duplicate route returns the existing id; one bound to another Worker is taken over', async () => {
  let call = 0;
  const m = mockCf((url, init) => {
    call++;
    if (init.method === 'POST') return fail('A route with the same pattern already exists');
    if (init.method === 'GET') return ok([{ id: 'r-other', pattern: 'other/*', script: 'x' }, { id: 'r-mine', pattern: 'a.sites.example.com/*', script: call > 100 ? 'w-a' : 'old-worker' }]);
    return ok({ id: 'r-mine' });
  });
  try {
    const r = await infraCf.ensureWorkerRoute(cfEnv, { pattern: 'a.sites.example.com/*', workerName: 'w-a' });
    assert.equal(r.routeId, 'r-mine');
  } finally { m.restore(); }
  assert.deepEqual(m.reqs.map((x) => x.init.method), ['POST', 'GET', 'PUT']);
  assert.match(m.reqs[2].url, /\/workers\/routes\/r-mine$/);
  assert.deepEqual(JSON.parse(m.reqs[2].init.body), { pattern: 'a.sites.example.com/*', script: 'w-a' });

  // an unrelated failure is not swallowed
  const m2 = mockCf(() => fail('Authentication error'));
  try { await assert.rejects(infraCf.ensureWorkerRoute(cfEnv, { pattern: 'p/*', workerName: 'w' }), /Authentication error/); } finally { m2.restore(); }
});

test('adapter: schedule PUT carries the cron list; delete route targets the route id', async () => {
  const m = mockCf(() => ok({}));
  try {
    await infraCf.setWorkerSchedule(cfEnv, { workerName: 'w-a', crons: ['0 */6 * * *'] });
    await infraCf.deleteWorkerRoute(cfEnv, 'route-9');
  } finally { m.restore(); }
  assert.equal(m.reqs[0].url, 'https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/w-a/schedules');
  assert.equal(m.reqs[0].init.method, 'PUT');
  assert.deepEqual(JSON.parse(m.reqs[0].init.body), [{ cron: '0 */6 * * *' }]);
  assert.equal(m.reqs[1].url, 'https://api.cloudflare.com/client/v4/zones/zone1/workers/routes/route-9');
  assert.equal(m.reqs[1].init.method, 'DELETE');
});
