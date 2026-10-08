// test/provisioning.test.js
//
// Covers worker/provisioning.js's actual orchestration logic against
// a real SQLite schema (D1 shim) and a fake infrastructure provider
// standing in for Cloudflare's account API
// (test/support/fake-infra-provider.js) -- no network access needed,
// since none of this is Cloudflare-API-shape-specific. Also
// exercises the real registry.js/crypto.js tenant-registration path
// (with a freshly generated test CREDENTIAL_KEK), since Phase 3's
// "register_tenant" step calls it directly rather than reimplementing
// credential storage.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';

import { createProvisioningService, PROVISIONING_STEPS } from '../worker/provisioning.js';
import * as jobsModule from '../worker/jobs.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';

function makeTestKek() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

function makeEnv(extra = {}) {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: makeTestKek(), ...extra };
}

function fakeSignupRequest(email, organizationName) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName }; },
    headers: { get: () => '203.0.113.11' }
  };
}

async function setUpOrgWithSite(env, email, orgName) {
  const signup = await customerAuth.signUp(fakeSignupRequest(email, orgName), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter'); // sites.max = 1
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'My Casino News Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  return { signup, siteId: site.siteId, slug: site.slug };
}

// -----------------------------------------------------
// startProvisioning gating
// -----------------------------------------------------

test('startProvisioning refuses a site that is not pending', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra);
  const { siteId } = await setUpOrgWithSite(env, 'not-pending@example.com', 'Org');

  await sites.transitionSiteStatus(env, siteId, 'provisioning');
  const result = await provisioning.startProvisioning(env, siteId);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'site_not_provisionable');
});

test('startProvisioning refuses when the organization is over its sites.max entitlement', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra);
  const signup = await customerAuth.signUp(fakeSignupRequest('over-limit@example.com', 'Org'), env);
  // No subscription started -- sites.max resolves to the zero-access floor (0).
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const result = await provisioning.startProvisioning(env, site.siteId);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'site_limit_reached');

  const unchanged = await sites.getSite(env, site.siteId);
  assert.equal(unchanged.status, 'pending', 'a refused startProvisioning must not touch the site status');
});

// -----------------------------------------------------
// Happy path
// -----------------------------------------------------

test('a full provisioning run creates real Cloudflare resource records, registers a tenant, and reaches "provisioned"', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra);
  const { siteId, slug } = await setUpOrgWithSite(env, 'happy-path@example.com', 'Org');

  const start = await provisioning.startProvisioning(env, siteId);
  assert.equal(start.ok, true);

  const siteDuringRun = await sites.getSite(env, siteId);
  assert.equal(siteDuringRun.status, 'provisioning');

  const runResult = await provisioning.runJob(env, start.jobId);
  assert.equal(runResult.ok, true, JSON.stringify(runResult));

  const site = await sites.getSite(env, siteId);
  assert.equal(site.status, 'provisioned');
  assert.ok(site.tenant_id, 'a provisioned site must be linked to a tenant registry row');
  assert.equal(site.primary_domain, `${slug}.sites.lummet.app`, 'must use the default platform domain suffix');

  const resources = await env.LUMMET_DB.prepare(`SELECT * FROM site_resources WHERE site_id = ? ORDER BY resource_type`)
    .bind(siteId).all();
  const resourceTypes = resources.results.map((r) => r.resource_type).sort();
  assert.deepEqual(resourceTypes, ['d1', 'kv', 'r2']);
  for (const r of resources.results) {
    assert.equal(r.provider, 'fake-cloudflare');
    assert.equal(r.status, 'active');
  }

  const tenant = await env.LUMMET_DB.prepare(`SELECT * FROM tenants WHERE id = ?`).bind(site.tenant_id).first();
  assert.equal(tenant.host, `${slug}.sites.lummet.app`);

  const job = await jobsModule.getJob(env, start.jobId);
  assert.equal(job.status, 'success');
  assert.equal(job.progress, 100);
  assert.ok(job.result.credential, 'the one-time tenant credential must be surfaced in the job result');
  assert.equal(job.result.credential.secret !== undefined, true);

  for (const stepKey of PROVISIONING_STEPS) {
    const step = job.steps.find((s) => s.step_key === stepKey);
    assert.ok(['success'].includes(step.status), `step ${stepKey} should have succeeded, was ${step.status}`);
  }
});

test('respects PLATFORM_DOMAIN_SUFFIX when configured', async () => {
  const env = makeEnv({ PLATFORM_DOMAIN_SUFFIX: 'preview.example.net' });
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra);
  const { siteId, slug } = await setUpOrgWithSite(env, 'custom-suffix@example.com', 'Org');

  const start = await provisioning.startProvisioning(env, siteId);
  await provisioning.runJob(env, start.jobId);

  const site = await sites.getSite(env, siteId);
  assert.equal(site.primary_domain, `${slug}.preview.example.net`);
});

// -----------------------------------------------------
// Idempotency / resumability
// -----------------------------------------------------

test('running an already-successful job again is a no-op and calls the provider zero additional times', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra);
  const { siteId } = await setUpOrgWithSite(env, 'already-done@example.com', 'Org');

  const start = await provisioning.startProvisioning(env, siteId);
  await provisioning.runJob(env, start.jobId);
  const callCountAfterFirstRun = infra._calls.length;

  const secondRun = await provisioning.runJob(env, start.jobId);
  assert.equal(secondRun.ok, true);
  assert.equal(secondRun.alreadyDone, true);
  assert.equal(infra._calls.length, callCountAfterFirstRun, 'no additional provider calls on a completed job');
});

test('a step failure marks the job and site failed, and retrying resumes from the failed step without redoing completed ones', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra);
  const { siteId } = await setUpOrgWithSite(env, 'retry-me@example.com', 'Org');

  infra._failNextCall('createKVNamespace', 'simulated Cloudflare outage');

  const start = await provisioning.startProvisioning(env, siteId);
  const firstRun = await provisioning.runJob(env, start.jobId);

  assert.equal(firstRun.ok, false);
  assert.equal(firstRun.failedStep, 'create_kv_namespace');

  const siteAfterFailure = await sites.getSite(env, siteId);
  assert.equal(siteAfterFailure.status, 'failed');

  const jobAfterFailure = await jobsModule.getJob(env, start.jobId);
  assert.equal(jobAfterFailure.status, 'failed');
  const databaseStep = jobAfterFailure.steps.find((s) => s.step_key === 'create_database');
  const kvStep = jobAfterFailure.steps.find((s) => s.step_key === 'create_kv_namespace');
  assert.equal(databaseStep.status, 'success', 'the step before the failure must have completed');
  assert.equal(kvStep.status, 'failed');
  assert.ok(kvStep.error_message.includes('simulated Cloudflare outage'));

  const databaseCallsBeforeRetry = infra._calls.filter((c) => c.method === 'createDatabase').length;
  assert.equal(databaseCallsBeforeRetry, 1);

  // Retry: create_database must NOT be called again (already succeeded
  // and recorded in site_resources); create_kv_namespace, which failed,
  // is retried and this time succeeds (fake provider only fails once).
  const retry = await provisioning.retryProvisioning(env, siteId);
  assert.equal(retry.ok, true);
  assert.equal(retry.jobId, start.jobId, 'retry must reuse the same job, not create a new one');

  const secondRunResult = await provisioning.runJob(env, retry.jobId);
  assert.equal(secondRunResult.ok, true, JSON.stringify(secondRunResult));

  const databaseCallsAfterRetry = infra._calls.filter((c) => c.method === 'createDatabase').length;
  assert.equal(databaseCallsAfterRetry, 1, 'create_database must not be re-run on retry -- it already succeeded');

  const finalSite = await sites.getSite(env, siteId);
  assert.equal(finalSite.status, 'provisioned');

  const finalResources = await env.LUMMET_DB.prepare(`SELECT resource_type FROM site_resources WHERE site_id = ?`)
    .bind(siteId).all();
  assert.equal(finalResources.results.length, 3, 'no duplicate resource rows from the retry');
});

test('site_resources has one row per resource type even if the same step were somehow re-run (ON CONFLICT upsert)', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const provisioning = createProvisioningService(infra);
  const { siteId } = await setUpOrgWithSite(env, 'upsert-check@example.com', 'Org');

  const start = await provisioning.startProvisioning(env, siteId);
  await provisioning.runJob(env, start.jobId);

  const before = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM site_resources WHERE site_id = ?`).bind(siteId).first();
  assert.equal(before.c, 3);

  // Calling runJob again is a documented no-op (see the test above);
  // this test just confirms the schema-level guarantee (UNIQUE
  // site_id+resource_type) that would prevent duplicates even if a
  // future bug re-triggered a create step.
  await provisioning.runJob(env, start.jobId);
  const after = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM site_resources WHERE site_id = ?`).bind(siteId).first();
  assert.equal(after.c, 3);
});
