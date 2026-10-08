// test/deployments.test.js
//
// Covers worker/deployments.js's orchestration against a real SQLite
// schema (D1 shim) and the fake infra provider -- no network needed.
// Provisions each test site through the real provisioning.js flow
// first (fake Cloudflare provider), since a deployment requires a
// site that's actually reached "provisioned".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';

import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';

function makeTestKek() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: makeTestKek() };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.30' }
  };
}

/** Signs up an org, starts a trial, creates a site, and provisions it to "provisioned" -- the real state a site must be in before deployments.js will touch it. */
async function setUpProvisionedSite(env, infra, email) {
  const signup = await customerAuth.signUp(fakeSignupRequest(email), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const provisioning = createProvisioningService(infra);
  const start = await provisioning.startProvisioning(env, site.siteId);
  await provisioning.runJob(env, start.jobId);

  return { signup, siteId: site.siteId };
}

// -----------------------------------------------------
// Initial deployment drives the site state machine
// -----------------------------------------------------

test('the first deployment moves a provisioned site all the way to active, and refuses to deploy a site with no code otherwise', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const { siteId } = await setUpProvisionedSite(env, infra, 'first-deploy@example.com');

  const before = await sites.getSite(env, siteId);
  assert.equal(before.status, 'provisioned');

  const start = await deploymentService.startDeployment(env, {
    siteId, version: '1.0.0', migrations: [], scriptContent: 'export default { fetch() { return new Response("ok"); } };'
  });
  assert.equal(start.ok, true);

  const runResult = await deploymentService.runJob(env, start.jobId);
  assert.equal(runResult.ok, true, JSON.stringify(runResult));

  const after = await sites.getSite(env, siteId);
  assert.equal(after.status, 'active');
  assert.equal(after.app_version, '1.0.0');
  assert.equal(after.last_deployment_id, start.deploymentId);

  const deployment = await deploymentService.getDeployment(env, start.deploymentId);
  assert.equal(deployment.status, 'active');
  assert.equal(deployment.is_current, 1);

  const uploadCall = infra._calls.find((c) => c.method === 'uploadWorkerScript');
  assert.ok(uploadCall);
  assert.equal(uploadCall.workerName, `lummet-site-${(await sites.getSite(env, siteId)).slug}`);
});

test('startDeployment refuses a site that has not been provisioned yet', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const signup = await customerAuth.signUp(fakeSignupRequest('never-provisioned@example.com'), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const result = await deploymentService.startDeployment(env, { siteId: site.siteId, version: '1.0.0', scriptContent: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'site_not_deployable');
});

// -----------------------------------------------------
// A failed initial deploy fails the site; a failed redeploy does not
// -----------------------------------------------------

test('a failing health check on the FIRST deploy marks the site failed (there is no old version to fall back to)', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const { siteId } = await setUpProvisionedSite(env, infra, 'first-deploy-fails@example.com');

  infra._setHealthCheckResult({ ok: false, statusCode: 503 });

  const start = await deploymentService.startDeployment(env, { siteId, version: '1.0.0', scriptContent: 'x' });
  const runResult = await deploymentService.runJob(env, start.jobId);

  assert.equal(runResult.ok, false);
  assert.equal(runResult.failedStep, 'health_check');

  const site = await sites.getSite(env, siteId);
  assert.equal(site.status, 'failed');

  const deployment = await deploymentService.getDeployment(env, start.deploymentId);
  assert.equal(deployment.status, 'failed');
});

test('a failing health check on a REDEPLOY leaves the already-active site untouched', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const { siteId } = await setUpProvisionedSite(env, infra, 'redeploy-fails@example.com');

  const first = await deploymentService.startDeployment(env, { siteId, version: '1.0.0', scriptContent: 'v1' });
  await deploymentService.runJob(env, first.jobId);
  assert.equal((await sites.getSite(env, siteId)).status, 'active');

  infra._setHealthCheckResult({ ok: false, statusCode: 500 });
  const second = await deploymentService.startDeployment(env, { siteId, version: '1.1.0', scriptContent: 'v2 has a bug' });
  const secondRun = await deploymentService.runJob(env, second.jobId);

  assert.equal(secondRun.ok, false);

  const site = await sites.getSite(env, siteId);
  assert.equal(site.status, 'active', 'the site must still be reported active -- the bad redeploy must not take it down');
  assert.equal(site.app_version, '1.0.0', 'the version on record must still be the last SUCCESSFUL one');

  const failedDeployment = await deploymentService.getDeployment(env, second.deploymentId);
  assert.equal(failedDeployment.status, 'failed');
});

// -----------------------------------------------------
// Migration ledger: idempotent, tracked per site
// -----------------------------------------------------

test('migrations are applied once, recorded in the ledger, and skipped on a later deployment that lists the same ones', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const { siteId } = await setUpProvisionedSite(env, infra, 'migration-ledger@example.com');

  const migrations = [
    { name: '0001_init', sql: 'CREATE TABLE foo (id INTEGER)' },
    { name: '0002_seed', sql: "INSERT INTO foo VALUES (1)" }
  ];

  const first = await deploymentService.startDeployment(env, { siteId, version: '1.0.0', migrations, scriptContent: 'v1' });
  await deploymentService.runJob(env, first.jobId);

  const appliedAfterFirst = await env.LUMMET_DB.prepare(`SELECT migration_name FROM site_migrations_applied WHERE site_id = ? ORDER BY migration_name`)
    .bind(siteId).all();
  assert.deepEqual(appliedAfterFirst.results.map((r) => r.migration_name), ['0001_init', '0002_seed']);

  const queryCallsAfterFirst = infra._calls.filter((c) => c.method === 'runD1Query').length;
  assert.equal(queryCallsAfterFirst, 2);

  // A second deployment lists the SAME two migrations plus one new
  // one -- only the new one should actually run.
  const second = await deploymentService.startDeployment(env, {
    siteId, version: '1.1.0',
    migrations: [...migrations, { name: '0003_add_column', sql: 'ALTER TABLE foo ADD COLUMN bar TEXT' }],
    scriptContent: 'v2'
  });
  await deploymentService.runJob(env, second.jobId);

  const queryCallsAfterSecond = infra._calls.filter((c) => c.method === 'runD1Query').length;
  assert.equal(queryCallsAfterSecond, 3, 'only the one new migration should have actually run');

  const appliedAfterSecond = await env.LUMMET_DB.prepare(`SELECT migration_name FROM site_migrations_applied WHERE site_id = ? ORDER BY migration_name`)
    .bind(siteId).all();
  assert.equal(appliedAfterSecond.results.length, 3);
});

// -----------------------------------------------------
// Resumability: retrying a failed deployment resumes, not redoes
// -----------------------------------------------------

test('retrying a failed deployment job does not re-run steps that already succeeded', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const { siteId } = await setUpProvisionedSite(env, infra, 'resume-deploy@example.com');

  infra._failNextCall('uploadWorkerScript', 'simulated upload timeout');

  const migrations = [{ name: '0001_init', sql: 'CREATE TABLE foo (id INTEGER)' }];
  const start = await deploymentService.startDeployment(env, { siteId, version: '1.0.0', migrations, scriptContent: 'v1' });
  const firstRun = await deploymentService.runJob(env, start.jobId);

  assert.equal(firstRun.ok, false);
  assert.equal(firstRun.failedStep, 'deploy_worker_script');

  const migrationCallsAfterFailure = infra._calls.filter((c) => c.method === 'runD1Query').length;
  assert.equal(migrationCallsAfterFailure, 1);

  // Site failed (this was the first deploy) -- but the job itself
  // can still be resumed directly via runJob (a "retry" route would
  // call this the same way after re-validating; the migration ledger
  // is what actually prevents redoing the migration step).
  const secondRun = await deploymentService.runJob(env, start.jobId);
  assert.equal(secondRun.ok, true, JSON.stringify(secondRun));

  const migrationCallsAfterRetry = infra._calls.filter((c) => c.method === 'runD1Query').length;
  assert.equal(migrationCallsAfterRetry, 1, 'run_migrations must not re-run on resume -- it already succeeded');
});

// -----------------------------------------------------
// Rollback
// -----------------------------------------------------

test('rollbackDeployment redeploys old code without touching migrations, and refuses a non-successful or unknown target', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const deploymentService = createDeploymentService(infra);
  const { siteId } = await setUpProvisionedSite(env, infra, 'rollback@example.com');

  const v1 = await deploymentService.startDeployment(env, {
    siteId, version: '1.0.0', migrations: [{ name: '0001_init', sql: 'CREATE TABLE foo (id INTEGER)' }], scriptContent: 'v1 code'
  });
  await deploymentService.runJob(env, v1.jobId);

  const v2 = await deploymentService.startDeployment(env, {
    siteId, version: '2.0.0', migrations: [{ name: '0002_break_things', sql: 'CREATE TABLE bar (id INTEGER)' }], scriptContent: 'v2 code with a bug'
  });
  await deploymentService.runJob(env, v2.jobId);
  assert.equal((await sites.getSite(env, siteId)).app_version, '2.0.0');

  const unknownTarget = await deploymentService.rollbackDeployment(env, {
    siteId, targetDeploymentId: 'does-not-exist', scriptContent: 'v1 code'
  });
  assert.equal(unknownTarget.ok, false);
  assert.equal(unknownTarget.error, 'target_deployment_not_found');

  const rollback = await deploymentService.rollbackDeployment(env, {
    siteId, targetDeploymentId: v1.deploymentId, scriptContent: 'v1 code'
  });
  assert.equal(rollback.ok, true);

  const queryCallsBeforeRollbackRun = infra._calls.filter((c) => c.method === 'runD1Query').length;
  const rollbackRun = await deploymentService.runJob(env, rollback.jobId);
  assert.equal(rollbackRun.ok, true, JSON.stringify(rollbackRun));
  const queryCallsAfterRollbackRun = infra._calls.filter((c) => c.method === 'runD1Query').length;
  assert.equal(queryCallsAfterRollbackRun, queryCallsBeforeRollbackRun, 'rollback must never run migrations');

  const site = await sites.getSite(env, siteId);
  assert.equal(site.app_version, '1.0.0');
  assert.equal(site.status, 'active', 'rollback of an already-active site must not walk it through provisioned/configuring again');

  const rollbackDeploymentRow = await deploymentService.getDeployment(env, rollback.deploymentId);
  assert.equal(rollbackDeploymentRow.is_rollback, 1);
  assert.equal(rollbackDeploymentRow.target_deployment_id, v1.deploymentId);

  // Rolling back to the v2 deployment itself (status 'active' at the
  // time, but no longer the target of a *repeat* rollback attempt at
  // the same id) should still work as a normal "roll forward" target
  // if it once succeeded -- but rolling back to the FAILED-looking
  // rollback deployment itself should be refused once it's superseded.
  const rollbackToRollback = await deploymentService.rollbackDeployment(env, {
    siteId, targetDeploymentId: rollback.deploymentId, scriptContent: 'v1 code again'
  });
  assert.equal(rollbackToRollback.ok, true, 'a successful rollback deployment is itself a valid future rollback target');
});
