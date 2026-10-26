// Phase 0 and 1 of the production blueprint: access state machine, lifecycle sweep, trial correctness, Stripe client
// safety, livemode guard, write gate, safe deletion, seat limit, scheduler heartbeat. Acceptance tests AT-1 to AT-4,
// AT-7, AT-8 and AT-10 run here on the fake provider (Stripe test clocks are Phase 4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import { computeAccess, resolveAccess } from '../worker/access.js';
import { billingConfig, effectiveNow } from '../worker/billing-config.js';
import * as lifecycle from '../worker/billing-lifecycle.js';
import * as organizations from '../worker/organizations.js';
import * as entitlements from '../worker/entitlements.js';
import * as scheduler from '../worker/scheduler.js';
import { runAlertCheck } from '../worker/alerts.js';
import { configIssues } from '../worker/config-check.js';
import * as customerAuth from '../worker/customer-auth.js';
import worker from '../worker/index.js';
import { setPlanPrice } from './support/plan-prices.js';

const DAY = 86400000;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const iso = (t) => new Date(t).toISOString();
const CFG = billingConfig({ BILLING_ENFORCE: 'enforce' });
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra };
}
async function signup(env, email) {
  const r = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.9' } }, env);
  return r.organizationId;
}
async function addSub(env, orgId, f = {}) {
  const id = f.id || crypto.randomUUID();
  const row = { status: 'active', plan_id: 'plan_casino_news_starter', provider: null, provider_subscription_id: null, trial_ends_at: null, grace_ends_at: null, restricted_at: null, suspended_at: null, stripe_status: null, canceled_at: null, ...f };
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id, trial_ends_at, grace_ends_at, restricted_at, suspended_at, stripe_status, canceled_at, updated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, orgId, row.plan_id, row.status, row.provider, row.provider_subscription_id, row.trial_ends_at, row.grace_ends_at, row.restricted_at, row.suspended_at, row.stripe_status, row.canceled_at, row.updated_at || iso(T0), iso(T0)).run();
  return id;
}
const subRow = (env, id) => env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE id = ?`).bind(id).first();
const events = async (env, id) => (await env.LUMMET_DB.prepare(`SELECT * FROM subscription_status_events WHERE subscription_id = ? ORDER BY id`).bind(id).all()).results;

// ---------------------------------------------------------------- pure state machine
test('computeAccess: table of transitions with clock jumps', () => {
  const org = { status: 'active' };
  const at = (sub, dt) => computeAccess({ sub, org, now: T0 + dt, cfg: CFG }).state;
  const trial = { status: 'trialing', trial_ends_at: iso(T0 + 7 * DAY), provider_subscription_id: null };
  assert.equal(at(trial, 0), 'trialing');
  assert.equal(at(trial, 7 * DAY + 1), 'trial_expired');
  assert.equal(at(trial, 14 * DAY + 1), 'restricted');
  assert.equal(at(trial, 21 * DAY + 1), 'suspended');
  assert.equal(at(trial, 51 * DAY + 1), 'closed');
  // a trial with a provider behind it is the provider's to convert, not ours to expire
  assert.equal(at({ ...trial, provider_subscription_id: 'sub_1' }, 30 * DAY), 'trialing');

  const pastDue = { status: 'past_due', grace_ends_at: iso(T0 + 14 * DAY) };
  assert.equal(at(pastDue, 13 * DAY), 'past_due');
  assert.equal(at(pastDue, 14 * DAY + 1), 'restricted');
  assert.equal(at(pastDue, 21 * DAY + 1), 'suspended');
  assert.equal(at(pastDue, 51 * DAY + 1), 'closed');

  assert.equal(at({ status: 'active' }, 400 * DAY), 'active');
  assert.equal(computeAccess({ sub: { status: 'active' }, org: { status: 'closed' }, now: T0, cfg: CFG }).state, 'closed');
  assert.equal(computeAccess({ sub: null, org, now: T0, cfg: CFG }).state, 'trial_expired');
  // an ended (canceled) subscription starts the restricted clock at cancellation
  const canceled = { status: 'canceled', canceled_at: iso(T0) };
  assert.equal(at(canceled, 1 * DAY), 'trial_expired');
  assert.equal(at(canceled, 8 * DAY), 'restricted');
});

test('computeAccess: write and serve gates per state', () => {
  const g = (sub) => { const a = computeAccess({ sub, org: { status: 'active' }, now: T0 + 30 * DAY, cfg: CFG }); return [a.canMutate, a.canServe]; };
  assert.deepEqual(g({ status: 'active' }), [true, true]);
  assert.deepEqual(g({ status: 'past_due', grace_ends_at: iso(T0 + 40 * DAY) }), [true, true]);
  assert.deepEqual(g({ status: 'restricted', restricted_at: iso(T0 + 29 * DAY) }), [false, true]);
  assert.deepEqual(g({ status: 'suspended', suspended_at: iso(T0 + 29 * DAY) }), [false, false]);
  assert.deepEqual(g({ status: 'paused' }), [false, true], 'an unrecognised status never grants write access');
});

test('configuration: defaults, bad values fall back, and X-Test-Now only works in staging', () => {
  assert.equal(billingConfig({}).mode, 'off');
  assert.equal(billingConfig({ BILLING_ENFORCE: 'ENFORCE' }).mode, 'enforce');
  assert.equal(billingConfig({ BILLING_ENFORCE: 'yes' }).mode, 'off');
  assert.equal(billingConfig({ BILLING_GRACE_DAYS: '-3' }).graceDays, 14);
  assert.equal(billingConfig({ BILLING_GRACE_DAYS: '21' }).graceDays, 21);
  assert.deepEqual(billingConfig({ BILLING_REMINDER_DAYS: '5, 2' }).reminderDays, [5, 2]);
  const req = new Request('https://x.test/', { headers: { 'X-Test-Now': '2030-01-01T00:00:00Z' } });
  assert.equal(effectiveNow({ ENVIRONMENT: 'staging' }, req), Date.parse('2030-01-01T00:00:00Z'));
  assert.ok(Math.abs(effectiveNow({ ENVIRONMENT: 'production' }, req) - Date.now()) < 5000, 'production ignores the header');
  assert.ok(Math.abs(effectiveNow({}, req) - Date.now()) < 5000);
});

// ---------------------------------------------------------------- sweep: modes
test('sweep is inert with BILLING_ENFORCE=off (default)', async () => {
  const env = makeEnv();
  const org = await signup(env, 'off@example.com');
  const id = await addSub(env, org, { status: 'trialing', trial_ends_at: iso(T0 - 30 * DAY) });
  const r = await lifecycle.sweep(env, T0);
  assert.equal(r.mode, 'off');
  assert.equal((await subRow(env, id)).status, 'trialing');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM subscription_access_shadow`).first()).n, 0);
});

test('shadow: records what WOULD change, changes nothing, and a second run adds nothing', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'shadow' });
  const org = await signup(env, 'shadow@example.com');
  const id = await addSub(env, org, { status: 'trialing', trial_ends_at: iso(T0 - 2 * DAY) });
  const first = await lifecycle.sweep(env, T0);
  assert.equal(first.shadowRows, 1);
  assert.equal((await subRow(env, id)).status, 'trialing', 'shadow never changes a subscription');
  const second = await lifecycle.sweep(env, T0 + 1000);
  assert.equal(second.shadowRows, 0);
  const row = await env.LUMMET_DB.prepare(`SELECT * FROM subscription_access_shadow`).first();
  assert.equal(row.state, 'trial_expired'); assert.equal(row.would_change_from, 'trialing');
});

// ---------------------------------------------------------------- AT-1 trial expiry
test('AT-1: a no-card trial expires, with an event, and the sweep is idempotent', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce' });
  const org = await signup(env, 'at1@example.com');
  const id = await addSub(env, org, { status: 'trialing', trial_ends_at: iso(T0 + 7 * DAY) });
  assert.equal((await lifecycle.sweep(env, T0 + 6 * DAY)).expiredTrials, 0);
  const r = await lifecycle.sweep(env, T0 + 8 * DAY);
  assert.equal(r.expiredTrials, 1);
  assert.equal((await subRow(env, id)).status, 'expired');
  const ev = await events(env, id);
  assert.equal(ev.length, 1); assert.equal(ev[0].to_status, 'expired'); assert.match(ev[0].reason, /trial ended/);
  assert.equal((await lifecycle.sweep(env, T0 + 8 * DAY)).expiredTrials, 0);
  assert.equal((await events(env, id)).length, 1, 'running twice writes no second event');
  assert.equal((await resolveAccess(env, org, T0 + 8 * DAY)).state, 'trial_expired');
  assert.equal((await resolveAccess(env, org, T0 + 15 * DAY)).state, 'restricted', 'then the clock moves it on with no further writes');
});

// ---------------------------------------------------------------- AT-2 trials do not stack
async function checkoutParams(envExtra, subFields) {
  const env = makeEnv(envExtra);
  const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  const org = await signup(env, `trial-${Math.random()}@example.com`);
  await env.LUMMET_DB.prepare(`UPDATE plans SET trial_days = 7 WHERE id = 'plan_casino_news_starter'`).run();
  await setPlanPrice(env, 'plan_casino_news_starter', 'price_x');
  if (subFields) await addSub(env, org, subFields);
  const r = await billing.startCheckout(env, { organizationId: org, planId: 'plan_casino_news_starter', successUrl: 'https://a.test/s', cancelUrl: 'https://a.test/c' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return provider._calls.find((c) => c.method === 'createCheckoutSession');
}
test('AT-2: subscribing mid-trial carries the REMAINING local trial, never a fresh trial period', async () => {
  const end = Date.now() + 4 * DAY;
  const call = await checkoutParams({ BILLING_ENFORCE: 'enforce' }, { status: 'trialing', trial_ends_at: iso(end) });
  assert.equal(call.trialEnd, Math.floor(end / 1000));
  assert.equal(call.trialDays, 0);
});
test('AT-2: an expired local trial, or under Stripe\'s 48 hour minimum, gets no further trial', async () => {
  const expired = await checkoutParams({ BILLING_ENFORCE: 'enforce' }, { status: 'trialing', trial_ends_at: iso(Date.now() - DAY) });
  assert.equal(expired.trialEnd, undefined); assert.equal(expired.trialDays, 0);
  const soon = await checkoutParams({ BILLING_ENFORCE: 'shadow' }, { status: 'trialing', trial_ends_at: iso(Date.now() + 20 * 3600 * 1000) });
  assert.equal(soon.trialEnd, undefined); assert.equal(soon.trialDays, 0);
});
test('AT-2: with BILLING_ENFORCE off the legacy behaviour (plan trial days) is unchanged', async () => {
  const call = await checkoutParams({}, { status: 'trialing', trial_ends_at: iso(Date.now() + 4 * DAY) });
  assert.equal(call.trialDays, 7); assert.equal(call.trialEnd, undefined);
});

// ---------------------------------------------------------------- webhooks
async function wired(extra = {}) {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce', ...extra });
  const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  const org = await signup(env, `wh-${Math.random()}@example.com`);
  const hook = (type, object, id = 'evt_' + Math.random()) => simulateWebhook(billing, provider, env, { id, type, data: { object } });
  return { env, provider, billing, org, hook };
}
test('checkout of a provider trial is "trialing" (not active) when the lifecycle is on, and keeps the provider trial end', async () => {
  const { env, org, hook } = await wired();
  const trialEnd = Math.floor((Date.now() + 5 * DAY) / 1000);
  await hook('checkout.session.completed', { id: 'cs_1', client_reference_id: org, subscription: 'sub_1', metadata: { organization_id: org, plan_id: 'plan_casino_news_starter', has_trial: '1', trial_end: String(trialEnd) } });
  const s = await env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ?`).bind(org).first();
  assert.equal(s.status, 'trialing'); assert.equal(s.trial_ends_at, new Date(trialEnd * 1000).toISOString());
});
test('checkout without a trial is active, and with BILLING_ENFORCE=off a trial checkout is active as before', async () => {
  const a = await wired(); await a.hook('checkout.session.completed', { id: 'cs_2', client_reference_id: a.org, subscription: 'sub_2', metadata: { organization_id: a.org, plan_id: 'plan_casino_news_starter' } });
  assert.equal((await a.env.LUMMET_DB.prepare(`SELECT status FROM subscriptions`).first()).status, 'active');
  const b = await wired({ BILLING_ENFORCE: 'off' }); await b.hook('checkout.session.completed', { id: 'cs_3', client_reference_id: b.org, subscription: 'sub_3', metadata: { organization_id: b.org, plan_id: 'plan_casino_news_starter', has_trial: '1', trial_end: '9999999999' } });
  assert.equal((await b.env.LUMMET_DB.prepare(`SELECT status FROM subscriptions`).first()).status, 'active');
});

test('AT-3: a failed payment starts one grace clock (not extended by retries); paying restores active and clears it', async () => {
  const { env, org, hook } = await wired();
  const id = await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_a' });
  await hook('invoice.payment_failed', { id: 'in_1', subscription: 'sub_a', metadata: { organization_id: org }, amount_due: 900 });
  const first = await subRow(env, id);
  assert.equal(first.status, 'past_due'); assert.ok(first.grace_ends_at);
  const graceMs = Date.parse(first.grace_ends_at) - Date.now();
  assert.ok(Math.abs(graceMs - 14 * DAY) < 60000, 'default grace is 14 days');
  await hook('invoice.payment_failed', { id: 'in_1', subscription: 'sub_a', metadata: { organization_id: org }, amount_due: 900 });
  assert.equal((await subRow(env, id)).grace_ends_at, first.grace_ends_at, 'a later retry does not move the clock');
  await hook('invoice.paid', { id: 'in_1', subscription: 'sub_a', metadata: { organization_id: org }, amount_paid: 900, amount_due: 900 });
  const after = await subRow(env, id);
  assert.equal(after.status, 'active'); assert.equal(after.grace_ends_at, null);
});

test('AT-4: unpaid -> restricted -> suspended -> restored by a late payment, each step an event', async () => {
  const { env, org, hook } = await wired();
  const id = await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_b' });
  await hook('customer.subscription.updated', { id: 'sub_b', status: 'restricted', current_period_end: Math.floor(Date.now() / 1000) + DAY / 1000 });
  let s = await subRow(env, id);
  assert.equal(s.status, 'restricted'); assert.ok(s.restricted_at, 'the restricted clock starts');
  const t = Date.parse(s.restricted_at.replace(' ', 'T') + (s.restricted_at.includes('Z') ? '' : 'Z'));
  const sw = await lifecycle.sweep(env, t + 8 * DAY);
  assert.equal(sw.suspended, 1);
  s = await subRow(env, id); assert.equal(s.status, 'suspended'); assert.ok(s.suspended_at);
  assert.equal((await resolveAccess(env, org, t + 8 * DAY)).canServe, false);
  await hook('invoice.paid', { id: 'in_late', subscription: 'sub_b', metadata: { organization_id: org }, amount_paid: 900, amount_due: 900 });
  s = await subRow(env, id);
  assert.equal(s.status, 'active'); assert.equal(s.restricted_at, null); assert.equal(s.suspended_at, null);
  assert.deepEqual((await events(env, id)).map((e) => e.to_status), ['restricted', 'suspended', 'active']);
});

test('Stripe "unpaid" maps to restricted only under enforce; before that it keeps the legacy mapping and is recorded raw', async () => {
  const stripe = await import('../worker/billing-stripe.js');
  assert.equal(stripe.normalizeSubscriptionStatus('unpaid'), 'past_due');
  assert.equal(stripe.normalizeSubscriptionStatus('unpaid', { restrictUnpaid: true }), 'restricted');
  assert.equal(stripe.normalizeSubscriptionStatus('active', { restrictUnpaid: true }), 'active');
});

test('sweep: a long-overdue past_due row with no grace_ends_at (pre-migration) is dated from its history, not forgiven', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce' });
  const org = await signup(env, 'legacy@example.com');
  const id = await addSub(env, org, { status: 'past_due' });
  await env.LUMMET_DB.prepare(`INSERT INTO subscription_status_events (subscription_id, from_status, to_status, created_at) VALUES (?, 'active', 'past_due', ?)`).bind(id, iso(T0 - 20 * DAY)).run();
  assert.equal((await resolveAccess(env, org, T0)).state, 'restricted');
  assert.equal((await lifecycle.sweep(env, T0)).restricted, 1);
});

// ---------------------------------------------------------------- AT-10 livemode
test('AT-10: a wrong-mode webhook is rejected, logged and counted; the right mode is processed', async () => {
  const { env, org, hook } = await wired({ ENVIRONMENT: 'production' });
  const r = await hook('checkout.session.completed', { id: 'cs_9', client_reference_id: org, subscription: 'sub_9', metadata: { organization_id: org, plan_id: 'plan_casino_news_starter' } }, 'evt_test');
  assert.equal(r.ok, true);                                    // an event without livemode is not judged
  const e2 = makeEnv({ ENVIRONMENT: 'production' }); const p2 = createFakeBillingProvider(); const b2 = createBillingService(p2);
  const bad = await simulateWebhook(b2, p2, e2, { id: 'evt_bad', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_x' } } });
  assert.equal(bad.rejected, 'livemode_mismatch');
  assert.equal((await e2.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM billing_webhook_rejections`).first()).n, 1);
  assert.equal((await e2.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM billing_webhook_events`).first()).n, 0, 'a rejected event is never stored for processing');
  const e3 = makeEnv({ ENVIRONMENT: 'staging' }); const p3 = createFakeBillingProvider(); const b3 = createBillingService(p3);
  assert.equal((await simulateWebhook(b3, p3, e3, { id: 'evt_live', type: 'invoice.paid', livemode: true, data: { object: {} } })).rejected, 'livemode_mismatch');
});

// ---------------------------------------------------------------- Stripe client safety
function stripeFetchStub(responses) {
  const calls = []; const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); const r = responses.shift(); if (r instanceof Error) throw r; return new Response(JSON.stringify(r.body || {}), { status: r.status }); };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}
const SENV = { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_RETRY_BASE_MS: '0' };

test('Stripe client: every POST carries an Idempotency-Key and the pinned version', async () => {
  const stripe = await import('../worker/billing-stripe.js');
  const f = stripeFetchStub([{ status: 200, body: { id: 'cus_1' } }]);
  try { await stripe.createCustomer({ ...SENV, STRIPE_API_VERSION: '2025-01-27' }, { organizationId: 'org1', email: 'a@b.test' }); } finally { f.restore(); }
  assert.equal(f.calls[0].init.headers['Idempotency-Key'], 'customer:org1:a@b.test');
  assert.equal(f.calls[0].init.headers['Stripe-Version'], '2025-01-27');
  assert.equal(stripe.stripeApiVersion({}), '2024-06-20'); assert.equal(stripe.stripeApiVersion({ STRIPE_API_VERSION: 'junk' }), '2024-06-20');
});
test('Stripe client: retries 5xx and network errors with the SAME key, never a 4xx', async () => {
  const stripe = await import('../worker/billing-stripe.js');
  let f = stripeFetchStub([{ status: 503 }, new Error('socket hang up'), { status: 200, body: { id: 'cus_2' } }]);
  try { assert.equal((await stripe.createCustomer(SENV, { organizationId: 'o', email: null })).providerCustomerId, 'cus_2'); } finally { f.restore(); }
  assert.equal(f.calls.length, 3);
  assert.equal(new Set(f.calls.map((c) => c.init.headers['Idempotency-Key'])).size, 1, 'a retry reuses the key, so it cannot double-apply');
  f = stripeFetchStub([{ status: 402, body: { error: { message: 'Your card was declined', code: 'card_declined' } } }, { status: 200, body: { id: 'x' } }]);
  let err; try { await stripe.createCustomer(SENV, { organizationId: 'o', email: null }); } catch (e) { err = e; } finally { f.restore(); }
  assert.equal(f.calls.length, 1, '4xx is never retried');
  assert.equal(err.kind, 'rejected'); assert.equal(err.status, 402); assert.equal(err.code, 'card_declined');
});
test('Stripe client: exhausted retries surface as "unreachable", distinct from "Stripe said no"', async () => {
  const stripe = await import('../worker/billing-stripe.js');
  const f = stripeFetchStub([{ status: 500 }, { status: 502 }, { status: 503 }]);
  let err; try { await stripe.cancelSubscription(SENV, 'sub_1', { atPeriodEnd: true }); } catch (e) { err = e; } finally { f.restore(); }
  assert.equal(f.calls.length, 3); assert.equal(err.kind, 'unreachable'); assert.ok(err instanceof stripe.StripeError);
});
test('Stripe client: a cancel then resume then cancel again are three distinct requests (keys are not reused across actions)', async () => {
  const stripe = await import('../worker/billing-stripe.js');
  const f = stripeFetchStub([{ status: 200, body: {} }, { status: 200, body: {} }]);
  try { await stripe.cancelSubscription(SENV, 'sub_1', { atPeriodEnd: true }); await stripe.resumeSubscription(SENV, 'sub_1'); } finally { f.restore(); }
  assert.notEqual(f.calls[0].init.headers['Idempotency-Key'], f.calls[1].init.headers['Idempotency-Key']);
});

// ---------------------------------------------------------------- write gate (index.js)
async function call(env, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function portalOrg(env, email) {
  const s = await call(env, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email });
  return { org: s.json.organizationId, cookie: s.cookie };
}
test('write gate: enforce refuses writes for a restricted organization (402 with a reason) but never billing, trial or reads', async () => {
  const env = makeEnv({ ENVIRONMENT: 'production', BILLING_ENFORCE: 'enforce' });
  const { org, cookie } = await portalOrg(env, 'gate@example.com');
  await addSub(env, org, { status: 'restricted', restricted_at: iso(Date.now() - DAY) });
  const blocked = await call(env, 'POST', `/api/organizations/${org}/sites`, { name: 'x' }, cookie);
  assert.equal(blocked.status, 402); assert.equal(blocked.json.error, 'billing_access_restricted'); assert.equal(blocked.json.reason, 'restricted');
  assert.notEqual((await call(env, 'POST', `/api/organizations/${org}/billing/portal`, { returnUrl: 'https://a.test' }, cookie)).status, 402, 'paying must stay possible');
  assert.equal((await call(env, 'GET', `/api/organizations/${org}/sites`, null, cookie)).status, 200, 'reads stay open');
});
test('write gate: off and shadow never refuse; shadow records the would-be refusal with the entry point, once an hour', async () => {
  for (const mode of ['off', 'shadow']) {
    const env = makeEnv({ ENVIRONMENT: 'production', BILLING_ENFORCE: mode });
    const { org, cookie } = await portalOrg(env, `g-${mode}@example.com`);
    await addSub(env, org, { status: 'restricted', restricted_at: iso(Date.now() - DAY) });
    assert.notEqual((await call(env, 'POST', `/api/organizations/${org}/sites`, { name: 'x' }, cookie)).status, 402);
    await call(env, 'POST', `/api/organizations/${org}/sites`, { name: 'y' }, cookie);
    const rows = (await env.LUMMET_DB.prepare(`SELECT reason FROM subscription_access_shadow`).all()).results;
    if (mode === 'off') assert.equal(rows.length, 0); else assert.deepEqual(rows.map((r) => r.reason), ['would refuse entry_point=/sites method=POST']);
  }
});

// ---------------------------------------------------------------- entitlements
test('entitlements: enforce drops a past-grace past_due subscription to the zero floor; off and shadow leave it as before', async () => {
  for (const [mode, expectSites] of [['off', true], ['shadow', true], ['enforce', false]]) {
    const env = makeEnv({ BILLING_ENFORCE: mode });
    const org = await signup(env, `ent-${mode}@example.com`);
    await env.LUMMET_DB.prepare(`INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter','sites.max','number','5')`).run();
    await addSub(env, org, { status: 'past_due', grace_ends_at: iso(Date.now() - 3 * DAY) });
    const e = await entitlements.resolveForOrganization(env, org);
    assert.equal(e['sites.max'].value > 0, expectSites, mode);
  }
});

// ---------------------------------------------------------------- serve gate and staff suspensions
test('site gate: only sites billing suspended are restored; a staff suspension is never undone', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce', BILLING_SUSPEND_SITES: 'on' });
  const org = await signup(env, 'sites@example.com');
  const product = (await env.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first()).id;
  const mk = async (id, status, reason) => env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, suspension_reason) VALUES (?,?,?,?,?,?,?)`).bind(id, org, product, id, id, status, reason).run();
  await mk('s_live', 'active', null); await mk('s_staff', 'suspended', 'abuse report');
  const sub = await addSub(env, org, { status: 'restricted', restricted_at: iso(T0) });
  const r = await lifecycle.sweep(env, T0 + 8 * DAY);
  assert.equal(r.suspended, 1); assert.equal(r.sitesSuspended, 1);
  const st = async (id) => (await env.LUMMET_DB.prepare(`SELECT status FROM sites WHERE id = ?`).bind(id).first()).status;
  assert.equal(await st('s_live'), 'suspended'); assert.equal(await st('s_staff'), 'suspended');
  const g = await lifecycle.applySiteGate(env, org, 'active');
  assert.equal(g.restored, 1);
  assert.equal(await st('s_live'), 'active'); assert.equal(await st('s_staff'), 'suspended', 'staff suspension survives');
  assert.ok(sub);
});

// ---------------------------------------------------------------- AT-7 seats
test('AT-7: invitations beyond users.max are refused under enforce, counting members plus pending invitations', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce' });
  const org = await signup(env, 'seats@example.com');
  await env.LUMMET_DB.prepare(`INSERT OR REPLACE INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter','users.max','number','2')`).run();
  await addSub(env, org, { status: 'active' });
  assert.equal((await organizations.createInvitation(env, { organizationId: org, email: 'a@x.test', role: 'viewer' })).ok, true, '1 member + 1 pending = 2');
  const over = await organizations.createInvitation(env, { organizationId: org, email: 'b@x.test', role: 'viewer' });
  assert.equal(over.ok, false); assert.equal(over.error, 'seat_limit_reached'); assert.equal(over.status, 402); assert.equal(over.limit, 2); assert.equal(over.used, 2);
  assert.match(over.message, /Upgrade/);
  const off = makeEnv(); const org2 = await signup(off, 'seats2@example.com');
  await off.LUMMET_DB.prepare(`INSERT OR REPLACE INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter','users.max','number','1')`).run();
  await addSub(off, org2, { status: 'active' });
  assert.equal((await organizations.createInvitation(off, { organizationId: org2, email: 'c@x.test', role: 'viewer' })).ok, true, 'off never blocks');
});

// ---------------------------------------------------------------- AT-8 deletion
test('AT-8: deleting during a Stripe outage queues the cancellation, still deletes, and the sweep retries it until it works', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce' });
  const org = await signup(env, 'del@example.com');
  const ownerId = (await env.LUMMET_DB.prepare(`SELECT user_id FROM organization_users WHERE organization_id = ? AND role = 'owner'`).bind(org).first()).user_id;
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_del', current_period_end: iso(Date.now() + 10 * DAY) });
  let down = true; const seen = [];
  const billingService = { async cancelSubscription(e, o, opts) { seen.push(opts); if (down) throw new Error('Stripe unreachable'); return { ok: true }; } };
  const r = await organizations.requestDeletion(env, org, ownerId, { billingService });
  assert.equal(r.ok, true); assert.equal(r.billingCancelQueued, true);
  assert.deepEqual(seen[0].atPeriodEnd, true, 'default is cancel at period end');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT status FROM organizations WHERE id = ?`).bind(org).first()).status, 'closed');
  const pending = await env.LUMMET_DB.prepare(`SELECT * FROM billing_cancel_pending WHERE organization_id = ?`).bind(org).first();
  assert.equal(pending.attempts, 1); assert.match(pending.last_error, /unreachable/);
  const still = await lifecycle.sweep(env, Date.now(), { billingService });
  assert.equal(still.cancelRetriesFailed, 1);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT attempts FROM billing_cancel_pending`).first()).attempts, 2);
  down = false;
  const done = await lifecycle.sweep(env, Date.now(), { billingService });
  assert.equal(done.cancelRetries, 1);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM billing_cancel_pending`).first()).n, 0);
});
test('deletion: the owner may choose to delete now (immediate), and with the lifecycle off the legacy immediate cancel is kept', async () => {
  for (const [mode, deleteNow, expectEnd] of [['enforce', true, false], ['off', false, false], ['enforce', false, true]]) {
    const env = makeEnv({ BILLING_ENFORCE: mode });
    const org = await signup(env, `d-${mode}-${deleteNow}@example.com`);
    const ownerId = (await env.LUMMET_DB.prepare(`SELECT user_id FROM organization_users WHERE organization_id = ? AND role = 'owner'`).bind(org).first()).user_id;
    const seen = [];
    await organizations.requestDeletion(env, org, ownerId, { deleteNow, billingService: { async cancelSubscription(e, o, opts) { seen.push(opts); return { ok: true }; } } });
    assert.equal(seen[0].atPeriodEnd, expectEnd, `${mode}/${deleteNow}`);
  }
});
test('deletion: cancelling it withdraws a queued cancellation and resumes a period-end cancellation', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce' });
  const org = await signup(env, 'undo@example.com');
  const ownerId = (await env.LUMMET_DB.prepare(`SELECT user_id FROM organization_users WHERE organization_id = ? AND role = 'owner'`).bind(org).first()).user_id;
  await organizations.requestDeletion(env, org, ownerId, { billingService: { async cancelSubscription() { throw new Error('down'); } } });
  let resumed = 0;
  const r = await organizations.cancelScheduledDeletion(env, org, ownerId, { billingService: { async resumeSubscription() { resumed++; return { ok: true }; } } });
  assert.equal(r.ok, true); assert.equal(r.subscriptionResumed, true); assert.equal(resumed, 1);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM billing_cancel_pending`).first()).n, 0);
});

// ---------------------------------------------------------------- scheduler
function fakeCtx() { const ps = []; return { waitUntil(p) { ps.push(Promise.resolve(p).catch(() => {})); }, done: () => Promise.all(ps) }; }
test('scheduler: every cron records a heartbeat; daily and weekly do not run the tick; an unknown cron falls through to it', async () => {
  const env = makeEnv();
  for (const cron of [scheduler.TICK_CRON, scheduler.DAILY_CRON, scheduler.WEEKLY_CRON, '*/7 * * * *']) {
    const c = fakeCtx(); await worker.scheduled({ cron }, env, c); await c.done();
  }
  const crons = (await env.LUMMET_DB.prepare(`SELECT cron FROM scheduler_ticks ORDER BY id`).all()).results.map((r) => r.cron);
  assert.deepEqual(crons, ['*/5 * * * *', '0 2 * * *', '0 7 * * 1', '*/7 * * * *']);
  assert.equal(scheduler.cronKind('0 2 * * *'), 'daily'); assert.equal(scheduler.cronKind('0 7 * * 1'), 'weekly'); assert.equal(scheduler.cronKind('*/7 * * * *'), 'tick');
  // proof the tick really ran its work: the lifecycle sweep touched shadow mode data
  const e2 = makeEnv({ BILLING_ENFORCE: 'enforce' }); const org = await signup(e2, 'tick@example.com');
  const id = await addSub(e2, org, { status: 'trialing', trial_ends_at: iso(Date.now() - 2 * DAY) });
  const c2 = fakeCtx(); await worker.scheduled({ cron: scheduler.TICK_CRON }, e2, c2); await c2.done();
  assert.equal((await subRow(e2, id)).status, 'expired');
  const e3 = makeEnv({ BILLING_ENFORCE: 'enforce' }); const o3 = await signup(e3, 'daily@example.com');
  const id3 = await addSub(e3, o3, { status: 'trialing', trial_ends_at: iso(Date.now() - 2 * DAY) });
  const c3 = fakeCtx(); await worker.scheduled({ cron: scheduler.DAILY_CRON }, e3, c3); await c3.done();
  assert.equal((await subRow(e3, id3)).status, 'trialing', 'the daily cron is reserved and does not run the tick');
});
test('alert cron_not_running: silent before the first tick, fires after 20 minutes without one, clears when ticking again', async () => {
  const env = makeEnv({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' });
  const f = async () => new Response('', { status: 200 });
  const state = async () => (await runAlertCheck(env, { fetchImpl: f })).results.find((r) => r.key === 'cron_not_running');
  assert.equal((await state()).action, 'ok', 'a fresh install does not alert before its first tick');
  await env.LUMMET_DB.prepare(`INSERT INTO scheduler_ticks (cron, ran_at) VALUES ('*/5 * * * *', datetime('now','-45 minutes'))`).run();
  assert.equal((await state()).action, 'notified');
  await scheduler.recordTick(env, '*/5 * * * *');
  assert.equal((await state()).action, 'resolved');
});
test('alert cancel_pending_stuck fires only after 24 hours', async () => {
  const env = makeEnv({ ALERT_WEBHOOK_URL: 'https://hooks.example.com/x' });
  const f = async () => new Response('', { status: 200 });
  await env.LUMMET_DB.prepare(`INSERT INTO billing_cancel_pending (organization_id, created_at) VALUES ('o1', datetime('now','-2 hours'))`).run();
  assert.equal((await runAlertCheck(env, { fetchImpl: f })).results.find((r) => r.key === 'cancel_pending_stuck').action, 'ok');
  await env.LUMMET_DB.prepare(`UPDATE billing_cancel_pending SET created_at = datetime('now','-30 hours')`).run();
  assert.equal((await runAlertCheck(env, { fetchImpl: f })).results.find((r) => r.key === 'cancel_pending_stuck').action, 'notified');
});

// ---------------------------------------------------------------- configuration
test('config check: every new production setting is required and named when missing, never its value', () => {
  const full = { ENVIRONMENT: 'production', PORTAL_BASE_URL: 'https://a.test', PLATFORM_DOMAIN_SUFFIX: 'sites.a.test', CREDENTIAL_KEK: 'k', STRIPE_SECRET_KEY: 's', STRIPE_WEBHOOK_SECRET: 'w', CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ZONE_ID: 'z',
    EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'r', EMAIL_FROM: 'a@b.test', ALERT_WEBHOOK_URL: 'https://h.test', ALERT_CHECK_TOKEN: 'x', CSP_MODE: 'enforce', WEBAUTHN_RP_ID: 'a', WEBAUTHN_ORIGIN: 'https://a',
    BILLING_ENFORCE: 'off', BILLING_EMAILS: 'off', STRIPE_API_VERSION: '2024-06-20', BILLING_TRIAL_DAYS_DEFAULT: '7', BILLING_GRACE_DAYS: '14', BILLING_RESTRICTED_DAYS: '7', BILLING_SUSPENDED_DAYS: '30', BILLING_REMINDER_DAYS: '3,1', RATE_LIMIT_RETRY_AFTER: 'off', PLATFORM_ACCESS_JWT_MODE: 'off', ERROR_TRACKING: 'off', LOG_REDACTION: 'off', AUDIT_LOG_STREAM: 'off', HSTS_PRELOAD: 'off', CSP_REPORT_MODE: 'basic', CF_WAF_ZONE_ID: 'a'.repeat(32), CF_WAF_MAX_RULES: '10', CF_WAF_ALLOWED_PERIODS: '10,60', CF_WAF_MAX_TIMEOUT: '3600', WAF_THRESHOLDS_CONFIRMED: 'yes', PUBLIC_TRUST_PAGES: 'off', PUBLIC_LEGAL_PAGES: 'off', STATUS_PROVIDER_URL: 'https://status.a.test', SECURITY_CONTACT: 'mailto:security@a.test', SECURITY_TXT_EXPIRES: '2030-01-01T00:00:00Z' };
  assert.deepEqual(configIssues(full), []);
  for (const key of ['BILLING_ENFORCE', 'STRIPE_API_VERSION', 'BILLING_TRIAL_DAYS_DEFAULT', 'BILLING_GRACE_DAYS', 'BILLING_RESTRICTED_DAYS', 'BILLING_SUSPENDED_DAYS', 'BILLING_REMINDER_DAYS', 'PUBLIC_TRUST_PAGES', 'PUBLIC_LEGAL_PAGES', 'STATUS_PROVIDER_URL', 'SECURITY_CONTACT', 'SECURITY_TXT_EXPIRES']) {
    const { [key]: _gone, ...rest } = full;
    assert.ok(configIssues(rest).some((i) => i.key === key), `${key} must be required`);
  }
  assert.ok(configIssues({ ...full, BILLING_ENFORCE: 'maybe' }).some((i) => i.key === 'BILLING_ENFORCE'));
  assert.ok(configIssues({ ...full, BILLING_GRACE_DAYS: '0' }).some((i) => i.key === 'BILLING_GRACE_DAYS'));
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging' }), []);
});

// ---------------------------------------------------------------- tenant migration re-run (G4, from fixes.patch)
test('applyMigrationSql: a migration that half-applied before can be re-run; real errors still fail', async () => {
  const { applyMigrationSql } = await import('../worker/deployments.js');
  const ran = [];
  const infra = { async runD1Query(e, { sql }) { ran.push(sql); if (sql.includes('ADD COLUMN a') && sql.includes('ADD COLUMN b')) throw new Error('duplicate column name: a'); if (sql.includes('ADD COLUMN a;')) throw new Error('duplicate column name: a'); } };
  await applyMigrationSql(infra, {}, 'db', 'ALTER TABLE t ADD COLUMN a;\nALTER TABLE t ADD COLUMN b; -- comment');
  assert.ok(ran.some((s) => s === 'ALTER TABLE t ADD COLUMN b;'), 'the statement that had not applied runs on its own');
  await assert.rejects(applyMigrationSql({ async runD1Query() { throw new Error('syntax error near X'); } }, {}, 'db', 'BAD'), /syntax error/);
});

test('BILLING_SUSPEND_SITES shadow records would-be site gates while BILLING_ENFORCE stays off', async () => {
  const env = makeEnv({ ENVIRONMENT: 'production', BILLING_ENFORCE: 'off', BILLING_SUSPEND_SITES: 'shadow' });
  const org = await signup(env, 'site-shadow-off@example.com');
  const product = (await env.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first()).id;
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) VALUES ('site_shadow_off', ?, ?, 'shadow', 'shadow', 'active')`).bind(org, product).run();
  await addSub(env, org, { status: 'restricted', restricted_at: iso(T0) });
  await lifecycle.sweep(env, T0 + 8 * DAY);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT status FROM sites WHERE id='site_shadow_off'`).first()).status, 'active');
  const shadow = (await env.LUMMET_DB.prepare(`SELECT reason FROM subscription_access_shadow WHERE organization_id=?`).bind(org).all()).results;
  assert.ok(shadow.some((r) => r.reason.includes('BILLING_SUSPEND_SITES shadow')));
});
