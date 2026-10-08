// test/webhook-integration.test.js
//
// webhooks.test.js covers webhooks.js in isolation; this file covers
// the actual WIRING -- that sites.js/provisioning.js/domains.js
// genuinely call webhooks.dispatchEvent() at the right moments, not
// just that dispatchEvent() itself works. Uses the same fake-fetch
// technique as webhooks.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createFakeDnsResolver } from './support/fake-dns-resolver.js';

import * as webhooks from '../worker/webhooks.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDomainService } from '../worker/domains.js';

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
    headers: { get: () => '203.0.113.90' }
  };
}

function withFakeFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

test('creating a site fires site.created to a subscribed webhook', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('wire-site-created@example.com'), env);
  await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: ['site.created']
  });

  const received = [];
  const restore = withFakeFetch(async (url, opts) => { received.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; });
  try {
    await sites.createSite(env, {
      organizationId: signup.organizationId, name: 'Wired Site', productId: 'prod_casino_news', actorUserId: signup.userId
    });
  } finally {
    restore();
  }

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'site.created');
  assert.equal(received[0].data.name, 'Wired Site');
});

test('a full provisioning run fires site.provisioned', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  const signup = await customerAuth.signUp(fakeSignupRequest('wire-provisioned@example.com'), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: ['site.provisioned', 'site.failed']
  });

  const received = [];
  const restore = withFakeFetch(async (url, opts) => { received.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; });
  try {
    const provisioning = createProvisioningService(infra);
    const start = await provisioning.startProvisioning(env, site.siteId);
    await provisioning.runJob(env, start.jobId);
  } finally {
    restore();
  }

  const types = received.map((e) => e.type);
  assert.deepEqual(types, ['site.provisioned']);
});

test('a provisioning failure fires site.failed, not site.provisioned', async () => {
  const env = makeEnv();
  const infra = createFakeInfraProvider();
  infra._failNextCall('createDatabase', 'simulated outage');
  const signup = await customerAuth.signUp(fakeSignupRequest('wire-failed@example.com'), env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: ['site.provisioned', 'site.failed']
  });

  const received = [];
  const restore = withFakeFetch(async (url, opts) => { received.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; });
  try {
    const provisioning = createProvisioningService(infra);
    const start = await provisioning.startProvisioning(env, site.siteId);
    await provisioning.runJob(env, start.jobId);
  } finally {
    restore();
  }

  assert.deepEqual(received.map((e) => e.type), ['site.failed']);
});

test('a domain reaching active SSL fires domain.verified', async () => {
  const env = makeEnv();
  const dns = createFakeDnsResolver();
  const infra = createFakeInfraProvider();
  const domainService = createDomainService({ dns, infra });

  const signup = await customerAuth.signUp(fakeSignupRequest('wire-domain@example.com'), env);
  const site = await sites.createSite(env, {
    organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId
  });
  await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: ['domain.verified']
  });

  const added = await domainService.addDomain(env, { siteId: site.siteId, hostname: 'wired-domain.example' });
  dns._setTXTRecords('_lummet-verify.wired-domain.example', [added.dnsInstructions.value]);
  await domainService.verifyDns(env, added.domainId);
  await domainService.requestSsl(env, added.domainId);
  const domain = await domainService.getDomain(env, added.domainId);
  infra._setCustomHostnameStatus(domain.ssl_resource_id, 'active');

  const received = [];
  const restore = withFakeFetch(async (url, opts) => { received.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; });
  try {
    await domainService.checkSsl(env, added.domainId);
  } finally {
    restore();
  }

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'domain.verified');
  assert.equal(received[0].data.hostname, 'wired-domain.example');
});
