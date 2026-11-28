// test/custom-hosting.test.js
//
// Customer-owned Cloudflare hosting (worker/custom-hosting.js and friends), end to end against the real schema and the fake
// infra provider: access gating, account storage that never exposes a secret, creating + provisioning + deploying a site in
// a customer's account with a scoped env, Lummet-hosted sites staying exactly as they were, teardown, and moving an existing
// site into a customer's account.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';

import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import { createTransferService } from '../worker/custom-hosting-transfer.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as hosting from '../worker/custom-hosting.js';

const PLATFORM_ACCOUNT = 'platform-account';
const PLATFORM_TOKEN = 'platform-token-value';
const PLATFORM_TURNSTILE = 'platform-turnstile-secret-value';
const hex32 = () => crypto.randomUUID().replace(/-/g, '');
const TOKEN = 'tok_' + 'Ab9'.repeat(12);              // matches the token shape check, obviously not a real token
const SCRIPT = 'export default { fetch() { return new Response("ok"); } };';

function makeEnv(extra = {}) {
  const db = createTestDb();
  applyMigrations(db);
  return {
    LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    CF_ACCOUNT_ID: PLATFORM_ACCOUNT, CF_API_TOKEN: PLATFORM_TOKEN, TURNSTILE_SECRET: PLATFORM_TURNSTILE, TURNSTILE_SITEKEY: 'platform-sitekey',
    CUSTOM_HOSTING: 'on', ...extra
  };
}

/** The fake provider, wrapped so every call records which Cloudflare account (and token) it ran with. */
function recordingInfra() {
  const fake = createFakeInfraProvider();
  const seen = [];
  const infra = new Proxy(fake, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function' || String(prop).startsWith('_')) return v;
      return (...args) => { seen.push({ method: prop, account: args[0]?.CF_ACCOUNT_ID, token: args[0]?.CF_API_TOKEN }); return v.apply(target, args); };
    }
  });
  return { fake, infra, seen };
}

function signupRequest(email) {
  return { async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.40' } };
}

async function setUpOrg(env, email, { allow = true } = {}) {
  const s = await customerAuth.signUp(signupRequest(email), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  if (allow) await hosting.setOrganizationAccess(env, { organization: s.organizationId, mode: 'allow', note: 'test', actorId: 1 });
  return s;
}

async function addVerifiedAccount(env, infra, org, cfAccountId = hex32()) {
  const r = await hosting.addAccount(env, { organizationId: org.organizationId, actorUserId: org.userId, infra, input: { label: 'Main', accountId: cfAccountId, apiToken: TOKEN } });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { id: r.account.id, cfAccountId, result: r };
}

async function provisionAndDeploy(env, infra, siteId) {
  const prov = createProvisioningService(infra);
  const start = await prov.startProvisioning(env, siteId);
  const p = await prov.runJob(env, start.jobId);
  assert.equal(p.ok, true, JSON.stringify(p));
  const deps = createDeploymentService(infra);
  const d = await deps.startDeployment(env, { siteId, version: '1.0.0', migrations: [], scriptContent: SCRIPT });
  assert.equal(d.ok, true, JSON.stringify(d));
  const run = await deps.runJob(env, d.jobId);
  return { run, deps };
}

// ------------------------------------------------------------------ access

test('access: off by default, platform switch + allow/deny per organization; Lummet hosting never needs it', async () => {
  const env = makeEnv({ CUSTOM_HOSTING: undefined });
  const org = await setUpOrg(env, 'gate@example.com', { allow: false });
  let a = await hosting.accessFor(env, org.organizationId);
  assert.equal(a.enabled, false);
  assert.equal(a.reason, 'feature_off');

  env.CUSTOM_HOSTING = 'on';
  a = await hosting.accessFor(env, org.organizationId);
  assert.equal(a.enabled, false);
  assert.equal(a.reason, 'not_in_plan');

  await hosting.setOrganizationAccess(env, { organization: org.organizationId, mode: 'allow', note: '', actorId: 1 });
  assert.equal((await hosting.accessFor(env, org.organizationId)).enabled, true);

  await hosting.setOrganizationAccess(env, { organization: org.organizationId, mode: 'deny', note: '', actorId: 1 });
  a = await hosting.accessFor(env, org.organizationId);
  assert.equal(a.enabled, false);
  assert.equal(a.reason, 'organization_denied');

  const { infra } = recordingInfra();
  await assert.rejects(
    hosting.addAccount(env, { organizationId: org.organizationId, actorUserId: org.userId, infra, input: { label: 'x', accountId: hex32(), apiToken: TOKEN } }),
    (e) => e.code === 'custom_hosting_not_available'
  );
  // The create form offers nothing when access is off.
  assert.equal(await hosting.createFormData(env, org.organizationId), null);
});

// ------------------------------------------------------------------ accounts and secrets

test('accounts: the token is verified before anything is stored, encrypted at rest, and never in a view', async () => {
  const env = makeEnv();
  const { fake, infra } = recordingInfra();
  const org = await setUpOrg(env, 'acct@example.com');

  const bad = await hosting.addAccount(env, { organizationId: org.organizationId, actorUserId: org.userId, infra, input: { label: 'x', accountId: 'nope', apiToken: TOKEN } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'invalid_account_id');

  fake._badTokens.add(TOKEN);
  const refused = await hosting.addAccount(env, { organizationId: org.organizationId, actorUserId: org.userId, infra, input: { label: 'x', accountId: hex32(), apiToken: TOKEN } });
  assert.equal(refused.error, 'token_invalid');
  assert.equal((await hosting.listAccounts(env, org.organizationId)).length, 0);
  fake._badTokens.clear();

  const { id, result } = await addVerifiedAccount(env, infra, org);
  assert.equal(result.account.status, 'verified');
  const views = JSON.stringify([result, await hosting.listAccounts(env, org.organizationId), await hosting.getAccountView(env, org.organizationId, id)]);
  assert.ok(!views.includes(TOKEN), 'a view leaked the API token');

  const rows = await env.LUMMET_DB.prepare('SELECT * FROM custom_hosting_secrets').all();
  assert.ok(rows.results.length >= 1);
  assert.ok(!JSON.stringify(rows.results).includes(TOKEN), 'the token is stored in clear text');
  assert.equal(await hosting.__internal.readSecret(env, 'account', id, 'api_token'), TOKEN);

  // Missing a required permission: stored but not usable for a site.
  const second = hex32();
  fake._missingPerms.set(second, ['d1']);
  const weak = await hosting.addAccount(env, { organizationId: org.organizationId, actorUserId: org.userId, infra, input: { label: 'Weak', accountId: second, apiToken: TOKEN } });
  assert.equal(weak.account.status, 'invalid');
  assert.ok(weak.check.missing.includes('d1'));
  const plan = await hosting.planHosting(env, { organizationId: org.organizationId, infra, choice: { accountId: weak.account.id, landing: 'workers_dev' } });
  assert.equal(plan.error, 'hosting_account_not_verified');
});

// ------------------------------------------------------------------ create, provision, deploy

test('a site created for a customer account is provisioned and deployed entirely with that account, without platform secrets', async () => {
  const env = makeEnv();
  const { fake, infra, seen } = recordingInfra();
  const org = await setUpOrg(env, 'custom@example.com');
  const { id: accountRef, cfAccountId } = await addVerifiedAccount(env, infra, org);

  const created = await sites.createSite(env, {
    organizationId: org.organizationId, name: 'Own site', productId: 'prod_casino_news', actorUserId: org.userId,
    hosting: { mode: 'custom', accountId: accountRef, landing: 'workers_dev' }, hostingInfra: infra
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.match(created.hosting.host, /\.fake-sub\.workers\.dev$/);

  const before = seen.length;
  const { run } = await provisionAndDeploy(env, infra, created.siteId);
  assert.equal(run.ok, true, JSON.stringify(run));
  assert.equal((await sites.getSite(env, created.siteId)).status, 'active');

  const siteCalls = seen.slice(before).filter((c) => c.account !== undefined);
  assert.ok(siteCalls.length > 5);
  for (const c of siteCalls) {
    assert.equal(c.account, cfAccountId, `${c.method} ran against ${c.account}`);
    assert.notEqual(c.token, PLATFORM_TOKEN);
  }
  for (const m of ['createDatabase', 'createKVNamespace', 'createR2Bucket', 'uploadWorkerScript', 'setWorkersDevEnabled', 'createTurnstileWidget']) {
    assert.ok(siteCalls.some((c) => c.method === m), `${m} was not called`);
  }
  assert.ok(!siteCalls.some((c) => c.method === 'ensureWorkerRoute'), 'no platform route for a custom-hosted site');

  const upload = fake._calls.filter((c) => c.method === 'uploadWorkerScript').at(-1);
  const text = JSON.stringify(upload.bindings);
  assert.ok(!text.includes(PLATFORM_TURNSTILE), 'the platform Turnstile secret was shipped to a customer account');
  const sitekey = upload.bindings.find((b) => b.name === 'TURNSTILE_SITEKEY');
  assert.match(sitekey.text, /^0xFAKESITEKEY/);
  assert.ok(upload.bindings.some((b) => b.name === 'LUMMET_HOSTING' && b.text === 'custom'));

  // Removing an account a site uses is refused.
  const rm = await hosting.removeAccount(env, { organizationId: org.organizationId, id: accountRef });
  assert.equal(rm.ok, false);
  assert.equal(rm.error, 'account_in_use');

  // Switching access off later keeps the site deployable.
  await hosting.setOrganizationAccess(env, { organization: org.organizationId, mode: 'deny', note: '', actorId: 1 });
  const again = createDeploymentService(infra);
  const d2 = await again.startDeployment(env, { siteId: created.siteId, version: '1.0.1', migrations: [], scriptContent: SCRIPT });
  assert.equal(d2.ok, true, JSON.stringify(d2));
  assert.equal((await again.runJob(env, d2.jobId)).ok, true);
  assert.equal((await hosting.accessFor(env, org.organizationId)).inUse, true);
});

test('a custom-domain site attaches a Workers Custom Domain in the customer zone; a taken hostname is refused', async () => {
  const env = makeEnv();
  const { fake, infra } = recordingInfra();
  const org = await setUpOrg(env, 'domain@example.com');
  const { id: accountRef } = await addVerifiedAccount(env, infra, org);
  const zoneId = fake._seedZone('own-domain.test', { zoneId: hex32() });

  const choice = { mode: 'custom', accountId: accountRef, landing: 'custom_domain', zoneId, subdomain: 'news' };
  const created = await sites.createSite(env, { organizationId: org.organizationId, name: 'Domain site', productId: 'prod_casino_news', actorUserId: org.userId, hosting: choice, hostingInfra: infra });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(created.hosting.host, 'news.own-domain.test');

  const { run } = await provisionAndDeploy(env, infra, created.siteId);
  assert.equal(run.ok, true, JSON.stringify(run));
  const attach = fake._calls.find((c) => c.method === 'attachWorkerDomain');
  assert.equal(attach.hostname, 'news.own-domain.test');
  assert.equal(attach.zoneId, zoneId);

  const dup = await sites.createSite(env, { organizationId: org.organizationId, name: 'Dup', productId: 'prod_casino_news', actorUserId: org.userId, hosting: choice, hostingInfra: infra });
  assert.equal(dup.ok, false);
  assert.equal(dup.error, 'hostname_taken');

  // Another subdomain of the same zone is fine.
  const other = await sites.createSite(env, { organizationId: org.organizationId, name: 'Other', productId: 'prod_casino_news', actorUserId: org.userId, hosting: { ...choice, subdomain: 'blog' }, hostingInfra: infra });
  assert.equal(other.ok, true, JSON.stringify(other));
});

test('Lummet-hosted sites are untouched: platform account, platform secrets, no hosting row', async () => {
  const env = makeEnv();
  const { fake, infra, seen } = recordingInfra();
  const org = await setUpOrg(env, 'lummet@example.com');
  await addVerifiedAccount(env, infra, org);          // having an account changes nothing for a normal site

  const created = await sites.createSite(env, { organizationId: org.organizationId, name: 'Normal', productId: 'prod_casino_news', actorUserId: org.userId });
  assert.equal(created.ok, true, JSON.stringify(created));
  assert.equal(await hosting.isCustomHosted(env, created.siteId), false);

  const before = seen.length;
  const { run } = await provisionAndDeploy(env, infra, created.siteId);
  assert.equal(run.ok, true, JSON.stringify(run));
  for (const c of seen.slice(before).filter((x) => x.account !== undefined)) assert.equal(c.account, PLATFORM_ACCOUNT, c.method);
  assert.ok(!fake._calls.slice(0).some((c) => c.method === 'createTurnstileWidget' && c.accountId === PLATFORM_ACCOUNT));
});

test('a failure in one customer account fails only that site; other customers and Lummet sites carry on', async () => {
  const env = makeEnv();
  const { fake, infra } = recordingInfra();
  const org = await setUpOrg(env, 'iso@example.com');
  const other = await setUpOrg(env, 'iso-other@example.com');
  const { id: accountRef } = await addVerifiedAccount(env, infra, org);
  const custom = await sites.createSite(env, { organizationId: org.organizationId, name: 'Custom one', productId: 'prod_casino_news', actorUserId: org.userId, hosting: { mode: 'custom', accountId: accountRef, landing: 'workers_dev' }, hostingInfra: infra });
  assert.equal(custom.ok, true, JSON.stringify(custom));
  const normal = await sites.createSite(env, { organizationId: other.organizationId, name: 'Normal one', productId: 'prod_casino_news', actorUserId: other.userId });
  assert.equal(normal.ok, true, JSON.stringify(normal));

  const prov = createProvisioningService(infra);
  fake._failNextCall('createDatabase', 'Authentication error');
  const s1 = await prov.startProvisioning(env, custom.siteId);
  assert.equal(s1.ok, true, JSON.stringify(s1));
  const r1 = await prov.runJob(env, s1.jobId);
  assert.equal(r1.ok, false);
  const s2 = await prov.startProvisioning(env, normal.siteId);
  const r2 = await prov.runJob(env, s2.jobId);
  assert.equal(r2.ok, true, JSON.stringify({ r2, s2 }));
  assert.equal((await sites.getSite(env, normal.siteId)).status, 'provisioned');
});

// ------------------------------------------------------------------ moving an existing site

test('an existing Lummet site moves into the customer account with its media, cache and database', async () => {
  const env = makeEnv({ CUSTOM_HOSTING_POLL_MS: '0' });
  const { fake, infra } = recordingInfra();
  const org = await setUpOrg(env, 'move@example.com');
  const { id: accountRef, cfAccountId } = await addVerifiedAccount(env, infra, org);

  const created = await sites.createSite(env, { organizationId: org.organizationId, name: 'Mover', productId: 'prod_casino_news', actorUserId: org.userId });
  const { run } = await provisionAndDeploy(env, infra, created.siteId);
  assert.equal(run.ok, true, JSON.stringify(run));

  const res = await env.LUMMET_DB.prepare('SELECT resource_type AS type, resource_id FROM site_resources WHERE site_id = ?').bind(created.siteId).all();
  const byType = Object.fromEntries(res.results.map((r) => [r.type, r.resource_id]));
  fake._r2.set(byType.r2, new Map([['img/a.png', { body: new Uint8Array([1, 2, 3]), contentType: 'image/png' }]]));
  fake._kv.set(byType.kv, new Map([['k1', 'v1']]));
  fake._d1Dumps.set(byType.d1, 'CREATE TABLE posts (id); INSERT INTO posts VALUES (1);');

  // The release the site runs, as the template store would return it (deploy_target redeploys that same release).
  const templateService = {
    async getReleaseByVersion(_env, version) { return { ok: true, version, scriptContent: SCRIPT }; },
    async getCurrentReleaseForSite() { return { ok: true, version: '1.0.0', scriptContent: SCRIPT }; },
    async readAsset() { return null; }
  };
  const access = { async freeze() {}, async unfreeze() {} };   // the tenant push is covered in custom-hosting-hardening.test.js
  const transfers = createTransferService(infra, { templateService, access });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId: created.siteId, actorUserId: org.userId, choice: { accountId: accountRef, landing: 'workers_dev' } });
  assert.equal(start.ok, true, JSON.stringify(start));
  // Until the switch the site still runs on Lummet.
  assert.equal(await hosting.contextForSite(env, created.siteId), null);

  let r;
  for (let i = 0; i < 20; i++) {
    r = await transfers.runJob(env, start.jobId, { budgetMs: 600000 });
    if (!r?.paused) break;
  }
  assert.equal(r.ok, true, JSON.stringify(r));

  const view = await transfers.transferView(env, created.siteId);
  assert.equal(view.status, 'completed', JSON.stringify(view));
  const ctx = await hosting.contextForSite(env, created.siteId);
  assert.equal(ctx.account.cf_account_id, cfAccountId);

  const r2Puts = fake._calls.filter((c) => c.method === 'putR2Object');
  assert.ok(r2Puts.some((c) => c.key === 'img/a.png' && c.accountId === cfAccountId));
  assert.ok(fake._calls.some((c) => c.method === 'putKvBulk' && c.accountId === cfAccountId && c.count === 1));
  const imp = fake._calls.find((c) => c.method === 'importD1Sql');
  assert.equal(imp.accountId, cfAccountId);
  assert.match(fake._d1Dumps.get(imp.databaseId), /INSERT INTO posts/);
  assert.ok(fake._calls.some((c) => c.method === 'deleteWorkerScript'), 'the old Lummet Worker is removed at switch-over');
  assert.match((await sites.getSite(env, created.siteId)).primary_domain || '', /workers\.dev$/);
});

// ------------------------------------------------------------------ customer API

test('customer API: 404 while the organization has no access; never returns a secret; members cannot change accounts', async () => {
  const { handleCustomHostingRoute } = await import('../worker/custom-hosting-api.js');
  const { __setInfraProviderForTests } = await import('../worker/custom-hosting-transfer.js');
  const env = makeEnv();
  const { infra } = recordingInfra();
  __setInfraProviderForTests(infra);
  try {
    const org = await setUpOrg(env, 'api@example.com', { allow: false });
    const audits = [];
    const call = (method, sub, bodyObj, role = 'owner') => handleCustomHostingRoute({
      env, method, path: `/api/organizations/${org.organizationId}${sub}`, organizationId: org.organizationId, customer: { id: org.userId },
      request: { json: async () => bodyObj || {} },
      requireOrgRole: async () => (role === 'owner' ? null : { status: 403, body: { error: 'forbidden' } }),
      json: (body, status = 200) => ({ status, body }), audit: async (f) => audits.push(f), dispatchJob: async () => {}, redeploy: async () => {}
    });
    assert.equal((await call('GET', '/cloud-hosting')).status, 404);

    await hosting.setOrganizationAccess(env, { organization: org.organizationId, mode: 'allow', note: '', actorId: 1 });
    assert.equal((await call('POST', '/cloud-hosting/accounts', { label: 'Main', accountId: hex32(), apiToken: TOKEN }, 'member')).status, 403);
    const created = await call('POST', '/cloud-hosting/accounts', { label: 'Main', accountId: hex32(), apiToken: TOKEN });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const list = await call('GET', '/cloud-hosting');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.accounts.length, 1);
    assert.ok(!JSON.stringify([created, list, audits]).includes(TOKEN), 'an API response or audit entry contains the token');
    assert.equal((await call('GET', `/cloud-hosting/accounts/${crypto.randomUUID()}`)).status, 404);

    // Access switched off later: the organization still sees and manages what it has.
    await hosting.setOrganizationAccess(env, { organization: org.organizationId, mode: 'deny', note: '', actorId: 1 });
    assert.equal((await call('GET', '/cloud-hosting')).status, 200);
    assert.equal((await call('POST', '/cloud-hosting/accounts', { label: 'Two', accountId: hex32(), apiToken: TOKEN })).status, 403);
  } finally {
    __setInfraProviderForTests(null);
  }
});
