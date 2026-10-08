import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as usage from '../worker/usage.js';
import * as credits from '../worker/ai-credits.js';
import { runAiTask } from '../worker/ai-gateway.js';
import * as jobs from '../worker/jobs.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import worker from '../worker/index.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const req = (ip = '203.0.113.9') => ({ async json() { return {}; }, headers: { get: (n) => (n === 'CF-Connecting-IP' ? ip : null) } });
async function orgOnPlan(e, email, planId) {
  const s = await customerAuth.signUp({ async json() { return { email, password: 'Correct-Horse-Battery-9', organizationName: 'O' }; }, headers: { get: () => '203.0.113.9' } }, e);
  await plans.startTrialSubscription(e, s.organizationId, planId);
  return s;
}
const okProvider = { name: 'fake', model: 'm1', async complete() { return { text: 'hello', tokensIn: 10, tokensOut: 5, costMicros: 42 }; } };

test('usage events are idempotent and aggregate monthly', async () => {
  const e = env();
  await usage.recordUsage(e, { organizationId: 'o1', metric: 'emails', quantity: 2, idempotencyKey: 'a' });
  const dup = await usage.recordUsage(e, { organizationId: 'o1', metric: 'emails', quantity: 2, idempotencyKey: 'a' });
  await usage.recordUsage(e, { organizationId: 'o1', metric: 'emails', quantity: 3 });
  assert.equal(dup.duplicate, true);
  assert.equal((await usage.getMonthlyUsage(e, 'o1')).emails, 5);
  assert.equal((await usage.recordUsage(e, { organizationId: 'o1', metric: 'x', quantity: 0 })).ok, false);
});

test('usage is isolated per organization', async () => {
  const e = env();
  await usage.recordUsage(e, { organizationId: 'o1', metric: 'api_requests', quantity: 7 });
  assert.deepEqual(await usage.getMonthlyUsage(e, 'o2'), {});
});

test('credit reservation is atomic: cannot overspend, refund restores', async () => {
  const e = env();
  await credits.addCredits(e, 'o1', 10, { idempotencyKey: 'pay_1' });
  assert.equal((await credits.addCredits(e, 'o1', 10, { idempotencyKey: 'pay_1' })).duplicate, true, 'same payment id credited once');
  const a = await credits.reserveCredits(e, { organizationId: 'o1', amount: 6 });
  assert.ok(a.ok);
  assert.equal((await credits.reserveCredits(e, { organizationId: 'o1', amount: 6 })).error, 'insufficient_credits');
  assert.equal(await credits.getBalance(e, 'o1'), 4);
  await credits.refundCredits(e, { organizationId: 'o1', reservationId: a.reservationId });
  assert.equal(await credits.getBalance(e, 'o1'), 10);
  assert.equal((await credits.refundCredits(e, { organizationId: 'o1', reservationId: a.reservationId })).duplicate, true, 'double refund is a no-op');
  assert.equal(await credits.getBalance(e, 'o1'), 10);
});

test('settle never charges more than reserved and returns the difference', async () => {
  const e = env();
  await credits.addCredits(e, 'o1', 20);
  const r = await credits.reserveCredits(e, { organizationId: 'o1', amount: 5 });
  const s = await credits.settleCredits(e, { organizationId: 'o1', reservationId: r.reservationId, actual: 2 });
  assert.equal(s.charged, 2); assert.equal(await credits.getBalance(e, 'o1'), 18);
  const over = await credits.reserveCredits(e, { organizationId: 'o1', amount: 3 });
  const s2 = await credits.settleCredits(e, { organizationId: 'o1', reservationId: over.reservationId, actual: 99 });
  assert.equal(s2.charged, 3);
});

test('a reservation belongs to its organization', async () => {
  const e = env();
  await credits.addCredits(e, 'o1', 10);
  const r = await credits.reserveCredits(e, { organizationId: 'o1', amount: 4 });
  assert.equal((await credits.refundCredits(e, { organizationId: 'o2', reservationId: r.reservationId })).error, 'unknown_reservation');
});

test('gateway: plan without ai.enabled is refused before any credit is touched', async () => {
  const e = env(); const s = await orgOnPlan(e, 'a@x.test', 'plan_casino_news_starter');
  const r = await runAiTask(e, { organizationId: s.organizationId, task: 'summarize', input: { text: 'x' }, provider: okProvider });
  assert.equal(r.error, 'ai_not_enabled');
  assert.equal(await credits.getBalance(e, s.organizationId), 0);
});

test('gateway: growth plan gets its monthly allocation once, is charged, and usage is recorded', async () => {
  const e = env(); const s = await orgOnPlan(e, 'g@x.test', 'plan_casino_news_growth');
  const r = await runAiTask(e, { organizationId: s.organizationId, task: 'seo_meta', input: { title: 't', summary: 's' }, provider: okProvider });
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.creditsCharged, 2);
  await runAiTask(e, { organizationId: s.organizationId, task: 'summarize', input: { text: 'x' }, provider: okProvider });
  assert.equal(await credits.getBalance(e, s.organizationId), 500 - 3, 'allocation granted exactly once');
  assert.equal((await usage.getMonthlyUsage(e, s.organizationId)).ai_credits, 3);
  const led = (await credits.listLedger(e, s.organizationId)).find((x) => x.kind === 'settle');
  assert.equal(led.model, 'm1');
});

test('gateway: provider failure refunds and hides provider detail', async () => {
  const e = env(); const s = await orgOnPlan(e, 'f@x.test', 'plan_casino_news_growth');
  const bad = { name: 'bad', model: 'm', async complete() { throw new Error('SECRET upstream stack'); } };
  const r = await runAiTask(e, { organizationId: s.organizationId, task: 'draft_article', input: { topic: 't' }, provider: bad });
  assert.equal(r.error, 'provider_error'); assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.equal(await credits.getBalance(e, s.organizationId), 500);
});

test('gateway: unknown task / oversized / missing input / exhausted credits', async () => {
  const e = env(); const s = await orgOnPlan(e, 'v@x.test', 'plan_casino_news_growth');
  const run = (task, input) => runAiTask(e, { organizationId: s.organizationId, task, input, provider: okProvider });
  assert.equal((await run('drop_tables', {})).error, 'unknown_task');
  assert.equal((await run('summarize', {})).error, 'missing_text');
  assert.equal((await run('summarize', { text: 'x'.repeat(9000) })).error, 'input_too_long');
  await credits.addCredits(e, s.organizationId, 1, { kind: 'adjust' }); // ensure a ledger exists
  await credits.grantMonthlyAllocation(e, s.organizationId);
  const bal = await credits.getBalance(e, s.organizationId);
  await credits.reserveCredits(e, { organizationId: s.organizationId, amount: bal });
  assert.equal((await run('summarize', { text: 'x' })).status, 402);
});

test('job history: runs, attempts and logs are recorded; retry is a new run', async () => {
  const e = env();
  const { jobId } = await jobs.createJob(e, { type: 'test', stepKeys: ['a', 'b'] });
  await jobs.markJobRunning(e, jobId);
  await jobs.startStep(e, jobId, 'a'); await jobs.completeStep(e, jobId, 'a', {});
  await jobs.startStep(e, jobId, 'b'); await jobs.failStep(e, jobId, 'b', 'boom'); await jobs.markJobFailed(e, jobId, 'boom');
  await jobs.markJobRunning(e, jobId);
  await jobs.startStep(e, jobId, 'b'); await jobs.completeStep(e, jobId, 'b', {}); await jobs.markJobSuccess(e, jobId, {});
  const h = await jobs.getJobHistory(e, jobId);
  assert.deepEqual(h.runs.map((r) => [r.run_number, r.trigger, r.status]), [[1, 'initial', 'failed'], [2, 'retry', 'success']]);
  assert.equal(h.attempts.filter((a) => a.step_key === 'b').map((a) => a.status).join(), 'failed,success');
  assert.ok(h.logs.some((l) => l.level === 'error' && /boom/.test(l.message)));
});

async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('routes: credits/ledger/run are org-scoped and role-gated', async () => {
  const e = env();
  const a = await call(e, 'POST', '/api/customer/signup', { email: 'ra@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'A' });
  const b = await call(e, 'POST', '/api/customer/signup', { email: 'rb@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'B' });
  const org = a.json.organizationId;
  assert.equal((await call(e, 'GET', `/api/organizations/${org}/ai/credits`, null, a.cookie)).status, 200);
  assert.ok([403, 404].includes((await call(e, 'GET', `/api/organizations/${org}/ai/credits`, null, b.cookie)).status));
  assert.ok([403, 404].includes((await call(e, 'GET', `/api/organizations/${org}/ai/ledger`, null, b.cookie)).status));
  assert.equal((await call(e, 'GET', `/api/organizations/${org}/ai/credits`)).status, 401);
  const run = await call(e, 'POST', `/api/organizations/${org}/ai/run`, { task: 'summarize', input: { text: 'x' } }, a.cookie);
  assert.equal(run.status, 403, 'no trial plan => ai_not_enabled');
  const foreign = await call(e, 'POST', `/api/organizations/${org}/ai/run`, { task: 'summarize', input: { text: 'x' }, siteId: 'not-mine' }, a.cookie);
  assert.equal(foreign.status, 404);
});
