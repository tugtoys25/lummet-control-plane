// test/custom-hosting-hardening.test.js
//
// The seven hardening points of customer-owned Cloudflare hosting, against the real schema and the fake infra provider:
//   1 rollouts stop on a release failure but carry on past a clearly account-level one
//   2 a move freezes the site, copies the database after the deploy, verifies, and refuses to skip files silently
//   3 saved tokens are re-verified on a schedule and the organization is told
//   4 a suspended custom-hosted site is also cut off at the edge of the customer's account
//   5 the real Cloudflare provider's request shapes (recorded fetch)
//   6 the old Lummet address redirects and its label stays held
//   7 backups, usage and analytics reach a custom-hosted site through its own address

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService, __setInfraProviderForTests as setDeployInfra } from '../worker/deployments.js';
import { createTransferService } from '../worker/custom-hosting-transfer.js';
import * as jobRunner from '../worker/job-runner.js';
import * as rollouts from '../worker/rollouts.js';
import * as template from '../worker/tenant-template.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as hosting from '../worker/custom-hosting.js';
import { redirectResponseFor } from '../worker/site-domain-moves.js';

const hex32 = () => crypto.randomUUID().replace(/-/g, '');
const TOKEN = 'tok_' + 'Ab9'.repeat(12);
const SCRIPT = 'export default { fetch() { return new Response("ok"); } };';
const fakeR2 = () => { const m = new Map(); return { async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; } }; };

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return {
    LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
    CF_ACCOUNT_ID: 'platform-account', CF_API_TOKEN: 'platform-token-value', TURNSTILE_SECRET: 'platform-turnstile', TURNSTILE_SITEKEY: 'platform-sitekey',
    CUSTOM_HOSTING: 'on', CUSTOM_HOSTING_POLL_MS: '0', ...extra
  };
}
/** The fake provider; calls made with a customer account's env can be made to fail (`customFail`). */
function infraWith() {
  const fake = createFakeInfraProvider();
  const state = { customFail: null };
  const infra = new Proxy(fake, {
    get(target, prop) {
      const v = target[prop];
      if (typeof v !== 'function' || String(prop).startsWith('_')) return v;
      return (...args) => {
        if (state.customFail && args[0]?.LUMMET_HOSTING === 'custom' && prop === state.customFail.method) throw Object.assign(new Error(state.customFail.message), { httpStatus: state.customFail.status });
        return v.apply(target, args);
      };
    }
  });
  return { fake, infra, state };
}
const signup = (email) => ({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.50' } });
async function setUpOrg(env, email) {
  const s = await customerAuth.signUp(signup(email), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  await hosting.setOrganizationAccess(env, { organization: s.organizationId, mode: 'allow', note: 'test', actorId: 1 });
  return s;
}
async function addAccount(env, infra, org, label = 'Main') {
  const cfAccountId = hex32();
  const r = await hosting.addAccount(env, { organizationId: org.organizationId, actorUserId: org.userId, infra, input: { label, accountId: cfAccountId, apiToken: TOKEN } });
  assert.equal(r.ok, true, JSON.stringify(r));
  return { id: r.account.id, cfAccountId };
}
const templates = {
  async getReleaseByVersion(_e, version) { return { ok: true, version, scriptContent: SCRIPT }; },
  async getCurrentReleaseForSite() { return { ok: true, version: '1.0.0', scriptContent: SCRIPT }; },
  async readAsset() { return null; }
};

/** A live Lummet-hosted site with media, cache and a database, ready to be moved. */
async function movableSite(env, fake, infra, org) {
  const created = await sites.createSite(env, { organizationId: org.organizationId, name: 'Mover', productId: 'prod_casino_news', actorUserId: org.userId });
  const prov = createProvisioningService(infra);
  const p = await prov.runJob(env, (await prov.startProvisioning(env, created.siteId)).jobId);
  assert.equal(p.ok, true, JSON.stringify(p));
  const deps = createDeploymentService(infra);
  const d = await deps.startDeployment(env, { siteId: created.siteId, version: '1.0.0', migrations: [], scriptContent: SCRIPT });
  assert.equal((await deps.runJob(env, d.jobId)).ok, true);
  const res = await env.LUMMET_DB.prepare('SELECT resource_type AS type, resource_id, resource_name FROM site_resources WHERE site_id = ?').bind(created.siteId).all();
  const by = Object.fromEntries(res.results.map((r) => [r.type, r]));
  fake._r2.set(by.r2.resource_id, new Map([['img/a.png', { body: new Uint8Array([1, 2, 3]), contentType: 'image/png' }]]));
  fake._kv.set(by.kv.resource_id, new Map([['k1', 'v1']]));
  fake._d1Dumps.set(by.d1.resource_id, 'CREATE TABLE posts (id); INSERT INTO posts VALUES (1);');
  return { siteId: created.siteId, by };
}
function fakeAccess(fake, { failFreeze = false } = {}) {
  const log = [];
  return { log, async freeze(_e, id) { if (failFreeze) throw new Error('tenant did not answer'); log.push('freeze'); fake._calls.push({ method: 'FREEZE' }); }, async unfreeze() { log.push('unfreeze'); fake._calls.push({ method: 'UNFREEZE' }); } };
}
const names = (fake) => fake._calls.map((c) => c.method);
async function runToEnd(transfers, env, jobId) {
  let r;
  for (let i = 0; i < 30; i++) { r = await transfers.runJob(env, jobId, { budgetMs: 600000 }); if (!r?.paused) break; }
  return r;
}

// ------------------------------------------------------------------ 1. rollouts

async function rolloutFleet(t, failure) {
  const { fake, infra, state } = infraWith();
  setDeployInfra(infra); t.after(() => setDeployInfra(null));
  const env = makeEnv();
  assert.ok((await template.publishRelease(env, { version: '1.0.0', scriptContent: 'export default {/*1.0.0*/}', migrations: [] })).ok);
  const org = await setUpOrg(env, `fleet${Math.random()}@example.com`);
  const { id: accountRef } = await addAccount(env, infra, org);
  const mk = async (name, custom) => {
    const o = custom ? org : await setUpOrg(env, `fleet-${name.replace(/\W/g, '')}${Math.random()}@example.com`);   // one site per starter plan
    const s = await sites.createSite(env, { organizationId: o.organizationId, name, productId: 'prod_casino_news', actorUserId: o.userId, ...(custom ? { hosting: { mode: 'custom', accountId: accountRef, landing: 'workers_dev' }, hostingInfra: infra } : {}) });
    assert.equal(s.ok, true, JSON.stringify(s));
    const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra), templateService: template });
    const run = await prov.runJob(env, (await prov.startProvisioning(env, s.siteId)).jobId);
    assert.equal(run.ok, true, JSON.stringify(run));
    return s.siteId;
  };
  const b = await mk('B custom', true); const a = await mk('A platform', false); const c = await mk('C platform', false);
  assert.ok((await template.publishRelease(env, { version: '2.0.0', scriptContent: 'export default {/*2.0.0*/}', migrations: [] })).ok);
  state.customFail = failure;
  const ver = async (id) => (await sites.getSite(env, id)).app_version;
  return { env, fake, a, b, c, ver, dispatch: (jobId) => jobRunner.runJobById(env, jobId) };
}
async function drive(env, dispatch) {
  const s = await rollouts.startRollout(env, { startedBy: 'admin:1' });
  assert.equal(s.ok, true, JSON.stringify(s));
  let r;
  for (let i = 0; i < 20; i++) { r = await rollouts.advanceRollout(env, s.rolloutId, { dispatch }); if (r.done) break; }
  return r;
}

test('1: a release failure on a custom-hosted site STOPS the rollout, exactly like a Lummet-hosted site', async (t) => {
  const f = await rolloutFleet(t, { method: 'uploadWorkerScript', message: 'Script startup failed: SyntaxError', status: 400 });
  const r = await drive(f.env, f.dispatch);
  assert.equal(r.status, 'failed', JSON.stringify(r));
  assert.equal(await f.ver(f.b), '1.0.0');
  const updated = [await f.ver(f.a), await f.ver(f.c)].filter((v) => v === '2.0.0').length;
  assert.ok(updated < 2, 'the sites after the failing one were not touched');
  assert.equal(r.counts.pending + r.counts.failed + r.counts.succeeded, 3);
});

test('1: a clearly account-level failure (revoked token) is recorded, the customer is told, and the rollout carries on', async (t) => {
  const f = await rolloutFleet(t, { method: 'uploadWorkerScript', message: 'Authentication error (10000): Forbidden', status: 403 });
  const r = await drive(f.env, f.dispatch);
  assert.equal(r.status, 'completed', JSON.stringify(r));
  assert.equal(r.counts.failed, 1, 'the failure stays visible in the rollout');
  assert.equal(await f.ver(f.b), '1.0.0');
  assert.equal(await f.ver(f.c), '2.0.0');
  const note = await f.env.LUMMET_DB.prepare(`SELECT subject FROM announcements WHERE subject LIKE 'A release could not be delivered%'`).first();
  assert.ok(note, 'the organization was told');
  assert.equal(hosting.isAccountLevelFailure('R2 is not enabled on your Cloudflare account'), true);
  assert.equal(hosting.isAccountLevelFailure('health check failed: status 500'), false);
  assert.equal(hosting.isAccountLevelFailure('migration 0007 failed: no such table'), false);
});

// ------------------------------------------------------------------ 2 + 6. the move

test('2+6: the move freezes first, copies the database after the deploy, verifies with data, redirects the old address and holds the label', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'move1@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId } = await movableSite(env, fake, infra, org);
  const before = await sites.getSite(env, siteId);
  const oldRoute = await env.LUMMET_DB.prepare(`SELECT resource_name FROM site_resources WHERE site_id = ? AND resource_type = 'route'`).bind(siteId).first();
  const access = fakeAccess(fake);
  const transfers = createTransferService(infra, { templateService: templates, access });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: { accountId: accountRef, landing: 'workers_dev' } });
  assert.equal(start.ok, true, JSON.stringify(start));
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, true, JSON.stringify(r));

  const n = names(fake);
  const iFreeze = n.indexOf('FREEZE'), iImport = n.indexOf('importD1Sql'), iUpload = n.lastIndexOf('uploadWorkerScript');
  const iVerify = n.findLastIndex((x) => x === 'checkHealth');
  assert.ok(iUpload >= 0 && iUpload < iFreeze, 'the Worker is deployed before the window opens');
  assert.ok(iFreeze >= 0 && iFreeze < n.indexOf('exportD1Database'), 'the site is frozen before the database is read');
  assert.ok(iImport > iFreeze && iVerify > iImport, 'the health check runs after the database is in');
  assert.ok(n.indexOf('deleteWorkerScript') > iVerify, 'Lummet stops only after the copy proved itself');
  assert.equal(access.log[0], 'freeze');
  assert.ok(access.log.includes('unfreeze'), 'maintenance state cleared at the end');

  // 6. old address: route repointed to the control plane, redirect row, label held.
  const host = (await sites.getSite(env, siteId)).primary_domain;
  assert.match(host, /workers\.dev$/);
  const oldHost = oldRoute.resource_name.replace(/\/\*$/, '');
  const hit = await redirectResponseFor(env, new Request(`https://${oldHost}/page?a=1`));
  assert.equal(hit.status, 301);
  assert.equal(hit.headers.get('Location'), `https://${host}/page?a=1`);
  assert.ok(fake._calls.some((c) => c.method === 'ensureWorkerRoute' && c.pattern === oldRoute.resource_name && c.workerName === 'lummet-control-plane'));
  const after = await sites.getSite(env, siteId);
  assert.equal(after.host_label, before.host_label, 'the platform label stays with the site');
  assert.equal((await transfers.transferView(env, siteId)).redirectUntil !== null, true);
});

test('2: files too large to copy stop the move before anything is touched, until the customer confirms', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'move2@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId, by } = await movableSite(env, fake, infra, org);
  fake._r2.get(by.r2.resource_id).set('video/big.mp4', { body: { length: 100 * 1024 * 1024 }, contentType: 'video/mp4' });
  const access = fakeAccess(fake);
  const transfers = createTransferService(infra, { templateService: templates, access });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: { accountId: accountRef, landing: 'workers_dev' } });
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, false);
  assert.match(r.error, /video\/big\.mp4/);
  assert.deepEqual(access.log, [], 'the site was never frozen');
  assert.equal(await hosting.contextForSite(env, siteId), null, 'still a Lummet site');
  const view = await transfers.transferView(env, siteId);
  assert.equal(view.needsConfirmation, true);

  assert.equal((await transfers.confirmSkipped(env, { organizationId: 'other-org', siteId })).ok, false);
  const c = await transfers.confirmSkipped(env, { organizationId: org.organizationId, siteId });
  assert.equal(c.ok, true, JSON.stringify(c));
  const r2 = await runToEnd(transfers, env, c.jobId);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal((await transfers.transferView(env, siteId)).status, 'completed');
});

test('2: a failed health check after the import un-freezes the site, leaves it on Lummet, and the next attempt starts from a clean database', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'move3@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId } = await movableSite(env, fake, infra, org);
  const access = fakeAccess(fake);
  const transfers = createTransferService(infra, { templateService: templates, access });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: { accountId: accountRef, landing: 'workers_dev' } });
  fake._setHealthCheckResult({ ok: false, statusCode: 500 });
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer/);
  assert.deepEqual(access.log, ['freeze', 'unfreeze']);
  assert.equal(await hosting.contextForSite(env, siteId), null, 'the site still runs on Lummet');
  assert.ok(!fake._calls.some((c) => c.method === 'deleteWorkerScript'), 'nothing of Lummet was removed');
  assert.equal((await transfers.transferView(env, siteId)).frozen, false);

  fake._setHealthCheckResult({ ok: true, statusCode: 200 });
  const imports = () => fake._calls.filter((c) => c.method === 'importD1Sql').length;
  const importsBefore = imports();
  const r2 = await runToEnd(transfers, env, start.jobId);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.ok(fake._calls.some((c) => c.method === 'deleteDatabase'), 'the half-filled database was replaced, never imported over');
  assert.equal(imports(), importsBefore + 1);
});

test('2: if the site cannot be put into maintenance, nothing is copied over the live data', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'move4@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId } = await movableSite(env, fake, infra, org);
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake, { failFreeze: true }) });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: { accountId: accountRef, landing: 'workers_dev' } });
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, false);
  assert.ok(!fake._calls.some((c) => c.method === 'exportD1Database'));
});

// ------------------------------------------------------------------ 3. token health

test('3: a revoked token is found by the scheduled check, shown as invalid, the organization is told once, and told again when it works', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'health@example.com');
  const { id } = await addAccount(env, infra, org, 'Prod account');
  const later = Date.now() + 7 * 3600_000;
  assert.equal((await hosting.sweepAccountHealth(env, { infra, now: later })).checked, 1);
  assert.equal((await hosting.getAccountView(env, org.organizationId, id)).status, 'verified');

  fake._badTokens.add(TOKEN);
  const r1 = await hosting.sweepAccountHealth(env, { infra, now: later + 7 * 3600_000 });
  assert.equal(r1.invalid, 1); assert.equal(r1.alerts, 1);
  assert.equal((await hosting.getAccountView(env, org.organizationId, id)).status, 'invalid');
  const r2 = await hosting.sweepAccountHealth(env, { infra, now: later + 14 * 3600_000 });
  assert.equal(r2.alerts, 0, 'the same problem is not repeated on every check');
  const subjects = () => env.LUMMET_DB.prepare(`SELECT * FROM announcements WHERE subject LIKE '%Prod account%'`).all().then((x) => x.results);
  const first = await subjects();
  assert.equal(first.length, 1);
  assert.ok(!JSON.stringify(first).includes(TOKEN), 'a notice carried the token');

  fake._badTokens.clear();
  const r3 = await hosting.sweepAccountHealth(env, { infra, now: later + 21 * 3600_000 });
  assert.equal(r3.recovered, 1);
  assert.equal((await hosting.getAccountView(env, org.organizationId, id)).status, 'verified');
  assert.equal((await subjects()).length, 2);
});

test('3: an unreachable Cloudflare never turns a good account invalid', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'health2@example.com');
  const { id } = await addAccount(env, infra, org);
  fake.verifyApiToken = async () => ({ ok: false, status: 'unreachable', error: 'timeout' });
  const r = await hosting.sweepAccountHealth(env, { infra, now: Date.now() + 7 * 3600_000 });
  assert.equal(r.transient, 1); assert.equal(r.alerts, 0);
  assert.equal((await hosting.getAccountView(env, org.organizationId, id)).status, 'verified');
});

// ------------------------------------------------------------------ 4. edge enforcement

test('4: suspending a custom-hosted site also cuts its Worker off at the customer account, and reactivating restores it', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'enforce@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const created = await sites.createSite(env, { organizationId: org.organizationId, name: 'Own', productId: 'prod_casino_news', actorUserId: org.userId, hosting: { mode: 'custom', accountId: accountRef, landing: 'workers_dev' }, hostingInfra: infra });
  const prov = createProvisioningService(infra);
  assert.equal((await prov.runJob(env, (await prov.startProvisioning(env, created.siteId)).jobId)).ok, true);
  const deps = createDeploymentService(infra);
  const d = await deps.startDeployment(env, { siteId: created.siteId, version: '1.0.0', migrations: [], scriptContent: SCRIPT });
  assert.equal((await deps.runJob(env, d.jobId)).ok, true);

  assert.deepEqual(await hosting.enforceAccessSweep(env, { infra }), { blocked: 0, restored: 0, failed: 0 }, 'an active site is left alone');
  const t = await sites.transitionSiteStatus(env, created.siteId, 'suspended', { reason: 'test', actorType: 'lummet_admin' });
  assert.equal(t.ok, true, JSON.stringify(t));
  const blocked = await hosting.enforceAccessSweep(env, { infra });
  assert.equal(blocked.blocked, 1);
  const off = fake._calls.filter((c) => c.method === 'setWorkersDevEnabled' && c.enabled === false);
  assert.equal(off.length, 1);
  assert.notEqual(off[0].accountId, 'platform-account', 'it ran with the customer account, never the platform one');
  assert.equal((await hosting.enforceAccessSweep(env, { infra })).blocked, 0, 'done once');

  assert.equal((await sites.transitionSiteStatus(env, created.siteId, 'active', { reason: 'test', actorType: 'lummet_admin' })).ok, true);
  assert.equal((await hosting.enforceAccessSweep(env, { infra })).restored, 1);
  assert.ok(fake._calls.filter((c) => c.method === 'setWorkersDevEnabled' && c.enabled === true).length >= 2);
});

// ------------------------------------------------------------------ 5. real provider request shapes

test('5: the Cloudflare provider sends the documented requests (recorded fetch; NOT a live account)', async () => {
  const cf = await import('../worker/infra-cloudflare.js');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: typeof init.body === 'string' ? init.body : null });
    return new Response(JSON.stringify({ success: true, result: { id: 'x', status: 'complete', result: { filename: 'f', signed_url: 'https://example.invalid/dump' } }, result_info: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const env = { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acc1', CF_ZONE_ID: '' };
    await cf.setWorkersDevEnabled(env, { workerName: 'w1', enabled: false });
    await cf.listR2Objects(env, { bucket: 'b', perPage: 10 }).catch(() => {});
    assert.ok(calls.some((c) => c.method === 'POST' && /\/accounts\/acc1\/workers\/scripts\/w1\/subdomain$/.test(c.url) && JSON.parse(c.body).enabled === false));
    assert.ok(calls.some((c) => /\/accounts\/acc1\/r2\/buckets\/b\/objects\?per_page=10/.test(c.url)));
  } finally { globalThis.fetch = realFetch; }
});

// ------------------------------------------------------------------ 7. backups, usage, analytics

test('7: backups, storage usage and analytics reach a custom-hosted site through its own address, never through the platform account', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'reach@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const created = await sites.createSite(env, { organizationId: org.organizationId, name: 'Own', productId: 'prod_casino_news', actorUserId: org.userId, hosting: { mode: 'custom', accountId: accountRef, landing: 'workers_dev' }, hostingInfra: infra });
  const prov = createProvisioningService(infra);
  assert.equal((await prov.runJob(env, (await prov.startProvisioning(env, created.siteId)).jobId)).ok, true);
  const deps = createDeploymentService(infra);
  const d = await deps.startDeployment(env, { siteId: created.siteId, version: '1.0.0', migrations: [], scriptContent: SCRIPT });
  assert.equal((await deps.runJob(env, d.jobId)).ok, true);

  const site = await sites.getSite(env, created.siteId);
  const tenant = await env.LUMMET_DB.prepare('SELECT host, api_base_url FROM tenants WHERE id = ?').bind(site.tenant_id).first();
  assert.equal(tenant.api_base_url, `https://${site.primary_domain}`, 'every Super API call (backups, usage, analytics) goes to the site\'s own address');
  assert.match(tenant.api_base_url, /workers\.dev$/);
  const cred = await env.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM tenant_api_credentials WHERE tenant_id = ? AND status = ?').bind(site.tenant_id, 'active').first();
  assert.ok(cred.n >= 1, 'the site was given its Super API credential');

  // The storage sweep selects the custom-hosted site like any other and calls its address.
  const { collectStorageUsage } = await import('../worker/storage-sync.js');
  const seen = [];
  const out = await collectStorageUsage(env, { limit: 10, clientAdapter: { async getFromTenant(_e, tenantId, path) { seen.push({ tenantId, path }); return { ok: true, data: { success: true, data: { total_bytes: 5 } } }; } } });
  assert.ok(seen.some((s) => s.tenantId === site.tenant_id && s.path === '/en/api/super/storage-usage'), JSON.stringify({ out, seen }));
  assert.ok(!fake._calls.some((c) => c.accountId === 'platform-account' && /Usage|Analytics/i.test(c.method)));
});
