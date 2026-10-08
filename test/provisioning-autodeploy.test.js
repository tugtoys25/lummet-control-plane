// Covers the roadmap-0.1 gap directly: a newly provisioned site now
// automatically continues into a real deployment (via
// worker/deployments.js's own already-tested job) when a tenant
// template release has been published, and honestly stays
// "provisioned" — not a fake "active" — when none has been.
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

function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; } };
}
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(bytes).toString('base64'), ...extra };
}
function fakeSignupRequest(email, organizationName) {
  return { async json() { return { email, password: 'correct-horse-battery', organizationName }; }, headers: { get: () => '203.0.113.20' } };
}
async function setUpOrgWithSite(env, email, orgName) {
  const signup = await customerAuth.signUp(fakeSignupRequest(email, orgName), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId });
  return { signup, siteId: site.siteId, slug: site.slug };
}
const REAL_MIGS = [{ name: '0001_x.sql', sql: 'CREATE TABLE x (id INTEGER);' }];

test('no template published: provisioning succeeds and honestly stops at "provisioned", not a fake "active"', async () => {
  const env = makeEnv(); // no TENANT_TEMPLATES binding at all
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra, { deploymentService: createDeploymentService(infra) });
  const { siteId } = await setUpOrgWithSite(env, 'no-template@example.com', 'Org');
  const start = await provisioning.startProvisioning(env, siteId);
  const run = await provisioning.runJob(env, start.jobId);
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.result.autoDeploy.attempted, false);
  assert.equal(run.result.autoDeploy.reason, 'no_release_published');
  const site = await sites.getSite(env, siteId);
  assert.equal(site.status, 'provisioned', 'must not claim the site is active without ever deploying real code');
});

test('a published template release: provisioning automatically continues all the way to "active" with no human step', async () => {
  const env = makeEnv({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default { fetch() { return new Response("ok"); } }', migrations: REAL_MIGS });
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const provisioning = createProvisioningService(infra, { deploymentService, templateService: template });

  const { siteId } = await setUpOrgWithSite(env, 'has-template@example.com', 'Org');
  const start = await provisioning.startProvisioning(env, siteId);
  const run = await provisioning.runJob(env, start.jobId);
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal(run.result.autoDeploy.attempted, true);
  assert.equal(run.result.autoDeploy.ok, true, JSON.stringify(run.result.autoDeploy));

  const site = await sites.getSite(env, siteId);
  assert.equal(site.status, 'active', 'a real published release must carry the site all the way to active automatically');
  assert.equal(site.app_version, '1.0.0');

  const deployments = await deploymentService.listDeploymentsForSite(env, siteId);
  assert.equal(deployments.length, 1);
  assert.equal(deployments[0].status, 'active');

  const uploaded = infra._calls.find((c) => c.method === 'uploadWorkerScript');
  assert.match(uploaded.scriptContent, /fetch/, 'the actual published script content must be what gets deployed');

  const migrationRan = infra._calls.find((c) => c.method === 'runD1Query');
  assert.match(migrationRan.sql, /CREATE TABLE x/, "the release's own migrations must run against the new tenant's D1");
});

test('a broken release fails the deployment, and the site lands in "failed" (matching deployments.js\'s own documented behavior) — never silently "active"', async () => {
  const env = makeEnv({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(env, { version: 'bad-1', scriptContent: 'x', migrations: [] });
  const infra = createFakeInfraProvider();
  infra._failNextCall('uploadWorkerScript', 'quota exceeded');
  const deploymentService = createDeploymentService(infra);
  const provisioning = createProvisioningService(infra, { deploymentService, templateService: template });

  const { siteId } = await setUpOrgWithSite(env, 'broken-template@example.com', 'Org');
  const start = await provisioning.startProvisioning(env, siteId);
  const run = await provisioning.runJob(env, start.jobId);
  assert.equal(run.ok, true, 'provisioning ITSELF still succeeded — the site really was provisioned');
  assert.equal(run.result.autoDeploy.ok, false);

  const site = await sites.getSite(env, siteId);
  assert.equal(site.status, 'failed');
});

test('each new site independently triggers its own deployment using the CURRENT release at the time it is provisioned', async () => {
  const env = makeEnv({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'v1', migrations: [] });
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const provisioning = createProvisioningService(infra, { deploymentService, templateService: template });

  const a = await setUpOrgWithSite(env, 'site-a@example.com', 'Org A');
  const runA = await provisioning.runJob(env, (await provisioning.startProvisioning(env, a.siteId)).jobId);
  assert.equal((await sites.getSite(env, a.siteId)).app_version, '1.0.0');

  await template.publishRelease(env, { version: '2.0.0', scriptContent: 'v2', migrations: [] });
  const b = await setUpOrgWithSite(env, 'site-b@example.com', 'Org B');
  const runB = await provisioning.runJob(env, (await provisioning.startProvisioning(env, b.siteId)).jobId);
  assert.equal((await sites.getSite(env, b.siteId)).app_version, '2.0.0');

  // Site A was never touched by publishing 2.0.0 — no redeploy happens on its own.
  assert.equal((await sites.getSite(env, a.siteId)).app_version, '1.0.0');
  assert.ok(runA.ok && runB.ok);
});
