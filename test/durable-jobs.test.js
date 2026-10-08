// v7D: durable background jobs. Covers the safety net (job-runner.js sweepJobs), dispatch through a Queue or
// waitUntil, the Queue consumer, dead-lettering, and the failure -> retry -> success path end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createProvisioningService } from '../worker/provisioning.js';
import * as jobsModule from '../worker/jobs.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as jobRunner from '../worker/job-runner.js';
import { runAlertCheck } from '../worker/alerts.js';
import worker from '../worker/index.js';

const { sweepJobs, dispatchJob, handleQueueBatch, defaultRunners, requeueDeadLetter, MAX_AUTO_RETRIES } = jobRunner;
const HOUR = 3600 * 1000;

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ...extra };
}
const signupReq = (email) => ({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.31' } });
async function orgWithSite(env, email) {
  const s = await customerAuth.signUp(signupReq(email), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: s.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: s.userId });
  return { orgId: s.organizationId, siteId: site.siteId };
}
const one = (env, sql, ...b) => env.LUMMET_DB.prepare(sql).bind(...b).first();
const ago = (env, jobId, minutes) => env.LUMMET_DB.batch([
  env.LUMMET_DB.prepare(`UPDATE jobs SET created_at = datetime('now', ?), started_at = CASE WHEN started_at IS NULL THEN NULL ELSE datetime('now', ?) END WHERE id = ?`).bind(`-${minutes} minutes`, `-${minutes} minutes`, jobId),
  env.LUMMET_DB.prepare(`UPDATE job_logs SET created_at = datetime('now', ?) WHERE job_id = ?`).bind(`-${minutes} minutes`, jobId)
]);
/** Runners that record what they were asked to do (and optionally misbehave) instead of touching real infrastructure. */
function stubRunners({ retryFails = false } = {}) {
  const calls = [];
  const mk = (type, retryFailed) => ({
    resumeLost: true, retryFailed,
    run: async (env, job) => { calls.push(['run', type, job.id]); return { ok: true }; },
    retry: async (env, job) => { calls.push(['retry', type, job.id]); if (retryFails) await jobsModule.markJobFailed(env, job.id, 'still broken'); return retryFails ? { ok: false } : { ok: true }; }
  });
  return { calls, runners: { tenant_provisioning: mk('tenant_provisioning', true), site_deployment: mk('site_deployment', false) } };
}
async function newJob(env, type, { status = 'queued', siteId = null } = {}) {
  const { jobId } = await jobsModule.createJob(env, { type, siteId, stepKeys: ['a', 'b'] });
  if (status === 'running') await jobsModule.markJobRunning(env, jobId);
  if (status === 'failed') { await jobsModule.markJobRunning(env, jobId); await jobsModule.markJobFailed(env, jobId, 'boom'); }
  return jobId;
}

test('failure -> retry -> success: a failed provisioning job is retried by the sweep after its backoff and the site comes up', async () => {
  const env = makeEnv(); const infra = createFakeInfraProvider();
  const svc = createProvisioningService(infra);
  const { siteId } = await orgWithSite(env, 'retry-ok@example.com');
  const start = await svc.startProvisioning(env, siteId);
  infra._failNextCall('createDatabase', 'cloudflare timeout');
  assert.equal((await svc.runJob(env, start.jobId)).ok, false);
  assert.equal((await sites.getSite(env, siteId)).status, 'failed');
  const runners = defaultRunners({ provisioning: svc });

  assert.deepEqual((await sweepJobs(env, { runners })).results, [], 'not due yet: the first retry waits 5 minutes');
  const swept = await sweepJobs(env, { runners, now: Date.now() + 6 * 60 * 1000 });
  assert.equal(swept.results.length, 1);
  assert.match(swept.results[0].action, /retried by the sweep/);

  const job = await jobsModule.getJob(env, start.jobId);
  assert.equal(job.status, 'success');
  assert.equal(job.auto_retries, 1);
  assert.equal((await sites.getSite(env, siteId)).status, 'provisioned');
  assert.ok((await jobsModule.getJobHistory(env, start.jobId)).logs.some((l) => /retried by the sweep/.test(l.message)));
  assert.deepEqual((await sweepJobs(env, { runners, now: Date.now() + 99 * HOUR })).results, [], 'a finished job is left alone');
});

test('a job that keeps failing is retried with backoff up to the limit, then dead-lettered; staff retry forgives it', async () => {
  const env = makeEnv(); const { calls, runners } = stubRunners({ retryFails: true });
  const id = await newJob(env, 'tenant_provisioning', { status: 'failed' });
  for (let i = 0; i < MAX_AUTO_RETRIES; i++) {
    const r = await sweepJobs(env, { runners, now: Date.now() + 10 * HOUR });
    assert.equal(r.results.length, 1, `retry ${i + 1}`);
  }
  assert.equal(calls.filter((c) => c[0] === 'retry').length, MAX_AUTO_RETRIES);
  const last = await sweepJobs(env, { runners, now: Date.now() + 10 * HOUR });
  assert.equal(last.results[0].action, 'dead_lettered');
  assert.match(last.results[0].reason, /retries used up/);
  assert.equal(calls.length, MAX_AUTO_RETRIES, 'nothing is run once it is dead');

  const job = await jobsModule.getJob(env, id);
  assert.equal(job.status, 'failed', 'status keeps its old meaning');
  assert.ok(job.dead_lettered_at);
  assert.deepEqual((await sweepJobs(env, { runners, now: Date.now() + 99 * HOUR })).results, []);

  const alert = await runAlertCheck({ ...env, ENVIRONMENT: 'staging', ALERT_WEBHOOK_URL: 'https://hooks.example.com/x/y' }, { fetchImpl: async () => new Response('', { status: 200 }) });
  assert.equal(alert.results.find((r) => r.key === 'dead_jobs').action, 'notified');

  assert.equal(await requeueDeadLetter(env, id), true);
  const again = await jobsModule.getJob(env, id);
  assert.equal(again.dead_lettered_at, null); assert.equal(again.auto_retries, 0);
  assert.equal((await sweepJobs(env, { runners, now: Date.now() + 10 * HOUR })).results.length, 1, 'eligible again');
});

test('backoff: a failed job is not retried before its wait has passed, and the wait grows', async () => {
  const env = makeEnv(); const { calls, runners } = stubRunners({ retryFails: true });
  await newJob(env, 'tenant_provisioning', { status: 'failed' });
  assert.equal((await sweepJobs(env, { runners, now: Date.now() + 4 * 60 * 1000 })).results.length, 0, '5 minutes for the first retry');
  assert.equal((await sweepJobs(env, { runners, now: Date.now() + 6 * 60 * 1000 })).results.length, 1);
  assert.equal((await sweepJobs(env, { runners, now: Date.now() + 10 * 60 * 1000 })).results.length, 0, 'the second wait is 15 minutes');
  assert.equal((await sweepJobs(env, { runners, now: Date.now() + 16 * 60 * 1000 })).results.length, 1);
  assert.equal(calls.length, 2);
});

test('a running job with no activity is treated as lost: its run is closed as failed and it is resumed; an active one is left alone', async () => {
  const env = makeEnv(); const { calls, runners } = stubRunners();
  const lost = await newJob(env, 'site_deployment', { status: 'running' });
  const alive = await newJob(env, 'site_deployment', { status: 'running' });
  await ago(env, lost, 20);
  const r = await sweepJobs(env, { runners });
  assert.deepEqual(r.results.map((x) => [x.jobId, x.action]), [[lost, 'resumed_stale']]);
  assert.deepEqual(calls, [['run', 'site_deployment', lost]]);
  const runs = (await jobsModule.getJobHistory(env, lost)).runs;
  assert.equal(runs[0].status, 'failed'); assert.match(runs[0].error_message, /Worker running this job stopped/);
  assert.equal((await jobsModule.getJob(env, alive)).auto_retries, 0);
});

test('a job that was never started is started by the sweep, exactly once even when two sweeps race', async () => {
  const env = makeEnv(); const { calls, runners } = stubRunners();
  const id = await newJob(env, 'tenant_provisioning');
  const fresh = await newJob(env, 'tenant_provisioning');
  await ago(env, id, 10);
  await Promise.all([sweepJobs(env, { runners }), sweepJobs(env, { runners })]);
  assert.deepEqual(calls, [['run', 'tenant_provisioning', id]], 'the fresh job is not touched; the old one ran once');
  assert.equal((await jobsModule.getJob(env, id)).auto_retries, 1);
  assert.equal((await jobsModule.getJob(env, fresh)).auto_retries, 0);
});

test('a failed deployment is never retried automatically (that is a decision), but a lost one is resumed', async () => {
  const env = makeEnv(); const { calls, runners } = stubRunners();
  const failed = await newJob(env, 'site_deployment', { status: 'failed' });
  assert.deepEqual((await sweepJobs(env, { runners, now: Date.now() + 99 * HOUR })).results, []);
  const lost = await newJob(env, 'site_deployment'); await ago(env, lost, 10);
  const r = await sweepJobs(env, { runners });
  assert.deepEqual(r.results.map((x) => x.jobId), [lost]);
  assert.equal((await jobsModule.getJob(env, failed)).auto_retries, 0);
  assert.equal(calls.length, 1);
});

test('lost jobs that keep getting lost are dead-lettered after the limit', async () => {
  const env = makeEnv(); const { runners } = stubRunners();
  const id = await newJob(env, 'tenant_provisioning'); await ago(env, id, 10);
  await env.LUMMET_DB.prepare(`UPDATE jobs SET auto_retries = ? WHERE id = ?`).bind(MAX_AUTO_RETRIES, id).run();
  const r = await sweepJobs(env, { runners });
  assert.equal(r.results[0].action, 'dead_lettered');
  const job = await jobsModule.getJob(env, id);
  assert.equal(job.status, 'failed'); assert.ok(job.dead_lettered_at);
});

test('a failed provisioning job whose site can no longer be retried is dead-lettered with the reason, not retried forever', async () => {
  const env = makeEnv(); const infra = createFakeInfraProvider(); const svc = createProvisioningService(infra);
  const { siteId } = await orgWithSite(env, 'gone@example.com');
  const start = await svc.startProvisioning(env, siteId);
  infra._failNextCall('createDatabase', 'boom'); await svc.runJob(env, start.jobId);
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'suspended' WHERE id = ?`).bind(siteId).run();
  await sweepJobs(env, { runners: defaultRunners({ provisioning: svc }), now: Date.now() + 10 * HOUR });
  const job = await jobsModule.getJob(env, start.jobId);
  assert.ok(job.dead_lettered_at); assert.match(job.dead_reason, /site_not_failed/);
});

test('dispatchJob uses the Queue when bound, falls back to waitUntil when it refuses, and uses waitUntil when there is none', async () => {
  const { calls, runners } = stubRunners();
  const env = makeEnv(); const id = await newJob(env, 'tenant_provisioning');
  const pending = []; const ctx = { waitUntil: (p) => pending.push(p) };

  const sent = []; env.JOB_QUEUE = { send: async (m) => { sent.push(m); } };
  assert.equal((await dispatchJob(env, ctx, id, { runners })).via, 'queue');
  assert.deepEqual(sent, [{ kind: 'run', jobId: id }]); assert.equal(pending.length, 0); assert.equal(calls.length, 0);

  env.JOB_QUEUE = { send: async () => { throw new Error('queue down'); } };
  assert.equal((await dispatchJob(env, ctx, id, { runners })).via, 'waitUntil');
  await Promise.all(pending); assert.equal(calls.length, 1);

  delete env.JOB_QUEUE; pending.length = 0;
  assert.equal((await dispatchJob(env, ctx, id, { runners })).via, 'waitUntil');
  await Promise.all(pending); assert.equal(calls.length, 2);
});

test('with a Queue bound, the sweep enqueues instead of running, and the consumer runs the job, acks, or asks for redelivery', async () => {
  const { calls, runners } = stubRunners({ retryFails: false });
  const env = makeEnv(); const sent = []; env.JOB_QUEUE = { send: async (m) => { sent.push(m); } };
  const id = await newJob(env, 'tenant_provisioning', { status: 'failed' });
  const r = await sweepJobs(env, { runners, now: Date.now() + 10 * HOUR });
  assert.equal(r.results[0].via, 'queue'); assert.deepEqual(sent, [{ kind: 'retry', jobId: id }]); assert.equal(calls.length, 0);

  const acked = []; const retried = [];
  const msg = (body, attempts = 1) => ({ body, attempts, ack: () => acked.push(body), retry: (o) => retried.push([body, o]) });
  await handleQueueBatch({ messages: [msg(sent[0]), msg({ kind: 'run', jobId: 'no-such-job' })] }, env, { runners });
  assert.deepEqual(calls, [['retry', 'tenant_provisioning', id]]); assert.equal(acked.length, 2, 'unknown jobs are acked, not retried forever');

  const boom = { tenant_provisioning: { run: async () => { throw new Error('x'); } } };
  await handleQueueBatch({ messages: [msg({ kind: 'run', jobId: id }, 3)] }, env, { runners: boom });
  assert.deepEqual(retried, [[{ kind: 'run', jobId: id }, { delaySeconds: 120 }]], 'redelivery is delayed and grows with attempts');
});

test('POST /api/ops/alert-check also runs the job sweep (same token, same pinger)', async () => {
  const env = makeEnv({ ALERT_CHECK_TOKEN: 'tick-token' }); const sent = []; env.JOB_QUEUE = { send: async (m) => { sent.push(m); } };
  const id = await newJob(env, 'tenant_provisioning'); await ago(env, id, 10);
  const res = await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method: 'POST', headers: { Authorization: 'Bearer tick-token' } }), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.jobs.map((j) => j.jobId), [id]);
  assert.deepEqual(sent, [{ kind: 'run', jobId: id }]);
});

test('the Worker exports a queue handler', () => { assert.equal(typeof worker.queue, 'function'); });
