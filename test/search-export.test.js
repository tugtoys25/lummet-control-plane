// test/search-export.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import { searchOrganization } from '../worker/search.js';
import { exportOrganizationData } from '../worker/export.js';
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
    headers: { get: () => '203.0.113.80' }
  };
}

// -----------------------------------------------------
// Search
// -----------------------------------------------------

test('searchOrganization finds matching sites, domains, and members', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('search-owner@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Freewin Casino News', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const dns = createFakeDnsResolver();
  const infra = createFakeInfraProvider();
  const domainService = createDomainService({ dns, infra });
  await domainService.addDomain(env, { siteId: site.siteId, hostname: 'freewin-search.example' });

  const bySite = await searchOrganization(env, signup.organizationId, 'freewin');
  assert.equal(bySite.sites.length, 1);
  assert.equal(bySite.sites[0].id, site.siteId);
  assert.equal(bySite.domains.length, 1);
  assert.equal(bySite.domains[0].hostname, 'freewin-search.example');

  const byMember = await searchOrganization(env, signup.organizationId, 'search-owner@example.com');
  assert.equal(byMember.members.length, 1);
  assert.equal(byMember.members[0].email, 'search-owner@example.com');

  const noMatch = await searchOrganization(env, signup.organizationId, 'totally-unrelated-query-xyz');
  assert.deepEqual(noMatch, { sites: [], domains: [], members: [] });
});

test('searchOrganization never returns another organization\'s data', async () => {
  const env = makeEnv();
  const orgA = await customerAuth.signUp(fakeSignupRequest('search-isolation-a@example.com'), env);
  const orgB = await customerAuth.signUp(fakeSignupRequest('search-isolation-b@example.com'), env);
  await sites.createSite(env, {
    organizationId: orgB.organizationId, name: 'Shared Keyword Site', productId: 'prod_casino_news', actorUserId: orgB.userId
  });

  const result = await searchOrganization(env, orgA.organizationId, 'Shared Keyword');
  assert.equal(result.sites.length, 0, 'org A must never see org B\'s site in search results');
});

test('searchOrganization returns empty results for an empty or whitespace-only query', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('search-empty-query@example.com'), env);
  await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Some Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const result = await searchOrganization(env, signup.organizationId, '   ');
  assert.deepEqual(result, { sites: [], domains: [], members: [] });
});

// -----------------------------------------------------
// Export
// -----------------------------------------------------

test('exportOrganizationData returns a complete, real snapshot with no secrets, and null for an unknown org', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('export-owner@example.com'), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Export Test Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });

  const dns = createFakeDnsResolver();
  const infra = createFakeInfraProvider();
  const domainService = createDomainService({ dns, infra });
  await domainService.addDomain(env, { siteId: site.siteId, hostname: 'export-check.example' });

  const data = await exportOrganizationData(env, signup.organizationId);

  assert.equal(data.organization.name, 'Org');
  assert.equal(data.members.length, 1);
  assert.equal(data.members[0].email, 'export-owner@example.com');
  assert.equal(data.sites.length, 1);
  assert.equal(data.sites[0].name, 'Export Test Site');
  assert.equal(data.sites[0].domains.length, 1);
  assert.equal(data.sites[0].domains[0].hostname, 'export-check.example');
  assert.equal(data.subscription.status, 'trialing');

  const serialized = JSON.stringify(data);
  assert.doesNotMatch(serialized, /password_hash/);
  assert.doesNotMatch(serialized, /key_hash/);
  assert.doesNotMatch(serialized, /encrypted_secret/);
  assert.doesNotMatch(serialized, /correct-horse-battery/);

  const missing = await exportOrganizationData(env, 'org-does-not-exist');
  assert.equal(missing, null);
});

test('exportOrganizationData reports no subscription as null, not a fabricated one', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('export-no-sub@example.com'), env);

  const data = await exportOrganizationData(env, signup.organizationId);
  assert.equal(data.subscription, null);
  assert.deepEqual(data.sites, []);
});
