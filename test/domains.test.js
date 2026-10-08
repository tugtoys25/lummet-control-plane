// test/domains.test.js
//
// Covers worker/domains.js against a real SQLite schema (D1 shim), a
// fake DNS resolver, and the fake infra provider standing in for
// Cloudflare's custom-hostname SSL API -- no network needed, since
// none of this is DNS/Cloudflare-shape-specific (that part is
// covered narrowly wherever it's pure/testable, same as
// billing-stripe.test.js's signature verification).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeDnsResolver } from './support/fake-dns-resolver.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';

import { createDomainService } from '../worker/domains.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email, organizationName) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName }; },
    headers: { get: () => '203.0.113.20' }
  };
}

async function setUpOrgWithSite(env, email) {
  const signup = await customerAuth.signUp(fakeSignupRequest(email, 'Org'), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  return { signup, siteId: site.siteId };
}

function makeServices() {
  const dns = createFakeDnsResolver();
  const infra = createFakeInfraProvider();
  return { dns, infra, domainService: createDomainService({ dns, infra }) };
}

// -----------------------------------------------------
// addDomain
// -----------------------------------------------------

test('addDomain rejects a malformed hostname and returns real DNS instructions for a valid one', async () => {
  const env = makeEnv();
  const { domainService } = makeServices();
  const { siteId } = await setUpOrgWithSite(env, 'add-domain@example.com');

  const bad = await domainService.addDomain(env, { siteId, hostname: 'not a hostname!!' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_hostname');

  const good = await domainService.addDomain(env, { siteId, hostname: 'Example.COM' });
  assert.equal(good.ok, true);
  assert.equal(good.hostname, 'example.com', 'hostname must be normalized to lowercase');
  assert.equal(good.dnsInstructions.type, 'TXT');
  assert.equal(good.dnsInstructions.name, '_lummet-verify.example.com');
  assert.ok(good.dnsInstructions.value.includes('lummet-site-verification='));
});

test('addDomain refuses a hostname already attached to any site, including a different organization\'s', async () => {
  const env = makeEnv();
  const { domainService } = makeServices();
  const siteA = await setUpOrgWithSite(env, 'domain-owner-a@example.com');
  const siteB = await setUpOrgWithSite(env, 'domain-owner-b@example.com');

  const first = await domainService.addDomain(env, { siteId: siteA.siteId, hostname: 'shared-domain.example' });
  assert.equal(first.ok, true);

  const second = await domainService.addDomain(env, { siteId: siteB.siteId, hostname: 'shared-domain.example' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'hostname_already_in_use');
});

// -----------------------------------------------------
// DNS verification
// -----------------------------------------------------

test('verifyDns returns not-verified when the TXT record is absent, and succeeds once it matches', async () => {
  const env = makeEnv();
  const { dns, domainService } = makeServices();
  const { siteId } = await setUpOrgWithSite(env, 'verify-flow@example.com');

  const added = await domainService.addDomain(env, { siteId, hostname: 'verify-flow.example' });

  const beforePropagation = await domainService.verifyDns(env, added.domainId);
  assert.equal(beforePropagation.ok, true);
  assert.equal(beforePropagation.verified, false);

  const domainAfterFailedCheck = await domainService.getDomain(env, added.domainId);
  assert.equal(domainAfterFailedCheck.status, 'pending', 'an unverified check must not advance status');

  dns._setTXTRecords('_lummet-verify.verify-flow.example', [added.dnsInstructions.value]);

  const afterPropagation = await domainService.verifyDns(env, added.domainId);
  assert.equal(afterPropagation.verified, true);

  const domainAfterSuccess = await domainService.getDomain(env, added.domainId);
  assert.equal(domainAfterSuccess.status, 'dns_verified');
  assert.ok(domainAfterSuccess.dns_verified_at);
});

test('verifyDns does not match an unrelated TXT value at the same host', async () => {
  const env = makeEnv();
  const { dns, domainService } = makeServices();
  const { siteId } = await setUpOrgWithSite(env, 'wrong-txt@example.com');

  const added = await domainService.addDomain(env, { siteId, hostname: 'wrong-txt.example' });
  dns._setTXTRecords('_lummet-verify.wrong-txt.example', ['some-other-unrelated-value']);

  const result = await domainService.verifyDns(env, added.domainId);
  assert.equal(result.verified, false);
});

// -----------------------------------------------------
// SSL lifecycle
// -----------------------------------------------------

test('requestSsl and checkSsl only advance the domain to active once Cloudflare actually reports it active', async () => {
  const env = makeEnv();
  const { dns, infra, domainService } = makeServices();
  const { siteId } = await setUpOrgWithSite(env, 'ssl-flow@example.com');

  const added = await domainService.addDomain(env, { siteId, hostname: 'ssl-flow.example' });
  dns._setTXTRecords('_lummet-verify.ssl-flow.example', [added.dnsInstructions.value]);
  await domainService.verifyDns(env, added.domainId);

  const requested = await domainService.requestSsl(env, added.domainId);
  assert.equal(requested.ok, true);

  const domainAfterRequest = await domainService.getDomain(env, added.domainId);
  assert.equal(domainAfterRequest.status, 'ssl_pending');
  assert.equal(domainAfterRequest.ssl_status, 'pending');
  assert.ok(domainAfterRequest.ssl_resource_id);

  const stillPending = await domainService.checkSsl(env, added.domainId);
  assert.equal(stillPending.sslStatus, 'pending');
  const domainStillPending = await domainService.getDomain(env, added.domainId);
  assert.equal(domainStillPending.status, 'ssl_pending', 'must not advance to active just because it was checked');

  infra._setCustomHostnameStatus(domainAfterRequest.ssl_resource_id, 'active');
  const nowActive = await domainService.checkSsl(env, added.domainId);
  assert.equal(nowActive.sslStatus, 'active');

  const domainActive = await domainService.getDomain(env, added.domainId);
  assert.equal(domainActive.status, 'active');
  assert.ok(domainActive.ssl_verified_at);
});

test('checkSsl marks the domain failed when Cloudflare reports SSL failure', async () => {
  const env = makeEnv();
  const { dns, infra, domainService } = makeServices();
  const { siteId } = await setUpOrgWithSite(env, 'ssl-failure@example.com');

  const added = await domainService.addDomain(env, { siteId, hostname: 'ssl-failure.example' });
  dns._setTXTRecords('_lummet-verify.ssl-failure.example', [added.dnsInstructions.value]);
  await domainService.verifyDns(env, added.domainId);
  await domainService.requestSsl(env, added.domainId);

  const domain = await domainService.getDomain(env, added.domainId);
  infra._setCustomHostnameStatus(domain.ssl_resource_id, 'active_but_never_actually_a_real_status_meaning_failed');

  const result = await domainService.checkSsl(env, added.domainId);
  assert.equal(result.sslStatus, 'failed');
  const failedDomain = await domainService.getDomain(env, added.domainId);
  assert.equal(failedDomain.status, 'failed');
});

// -----------------------------------------------------
// Primary domain assignment + removal
// -----------------------------------------------------

test('setPrimary refuses a domain that is not active yet, and succeeds once it is, updating the site record', async () => {
  const env = makeEnv();
  const { dns, infra, domainService } = makeServices();
  const { siteId } = await setUpOrgWithSite(env, 'set-primary@example.com');

  const added = await domainService.addDomain(env, { siteId, hostname: 'set-primary.example' });

  const tooEarly = await domainService.setPrimary(env, siteId, added.domainId);
  assert.equal(tooEarly.ok, false);
  assert.equal(tooEarly.error, 'domain_not_active');

  dns._setTXTRecords('_lummet-verify.set-primary.example', [added.dnsInstructions.value]);
  await domainService.verifyDns(env, added.domainId);
  await domainService.requestSsl(env, added.domainId);
  const domain = await domainService.getDomain(env, added.domainId);
  infra._setCustomHostnameStatus(domain.ssl_resource_id, 'active');
  await domainService.checkSsl(env, added.domainId);

  const result = await domainService.setPrimary(env, siteId, added.domainId);
  assert.equal(result.ok, true);

  const site = await sites.getSite(env, siteId);
  assert.equal(site.primary_domain, 'set-primary.example');

  const domainRow = await domainService.getDomain(env, added.domainId);
  assert.equal(domainRow.is_primary, 1);
});

test('removeDomain clears the site primary_domain if the removed domain was primary, and best-effort deletes the SSL resource', async () => {
  const env = makeEnv();
  const { dns, infra, domainService } = makeServices();
  const { siteId } = await setUpOrgWithSite(env, 'remove-primary@example.com');

  const added = await domainService.addDomain(env, { siteId, hostname: 'remove-primary.example' });
  dns._setTXTRecords('_lummet-verify.remove-primary.example', [added.dnsInstructions.value]);
  await domainService.verifyDns(env, added.domainId);
  await domainService.requestSsl(env, added.domainId);
  const domain = await domainService.getDomain(env, added.domainId);
  infra._setCustomHostnameStatus(domain.ssl_resource_id, 'active');
  await domainService.checkSsl(env, added.domainId);
  await domainService.setPrimary(env, siteId, added.domainId);

  const removed = await domainService.removeDomain(env, added.domainId);
  assert.equal(removed.ok, true);

  const site = await sites.getSite(env, siteId);
  assert.equal(site.primary_domain, null);

  const deleteCall = infra._calls.find((c) => c.method === 'deleteCustomHostname');
  assert.ok(deleteCall);
  assert.equal(deleteCall.resourceId, domain.ssl_resource_id);

  const domainRow = await domainService.getDomain(env, added.domainId);
  assert.equal(domainRow.status, 'removed');

  // A removed hostname frees the global uniqueness constraint back up.
  const readded = await domainService.addDomain(env, { siteId, hostname: 'remove-primary.example' });
  assert.equal(readded.ok, true);
});
