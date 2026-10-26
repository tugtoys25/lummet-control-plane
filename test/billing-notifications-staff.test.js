// Phase 2.3: staff view of billing notifications and the dedupe-aware resend.
// The rule under test: resend never writes a new message, so it can never produce a second copy of an email that was
// delivered or is on its way. It only retries an intent that never reached the outbox, or re-queues a FAILED message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as notifications from '../worker/billing-notifications.js';
import * as repo from '../worker/repositories/billing-notifications.js';
import { flushOutbox, emailHash, queueEmail } from '../worker/email.js';
import { BILLING_KINDS } from '../worker/billing-email-templates.js';
import * as customerAuth from '../worker/customer-auth.js';

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const MAIL = { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Lummet <no-reply@example.test>', PORTAL_BASE_URL: 'https://app.example.test' };
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), BILLING_EMAILS: 'on', ENVIRONMENT: 'production', ...MAIL, ...extra };
}
async function signup(env, email, name) {
  const r = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: name || 'Org ' + email }; }, headers: { get: () => '203.0.113.9' } }, env);
  await env.LUMMET_DB.prepare(`UPDATE customer_users SET email_verified_at = CURRENT_TIMESTAMP WHERE email = ?`).bind(email).run();
  return r.organizationId;
}
async function addSub(env, orgId) {
  const id = crypto.randomUUID();
  await env.LUMMET_DB.prepare(`INSERT INTO subscriptions (id, organization_id, plan_id, status, updated_at, created_at) VALUES (?,?,?,?,?,?)`)
    .bind(id, orgId, 'plan_casino_news_starter', 'active', iso(Date.now()), iso(Date.now())).run();
  return id;
}
const outbox = async (env) => (await env.LUMMET_DB.prepare(`SELECT * FROM email_outbox WHERE template LIKE 'billing_%' ORDER BY created_at, rowid`).all()).results;
const failingFetch = (status) => async () => new Response('{}', { status });
const okFetch = async () => new Response(JSON.stringify({ id: 'msg_ok' }), { status: 200 });
const flushAll = async (env, fetchImpl, rounds = 6) => { for (let i = 0; i < rounds; i++) await flushOutbox(env, { fetchImpl, now: Date.now() + i * 3600000 }); };

async function oneNotice(extra = {}) {
  const env = makeEnv(extra);
  const org = await signup(env, `o-${Math.random().toString(36).slice(2)}@example.com`);
  const sub = await addSub(env, org);
  const r = await notifications.notify.cancellationScheduled(env, { organizationId: org, subscriptionId: sub, endsAt: iso(Date.now() + 5 * DAY) });
  assert.ok(r.ok && r.queued === 1, JSON.stringify(r));
  return { env, org, sub, id: r.notificationId };
}

// ---------------------------------------------------------------- states and filters
test('the staff list reports each state and filters by organization, kind and state', async () => {
  const { env, org, sub } = await oneNotice();
  const state = async (f = {}) => (await repo.listForStaff(env, f));
  assert.equal((await state())[0].state, 'queued');
  await flushAll(env, okFetch); await repo.syncSent(env);
  assert.equal((await state())[0].state, 'sent');

  // failed: a second notice whose only message fails permanently
  const r2 = await notifications.notify.endingSoon(env, { organizationId: org, subscriptionId: sub, endsAt: iso(Date.now() + 2 * DAY), bucket: 3, daysLeft: 2 });
  await flushAll(env, failingFetch(400));
  assert.equal((await state({ state: 'failed' })).length, 1);
  assert.equal((await state({ state: 'failed' }))[0].id, r2.notificationId);

  // pending, then stuck (out of attempts)
  const pend = await repo.insertIntent(env, { id: crypto.randomUUID(), organizationId: org, subscriptionId: sub, kind: 'trial_ended', stage: 'ended', dedupeKey: `${sub}:trial_ended:ended`, payload: '{}' });
  assert.equal((await state({ state: 'pending' })).length, 1);
  await env.LUMMET_DB.prepare(`UPDATE billing_notifications SET attempts = ? WHERE id = ?`).bind(repo.MAX_ATTEMPTS, pend.row.id).run();
  assert.equal((await state({ state: 'stuck' })).length, 1);

  assert.equal((await state({ kind: 'cancellation_scheduled' })).length, 1);
  assert.equal((await state({ organizationId: org })).length, 3, 'sent + failed + pending/stuck all belong to this organization');
  assert.equal((await state({ organizationId: 'someone-else' })).length, 0);
  const row = (await state())[0];
  for (const k of Object.keys(row)) assert.ok(!/payload|email|to_/i.test(k), `list must not expose ${k}`);
});

// ---------------------------------------------------------------- resend: never a second copy
test('resend of a delivered notice is refused and writes nothing', async () => {
  const { env, id } = await oneNotice();
  await flushAll(env, okFetch);
  const before = (await outbox(env)).length;
  const r = await notifications.resend(env, id);
  assert.equal(r.ok, false); assert.equal(r.error, 'already_delivered'); assert.equal(r.status, 409);
  assert.equal((await outbox(env)).length, before);
});

test('resend while a message is still queued is refused (in flight)', async () => {
  const { env, id } = await oneNotice();
  const r = await notifications.resend(env, id);
  assert.equal(r.ok, false); assert.equal(r.error, 'in_flight');
  assert.equal((await outbox(env)).length, 1);
});

test('a failed message goes back in the queue (same row), is delivered once, and cannot then be resent', async () => {
  const { env, id } = await oneNotice();
  await flushAll(env, failingFetch(400));
  let [m] = await outbox(env);
  assert.equal(m.status, 'failed'); assert.ok(m.body_encrypted, 'a failed billing message keeps its encrypted body for resend');
  const key = m.dedupe_key, rowId = m.id;

  const r = await notifications.resend(env, id);
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.action, 'requeued'); assert.equal(r.requeued, 1);
  let rows = await outbox(env);
  assert.equal(rows.length, 1, 'no new message was written'); assert.equal(rows[0].id, rowId); assert.equal(rows[0].dedupe_key, key); assert.equal(rows[0].status, 'queued');

  let sentCount = 0;
  await flushOutbox(env, { fetchImpl: async () => { sentCount += 1; return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }); } });
  assert.equal(sentCount, 1);
  await repo.syncSent(env);
  assert.equal((await notifications.resend(env, id)).error, 'already_delivered');
  await flushOutbox(env, { fetchImpl: async () => { sentCount += 1; return new Response('{}', { status: 200 }); } });
  assert.equal(sentCount, 1, 'nothing further was sent');
  assert.equal((await outbox(env)).length, 1);
});

test('double click: the second resend of a failed message finds it already queued', async () => {
  const { env, id } = await oneNotice();
  await flushAll(env, failingFetch(400));
  assert.ok((await notifications.resend(env, id)).ok);
  const again = await notifications.resend(env, id);
  assert.equal(again.ok, false); assert.equal(again.error, 'in_flight');
  assert.equal((await outbox(env)).length, 1);
});

test('an intent that never reached the outbox is retried with fresh attempts and queued once', async () => {
  const env = makeEnv();
  const org = await signup(env, 'stuck@example.com'); const sub = await addSub(env, org);
  const ins = await repo.insertIntent(env, { id: crypto.randomUUID(), organizationId: org, subscriptionId: sub, kind: 'cancellation_scheduled', stage: 'x', dedupeKey: `${sub}:cancellation_scheduled:x`, payload: JSON.stringify({ endsAt: iso(Date.now() + 3 * DAY) }) });
  await env.LUMMET_DB.prepare(`UPDATE billing_notifications SET attempts = ?, last_error = 'boom' WHERE id = ?`).bind(repo.MAX_ATTEMPTS, ins.row.id).run();
  assert.equal((await repo.listPending(env)).length, 0, 'the tick no longer picks it up');
  const r = await notifications.resend(env, ins.row.id);
  assert.ok(r.ok, JSON.stringify(r)); assert.equal(r.action, 'queued'); assert.equal(r.queued, 1);
  assert.equal((await outbox(env)).length, 1);
  assert.equal((await notifications.resend(env, ins.row.id)).error, 'in_flight');
  assert.equal((await outbox(env)).length, 1);
});

test('a recipient who has since bounced is not mailed by a resend', async () => {
  const { env, id } = await oneNotice();
  await flushAll(env, failingFetch(400));
  const [m] = await outbox(env);
  await repo.addSuppression(env, await emailHash(m.to_email), 'bounce');
  const r = await notifications.resend(env, id);
  assert.equal(r.ok, false); assert.equal(r.error, 'recipient_suppressed');
  assert.equal((await outbox(env))[0].status, 'failed');
});

test('once the failed body is dropped the message cannot be resent, and the tick drops it after 14 days', async () => {
  const { env, id } = await oneNotice();
  await flushAll(env, failingFetch(400));
  await env.LUMMET_DB.prepare(`UPDATE email_outbox SET created_at = datetime('now','-15 days') WHERE notification_id = ?`).bind(id).run();
  const d = await notifications.drain(env);
  assert.equal(d.pruned, 1);
  const [m] = await outbox(env); assert.equal(m.body_encrypted, null); assert.equal(m.body_iv, null);
  const r = await notifications.resend(env, id);
  assert.equal(r.ok, false); assert.equal(r.error, 'message_unavailable');
});

test('a failed message that is not a billing notification still has its body wiped (unchanged behaviour)', async () => {
  const env = makeEnv();
  await queueEmail(env, { to: 'x@example.com', template: 'notification', vars: { message: 'hi', link: null } });
  await flushAll(env, failingFetch(400));
  const row = await env.LUMMET_DB.prepare(`SELECT status, body_encrypted FROM email_outbox WHERE template = 'notification'`).first();
  assert.equal(row.status, 'failed'); assert.equal(row.body_encrypted, null);
});

test('resend needs BILLING_EMAILS=on and an existing notification', async () => {
  const { env, id } = await oneNotice();
  assert.equal((await notifications.resend({ ...env, BILLING_EMAILS: 'shadow' }, id)).error, 'emails_not_on');
  assert.equal((await notifications.resend({ ...env, BILLING_EMAILS: 'off' }, id)).error, 'emails_not_on');
  const nf = await notifications.resend(env, 'nope'); assert.equal(nf.status, 404);
});

test('failed delivery with a retryable error exhausts attempts, then resend works (503 path)', async () => {
  const { env, id } = await oneNotice();
  await flushAll(env, failingFetch(503), 8);
  const [m] = await outbox(env); assert.equal(m.status, 'failed'); assert.ok(m.body_encrypted);
  assert.ok((await notifications.resend(env, id)).ok);
});

// ---------------------------------------------------------------- staff API and page
async function call(env, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(env) {
  assert.equal((await call(env, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).status, 200);
  const l = await call(env, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  assert.equal(l.status, 200, l.text); return l.cookie;
}

test('staff API: list and resend work for a super admin, are audited, and are closed to everyone else', async () => {
  const { env, org, id } = await oneNotice();
  await flushAll(env, failingFetch(400));
  const staff = await staffLogin(env);

  const list = await call(env, 'GET', `/api/platform/saas/notifications?organization=${org}`, null, staff);
  assert.equal(list.status, 200, list.text); assert.equal(list.json.data.length, 1); assert.equal(list.json.data[0].state, 'failed');
  assert.ok(!/payload|to_email/.test(JSON.stringify(list.json)), 'no payload or address in the list');
  assert.equal((await call(env, 'GET', '/api/platform/saas/notifications?state=sent', null, staff)).json.data.length, 0);

  assert.equal((await call(env, 'GET', '/api/platform/saas/notifications')).status, 401);
  assert.equal((await call(env, 'POST', `/api/platform/saas/notifications/${id}/resend`, {})).status, 401);

  const ok = await call(env, 'POST', `/api/platform/saas/notifications/${id}/resend`, {}, staff);
  assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.action, 'requeued');
  const dup = await call(env, 'POST', `/api/platform/saas/notifications/${id}/resend`, {}, staff);
  assert.equal(dup.status, 409); assert.equal(dup.json.error, 'in_flight');
  assert.equal((await call(env, 'POST', '/api/platform/saas/notifications/missing/resend', {}, staff)).status, 404);

  const audit = (await env.LUMMET_DB.prepare(`SELECT action, organization_id, success FROM lummet_audit_logs WHERE resource = 'billing_notification' ORDER BY id`).all()).results;
  assert.equal(audit.length, 3);
  assert.equal(audit[0].action, 'resend:cancellation_scheduled:requeued'); assert.equal(audit[0].organization_id, org); assert.equal(audit[0].success, 1);
  assert.equal(audit[1].success, 0);
});

test('a customer session cannot reach the notification screens', async () => {
  const { env, id } = await oneNotice();
  const c = await call(env, 'POST', '/api/customer/signup', { email: 'cust@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'C' });
  for (const [m, p] of [['GET', '/platform/saas/notifications'], ['GET', '/api/platform/saas/notifications'], ['POST', `/api/platform/saas/notifications/${id}/resend`]]) {
    const r = await call(env, m, p, m === 'POST' ? {} : null, c.cookie);
    assert.ok([301, 302, 303, 401, 403].includes(r.status), `${m} ${p} ${r.status}`);
  }
});

test('the notifications page renders, filters, offers Resend only where it is safe, and escapes names', async () => {
  const env = makeEnv();
  const org = await signup(env, 'xss@example.com', '<img src=x onerror=alert(1)>');
  const sub = await addSub(env, org);
  const sent = await notifications.notify.cancellationScheduled(env, { organizationId: org, subscriptionId: sub, endsAt: iso(Date.now() + 5 * DAY) });
  await flushAll(env, okFetch); await repo.syncSent(env);
  await notifications.notify.endingSoon(env, { organizationId: org, subscriptionId: sub, endsAt: iso(Date.now() + 2 * DAY), bucket: 3, daysLeft: 2 });
  await flushAll(env, failingFetch(400));
  const staff = await staffLogin(env);

  const page = await call(env, 'GET', '/platform/saas/notifications', null, staff);
  assert.equal(page.status, 200, page.text.slice(0, 300));
  assert.ok(!page.text.includes('<img src=x'), 'organization name is escaped');
  assert.match(page.text, /Billing notifications/);
  assert.equal((page.text.match(/\/resend/g) || []).length, 1, 'only the failed notice offers Resend');
  assert.ok(!page.text.includes(`/notifications/${sent.notificationId}/resend`));

  const onlyFailed = await call(env, 'GET', '/platform/saas/notifications?state=failed', null, staff);
  assert.match(onlyFailed.text, /ending_soon/); assert.ok(!/cancellation_scheduled<\/td>/.test(onlyFailed.text));
  const junk = await call(env, 'GET', '/platform/saas/notifications?state=%27%3Bdrop&kind=nope&page=-4', null, staff);
  assert.equal(junk.status, 200);
  const nav = await call(env, 'GET', '/platform/saas/email', null, staff);
  assert.match(nav.text, /\/platform\/saas\/notifications/);
});

test('every notification kind the engine knows is listed in the page filter', async () => {
  const env = makeEnv(); const staff = await staffLogin(env);
  const page = await call(env, 'GET', '/platform/saas/notifications', null, staff);
  for (const k of BILLING_KINDS) assert.ok(page.text.includes(`<option >${k}</option>`) || page.text.includes(`<option>${k}</option>`), k);
});
