// test/custom-hosting-recovery.test.js
//
// Moving a site must be recoverable and a copy must be exact:
//   - the maintenance state is never carried into the customer's database (it made every moved site answer 503)
//   - a bucket name Cloudflare still blocks after a delete is waited out, not failed on
//   - Cancel / Clean up removes what the move created (by id and, for a half-created resource, by name) and reports what is left
//   - a failed move can be retried from where it stopped
//   - Copy site: the source stays untouched, the copy is a separate site in the customer's account, a failed copy retries or is deleted
//   - DNS records of a connected domain can be listed, added and deleted, with the safety checks

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
async function setUpOrg(env, email, plan = 'plan_casino_news_starter') {
  const s = await customerAuth.signUp(signup(email), env);
  await plans.startTrialSubscription(env, s.organizationId, plan);
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
const choice = (accountRef) => ({ accountId: accountRef, landing: 'workers_dev' });

test('503 fix: the maintenance state row is removed from the copied database', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'rec1@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId, by } = await movableSite(env, fake, infra, org);
  fake._d1Dumps.set(by.d1.resource_id, "CREATE TABLE system_settings (key TEXT, value TEXT); INSERT INTO system_settings VALUES ('__lummet_site_access_state','{\"state\":\"suspended\"}');");
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake) });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: choice(accountRef) });
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, true, JSON.stringify(r));
  const del = fake._calls.find((c) => c.method === 'runD1Query' && /DELETE FROM system_settings/.test(c.sql) && /__lummet_site_access_state/.test(c.sql));
  assert.ok(del, 'the state row is deleted in the new database');
  const imp = fake._calls.findIndex((c) => c.method === 'importD1Sql');
  assert.ok(fake._calls.indexOf(del) > imp, 'after the import');
});

test('R2: a bucket name Cloudflare still blocks after a delete is waited out and the move continues', async () => {
  const env = makeEnv({ CUSTOM_HOSTING_BUCKET_WAIT_PAD_MS: '0' });
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'rec2@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId } = await movableSite(env, fake, infra, org);
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake) });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: choice(accountRef) });
  const row = await env.LUMMET_DB.prepare('SELECT id FROM site_hosting_transfers WHERE job_id = ?').bind(start.jobId).first();
  assert.ok(row);
  // Block every name for 1 s: the first create fails with Cloudflare's message, the patient retry succeeds after the wait.
  const realCreate = fake.createR2Bucket.bind(fake);
  let blockedOnce = 0;
  fake.createR2Bucket = async (e, args) => {
    if (!blockedOnce++ && e.LUMMET_HOSTING === 'custom') throw Object.assign(new Error(`Bucket was deleted at 2026-01-01T00:00:00Z; same-name recreation is blocked until ${new Date(Date.now() + 300).toISOString()}`), { httpStatus: 409 });
    return realCreate(e, args);
  };
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(blockedOnce >= 2, 'created again after the wait');
});

test('Cancel removes everything the move created, even a resource whose id was never recorded, and reports it', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'rec3@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId } = await movableSite(env, fake, infra, org);
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake) });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: choice(accountRef) });
  fake._setHealthCheckResult({ ok: false, statusCode: 500 });
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, false);
  const before = { d1: fake._databases.size, kv: fake._namespaces.size, r2: fake._buckets.size };
  assert.ok(before.d1 >= 2 && before.kv >= 2 && before.r2 >= 2, 'the move created resources next to the source ones');
  const view = await transfers.transferView(env, siteId);
  assert.equal(view.canRetry, true);

  const c = await transfers.cancelTransfer(env, { organizationId: org.organizationId, siteId });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal(fake._databases.size, before.d1 - 1);
  assert.equal(fake._namespaces.size, before.kv - 1);
  assert.equal(fake._buckets.size, before.r2 - 1);
  const v2 = await transfers.transferView(env, siteId);
  assert.equal(v2.status, 'cancelled');
  assert.ok(v2.cleanup && v2.cleanup.removed.length >= 3 && v2.cleanup.left.length === 0);
  assert.equal(await hosting.contextForSite(env, siteId), null, 'still a Lummet site');
  assert.equal((await transfers.cancelTransfer(env, { organizationId: org.organizationId, siteId })).ok, false, 'nothing left to cancel');
});

test('Cancel that cannot remove something says what is left and can be pressed again', async () => {
  const env = makeEnv();
  const { fake, infra, state } = infraWith();
  const org = await setUpOrg(env, 'rec4@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId } = await movableSite(env, fake, infra, org);
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake) });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: choice(accountRef) });
  fake._setHealthCheckResult({ ok: false, statusCode: 500 });
  await runToEnd(transfers, env, start.jobId);
  state.customFail = { method: 'deleteKVNamespace', message: 'kv busy', status: 500 };
  const c = await transfers.cancelTransfer(env, { organizationId: org.organizationId, siteId });
  assert.equal(c.ok, false);
  assert.equal(c.error, 'cleanup_incomplete');
  const v = await transfers.transferView(env, siteId);
  assert.equal(v.status, 'failed', 'not marked cancelled while something is left');
  assert.ok(v.cleanup.left.length >= 1);
  state.customFail = null;
  const again = await transfers.cancelTransfer(env, { organizationId: org.organizationId, siteId });
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal((await transfers.transferView(env, siteId)).cleanup.left.length, 0);
});

test('Retry continues a failed move from the failed step, and only for the organization that owns it', async () => {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, 'rec5@example.com');
  const { id: accountRef } = await addAccount(env, infra, org);
  const { siteId } = await movableSite(env, fake, infra, org);
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake) });
  const start = await transfers.startTransfer(env, { organizationId: org.organizationId, siteId, actorUserId: org.userId, choice: choice(accountRef) });
  fake._setHealthCheckResult({ ok: false, statusCode: 500 });
  assert.equal((await runToEnd(transfers, env, start.jobId)).ok, false);
  assert.equal((await transfers.retryTransfer(env, { organizationId: 'someone-else', siteId })).ok, false);
  fake._setHealthCheckResult({ ok: true, statusCode: 200 });
  const rt = await transfers.retryTransfer(env, { organizationId: org.organizationId, siteId });
  assert.equal(rt.ok, true, JSON.stringify(rt));
  const r = await runToEnd(transfers, env, rt.jobId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await transfers.transferView(env, siteId)).status, 'completed');
  assert.equal((await transfers.retryTransfer(env, { organizationId: org.organizationId, siteId })).ok, false, 'a finished move has nothing to retry');
});

// ------------------------------------------------------------------ copy

async function copySetup(email) {
  const env = makeEnv();
  const { fake, infra, state } = infraWith();
  setDeployInfra(infra);
  const org = await setUpOrg(env, email, 'plan_casino_news_pro');
  const { id: accountRef } = await addAccount(env, infra, org);
  const src = await movableSite(env, fake, infra, org);
  const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra), templateService: templates });
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake), provisioningService: prov, deploymentService: createDeploymentService(infra) });
  return { env, fake, infra, state, org, accountRef, src, transfers };
}

test('Copy: the source stays on Lummet untouched and the copy is a separate custom-hosted site with the same data', async (t) => {
  t.after(() => setDeployInfra(null));
  const { env, fake, org, accountRef, src, transfers } = await copySetup('copy1@example.com');
  const start = await transfers.startCopy(env, { organizationId: org.organizationId, siteId: src.siteId, name: 'Mover copy', choice: choice(accountRef), actorUserId: org.userId });
  assert.equal(start.ok, true, JSON.stringify(start));
  assert.notEqual(start.targetSiteId, src.siteId);
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, true, JSON.stringify(r));
  const v = await transfers.copyView(env, src.siteId);
  assert.equal(v.status, 'completed', JSON.stringify(v));
  assert.equal(v.targetName, 'Mover copy');
  assert.equal(await hosting.contextForSite(env, src.siteId), null, 'the source is still hosted by Lummet');
  assert.equal((await sites.getSite(env, src.siteId)).status, 'active');
  const target = await hosting.contextForSite(env, start.targetSiteId);
  assert.ok(target, 'the copy runs in the customer account');
  assert.ok(!fake._calls.some((c) => c.method === 'deleteWorkerScript'), 'nothing of the source was removed');
  assert.ok(!fake._calls.some((c) => c.method === 'FREEZE'));
  assert.ok(fake._calls.some((c) => c.method === 'importD1Sql'), 'the database was copied');
  assert.equal((await transfers.copyView(env, src.siteId)).canRetry, false);
});

test('Copy: refused for a site that is not on Lummet, when a move is open, and beyond the plan site limit', async (t) => {
  t.after(() => setDeployInfra(null));
  const env = makeEnv();
  const { fake, infra } = infraWith();
  setDeployInfra(infra);
  const org = await setUpOrg(env, 'copy2@example.com');   // starter: one site
  const { id: accountRef } = await addAccount(env, infra, org);
  const src = await movableSite(env, fake, infra, org);
  const transfers = createTransferService(infra, { templateService: templates, access: fakeAccess(fake) });
  const r = await transfers.startCopy(env, { organizationId: org.organizationId, siteId: src.siteId, name: 'x', choice: choice(accountRef), actorUserId: org.userId });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'site_limit_reached');
  assert.equal((await transfers.startCopy(env, { organizationId: 'other', siteId: src.siteId, name: 'x', choice: choice(accountRef), actorUserId: 1 })).ok, false);
});

test('Copy: a failed copy retries, and deleting it removes the new site and its resources while the source stays', async (t) => {
  t.after(() => setDeployInfra(null));
  const { env, fake, state, org, accountRef, src, transfers } = await copySetup('copy3@example.com');
  const start = await transfers.startCopy(env, { organizationId: org.organizationId, siteId: src.siteId, name: 'Mover copy', choice: choice(accountRef), actorUserId: org.userId });
  fake._setHealthCheckResult({ ok: false, statusCode: 500 });
  const r = await runToEnd(transfers, env, start.jobId);
  assert.equal(r.ok, false);
  assert.equal((await transfers.copyView(env, src.siteId)).canRetry, true);
  assert.equal((await transfers.retryCopy(env, { organizationId: 'other', siteId: src.siteId })).ok, false);

  fake._setHealthCheckResult({ ok: true, statusCode: 200 });
  const rt = await transfers.retryCopy(env, { organizationId: org.organizationId, siteId: src.siteId });
  assert.equal(rt.ok, true, JSON.stringify(rt));
  const r2 = await runToEnd(transfers, env, rt.jobId);
  assert.equal(r2.ok, true, JSON.stringify(r2));
  assert.equal((await transfers.copyView(env, src.siteId)).status, 'completed');
  void state;
});

test('Copy: cancelling a running copy deletes the new site and leaves the source alone', async (t) => {
  t.after(() => setDeployInfra(null));
  const { env, fake, org, accountRef, src, transfers } = await copySetup('copy4@example.com');
  const start = await transfers.startCopy(env, { organizationId: org.organizationId, siteId: src.siteId, name: 'Mover copy', choice: choice(accountRef), actorUserId: org.userId });
  fake._setHealthCheckResult({ ok: false, statusCode: 500 });
  await runToEnd(transfers, env, start.jobId);
  const c = await transfers.cancelCopy(env, { organizationId: org.organizationId, siteId: src.siteId });
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.equal((await transfers.copyView(env, src.siteId)).status, 'cancelled');
  const gone = await sites.getSite(env, start.targetSiteId);
  assert.ok(!gone || ['deleting', 'deleted'].includes(gone.status), 'the new site is being deleted');
  assert.equal((await sites.getSite(env, src.siteId)).status, 'active');
  assert.equal(await hosting.contextForSite(env, src.siteId), null);
});

// ------------------------------------------------------------------ DNS

async function dnsSetup(email) {
  const env = makeEnv();
  const { fake, infra } = infraWith();
  const org = await setUpOrg(env, email);
  const { id } = await addAccount(env, infra, org);
  const zoneId = hex32();
  fake._zones.set(zoneId, { name: 'example.org', status: 'pending', nameServers: ['a.ns.cloudflare.com', 'b.ns.cloudflare.com'], records: [{ id: hex32(), type: 'NS', name: 'example.org', content: 'x.ns', ttl: 1, proxied: false }], scanned: [] });
  return { env, fake, infra, org, id, zoneId };
}

test('DNS: list shows the zone state and locks NS; add validates and normalises; delete refuses locked records', async () => {
  const { env, infra, org, id, zoneId } = await dnsSetup('dns1@example.com');
  const base = { organizationId: org.organizationId, id, zoneId, infra };
  const l = await hosting.listZoneRecords(env, base);
  assert.equal(l.ok, true, JSON.stringify(l));
  assert.deepEqual(l.zone.nameServers, ['a.ns.cloudflare.com', 'b.ns.cloudflare.com']);
  assert.equal(l.records[0].locked, true);

  const a = await hosting.addZoneRecord(env, { ...base, record: { type: 'a', name: 'www', content: '203.0.113.5', proxied: true } });
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(a.record.name, 'www.example.org');
  const root = await hosting.addZoneRecord(env, { ...base, record: { type: 'TXT', name: '@', content: 'v=spf1 -all' } });
  assert.equal(root.ok, true, JSON.stringify(root));
  assert.equal(root.record.name, 'example.org');

  for (const bad of [{ type: 'SRV', name: 'x', content: 'y' }, { type: 'A', name: 'bad name!', content: '1.2.3.4' }, { type: 'A', name: 'w', content: '' }, { type: 'MX', name: '@', content: 'mail.example.org', priority: 70000 }]) {
    const r = await hosting.addZoneRecord(env, { ...base, record: bad });
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.equal(r.status, 422);
  }
  const after = await hosting.listZoneRecords(env, base);
  const ns = after.records.find((x) => x.type === 'NS');
  assert.equal((await hosting.deleteZoneRecord(env, { ...base, recordId: ns.id })).ok, false);
  const www = after.records.find((x) => x.name === 'www.example.org');
  assert.equal((await hosting.deleteZoneRecord(env, { ...base, recordId: www.id })).ok, true);
  assert.ok(!(await hosting.listZoneRecords(env, base)).records.some((x) => x.id === www.id));
});

test('DNS: a zone that is not in the saved account, or belongs to another organization, is refused', async () => {
  const { env, infra, org, id } = await dnsSetup('dns2@example.com');
  const other = await setUpOrg(env, 'dns3@example.com');
  const strange = hex32();
  assert.equal((await hosting.listZoneRecords(env, { organizationId: org.organizationId, id, zoneId: strange, infra })).ok, false);
  assert.equal((await hosting.listZoneRecords(env, { organizationId: other.organizationId, id, zoneId: strange, infra })).ok, false);
  assert.equal((await hosting.addZoneRecord(env, { organizationId: org.organizationId, id, zoneId: strange, record: { type: 'A', name: 'a', content: '1.1.1.1' }, infra })).ok, false);
});
