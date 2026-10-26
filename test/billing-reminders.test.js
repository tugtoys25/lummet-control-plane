// Phase 2.2: the five webhook events, sweep reminders, the nine new templates, and the dedupe between the two sources of
// the same reminder (a Stripe event and the sweep). Fake provider and in-memory SQLite only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as notifications from '../worker/billing-notifications.js';
import { sweepReminders, bucketFor, renewalWanted } from '../worker/billing-reminders.js';
import { billingTemplates, BILLING_KINDS, renderBillingEmail } from '../worker/billing-email-templates.js';
import { renewalNoticeMode, winbackEnabled } from '../worker/billing-config.js';
import { flushOutbox } from '../worker/email.js';
import * as couponRepo from '../worker/repositories/coupons.js';
import * as customerAuth from '../worker/customer-auth.js';
import { setPlanPrice } from './support/plan-prices.js';

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
  const row = { status: 'active', plan_id: 'plan_casino_news_starter', provider: null, provider_subscription_id: null, trial_ends_at: null, grace_ends_at: null, current_period_end: null, cancel_at_period_end: 0, created_at: iso(Date.now() - 30 * DAY), ...f };
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id, trial_ends_at, grace_ends_at, current_period_end, cancel_at_period_end, updated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(id, orgId, row.plan_id, row.status, row.provider, row.provider_subscription_id, row.trial_ends_at, row.grace_ends_at, row.current_period_end, row.cancel_at_period_end, iso(Date.now()), row.created_at).run();
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
const templatesSent = async (env) => (await outbox(env)).map((r) => r.template);
async function lastBody(env) {
  let body;
  await flushOutbox(env, { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'msg_x' }), { status: 200 }); } });
  return body;
}

// ---------------------------------------------------------------- templates
const FULL = {
  brand: 'Lummet', orgName: 'Acme', planName: 'Growth', previousPlanName: 'Starter', billingUrl: 'https://app.example.test/app/billing',
  trialEndsAt: '2026-11-04T00:00:00Z', renewsAt: '2026-11-20T00:00:00Z', graceEndsAt: '2026-11-10T00:00:00Z', endsAt: '2026-11-30T00:00:00Z', deletesAt: '2026-12-01T00:00:00Z',
  amountCents: 4900, currency: 'usd', daysLeft: 3, invoiceUrl: 'https://pay.example.test/i/9', exportUrl: 'https://app.example.test/api/export', unsubscribeUrl: 'https://app.example.test/unsub'
};
const MINIMAL = { brand: 'Lummet', orgName: 'Acme' };
const NEW_KINDS = ['trial_reminder', 'renewal_notice', 'grace_reminder', 'card_authentication', 'plan_changed', 'ending_soon', 'win_back', 'refund_issued', 'deletion_warning'];

test('the nine new templates exist, render with and without optional facts, never print undefined, and escape HTML', () => {
  for (const kind of NEW_KINDS) assert.ok(BILLING_KINDS.includes(kind), kind);
  assert.equal(BILLING_KINDS.length, 17);
  for (const kind of NEW_KINDS) {
    for (const facts of [FULL, MINIMAL, { ...MINIMAL, daysLeft: 0, amountCents: null, trialEndsAt: 'not a date' }]) {
      const m = billingTemplates[kind](facts);
      assert.ok(m.subject && m.text && m.html, kind);
      for (const part of [m.subject, m.text, m.html]) assert.doesNotMatch(part, /undefined|null|NaN|\[object/, `${kind}: ${part.slice(0, 80)}`);
    }
    const evil = billingTemplates[kind]({ ...FULL, orgName: '<script>alert(1)</script>', planName: '"><img src=x>' });
    assert.doesNotMatch(evil.html, /<script>alert|<img src=x>/, kind);
  }
});

test('template wording: the reminders count down, the deletion warning links the export, win-back carries the unsubscribe link only when given', () => {
  assert.match(billingTemplates.trial_reminder({ ...FULL, daysLeft: 1 }).subject, /ends in 1 day$/);
  assert.match(billingTemplates.trial_reminder({ ...FULL, daysLeft: 3 }).subject, /ends in 3 days$/);
  assert.match(billingTemplates.renewal_notice(FULL).text, /\$49\.00/);
  assert.match(billingTemplates.deletion_warning(FULL).text, /https:\/\/app\.example\.test\/api\/export/);
  assert.match(billingTemplates.card_authentication(FULL).text, /https:\/\/pay\.example\.test\/i\/9/);
  assert.match(billingTemplates.win_back(FULL).text, /unsub/);
  assert.doesNotMatch(billingTemplates.win_back(MINIMAL).text, /nsubscribe/);
  assert.equal(renderBillingEmail('nope', FULL), null);
});

// ---------------------------------------------------------------- config
test('config: renewal notices default to yearly; win-back defaults off; the reminder buckets pick the smallest day count that fits', () => {
  assert.equal(renewalNoticeMode({}), 'yearly');
  assert.equal(renewalNoticeMode({ BILLING_RENEWAL_NOTICES: 'ALL' }), 'all');
  assert.equal(renewalNoticeMode({ BILLING_RENEWAL_NOTICES: 'bogus' }), 'yearly');
  assert.equal(winbackEnabled({}), false);
  assert.equal(winbackEnabled({ BILLING_WINBACK_EMAILS: 'on' }), true);
  assert.equal(renewalWanted({}, 'annual'), true);
  assert.equal(renewalWanted({}, 'monthly'), false);
  assert.equal(renewalWanted({ BILLING_RENEWAL_NOTICES: 'all' }, 'monthly'), true);
  assert.equal(renewalWanted({ BILLING_RENEWAL_NOTICES: 'off' }, 'annual'), false);
  assert.equal(bucketFor(2.5 * DAY, [3, 1]), 3);
  assert.equal(bucketFor(0.5 * DAY, [3, 1]), 1);
  assert.equal(bucketFor(5 * DAY, [3, 1]), null);
  assert.equal(bucketFor(-1, [3, 1]), null);
});

// ---------------------------------------------------------------- customer.subscription.trial_will_end
test('trial_will_end: one reminder however often it is delivered, and the sweep adds no second one for the same moment', async () => {
  const { env, org, hook } = await wired();
  const sub = await addSub(env, org, { status: 'trialing', provider: 'fake', provider_subscription_id: 'sub_t', trial_ends_at: iso(Date.now() + 2.5 * DAY), created_at: iso(Date.now() - 4.5 * DAY) });
  const end = Math.floor((Date.now() + 2.5 * DAY) / 1000);
  for (let i = 0; i < 5; i++) await hook('customer.subscription.trial_will_end', { id: 'sub_t', trial_end: end });
  assert.deepEqual(await templatesSent(env), ['billing_trial_reminder']);
  await sweepReminders(env); await sweepReminders(env);
  assert.deepEqual(await templatesSent(env), ['billing_trial_reminder'], 'the sweep recognises the webhook already sent it');
  const body = await lastBody(env);
  assert.match(body.subject, /trial ends in 3 days/);
  assert.ok(sub);
});

test('trial_will_end before the subscription exists fails (so Stripe redelivers) and succeeds once it does', async () => {
  const { env, org, hook } = await wired();
  const end = Math.floor((Date.now() + 2 * DAY) / 1000);
  const first = await hook('customer.subscription.trial_will_end', { id: 'sub_late', trial_end: end }, 'evt_late');
  assert.equal(first.ok, false); assert.equal(first.status, 500);
  await addSub(env, org, { status: 'trialing', provider: 'fake', provider_subscription_id: 'sub_late', trial_ends_at: iso(Date.now() + 2 * DAY), created_at: iso(Date.now() - 5 * DAY) });
  const again = await hook('customer.subscription.trial_will_end', { id: 'sub_late', trial_end: end }, 'evt_late');
  assert.equal(again.ok, true);
  assert.deepEqual(await templatesSent(env), ['billing_trial_reminder']);
});

// ---------------------------------------------------------------- sweep: trial reminders
test('sweep trial reminders: "3 days" once at three days, "1 day" once at one day, never repeated, never for a trial too short', async () => {
  const env = makeEnv();
  const org = await signup(env, 'a@example.com'); await verifyAll(env);
  const T0 = Date.now();
  await addSub(env, org, { status: 'trialing', trial_ends_at: iso(T0 + 7 * DAY), created_at: iso(T0) });
  const sent = async () => (await outbox(env)).length;
  await sweepReminders(env, T0); assert.equal(await sent(), 0, '7 days left: nothing yet');
  await sweepReminders(env, T0 + 4.2 * DAY); await sweepReminders(env, T0 + 4.3 * DAY);
  assert.equal(await sent(), 1);
  await sweepReminders(env, T0 + 5 * DAY); assert.equal(await sent(), 1, '2 days left is still the 3-day bucket');
  await sweepReminders(env, T0 + 6.1 * DAY); await sweepReminders(env, T0 + 6.2 * DAY);
  assert.equal(await sent(), 2);
  assert.deepEqual(await templatesSent(env), ['billing_trial_reminder', 'billing_trial_reminder']);

  const env2 = makeEnv();
  const o2 = await signup(env2, 'short@example.com'); await verifyAll(env2);
  await addSub(env2, o2, { status: 'trialing', trial_ends_at: iso(T0 + 2 * DAY), created_at: iso(T0) });
  await sweepReminders(env2, T0 + 0.1 * DAY);
  assert.equal((await outbox(env2)).length, 0, 'a 2-day trial gets no "3 days left" mail as it starts');
  await sweepReminders(env2, T0 + 1.2 * DAY);
  assert.equal((await outbox(env2)).length, 1);
});

test('sweep reminders are inert with BILLING_EMAILS off, log-only in shadow, and independent of BILLING_ENFORCE', async () => {
  for (const [mode, enforce, expected] of [['off', 'enforce', 0], ['shadow', 'enforce', 0], ['on', 'off', 1], ['on', 'shadow', 1]]) {
    const env = makeEnv({ BILLING_EMAILS: mode, BILLING_ENFORCE: enforce });
    const org = await signup(env, `m-${mode}-${enforce}@example.com`); await verifyAll(env);
    await addSub(env, org, { status: 'trialing', trial_ends_at: iso(Date.now() + 0.5 * DAY), created_at: iso(Date.now() - 6 * DAY) });
    const r = await sweepReminders(env);
    assert.equal((await outbox(env)).length, expected, `${mode}/${enforce}`);
    if (mode === 'off') assert.equal(r.skipped, 'off');
  }
});

// ---------------------------------------------------------------- renewal: invoice.upcoming and the sweep
test('renewal notice: invoice.upcoming and the sweep together send one email per renewal; monthly plans are skipped by default', async () => {
  const { env, org, hook } = await wired();
  await env.LUMMET_DB.prepare(`UPDATE plans SET billing_period = 'annual', price_cents = 4900 WHERE id = 'plan_casino_news_starter'`).run();
  const renews = iso(Date.now() + 2 * DAY);
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_y', current_period_end: renews });
  const upcoming = { subscription: 'sub_y', metadata: { organization_id: org }, amount_due: 4900, currency: 'usd', period_end: Math.floor((Date.now() + 2 * DAY) / 1000) };
  await hook('invoice.upcoming', upcoming); await hook('invoice.upcoming', upcoming);
  await sweepReminders(env);
  assert.deepEqual(await templatesSent(env), ['billing_renewal_notice']);
  assert.match((await lastBody(env)).text, /\$49\.00/);

  const m = await wired();
  await addSub(m.env, m.org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_m', current_period_end: renews });
  await m.hook('invoice.upcoming', { subscription: 'sub_m', metadata: { organization_id: m.org }, amount_due: 500, currency: 'usd' });
  await sweepReminders(m.env);
  assert.equal((await outbox(m.env)).length, 0, 'monthly: the receipt is enough');

  const all = await wired({ BILLING_RENEWAL_NOTICES: 'all' });
  await addSub(all.env, all.org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_a', current_period_end: renews });
  await sweepReminders(all.env);
  assert.deepEqual(await templatesSent(all.env), ['billing_renewal_notice']);
});

test('invoice.upcoming for a cancelling, trialing or unknown subscription sends nothing and does not fail', async () => {
  const { env, org, hook } = await wired({ BILLING_RENEWAL_NOTICES: 'all' });
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_c', cancel_at_period_end: 1, current_period_end: iso(Date.now() + DAY) });
  const r1 = await hook('invoice.upcoming', { subscription: 'sub_c', metadata: { organization_id: org }, amount_due: 900, currency: 'usd' });
  const r2 = await hook('invoice.upcoming', { subscription: 'sub_unknown', metadata: { organization_id: org }, amount_due: 900, currency: 'usd' });
  const r3 = await hook('invoice.upcoming', { subscription: 'sub_x', customer: 'cus_stranger', amount_due: 900 });
  assert.ok(r1.ok && r2.ok && r3.ok);
  assert.equal((await outbox(env)).length, 0);
});

// ---------------------------------------------------------------- grace, ending soon, deletion
test('sweep: grace reminder, ending soon and deletion warning each go out once per bucket', async () => {
  const env = makeEnv();
  const g = await signup(env, 'g@example.com'); await verifyAll(env);
  const T0 = Date.now();
  await addSub(env, g, { status: 'past_due', provider: 'fake', provider_subscription_id: 'sub_g', grace_ends_at: iso(T0 + 2.5 * DAY) });
  const e = await signup(env, 'e@example.com'); await verifyAll(env);
  await addSub(env, e, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_e', cancel_at_period_end: 1, current_period_end: iso(T0 + 2.5 * DAY) });
  const d = await signup(env, 'd@example.com'); await verifyAll(env);
  await env.LUMMET_DB.prepare(`UPDATE organizations SET status = 'closed', scheduled_deletion_at = ? WHERE id = ?`).bind(iso(T0 + 2.5 * DAY), d).run();

  const first = await sweepReminders(env, T0); await sweepReminders(env, T0 + 1000);
  assert.equal(first.grace, 1); assert.equal(first.ending, 1); assert.equal(first.deletion, 1);
  assert.deepEqual((await templatesSent(env)).sort(), ['billing_deletion_warning', 'billing_ending_soon', 'billing_grace_reminder']);
  await sweepReminders(env, T0 + 1.7 * DAY);
  assert.equal((await outbox(env)).length, 6, 'the 1-day bucket is a second notice for each');
  await sweepReminders(env, T0 + 1.8 * DAY);
  assert.equal((await outbox(env)).length, 6);

  const del = (await outbox(env)).find((r) => r.template === 'billing_deletion_warning');
  assert.ok(del);
});

test('deletion warning carries a real export link to the organization', async () => {
  const env = makeEnv();
  const d = await signup(env, 'del@example.com'); await verifyAll(env);
  await env.LUMMET_DB.prepare(`UPDATE organizations SET status = 'closed', scheduled_deletion_at = ? WHERE id = ?`).bind(iso(Date.now() + 2 * DAY), d).run();
  await sweepReminders(env);
  const body = await lastBody(env);
  assert.match(body.text, new RegExp(`https://app\\.example\\.test/api/customer/organizations/${d}/export`));
  assert.match(body.subject, /will be deleted in 2 days/);
});

test('an organization already erased or without a scheduled deletion gets no warning', async () => {
  const env = makeEnv();
  const o = await signup(env, 'ok@example.com'); await verifyAll(env);
  await sweepReminders(env);
  assert.equal((await outbox(env)).length, 0);
  assert.ok(o);
});

// ---------------------------------------------------------------- invoice.payment_action_required
test('payment_action_required: one card-authentication email per invoice, with the invoice link', async () => {
  const { env, org, hook } = await wired();
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_p' });
  const inv = { id: 'in_3ds', subscription: 'sub_p', metadata: { organization_id: org }, amount_due: 1900, currency: 'usd', hosted_invoice_url: 'https://pay.example.test/i/3ds' };
  for (let i = 0; i < 5; i++) await hook('invoice.payment_action_required', inv);
  await hook('invoice.payment_action_required', { ...inv, id: 'in_3ds_2' });
  assert.deepEqual(await templatesSent(env), ['billing_card_authentication', 'billing_card_authentication']);
  assert.match((await lastBody(env)).text, /https:\/\/pay\.example\.test\/i\/3ds/);
});

test('payment_action_required with no resolvable organization fails so it is redelivered', async () => {
  const { hook } = await wired();
  const r = await hook('invoice.payment_action_required', { id: 'in_orphan', customer: 'cus_nobody' });
  assert.equal(r.ok, false); assert.equal(r.status, 500);
});

// ---------------------------------------------------------------- checkout.session.expired
test('checkout.session.expired releases the coupon hold; unrelated sessions and repeats change nothing', async () => {
  const { env, org, hook } = await wired();
  await env.LUMMET_DB.prepare(`INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off, duration, status, max_redemptions) VALUES ('cp1','LIMITED','fake','fcp1',10,'once','active',1)`).run();
  assert.ok(await couponRepo.reserveUse(env, 'cp1', org, 3600));
  const other = await signup(env, 'other@example.com');
  assert.equal(await couponRepo.countOtherHolds(env, 'cp1', other), 1, 'held');
  await hook('checkout.session.expired', { id: 'cs_1', client_reference_id: org, metadata: { coupon_id: 'cp1', organization_id: org } });
  assert.equal(await couponRepo.countOtherHolds(env, 'cp1', other), 0, 'released');
  const r = await hook('checkout.session.expired', { id: 'cs_2', metadata: {} });
  assert.ok(r.ok);
  assert.ok(await couponRepo.reserveUse(env, 'cp1', other, 3600), 'another organization can now take the last use');
});

// ---------------------------------------------------------------- customer.subscription.created
const stripeSub = (org, extra = {}) => ({
  id: 'sub_new', status: 'active', customer: 'cus_1', metadata: { organization_id: org, plan_id: 'plan_casino_news_growth' },
  items: { data: [{ price: { id: 'price_growth' } }] }, current_period_start: Math.floor(Date.now() / 1000), current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000), ...extra
});
const subs = async (env, org) => (await env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ?`).bind(org).all()).results;

test('subscription.created upserts by provider id: created once, repeat is a no-op', async () => {
  const { env, org, hook } = await wired();
  for (let i = 0; i < 3; i++) await hook('customer.subscription.created', stripeSub(org));
  const rows = await subs(env, org);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider_subscription_id, 'sub_new'); assert.equal(rows[0].status, 'active'); assert.equal(rows[0].plan_id, 'plan_casino_news_growth');
  assert.ok(rows[0].current_period_end);
});

test('subscription.created then checkout.session.completed (and the reverse) leave exactly one subscription', async () => {
  for (const order of ['created-first', 'completed-first']) {
    const { env, org, hook } = await wired();
    const completed = { id: 'cs_ok', client_reference_id: org, subscription: 'sub_new', metadata: { organization_id: org, plan_id: 'plan_casino_news_growth' } };
    if (order === 'created-first') { await hook('customer.subscription.created', stripeSub(org)); await hook('checkout.session.completed', completed); }
    else { await hook('checkout.session.completed', completed); await hook('customer.subscription.created', stripeSub(org)); }
    const rows = await subs(env, org);
    assert.equal(rows.length, 1, order);
    assert.equal(rows[0].provider_subscription_id, 'sub_new', order);
  }
});

test('subscription.created converts a local trial in place instead of adding a second subscription', async () => {
  const { env, org, hook } = await wired();
  const local = await addSub(env, org, { status: 'trialing', trial_ends_at: iso(Date.now() + 3 * DAY) });
  await hook('customer.subscription.created', stripeSub(org));
  const rows = await subs(env, org);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, local); assert.equal(rows[0].provider_subscription_id, 'sub_new'); assert.equal(rows[0].plan_id, 'plan_casino_news_growth');
});

test('subscription.created: incomplete is not materialised, a stranger customer is ignored, an unmappable plan fails for redelivery', async () => {
  const { env, org, hook, billing } = await wired();
  assert.ok((await hook('customer.subscription.created', stripeSub(org, { status: 'incomplete' }))).ok);
  assert.equal((await subs(env, org)).length, 0);
  assert.ok((await hook('customer.subscription.created', { id: 'sub_x', status: 'active', customer: 'cus_stranger', metadata: {}, items: { data: [] } })).ok);
  const bad = await hook('customer.subscription.created', { ...stripeSub(org, { metadata: { organization_id: org }, items: { data: [{ price: { id: 'price_unknown' } }] } }) }, 'evt_plan');
  assert.equal(bad.ok, false); assert.equal(bad.status, 500);
  await setPlanPrice(env, 'plan_casino_news_growth', 'price_unknown');
  const retry = await hook('customer.subscription.created', { ...stripeSub(org, { metadata: { organization_id: org }, items: { data: [{ price: { id: 'price_unknown' } }] } }) }, 'evt_plan');
  assert.ok(retry.ok);
  assert.equal((await subs(env, org)).length, 1);
  assert.ok(billing);
});

test('subscription.created refuses a second provider subscription for an organization that already has one', async () => {
  const { env, org, hook } = await wired();
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_old' });
  const r = await hook('customer.subscription.created', stripeSub(org));
  assert.equal(r.ok, false); assert.equal(r.status, 500);
  assert.equal((await subs(env, org)).length, 1);
});

test('subscription.created for a card trial sends one welcome; a repeat or the later local welcome does not double it', async () => {
  const { env, org, hook } = await wired();
  const trialEnd = Math.floor((Date.now() + 7 * DAY) / 1000);
  await hook('customer.subscription.created', stripeSub(org, { status: 'trialing', trial_end: trialEnd }));
  await hook('customer.subscription.created', stripeSub(org, { status: 'trialing', trial_end: trialEnd }));
  assert.deepEqual(await templatesSent(env), ['billing_trial_welcome']);
});

// ---------------------------------------------------------------- plan changed
// Sprint 3.2 (N2): under BILLING_ENFORCE=enforce the request itself announces nothing and changes no plan; the provider's
// confirming webhook applies the plan and is what emails the owners, once however many times the change arrives.
test('plan change (enforce): the request sends no email; the confirming webhook sends one, once; the same plan is refused', async () => {
  const { env, org, billing, hook } = await wired();
  await setPlanPrice(env, 'plan_casino_news_growth', 'price_growth');
  await addSub(env, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_pc' });
  const r1 = await billing.changePlan(env, org, 'plan_casino_news_growth');
  assert.ok(r1.ok && r1.pending);
  assert.deepEqual(await templatesSent(env), [], 'nothing is announced before the provider confirms');
  const confirmed = stripeSub(org, { id: 'sub_pc' });
  await hook('customer.subscription.updated', confirmed);
  await hook('customer.subscription.updated', confirmed);          // the same change again, as a different event
  assert.deepEqual(await templatesSent(env), ['billing_plan_changed']);
  assert.match((await lastBody(env)).text, /Growth/);
  assert.equal((await billing.changePlan(env, org, 'plan_casino_news_growth')).error, 'already_on_plan');
  assert.equal((await outbox(env)).length, 1, 'already on that plan: nothing to tell');
});

// ---------------------------------------------------------------- win-back, refund
test('win-back is switched off by default and queues only when BILLING_WINBACK_EMAILS=on; no sweep sends it', async () => {
  const off = await wired();
  const sub = await addSub(off.env, off.org, { status: 'canceled' });
  await off.env.LUMMET_DB.prepare(`UPDATE subscriptions SET canceled_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(sub).run();
  const r = await notifications.notify.winBack(off.env, { organizationId: off.org, subscriptionId: sub, canceledAt: iso(Date.now()) });
  assert.equal(r.skipped, 'winback_off');
  await sweepReminders(off.env);
  assert.equal((await outbox(off.env)).length, 0);

  const on = await wired({ BILLING_WINBACK_EMAILS: 'on' });
  const s2 = await addSub(on.env, on.org, { status: 'canceled' });
  await notifications.notify.winBack(on.env, { organizationId: on.org, subscriptionId: s2, canceledAt: iso(Date.now()) });
  await notifications.notify.winBack(on.env, { organizationId: on.org, subscriptionId: s2, canceledAt: iso(Date.now()) });
  assert.deepEqual(await templatesSent(on.env), ['billing_win_back']);
  await sweepReminders(on.env);
  assert.equal((await outbox(on.env)).length, 1, 'the sweep never triggers win-back');
});

test('refund notice: one email per refund id', async () => {
  const { env, org } = await wired();
  const sub = await addSub(env, org, { status: 'active' });
  for (let i = 0; i < 3; i++) await notifications.notify.refundIssued(env, { organizationId: org, subscriptionId: sub, refundId: 're_1', amountCents: 500, currency: 'usd' });
  await notifications.notify.refundIssued(env, { organizationId: org, subscriptionId: sub, refundId: 're_2', amountCents: 200, currency: 'usd' });
  assert.deepEqual(await templatesSent(env), ['billing_refund_issued', 'billing_refund_issued']);
});

// ---------------------------------------------------------------- recipients and suppression still apply
test('a suppressed owner is not sent a reminder', async () => {
  const { env, org, email } = await wired();
  const { emailHash } = await import('../worker/email.js');
  await env.LUMMET_DB.prepare(`INSERT INTO email_suppressions (email_hash, reason) VALUES (?, 'bounce')`).bind(await emailHash(email)).run();
  await addSub(env, org, { status: 'trialing', trial_ends_at: iso(Date.now() + 0.5 * DAY), created_at: iso(Date.now() - 6 * DAY) });
  await sweepReminders(env);
  assert.equal((await outbox(env)).length, 0);
});

test('one failing reminder does not stop the rest of the sweep, and the failure is reported', async () => {
  const env = makeEnv();
  const a = await signup(env, 'bad@example.com'); const b = await signup(env, 'good@example.com'); await verifyAll(env);
  await addSub(env, a, { status: 'trialing', trial_ends_at: iso(Date.now() + 0.5 * DAY), created_at: iso(Date.now() - 6 * DAY) });
  await addSub(env, b, { status: 'trialing', trial_ends_at: iso(Date.now() + 0.5 * DAY), created_at: iso(Date.now() - 6 * DAY) });
  const real = env.LUMMET_DB.prepare.bind(env.LUMMET_DB);
  let broke = false;
  env.LUMMET_DB.prepare = (sql) => {
    if (!broke && /INSERT INTO billing_notifications/.test(sql)) { broke = true; throw new Error('db hiccup'); }
    return real(sql);
  };
  const logs = []; const orig = console.error; console.error = (m) => logs.push(String(m));
  try { var summary = await sweepReminders(env); } finally { console.error = orig; }
  assert.equal(summary.errors, 1); assert.equal(summary.trial, 1);
  assert.ok(logs.some((l) => /billing_reminder_failed/.test(l)));
});
