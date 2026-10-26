import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
function env(mode = 'off', extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', BILLING_ENFORCE: mode,
    PORTAL_BASE_URL: 'https://app.example.test', EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }), ...extra };
}
async function call(e, method, path, body, cookie, headers = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.41', ...headers });
  if (cookie) h.set('Cookie', cookie);
  if (body !== undefined && body !== null) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: response.status, json, text, cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(e, email, orgName = email) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: orgName });
  assert.equal(r.status, 200, r.text);
  return { ...r, organizationId: r.json.organizationId };
}
async function auditRows(e, action) {
  return (await e.LUMMET_DB.prepare('SELECT action, success, status_code, error_message FROM lummet_audit_logs WHERE action = ?').bind(action).all()).results;
}

test('invitation route: off preserves legacy behavior at seat boundary', async () => {
  const e = env('off'); const owner = await signup(e, 'off-owner@example.test'); await plans.startTrialSubscription(e, owner.organizationId, 'plan_casino_news_starter');
  const first = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'one@example.test', role: 'viewer' }, owner.cookie);
  const second = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'two@example.test', role: 'viewer' }, owner.cookie);
  assert.equal(first.status, 200, first.text); assert.equal(second.status, 200, second.text);
  assert.equal((await auditRows(e, 'seat_limit_shadow')).length, 0, 'off must not emit shadow gate records');
});

test('invitation route: shadow records a stable would-exceed reason but does not block', async () => {
  const e = env('shadow'); const owner = await signup(e, 'shadow-owner@example.test'); await plans.startTrialSubscription(e, owner.organizationId, 'plan_casino_news_starter');
  const first = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'one@example.test', role: 'viewer' }, owner.cookie);
  const second = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'two@example.test', role: 'viewer' }, owner.cookie);
  assert.equal(first.status, 200, first.text); assert.equal(second.status, 200, second.text);
  const rows = await auditRows(e, 'seat_limit_shadow');
  assert.equal(rows.length, 1); assert.equal(rows[0].success, 1); assert.equal(rows[0].error_message, 'seat_limit_reached');
});

test('invitation route: enforce refuses at the boundary with stable reason and audit', async () => {
  const e = env('enforce'); const owner = await signup(e, 'enforce-owner@example.test'); await plans.startTrialSubscription(e, owner.organizationId, 'plan_casino_news_starter');
  const first = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'one@example.test', role: 'viewer' }, owner.cookie);
  const second = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'two@example.test', role: 'viewer' }, owner.cookie);
  assert.equal(first.status, 200, first.text); assert.equal(second.status, 402, second.text);
  assert.equal(second.json.error, 'seat_limit_reached');
  const rows = await auditRows(e, 'create');
  assert.ok(rows.some(r => r.success === 0 && r.error_message === 'seat_limit_reached'));
});

test('invitation route rejects unauthenticated, invalid-role, and cross-organization requests', async () => {
  const e = env('off'); const ownerA = await signup(e, 'owner-a@example.test'); const ownerB = await signup(e, 'owner-b@example.test');
  const unauth = await call(e, 'POST', `/api/organizations/${ownerA.organizationId}/invitations`, { email: 'x@example.test', role: 'viewer' });
  assert.equal(unauth.status, 401);
  const invalid = await call(e, 'POST', `/api/organizations/${ownerA.organizationId}/invitations`, { email: 'x@example.test', role: 'superuser' }, ownerA.cookie);
  assert.equal(invalid.status, 422); assert.equal(invalid.json.error, 'invalid_role');
  const cross = await call(e, 'POST', `/api/organizations/${ownerB.organizationId}/invitations`, { email: 'x@example.test', role: 'viewer' }, ownerA.cookie);
  assert.ok([403, 404].includes(cross.status), cross.text);
  const count = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM organization_invitations WHERE organization_id = ?').bind(ownerB.organizationId).first();
  assert.equal(count.n, 0, 'cross-tenant request must not create an invitation');
});

test('invitation accept route is single-use and binds the invitation to its email', async () => {
  const e = env('off'); const owner = await signup(e, 'owner-replay@example.test');
  const invite = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'invitee-replay@example.test', role: 'viewer' }, owner.cookie);
  assert.equal(invite.status, 200, invite.text); assert.ok(invite.json.token);
  const wrong = await signup(e, 'wrong-replay@example.test');
  const mismatch = await call(e, 'POST', `/api/invitations/${invite.json.token}/accept`, null, wrong.cookie);
  assert.equal(mismatch.status, 403); assert.equal(mismatch.json.error, 'invitation_email_mismatch');
  const right = await signup(e, 'invitee-replay@example.test');
  const accepted = await call(e, 'POST', `/api/invitations/${invite.json.token}/accept`, null, right.cookie);
  assert.equal(accepted.status, 200, accepted.text);
  const replay = await call(e, 'POST', `/api/invitations/${invite.json.token}/accept`, null, right.cookie);
  assert.equal(replay.status, 404); assert.equal(replay.json.error, 'invalid_or_used_invitation');
});

test('rollout route rejects unauthenticated requests before creating a rollout', async () => {
  const e = env('off');
  const r = await call(e, 'POST', '/api/platform/saas/rollouts', { version: '1.0.0' });
  assert.equal(r.status, 401, r.text);
  const rows = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM tenant_rollouts').first();
  assert.equal(rows.n, 0);
});

test('invitation route rejects duplicate pending invitations and malformed email', async () => {
  const e = env('off'); const owner = await signup(e, 'duplicate-owner@example.test');
  const malformed = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'not-an-email', role: 'viewer' }, owner.cookie);
  assert.equal(malformed.status, 422); assert.equal(malformed.json.error, 'invalid_email');
  const first = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'repeat@example.test', role: 'viewer' }, owner.cookie);
  const second = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'REPEAT@example.test', role: 'viewer' }, owner.cookie);
  assert.equal(first.status, 200, first.text); assert.equal(second.status, 409); assert.equal(second.json.error, 'invitation_already_pending');
});

test('invitation route provider failure leaves durable email queued and does not claim delivery', async () => {
  const e = env('off', { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Lummet <no-reply@example.test>', EMAIL_FETCH: async () => new Response('provider unavailable', { status: 503 }) });
  const owner = await signup(e, 'provider-owner@example.test');
  const r = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'provider-invitee@example.test', role: 'viewer' }, owner.cookie);
  assert.equal(r.status, 200, r.text);
  await new Promise(resolve => setTimeout(resolve, 25)); // let the request's waitUntil fake finish the provider attempt
  const row = await e.LUMMET_DB.prepare("SELECT status, last_error FROM email_outbox WHERE template = 'invitation' ORDER BY created_at DESC LIMIT 1").first();
  assert.ok(row); assert.equal(row.status, 'queued'); assert.equal(row.last_error, 'provider_http_503');
});

test('invitation route fails closed on database write failure without creating a row', async () => {
  const e = env('off'); const owner = await signup(e, 'db-failure-owner@example.test');
  const originalPrepare = e.LUMMET_DB.prepare.bind(e.LUMMET_DB);
  e.LUMMET_DB.prepare = (sql) => {
    if (/INSERT INTO organization_invitations/i.test(sql)) throw new Error('simulated database unavailable');
    return originalPrepare(sql);
  };
  const r = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'db-failure@example.test', role: 'viewer' }, owner.cookie);
  assert.equal(r.status, 500, r.text);
  e.LUMMET_DB.prepare = originalPrepare;
  const count = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM organization_invitations WHERE organization_id = ?').bind(owner.organizationId).first();
  assert.equal(count.n, 0);
});


test('usage snapshot GET is read-only; the scheduled path owns snapshot writes', async () => {
  const e = env('off'); const owner = await signup(e, 'usage-readonly@example.test');
  const before = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM usage_snapshots WHERE organization_id = ?').bind(owner.organizationId).first();
  const r = await call(e, 'GET', `/api/organizations/${owner.organizationId}/usage/snapshots`, null, owner.cookie);
  assert.equal(r.status, 200, r.text);
  const after = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM usage_snapshots WHERE organization_id = ?').bind(owner.organizationId).first();
  assert.equal(after.n, before.n, 'GET must not mutate usage snapshots');
});

test('invitation route rate-limits repeated invalid attempts per IP', async () => {
  const e = env('off'); const owner = await signup(e, 'rate-limit-owner@example.test');
  let last;
  for (let i = 0; i < 11; i++) {
    last = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: `rate-${i}@example.test`, role: 'not-a-role' }, owner.cookie, { 'CF-Connecting-IP': '198.51.100.77' });
  }
  assert.equal(last.status, 429, last.text); assert.equal(last.json.error, 'too_many_attempts');
});

test('daily scheduled sweep writes measured usage snapshots idempotently', async () => {
  const e = env('off'); const owner = await signup(e, 'usage-scheduled@example.test');
  const tasks = []; const scheduledCtx = { waitUntil(p) { tasks.push(Promise.resolve(p)); } };
  await worker.scheduled({ cron: '0 2 * * *' }, e, scheduledCtx);
  await Promise.all(tasks);
  const first = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM usage_snapshots WHERE organization_id = ?').bind(owner.organizationId).first();
  assert.ok(first.n >= 3, `expected measured sites/seats/domains snapshots, got ${first.n}`);
  const tasks2 = []; await worker.scheduled({ cron: '0 2 * * *' }, e, { waitUntil(p) { tasks2.push(Promise.resolve(p)); } }); await Promise.all(tasks2);
  const second = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM usage_snapshots WHERE organization_id = ?').bind(owner.organizationId).first();
  assert.equal(second.n, first.n, 'same-day scheduled snapshot rerun is idempotent');
});

test('invitation route rejects cross-origin cookie mutation before writing', async () => {
  const e = env('off'); const owner = await signup(e, 'csrf-owner@example.test');
  const r = await call(e, 'POST', `/api/organizations/${owner.organizationId}/invitations`, { email: 'csrf-invitee@example.test', role: 'viewer' }, owner.cookie, { Origin: 'https://attacker.example' });
  assert.equal(r.status, 403, r.text);
  const count = await e.LUMMET_DB.prepare('SELECT COUNT(*) AS n FROM organization_invitations WHERE organization_id = ?').bind(owner.organizationId).first();
  assert.equal(count.n, 0);
});
