// Deleting a site for real: typed confirmation, a durable teardown job that removes route, Worker, D1, KV, R2, backups and
// custom domains, stays `deleting` (address held) until everything is gone, retries after a failure, and is available to staff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as jobs from '../worker/jobs.js';
import * as jobRunner from '../worker/job-runner.js';
import * as changeRequests from '../worker/change-requests.js';
import * as labels from '../worker/site-labels.js';
import * as pd from '../worker/platform-domains.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import { createSiteTeardownService, TEARDOWN_STEPS } from '../worker/site-teardown.js';

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  const store = new Map();
  const BACKUPS = { store, async put(k, v) { store.set(k, v); }, async delete(k) { store.delete(k); } };
  return { LUMMET_DB: db, BACKUPS, PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default', CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra };
}
let seq = 0;
async function newOrg(env) {
  seq += 1;
  const s = await customerAuth.signUp({ async json() { return { email: `td${seq}@example.com`, password: 'correct-horse-battery', organizationName: `Org${seq}` }; }, headers: { get: () => '203.0.113.50' } }, env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter').catch(() => plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter'));
  return { organizationId: s.organizationId, userId: s.userId };
}
const run = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).run();
const one = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).first();
const all = async (env, sql, ...a) => (await env.LUMMET_DB.prepare(sql).bind(...a).all()).results;

/** A provisioned site (D1, KV, R2, tenant) plus a route and Worker as a deploy would leave them, and one stored backup. */
async function liveSite(env, infra, org, name = 'Reviews') {
  const made = await sites.createSite(env, { organizationId: org.organizationId, name, productId: 'prod_casino_news', actorUserId: org.userId });
  assert.equal(made.ok, true, JSON.stringify(made));
  const provisioning = createProvisioningService(infra, { deploymentService: createDeploymentService(infra) });
  const start = await provisioning.startProvisioning(env, made.siteId);
  assert.equal((await provisioning.runJob(env, start.jobId)).ok, true);
  await run(env, `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name, metadata) VALUES (?, 'fake-cloudflare', 'route', 'route-1', 'reviews.lummet.app/*', ?)`, made.siteId, JSON.stringify({ zoneId: 'zone-default' }));
  await run(env, `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES (?, 'fake-cloudflare', 'worker', 'w-1', 'lummet-site-reviews')`, made.siteId);
  await run(env, `UPDATE sites SET status = 'active' WHERE id = ?`, made.siteId);
  await env.BACKUPS.put('backups/b1.json', '{}');
  await run(env, `INSERT INTO site_backups (id, organization_id, site_id, status, storage_key) VALUES ('b1', ?, ?, 'complete', 'backups/b1.json')`, org.organizationId, made.siteId);
  return made;
}
const service = (infra) => createSiteTeardownService(infra);

test('typed confirmation is enforced by the server: no name, or the wrong name, deletes nothing', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider();
  const s = await liveSite(env, infra, org);
  for (const confirmName of [undefined, '', 'reviews', 'Review', 'Reviews!']) {
    const r = await changeRequests.requestSiteDeletion(env, { organizationId: org.organizationId, siteId: s.siteId, actorUserId: org.userId, confirmName });
    assert.equal(r.ok, false); assert.equal(r.error, 'confirmation_required'); assert.equal(r.status, 422);
  }
  assert.equal((await sites.getSite(env, s.siteId)).status, 'active');
  assert.equal((await all(env, `SELECT id FROM jobs WHERE type = 'site_teardown'`)).length, 0);
});

test('delete runs the whole teardown in order, removes everything at the provider, and frees the address', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider();
  const s = await liveSite(env, infra, org);
  const tenantId = (await sites.getSite(env, s.siteId)).tenant_id;
  assert.ok(tenantId);

  const req = await changeRequests.requestSiteDeletion(env, { organizationId: org.organizationId, siteId: s.siteId, actorUserId: org.userId, confirmName: 'Reviews' });
  assert.equal(req.ok, true); assert.ok(req.jobId);
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleting');
  // While it is deleting the address is still held.
  const dom = await pd.getDefaultDomain(env);
  assert.equal((await labels.checkLabel(env, { label: 'reviews', domain: dom })).available, false);

  infra._calls.length = 0;
  const done = await service(infra).runJob(env, req.jobId);
  assert.equal(done.ok, true, JSON.stringify(done));

  const order = infra._calls.map((c) => c.method).filter((m) => m.startsWith('delete'));
  assert.deepEqual(order, ['deleteWorkerRoute', 'deleteWorkerScript', 'deleteDatabase', 'deleteKVNamespace', 'deleteR2Bucket']);
  assert.equal(infra._calls.find((c) => c.method === 'deleteWorkerRoute').zoneId, 'zone-default');
  assert.equal(infra._calls.find((c) => c.method === 'deleteWorkerScript').workerName, 'lummet-site-reviews');

  const site = await sites.getSite(env, s.siteId);
  assert.equal(site.status, 'deleted'); assert.ok(site.deleted_at);
  assert.equal(site.tenant_id, null);
  assert.equal(await one(env, `SELECT id FROM tenants WHERE id = ?`, tenantId), null, 'tenant row and its credentials are gone');
  assert.deepEqual((await all(env, `SELECT DISTINCT status FROM site_resources WHERE site_id = ?`, s.siteId)).map((r) => r.status), ['deleted']);
  assert.equal(env.BACKUPS.store.size, 0, 'stored backup files are removed');
  assert.equal((await one(env, `SELECT COUNT(*) n FROM site_backups WHERE site_id = ?`, s.siteId)).n, 0);
  const job = await jobs.getJob(env, req.jobId);
  assert.equal(job.status, 'success');
  assert.deepEqual(job.steps.map((x) => x.step_key), TEARDOWN_STEPS);
  assert.ok(job.steps.every((x) => x.status === 'success'));
  // The status history stays as the record; the address is free for anyone now.
  assert.ok((await all(env, `SELECT to_status FROM site_status_events WHERE site_id = ?`, s.siteId)).some((e) => e.to_status === 'deleted'));
  assert.equal((await labels.checkLabel(env, { label: 'reviews', domain: dom })).available, true);
  // Deleting freed the plan slot immediately, and the site is gone from the customer's list.
  assert.equal((await sites.listSitesForOrganization(env, org.organizationId)).length, 0);
});

test('a provider failure leaves the site deleting with its address held; a retry resumes and finishes', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider();
  const s = await liveSite(env, infra, org);
  const req = await changeRequests.requestSiteDeletion(env, { organizationId: org.organizationId, siteId: s.siteId, actorUserId: org.userId, confirmName: 'Reviews' });
  infra._deleteFailures.set('deleteDatabase', 'Cloudflare 503');
  const svc = service(infra);

  const first = await svc.runJob(env, req.jobId);
  assert.equal(first.ok, false); assert.equal(first.failedStep, 'delete_database');
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleting', 'not deleted until the provider really is clean');
  assert.equal((await labels.checkLabel(env, { label: 'reviews', domain: await pd.getDefaultDomain(env) })).available, false);
  assert.equal((await jobs.getJob(env, req.jobId)).status, 'failed');
  const afterFail = await all(env, `SELECT resource_type, status FROM site_resources WHERE site_id = ? ORDER BY resource_type`, s.siteId);
  assert.deepEqual(afterFail.filter((r) => r.status === 'deleted').map((r) => r.resource_type).sort(), ['route', 'worker'], 'what was removed is recorded; what was not is still active');
  assert.equal(env.BACKUPS.store.size, 1, 'nothing past the failed step ran');

  infra._deleteFailures.clear();
  infra._calls.length = 0;
  const second = await svc.retryTeardown(env, req.jobId);
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.deepEqual(infra._calls.map((c) => c.method).filter((m) => m.startsWith('delete')), ['deleteDatabase', 'deleteKVNamespace', 'deleteR2Bucket'], 'finished steps are not repeated');
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleted');
});

test('a resource the provider no longer has counts as already gone', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider();
  const s = await liveSite(env, infra, org);
  const req = await changeRequests.requestSiteDeletion(env, { organizationId: org.organizationId, siteId: s.siteId, actorUserId: org.userId, confirmName: 'Reviews' });
  infra._deleteFailures.set('deleteKVNamespace', 'Namespace not found');
  const r = await service(infra).runJob(env, req.jobId);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleted');
});

test('stored backups that cannot be removed block the deletion instead of being left behind', async () => {
  const env = makeEnv({ BACKUPS: undefined }); const org = await newOrg(env); const infra = createFakeInfraProvider();
  const s = await liveSite({ ...env, BACKUPS: { async put() {} } }, infra, org);
  const req = await changeRequests.requestSiteDeletion(env, { organizationId: org.organizationId, siteId: s.siteId, actorUserId: org.userId, confirmName: 'Reviews' });
  const r = await service(infra).runJob(env, req.jobId);
  assert.equal(r.ok, false); assert.equal(r.failedStep, 'delete_backups');
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleting');
});

test('starting a deletion twice reuses the open job; busy and deleted sites are refused', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider(); const svc = service(infra);
  const s = await liveSite(env, infra, org);
  const a = await svc.beginSiteDeletion(env, { siteId: s.siteId, actorType: 'lummet_admin', actorId: '1', reason: 'staff' });
  const b = await svc.beginSiteDeletion(env, { siteId: s.siteId, actorType: 'lummet_admin', actorId: '1' });
  assert.equal(a.ok, true); assert.equal(b.jobId, a.jobId); assert.equal(b.alreadyRunning, true);
  assert.equal((await all(env, `SELECT id FROM jobs WHERE type = 'site_teardown'`)).length, 1);

  const org2 = await newOrg(env);
  const busy = await sites.createSite(env, { organizationId: org2.organizationId, name: 'Busy', productId: 'prod_casino_news', actorUserId: org2.userId });
  await run(env, `UPDATE sites SET status = 'deploying' WHERE id = ?`, busy.siteId);
  const refused = await svc.beginSiteDeletion(env, { siteId: busy.siteId });
  assert.equal(refused.error, 'site_busy'); assert.equal(refused.status, 409);

  await svc.runJob(env, a.jobId);
  assert.equal((await svc.beginSiteDeletion(env, { siteId: s.siteId })).error, 'site_already_deleted');
  assert.equal((await svc.beginSiteDeletion(env, { siteId: 'nope' })).error, 'site_not_found');
  assert.equal((await svc.beginSiteDeletion(env, { siteId: s.siteId, organizationId: 'other-org' })).error, 'site_not_found');
});

test('a site that stopped at "provisioned" (no release published) can be deleted, and so can one that never provisioned', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider(); const svc = service(infra);
  const made = await sites.createSite(env, { organizationId: org.organizationId, name: 'Stuck', productId: 'prod_casino_news', actorUserId: org.userId });
  const provisioning = createProvisioningService(infra, { deploymentService: createDeploymentService(infra) });
  await provisioning.runJob(env, (await provisioning.startProvisioning(env, made.siteId)).jobId);
  assert.equal((await sites.getSite(env, made.siteId)).status, 'provisioned');
  const r = await svc.beginSiteDeletion(env, { siteId: made.siteId });
  assert.equal(r.ok, true);
  assert.equal((await svc.runJob(env, r.jobId)).ok, true);
  assert.deepEqual(infra._calls.map((c) => c.method).filter((m) => m.startsWith('delete')), ['deleteDatabase', 'deleteKVNamespace', 'deleteR2Bucket']);

  const pending = await sites.createSite(env, { organizationId: org.organizationId, name: 'Never started', productId: 'prod_casino_news', actorUserId: org.userId });
  const p = await svc.beginSiteDeletion(env, { siteId: pending.siteId });
  assert.equal((await svc.runJob(env, p.jobId)).ok, true);
  assert.equal((await sites.getSite(env, pending.siteId)).status, 'deleted');
});

test('the old delete left sites in "deleting" with no job: the sweep adopts and finishes them', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider();
  const s = await liveSite(env, infra, org);
  await sites.transitionSiteStatus(env, s.siteId, 'deleting', { actorType: 'customer_user' });   // exactly what the old code did, and nothing more
  assert.equal((await all(env, `SELECT id FROM jobs WHERE type = 'site_teardown'`)).length, 0);

  const runners = jobRunner.defaultRunners({ teardown: service(infra) });
  const first = await jobRunner.sweepJobs(env, { runners, now: Date.now() });
  assert.ok(first.results.some((r) => r.action === 'adopted_orphan_deletion'));
  assert.equal((await all(env, `SELECT id FROM jobs WHERE type = 'site_teardown'`)).length, 1);
  // The adopted job is picked up once it has sat unstarted for a few minutes (the same stuck-queued rule as every job).
  await run(env, `UPDATE jobs SET created_at = datetime('now', '-10 minutes') WHERE type = 'site_teardown'`);   // the sweep reads the database clock
  await jobRunner.sweepJobs(env, { runners });
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleted');
});

test('a failed teardown is retried by the sweep with backoff', async () => {
  const env = makeEnv(); const org = await newOrg(env); const infra = createFakeInfraProvider(); const svc = service(infra);
  const s = await liveSite(env, infra, org);
  const b = await svc.beginSiteDeletion(env, { siteId: s.siteId });
  infra._deleteFailures.set('deleteR2Bucket', 'timeout');
  assert.equal((await svc.runJob(env, b.jobId)).ok, false);
  infra._deleteFailures.clear();
  const runners = jobRunner.defaultRunners({ teardown: svc });
  await jobRunner.sweepJobs(env, { runners, now: Date.now() + 60000 });                       // too soon: backoff not over
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleting');
  await jobRunner.sweepJobs(env, { runners, now: Date.now() + (jobRunner.BACKOFF_MINUTES[0] + 1) * 60000 });
  assert.equal((await sites.getSite(env, s.siteId)).status, 'deleted');
});

// ---- through worker.fetch: customer and staff routes ----
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 60;
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload; if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
const routeEnv = () => ({ ...makeEnv(), ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) });
async function signup(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, 'plan_casino_news_starter').catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
async function staffCookie(env) {
  assert.equal((await call(env, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
  const l = await call(env, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  assert.equal(l.status, 200, l.text); return l.cookie;
}
async function waitFor(fn, ms = 3000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await new Promise((r) => setTimeout(r, 25)); } }

test('route: DELETE needs the typed name; with it the site goes to deleting (202), a job is queued, and the address frees when it finishes', async () => {
  const env = routeEnv();
  const a = await signup(env, 'del-a@example.com');
  const made = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Reviews', productId: 'prod_casino_news' } });
  assert.equal(made.status, 200, made.text);

  const noName = await call(env, 'DELETE', `/api/organizations/${a.orgId}/sites/${made.json.siteId}`, { cookie: a.cookie, body: {} });
  assert.equal(noName.status, 422); assert.equal(noName.json.error, 'confirmation_required');
  assert.equal((await sites.getSite(env, made.json.siteId)).status, 'pending');

  const del = await call(env, 'DELETE', `/api/organizations/${a.orgId}/sites/${made.json.siteId}`, { cookie: a.cookie, body: { confirmName: 'Reviews' } });
  assert.equal(del.status, 202, del.text);
  assert.ok(del.json.jobId);
  // Nothing was provisioned, so the real provider is never called; the job finishes on its own.
  const deleted = await waitFor(async () => (await sites.getSite(env, made.json.siteId)).status === 'deleted');
  assert.ok(deleted, 'teardown finished');
  const again = await call(env, 'GET', `/api/organizations/${a.orgId}/sites/name-check?label=reviews`, { cookie: a.cookie });
  assert.equal(again.json.data.available, true);

  const gone = await call(env, 'DELETE', `/api/organizations/${a.orgId}/sites/${made.json.siteId}`, { cookie: a.cookie, body: { confirmName: 'Reviews' } });
  assert.equal(gone.status, 409);
});

test('route: another organization cannot delete the site', async () => {
  const env = routeEnv();
  const a = await signup(env, 'own-a@example.com'); const b = await signup(env, 'own-b@example.com');
  const made = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Mine', productId: 'prod_casino_news' } });
  const r = await call(env, 'DELETE', `/api/organizations/${b.orgId}/sites/${made.json.siteId}`, { cookie: b.cookie, body: { confirmName: 'Mine' } });
  assert.equal(r.status, 404);
  assert.equal((await sites.getSite(env, made.json.siteId)).status, 'pending');
});

test('route: staff can delete any site with a reason and the typed name; the action is audited; wrong name or short reason is refused', async () => {
  const env = routeEnv();
  const a = await signup(env, 'staffdel@example.com');
  const made = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Casinos', productId: 'prod_casino_news' } });
  const staff = await staffCookie(env);
  const url = `/api/platform/saas/sites/${made.json.siteId}/delete`;

  assert.equal((await call(env, 'POST', url, { cookie: a.cookie, body: { confirmName: 'Casinos', reason: 'abuse report' } })).status >= 400, true, 'a customer cannot use the staff route');
  assert.equal((await call(env, 'POST', url, { cookie: staff, body: { confirmName: 'Casinos', reason: 'abc' } })).json.error, 'reason_required');
  assert.equal((await call(env, 'POST', url, { cookie: staff, body: { confirmName: 'casinos', reason: 'abuse report' } })).json.error, 'confirmation_required');
  assert.equal((await sites.getSite(env, made.json.siteId)).status, 'pending');

  const ok = await call(env, 'POST', url, { cookie: staff, body: { confirmName: 'Casinos', reason: 'abuse report' } });
  assert.equal(ok.status, 202, ok.text);
  assert.ok(await waitFor(async () => (await sites.getSite(env, made.json.siteId)).status === 'deleted'));
  const audit = await one(env, `SELECT action, reason, success FROM lummet_audit_logs WHERE resource = 'site' AND resource_id = ? AND action = 'staff_delete'`, made.json.siteId);
  assert.ok(audit, 'audited'); assert.equal(audit.reason, 'abuse report'); assert.equal(audit.success, 1);
  assert.equal((await call(env, 'POST', `/api/platform/saas/sites/nope/delete`, { cookie: staff, body: { confirmName: 'x', reason: 'abuse report' } })).status, 404);
});

test('route: a failed teardown job shows Retry on the staff job page, and a staff retry re-runs it', async () => {
  const env = routeEnv();
  const a = await signup(env, 'retry-a@example.com');
  const made = await call(env, 'POST', `/api/organizations/${a.orgId}/sites`, { cookie: a.cookie, body: { name: 'Retryable', productId: 'prod_casino_news' } });
  const staff = await staffCookie(env);
  // A teardown job that failed (as after a Cloudflare outage), with the site still deleting.
  await run(env, `UPDATE sites SET status = 'deleting' WHERE id = ?`, made.json.siteId);
  const job = await jobs.createJob(env, { type: 'site_teardown', organizationId: a.orgId, siteId: made.json.siteId, actorType: 'system', stepKeys: TEARDOWN_STEPS });
  await jobs.markJobRunning(env, job.jobId);
  await jobs.markJobFailed(env, job.jobId, 'failed at step delete_worker: Cloudflare 503');
  const page = await call(env, 'GET', `/platform/saas/jobs/${job.jobId}`, { cookie: staff });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`/api/platform/saas/jobs/${job.jobId}/retry`), 'Retry button is offered');
  const retry = await call(env, 'POST', `/api/platform/saas/jobs/${job.jobId}/retry`, { cookie: staff, body: {} });
  assert.equal(retry.status, 200, retry.text);
  assert.ok(await waitFor(async () => (await sites.getSite(env, made.json.siteId)).status === 'deleted'), 'the retried teardown finished');
});
