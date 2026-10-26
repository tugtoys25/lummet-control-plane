// Phase 2.1: billing notification engine. AT-9 (the same event many times, one email), every template with and without
// optional facts, failed sends retry without duplicating, suppressed addresses are not mailed, Resend webhook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as lifecycle from '../worker/billing-lifecycle.js';
import * as notifications from '../worker/billing-notifications.js';
import { billingTemplates, BILLING_KINDS, formatMoney, formatDate } from '../worker/billing-email-templates.js';
import { flushOutbox, emailHash } from '../worker/email.js';
import { handleResendWebhook, verifySignature, suppressionFor } from '../worker/resend-webhook.js';
import { runAlertCheck } from '../worker/alerts.js';
import * as customerAuth from '../worker/customer-auth.js';

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString();
const MAIL = { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Lummet <no-reply@example.test>', PORTAL_BASE_URL: 'https://app.example.test' };

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), BILLING_EMAILS: 'on', BILLING_ENFORCE: 'enforce', ...MAIL, ...extra };
}
async function signup(env, email) {
  const r = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.9' } }, env);
  return r.organizationId;
}
async function verifyAll(env) { await env.LUMMET_DB.prepare(`UPDATE customer_users SET email_verified_at = CURRENT_TIMESTAMP`).run(); }
async function addSub(env, orgId, f = {}) {
  const id = f.id || crypto.randomUUID();
  const row = { status: 'active', plan_id: 'plan_casino_news_starter', provider: null, provider_subscription_id: null, trial_ends_at: null, grace_ends_at: null, restricted_at: null, suspended_at: null, ...f };
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id, trial_ends_at, grace_ends_at, restricted_at, suspended_at, updated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, orgId, row.plan_id, row.status, row.provider, row.provider_subscription_id, row.trial_ends_at, row.grace_ends_at, row.restricted_at, row.suspended_at, row.updated_at || iso(Date.now()), iso(Date.now())).run();
  return id;
}
async function wired(extra = {}) {
  const env = makeEnv(extra);
  const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  const email = `o-${Math.random().toString(36).slice(2)}@example.com`;
  const org = await signup(env, email);
  await verifyAll(env);
  const hook = (type, object, id = 'evt_' + Math.random()) => simulateWebhook(billing, provider, env, { id, type, data: { object } });
  return { env, provider, billing, org, email, hook };
}
const outbox = async (env) => (await env.LUMMET_DB.prepare(`SELECT * FROM email_outbox WHERE template LIKE 'billing_%' ORDER BY created_at, rowid`).all()).results;
const intents = async (env) => (await env.LUMMET_DB.prepare(`SELECT * FROM billing_notifications ORDER BY created_at, rowid`).all()).results;
async function lastBody(env, fetchImpl) {
  let body;
  await flushOutbox(env, { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'msg_x' }), { status: 200 }); } });
  return body;
}

// ---------------------------------------------------------------- rollout flag
test('BILLING_EMAILS=off is inert, shadow logs and records nothing, on queues', async () => {
  for (const [mode, expectRows] of [['off', 0], ['shadow', 0], ['on', 1]]) {
    const { env, org } = await wired({ BILLING_EMAILS: mode });
    const subId = await addSub(env, org, { status: 'active' });
    const r = await notifications.notify.cancellationScheduled(env, { organizationId: org, subscriptionId: subId, endsAt: iso(Date.now() + 5 * DAY) });
    assert.ok(r.ok);
    assert.equal((await outbox(env)).length, expectRows, mode);
    assert.equal((await intents(env)).length, expectRows, mode);
  }
});

// ---------------------------------------------------------------- AT-9
test('AT-9: the same invoice.payment_failed webhook five times sends one email', async () => {
  const { env, org, hook } = await wired();
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_1' });
  const inv = { id: 'in_1', subscription: 'sub_1', metadata: { organization_id: org }, amount_due: 900, currency: 'usd', attempt_count: 1 };
  for (let i = 0; i < 5; i++) await hook('invoice.payment_failed', inv, 'evt_same');   // identical event id
  assert.equal((await outbox(env)).length, 1);
  for (let i = 0; i < 5; i++) await hook('invoice.payment_failed', inv);                // different event ids, same invoice and attempt
  assert.equal((await outbox(env)).length, 1);
  assert.equal((await intents(env)).length, 1);
});

test('the dunning series: attempt 1, 2 and 3+ are three different emails; a repeat of attempt 3 is not a fourth', async () => {
  const { env, org, hook } = await wired();
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_d' });
  for (const attempt of [1, 2, 3, 3, 4]) await hook('invoice.payment_failed', { id: 'in_d', subscription: 'sub_d', metadata: { organization_id: org }, amount_due: 900, currency: 'usd', attempt_count: attempt });
  const rows = await outbox(env);
  assert.equal(rows.length, 3);
  assert.ok(rows.some((r) => /Final notice/.test(r.subject)));
});

test('paid invoice: one receipt per invoice; a zero-amount invoice sends none', async () => {
  const { env, org, hook } = await wired();
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_r' });
  const paid = { id: 'in_r', subscription: 'sub_r', metadata: { organization_id: org }, amount_paid: 1900, amount_due: 1900, currency: 'usd', hosted_invoice_url: 'https://pay.example.test/i/1' };
  await hook('invoice.paid', paid); await hook('invoice.paid', paid);
  await hook('invoice.paid', { id: 'in_zero', subscription: 'sub_r', metadata: { organization_id: org }, amount_paid: 0, amount_due: 0 });
  const rows = await outbox(env);
  assert.equal(rows.length, 1); assert.equal(rows[0].template, 'billing_receipt');
  const body = await lastBody(env);
  assert.match(body.text, /\$19\.00/); assert.match(body.text, /https:\/\/pay\.example\.test\/i\/1/);
});

test('a late payment from restricted sends a receipt and "active again"; a past-due recovery sends only the receipt', async () => {
  const a = await wired();
  await addSub(a.env, a.org, { status: 'restricted', provider: 'fake', provider_subscription_id: 'sub_x', restricted_at: iso(Date.now() - DAY) });
  await a.hook('invoice.paid', { id: 'in_x', subscription: 'sub_x', metadata: { organization_id: a.org }, amount_paid: 900, amount_due: 900, currency: 'usd' });
  assert.deepEqual((await outbox(a.env)).map((r) => r.template).sort(), ['billing_reactivated', 'billing_receipt']);
  const b = await wired();
  await addSub(b.env, b.org, { status: 'past_due', provider: 'fake', provider_subscription_id: 'sub_y', grace_ends_at: iso(Date.now() + DAY) });
  await b.hook('invoice.paid', { id: 'in_y', subscription: 'sub_y', metadata: { organization_id: b.org }, amount_paid: 900, amount_due: 900, currency: 'usd' });
  assert.deepEqual((await outbox(b.env)).map((r) => r.template), ['billing_receipt']);
});

test('cancellation scheduled: one email when the flag flips, none for later unrelated updates', async () => {
  const { env, org, hook } = await wired();
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_c' });
  const end = Math.floor((Date.now() + 10 * DAY) / 1000);
  await hook('customer.subscription.updated', { id: 'sub_c', status: 'active', cancel_at_period_end: true, current_period_end: end });
  await hook('customer.subscription.updated', { id: 'sub_c', status: 'active', cancel_at_period_end: true, current_period_end: end });
  assert.deepEqual((await outbox(env)).map((r) => r.template), ['billing_cancellation_scheduled']);
});

// ---------------------------------------------------------------- lifecycle sweep
test('sweep: trial ended, restricted and suspended each send once, and running the sweep twice adds nothing', async () => {
  const env = makeEnv();
  const t = await signup(env, 'trial@example.com'); await verifyAll(env);
  const T0 = Date.now();
  await addSub(env, t, { status: 'trialing', trial_ends_at: iso(T0 - 20 * DAY) });
  await lifecycle.sweep(env, T0); await lifecycle.sweep(env, T0);
  assert.deepEqual((await outbox(env)).map((r) => r.template), ['billing_trial_ended']);

  const p = await signup(env, 'pd@example.com'); await verifyAll(env);
  await addSub(env, p, { status: 'past_due', provider: 'fake', provider_subscription_id: 'sub_p', grace_ends_at: iso(T0 - DAY) });
  await lifecycle.sweep(env, T0); await lifecycle.sweep(env, T0);
  assert.equal((await outbox(env)).filter((r) => r.template === 'billing_restricted').length, 1);
  await lifecycle.sweep(env, T0 + 8 * DAY); await lifecycle.sweep(env, T0 + 8 * DAY);
  assert.equal((await outbox(env)).filter((r) => r.template === 'billing_suspended').length, 1);
});

// ---------------------------------------------------------------- recipients, trial welcome
test('recipients are the active owners only (not admins, not disabled owners)', async () => {
  const { env, org } = await wired();
  const sub = await addSub(env, org, { status: 'active' });
  const mk = async (email, role, status = 'active') => {
    const id = crypto.randomUUID();
    await env.LUMMET_DB.prepare(`INSERT INTO customer_users (id, email, password_hash, status, email_verified_at) VALUES (?,?,?,?,CURRENT_TIMESTAMP)`).bind(id, email, 'x', status).run();
    await env.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES (?,?,?)`).bind(org, id, role).run();
  };
  await mk('second-owner@example.com', 'owner'); await mk('admin@example.com', 'admin'); await mk('gone@example.com', 'owner', 'disabled');
  await notifications.notify.suspended(env, { organizationId: org, subscriptionId: sub, suspendedAt: iso(Date.now()) });
  const to = (await outbox(env)).map((r) => r.to_email).sort();
  assert.equal(to.length, 2); assert.ok(to.includes('second-owner@example.com')); assert.ok(!to.includes('admin@example.com') && !to.includes('gone@example.com'));
  const n = (await intents(env))[0]; assert.equal(n.recipient_count, 2); assert.ok(n.queued_at); assert.equal(n.payload, null);
});

test('trial welcome waits for a verified address, then sends once', async () => {
  const env = makeEnv({ BILLING_TRIAL_DAYS_DEFAULT: '7' });
  const org = await signup(env, 'new@example.com');
  const sub = await addSub(env, org, { status: 'trialing', trial_ends_at: iso(Date.now() + 7 * DAY) });
  await notifications.notify.trialStarted(env, { organizationId: org, subscriptionId: sub, trialEndsAt: iso(Date.now() + 7 * DAY) });
  assert.equal((await outbox(env)).length, 0, 'unverified: nothing sent');
  assert.equal((await intents(env)).length, 0, 'and the dedupe key is not used up');
  const user = await env.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = 'new@example.com'`).first();
  await verifyAll(env);
  await notifications.onEmailVerified(env, user.id); await notifications.onEmailVerified(env, user.id);
  assert.deepEqual((await outbox(env)).map((r) => r.template), ['billing_trial_welcome']);
});

// ---------------------------------------------------------------- suppression, failure, retry
test('a suppressed address is not mailed, even one suppressed after the message was queued', async () => {
  const { env, org, email } = await wired();
  const sub = await addSub(env, org, { status: 'active' });
  await env.LUMMET_DB.prepare(`INSERT INTO email_suppressions (email_hash, reason) VALUES (?, 'bounce')`).bind(await emailHash(email.toUpperCase())).run();
  const r = await notifications.notify.suspended(env, { organizationId: org, subscriptionId: sub, suspendedAt: iso(Date.now()) });
  assert.equal(r.queued, 0); assert.equal(r.suppressed, 1);
  assert.equal((await outbox(env)).length, 0);

  const w = await wired();
  const sub2 = await addSub(w.env, w.org, { status: 'active' });
  await notifications.notify.suspended(w.env, { organizationId: w.org, subscriptionId: sub2, suspendedAt: iso(Date.now()) });
  await w.env.LUMMET_DB.prepare(`INSERT INTO email_suppressions (email_hash, reason) VALUES (?, 'complaint')`).bind(await emailHash(w.email)).run();
  let called = 0;
  const res = await flushOutbox(w.env, { fetchImpl: async () => { called++; return new Response('{}', { status: 200 }); } });
  assert.equal(called, 0); assert.equal(res.sent, 0);
  assert.equal((await outbox(w.env))[0].status, 'suppressed');
  assert.equal((await runAlertCheck({ ...w.env, ALERT_WEBHOOK_URL: '' })).skipped, 'no_alert_channel_configured');
});

test('a failed send retries without duplicating, and the notification records when it was sent', async () => {
  const { env, org } = await wired();
  const sub = await addSub(env, org, { status: 'active' });
  await notifications.notify.suspended(env, { organizationId: org, subscriptionId: sub, suspendedAt: iso(Date.now()) });
  let now = Date.now();
  assert.equal((await flushOutbox(env, { fetchImpl: async () => new Response('x', { status: 503 }), now })).retried, 1);
  now += 3 * 3600e3;
  assert.equal((await flushOutbox(env, { fetchImpl: async () => new Response(JSON.stringify({ id: 'm1' }), { status: 200 }), now })).sent, 1);
  assert.equal((await outbox(env)).length, 1);
  await notifications.drain(env);
  assert.ok((await intents(env))[0].sent_at, 'sent_at is set once delivered');
});

test('an intent that failed to queue is finished by the tick, not lost, and no recipient gets two', async () => {
  const { env, org } = await wired();
  const sub = await addSub(env, org, { status: 'active' });
  const bad = { ...env, CREDENTIAL_KEK: undefined };                       // encryption unavailable: queueing throws
  const r = await notifications.notify.suspended(bad, { organizationId: org, subscriptionId: sub, suspendedAt: 'S1' });
  assert.equal(r.ok, false);
  let [n] = await intents(env); assert.equal(n.queued_at, null); assert.equal(n.attempts, 1); assert.ok(n.last_error);
  assert.equal((await outbox(env)).length, 0);
  const d = await notifications.drain(env); assert.equal(d.queued, 1);
  await notifications.drain(env);
  assert.equal((await outbox(env)).length, 1);
  [n] = await intents(env); assert.ok(n.queued_at); assert.equal(n.payload, null);
});

test('stuck notifications raise billing_email_stuck', async () => {
  const { env, org } = await wired({ ALERT_WEBHOOK_URL: 'https://hooks.example.test/x' });
  const sub = await addSub(env, org, { status: 'active' });
  await notifications.notify.suspended({ ...env, CREDENTIAL_KEK: undefined }, { organizationId: org, subscriptionId: sub, suspendedAt: 'S2' });
  await env.LUMMET_DB.prepare(`UPDATE billing_notifications SET created_at = datetime('now','-2 hours')`).run();
  const sent = [];
  const res = await runAlertCheck(env, { fetchImpl: async (u, init) => { sent.push(init.body); return new Response('ok', { status: 200 }); } });
  assert.ok(res.results.find((x) => x.key === 'billing_email_stuck' && x.action === 'notified'));
});

test('sender: BILLING_EMAIL_FROM and reply-to are used on billing mail only', async () => {
  const { env, org } = await wired({ BILLING_EMAIL_FROM: 'Billing <billing@example.test>', BILLING_EMAIL_REPLY_TO: 'help@example.test' });
  const sub = await addSub(env, org, { status: 'active' });
  await notifications.notify.suspended(env, { organizationId: org, subscriptionId: sub, suspendedAt: iso(Date.now()) });
  const body = await lastBody(env);
  assert.equal(body.from, 'Billing <billing@example.test>'); assert.equal(body.reply_to, 'help@example.test');
});

// ---------------------------------------------------------------- templates
test('every template renders with and without optional facts, escapes input, and never prints "undefined" or "null"', () => {
  const base = { brand: 'Lummet', orgName: 'Acme <b>&"Co"</b>' };
  const full = { ...base, planName: 'Pro', billingUrl: 'https://app.example.test/app/billing', invoiceUrl: 'https://pay.example.test/i/1', amountCents: 4900, currency: 'USD', attempt: 3, graceEndsAt: iso(Date.now() + 5 * DAY), trialEndsAt: iso(Date.now() + 3 * DAY), restrictedDays: 7, suspendsAt: iso(Date.now() + 7 * DAY), endsAt: iso(Date.now() + 9 * DAY), periodStart: Date.now(), periodEnd: Date.now() + 30 * DAY };
  assert.ok(BILLING_KINDS.length >= 8);
  for (const kind of BILLING_KINDS) for (const facts of [full, base]) {
    const m = billingTemplates[kind](facts);
    for (const part of [m.subject, m.text, m.html]) assert.ok(part && !/undefined|null|NaN/.test(part), `${kind}: ${part.slice(0, 80)}`);
    assert.ok(!m.html.includes('<b>&"Co"'), `${kind} escapes the organization name`);
    assert.ok(m.html.includes('&lt;b&gt;'), kind);
  }
  assert.equal(formatMoney(1234, 'EUR'), '€12.34'); assert.equal(formatDate('not a date'), null);
});

// ---------------------------------------------------------------- Resend webhook
async function sign(secretB64, id, ts, body) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  return 'v1,' + btoa(String.fromCharCode(...new Uint8Array(sig)));
}
const SECRET_B64 = btoa('s'.repeat(24));
async function resendReq(event, { id = 'msg_1', ts = Math.floor(Date.now() / 1000), secret = SECRET_B64, tamper = false } = {}) {
  const body = JSON.stringify(event);
  return new Request('https://app.example.test/api/email/webhook/resend', {
    method: 'POST', body: tamper ? body + ' ' : body,
    headers: { 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': await sign(secret, id, ts, body) }
  });
}

test('Resend webhook: permanent bounce and complaint suppress; transient bounce and delivery do not; bad signatures are refused', async () => {
  const env = makeEnv({ RESEND_WEBHOOK_SECRET: 'whsec_' + SECRET_B64 });
  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.bounced', data: { to: ['a@x.test'], bounce: { type: 'Permanent' } } }, { tamper: true }), env)).error, 'invalid_signature');
  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.bounced', data: { to: ['a@x.test'] } }, { ts: 1000 }), env)).error, 'invalid_signature', 'old timestamp');
  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.bounced', data: { to: ['a@x.test'] } }, { secret: btoa('z'.repeat(24)) }), env)).error, 'invalid_signature');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM email_suppressions`).first()).n, 0);

  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.bounced', data: { to: ['Ann <A@x.test>'], bounce: { type: 'Permanent' } } }, { id: 'm1' }), env)).suppressed, 1);
  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.complained', data: { to: ['b@x.test'] } }, { id: 'm2' }), env)).suppressed, 1);
  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.bounced', data: { to: ['c@x.test'], bounce: { type: 'Transient' } } }, { id: 'm3' }), env)).suppressed, 0);
  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.delivered', data: { to: ['d@x.test'] } }, { id: 'm4' }), env)).suppressed, 0);
  const dup = await handleResendWebhook(await resendReq({ type: 'email.bounced', data: { to: ['Ann <A@x.test>'], bounce: { type: 'Permanent' } } }, { id: 'm1' }), env);
  assert.equal(dup.duplicate, true);
  const rows = (await env.LUMMET_DB.prepare(`SELECT email_hash, reason FROM email_suppressions ORDER BY rowid`).all()).results;
  assert.deepEqual(rows.map((r) => r.reason), ['bounce', 'complaint']);
  assert.equal(rows[0].email_hash, await emailHash('a@x.test'));
  assert.ok(!JSON.stringify(rows).includes('x.test'), 'only hashes are stored');
});

test('Resend webhook: not configured answers 503; helper functions', async () => {
  const env = makeEnv();
  assert.equal((await handleResendWebhook(await resendReq({ type: 'email.bounced', data: {} }), env)).status, 503);
  assert.equal(suppressionFor({ type: 'email.bounced', data: { to: [], bounce: { type: 'Permanent' } } }), null);
  assert.equal(await verifySignature(null, { id: 'a', timestamp: '1', signature: 'v1,x', body: '' }), false);
});

test('email_bounce_rate alert: quiet at low volume, fires at 5% of 20+ messages', async () => {
  const env = makeEnv({ ALERT_WEBHOOK_URL: 'https://hooks.example.test/x' });
  const fetchImpl = async () => new Response('ok', { status: 200 });
  const ins = env.LUMMET_DB.prepare(`INSERT INTO email_outbox (id, to_email, template, subject, status, sent_at) VALUES (?, ?, 'billing_receipt', 's', 'sent', CURRENT_TIMESTAMP)`);
  for (let i = 0; i < 30; i++) await ins.bind('o' + i, `u${i}@x.test`).run();
  let res = await runAlertCheck(env, { fetchImpl });
  assert.equal(res.results.find((x) => x.key === 'email_bounce_rate').action, 'ok');
  for (let i = 0; i < 3; i++) await env.LUMMET_DB.prepare(`INSERT INTO email_suppressions (email_hash, reason) VALUES (?, 'bounce')`).bind('h' + i).run();
  res = await runAlertCheck(env, { fetchImpl });
  assert.equal(res.results.find((x) => x.key === 'email_bounce_rate').action, 'notified');
});

test('migration 0051 is additive and the new tables have their uniqueness guarantees', async () => {
  const env = makeEnv();
  await env.LUMMET_DB.prepare(`INSERT INTO billing_notifications (id, organization_id, kind, dedupe_key) VALUES ('a','o','k','d1')`).run();
  await assert.rejects(() => env.LUMMET_DB.prepare(`INSERT INTO billing_notifications (id, organization_id, kind, dedupe_key) VALUES ('b','o','k','d1')`).run(), /UNIQUE/);
  await env.LUMMET_DB.prepare(`INSERT INTO email_suppressions (email_hash, reason) VALUES ('h','bounce')`).run();
  await assert.rejects(() => env.LUMMET_DB.prepare(`INSERT INTO email_suppressions (email_hash, reason) VALUES ('h','bounce')`).run(), /UNIQUE/);
});
