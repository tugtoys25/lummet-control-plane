// test/usage.test.js
//
// Covers worker/usage.js against a real SQLite schema (D1 shim) --
// confirms every reported number is a real COUNT() against data
// Phases 1-4 actually created, not an estimate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import { getUsageSnapshot } from '../worker/usage.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import { createDomainService } from '../worker/domains.js';
import { createFakeDnsResolver } from './support/fake-dns-resolver.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.50' }
  };
}

test('an organization with no subscription shows zero limits and unmetered fields as null, not zero', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('no-sub-usage@example.com'), env);

  const usage = await getUsageSnapshot(env, signup.organizationId);
  assert.equal(usage.sites.used, 0);
  assert.equal(usage.sites.limit, 0);
  assert.equal(usage.users.used, 1, 'the signing-up owner counts as one member');
  assert.equal(usage.storageMb.used, null, 'storage is not metered yet -- must be null, not a fake zero');
});

test('sites/users/domains usage reflects real counts as they change', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('growing-org@example.com'), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter'); // sites.max = 1, users.max = 2

  const before = await getUsageSnapshot(env, signup.organizationId);
  assert.equal(before.sites.used, 0);
  assert.equal(before.sites.limit, 1);
  assert.equal(before.users.used, 1);
  assert.equal(before.users.limit, 2);
  assert.equal(before.customDomains.used, 0);
  assert.equal(before.customDomains.limit, 1);

  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const afterSite = await getUsageSnapshot(env, signup.organizationId);
  assert.equal(afterSite.sites.used, 1);

  const dns = createFakeDnsResolver();
  const infra = createFakeInfraProvider();
  const domainService = createDomainService({ dns, infra });
  const added = await domainService.addDomain(env, { siteId: site.siteId, hostname: 'usage-check.example' });

  const afterPendingDomain = await getUsageSnapshot(env, signup.organizationId);
  assert.equal(afterPendingDomain.customDomains.used, 1, 'a non-removed domain counts toward usage even before it is verified/active');

  await domainService.removeDomain(env, added.domainId);
  const afterRemovedDomain = await getUsageSnapshot(env, signup.organizationId);
  assert.equal(afterRemovedDomain.customDomains.used, 0, 'a removed domain must not count toward usage');
});

test('feature flags in the snapshot mirror resolved entitlements exactly', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('features-usage@example.com'), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');

  const usage = await getUsageSnapshot(env, signup.organizationId);
  assert.equal(usage.features.analyticsLevel, 'basic');
  assert.equal(usage.features.affiliateEnabled, false);
  assert.equal(usage.features.reportsEnabled, false);
  assert.equal(usage.features.alertsEnabled, false);

  await env.LUMMET_DB.prepare(
    `INSERT INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter', 'affiliate.enabled', 'boolean', 'true')
     ON CONFLICT(plan_id, key) DO UPDATE SET value = 'true'`
  ).run();

  const updatedUsage = await getUsageSnapshot(env, signup.organizationId);
  assert.equal(updatedUsage.features.affiliateEnabled, true);
});
