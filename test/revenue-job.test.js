// Round 6.1B (release 2.6.0.2): the daily revenue job. Writes revenue_snapshots from the 6.1A ledger (blueprint section 13).
// Acceptance (written first): AT-14 MRR within tolerance of an independent provider report on fake provider data (Stripe test mode is
// owner-run and NOT VERIFIED here); the job is idempotent on re-run; mixed currencies are flagged, reported per currency, never summed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import { revenueReportingCurrency } from '../worker/billing-config.js';
import * as revenue from '../worker/revenue.js';
import * as job from '../worker/revenue-job.js';
import * as staff from '../worker/staff-saas.js';
import { configIssues } from '../worker/config-check.js';
import { setPlanPrice } from './support/plan-prices.js';
import * as customerAuth from '../worker/customer-auth.js';

const DAY = 86400000;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const unix = (ms) => Math.floor(ms / 1000);
const STARTER = 'plan_casino_news_starter';          // 500 cents monthly
const ANNUAL = 'plan_casino_news_starter_annual';    // 5000 cents annual
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

function makeEnv(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; }
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;
const run = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).run();
async function signup(env, email) {
  return (await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.9' } }, env)).organizationId;
}
async function addSub(env, orgId, f = {}) {
  const id = f.id || crypto.randomUUID();
  await run(env, `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id, created_at, updated_at, canceled_at, current_period_start, coupon_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, orgId, f.plan_id || STARTER, f.status || 'active', f.provider ?? null, f.provider_subscription_id ?? null, f.created_at || '2026-11-01 00:00:00', f.updated_at || '2026-11-01 00:00:00', f.canceled_at ?? null, f.current_period_start ?? null, f.coupon_id ?? null);
  return id;
}
const setSub = (env, id, set, ...b) => run(env, `UPDATE subscriptions SET ${set} WHERE id = ?`, ...b, id);
async function addCoupon(env, id, { percent = null, amount = null, duration = 'forever' } = {}) {
  await run(env, `INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off, amount_off_cents, duration) VALUES (?, ?, 'fake', ?, ?, ?, ?)`, id, id.toUpperCase(), 'prov_' + id, percent, amount, duration);
}
async function addPlan(env, id, { price, currency, period = 'monthly' }) {
  const p = await one(env, `SELECT product_id FROM plans WHERE id = ?`, STARTER);
  await run(env, `INSERT INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status) VALUES (?,?,?,?,?,?,?,0,'active')`, id, p.product_id, id, id, period, price, currency);
}
const derive = (e, id, at) => revenue.deriveSubscriptionMovement(e, { subscriptionId: id, source: 'webhook', eventCreated: at });
const snaps = (e) => all(e, `SELECT day, currency, mrr_cents, arr_cents, active, trialing, past_due, new_mrr, expansion_mrr, contraction_mrr, churned_mrr FROM revenue_snapshots ORDER BY day, currency`);
async function capture(fn) { const logs = []; const o = [console.log, console.warn, console.error]; const rec = (...a) => logs.push(a.join(' ')); console.log = rec; console.warn = rec; console.error = rec; try { return { result: await fn(), logs }; } finally { [console.log, console.warn, console.error] = o; } }
async function wired(extra = {}) {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce', ...extra });
  const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  const hook = (type, object, { id = 'evt_' + Math.random(), created = unix(T0) } = {}) => simulateWebhook(billing, provider, env, { id, type, created, data: { object } });
  return { env, provider, billing, hook };
}

// ------------------------------------------------------------------ pure definitions (blueprint section 13)
test('mrrCents: annual / 12, quantity, recurring discounts only, floor at zero, trials and unpriced plans count nothing', () => {
  const m = (o) => revenue.mrrCents({ status: 'active', priceCents: 500, billingPeriod: 'monthly', ...o });
  assert.equal(m({}), 500);
  assert.equal(m({ quantity: 3 }), 1500);
  assert.equal(m({ billingPeriod: 'annual', priceCents: 5000 }), 417, 'annual is divided by 12 and rounded to a cent');
  assert.equal(m({ discount: { percentOff: 20, duration: 'forever' } }), 400);
  assert.equal(m({ quantity: 2, discount: { percentOff: 25, duration: 'repeating' } }), 750, 'a percent applies to the whole line');
  assert.equal(m({ discount: { amountOffCents: 200, duration: 'forever' } }), 300);
  assert.equal(m({ quantity: 4, discount: { amountOffCents: 200, duration: 'forever' } }), 1800, 'a flat amount is taken once per invoice, not per seat');
  assert.equal(m({ billingPeriod: 'annual', priceCents: 6000, discount: { amountOffCents: 1200, duration: 'forever' } }), 400, 'a flat amount on an annual invoice is spread over 12 months');
  assert.equal(m({ discount: { percentOff: 20, duration: 'once' } }), 500, 'a one-time discount is not recurring');
  assert.equal(m({ discount: { amountOffCents: 9999, duration: 'forever' } }), 0, 'MRR never goes below zero');
  assert.equal(m({ discount: { percentOff: 100, duration: 'forever' } }), 0);
  assert.equal(m({ status: 'trialing' }), 0); assert.equal(m({ status: 'restricted' }), 0); assert.equal(m({ status: 'past_due' }), 500);
  assert.equal(m({ billingPeriod: 'custom' }), 0);
});

test('mrrWithinTolerance compares in basis points and is exact for zero', () => {
  assert.equal(job.mrrWithinTolerance(10000, 10050, 100), true);
  assert.equal(job.mrrWithinTolerance(10000, 10200, 100), false);
  assert.equal(job.mrrWithinTolerance(0, 0, 100), true);
  assert.equal(job.mrrWithinTolerance(1, 0, 100), false);
  assert.ok(Number.isInteger(job.DEFAULT_MRR_TOLERANCE_BPS) && job.DEFAULT_MRR_TOLERANCE_BPS > 0, 'the tolerance is a registered [OPEN] placeholder with a default');
});

// ------------------------------------------------------------------ AT-14
test('AT-14: snapshot MRR is within tolerance of an independent provider report built from the same fake provider data', async () => {
  const { env, hook } = await wired();
  await setPlanPrice(env, STARTER, 'price_m'); await setPlanPrice(env, ANNUAL, 'price_a');
  await addCoupon(env, 'c_pct', { percent: 20, duration: 'forever' }); await addCoupon(env, 'c_once', { percent: 50, duration: 'once' }); await addCoupon(env, 'c_amt', { amount: 1200, duration: 'repeating' });
  // the provider's own view of every subscription, kept independently of the database under test
  const providerSubs = [];
  const make = async (n, { status = 'active', price = 'price_m', plan = STARTER, qty = 1, coupon = null, discount = null, created = T0, failPayment = false }) => {
    const org = await signup(env, `at14-${n}-${Math.random()}@example.com`);
    const obj = { id: `sub_${n}`, status, customer: `cus_${n}`, metadata: { organization_id: org, plan_id: plan, ...(coupon ? { coupon_id: coupon } : {}) }, current_period_start: unix(created), current_period_end: unix(created + 30 * DAY), items: { data: [{ price: { id: price }, quantity: qty }] } };
    await hook('customer.subscription.created', obj, { created: unix(created) });
    if (failPayment) { await hook('invoice.payment_failed', { id: `in_${n}`, subscription: `sub_${n}`, metadata: { organization_id: org }, amount_due: 500 }, { created: unix(created + DAY) }); status = 'past_due'; }
    providerSubs.push({ status, unitCents: price === 'price_a' ? 5000 : 500, interval: price === 'price_a' ? 'year' : 'month', qty, discount });
  };
  await make(1, {}); await make(2, { qty: 3 }); await make(3, { price: 'price_a', plan: ANNUAL }); await make(4, { failPayment: true });
  await make(5, { status: 'trialing' }); await make(6, { qty: 2, coupon: 'c_pct', discount: { percent: 20 } });
  await make(7, { coupon: 'c_once' }); await make(8, { price: 'price_a', plan: ANNUAL, coupon: 'c_amt', discount: { amount: 1200, interval: 'invoice' } });
  const cancelOrg = await signup(env, 'at14-cancel@example.com');
  await hook('customer.subscription.created', { id: 'sub_x', status: 'active', customer: 'cus_x', metadata: { organization_id: cancelOrg, plan_id: STARTER }, current_period_start: unix(T0), current_period_end: unix(T0 + 30 * DAY), items: { data: [{ price: { id: 'price_m' }, quantity: 1 }] } }, { created: unix(T0) });
  await hook('customer.subscription.deleted', { id: 'sub_x', status: 'canceled', customer: 'cus_x', metadata: { organization_id: cancelOrg, plan_id: STARTER } }, { created: unix(T0 + DAY) });
  // what a provider MRR report says: active + past_due, normalised to a month, minus recurring discounts, trials excluded
  let reportCents = 0;
  for (const s of providerSubs) {
    if (!['active', 'past_due'].includes(s.status)) continue;
    let monthly = (s.unitCents * s.qty) / (s.interval === 'year' ? 12 : 1);
    if (s.discount?.percent) monthly -= (monthly * s.discount.percent) / 100;
    if (s.discount?.amount) monthly -= s.discount.amount / (s.interval === 'year' ? 12 : 1);
    reportCents += Math.max(0, monthly);
  }
  // webhook-created rows are stamped with the wall clock, so run the job far enough ahead of both that and the event time
  const horizon = Math.max(Date.now(), T0) + 3 * DAY;
  const r = await job.runDailyRevenueJob(env, { now: horizon, maxDays: 4000 });
  assert.equal(r.status, 'ok'); assert.equal(r.complete, true);
  const row = await one(env, `SELECT * FROM revenue_snapshots WHERE currency = 'USD' ORDER BY day DESC LIMIT 1`);
  assert.ok(job.mrrWithinTolerance(row.mrr_cents, Math.round(reportCents), job.DEFAULT_MRR_TOLERANCE_BPS), `snapshot ${row.mrr_cents} vs report ${reportCents}`);
  assert.equal(row.mrr_cents, 4534, 'each rule applied (500 + 1500 + 417 + 500 + 800 + 500 + 317): annual/12, quantity, past_due counted, trial and canceled excluded, forever 20% off, once ignored, flat annual discount spread');
  assert.equal(row.arr_cents, row.mrr_cents * 12, 'ARR = 12 x MRR');
  assert.deepEqual([row.active, row.past_due, row.trialing], [6, 1, 1], 'status counts as of the day: the canceled subscription is in none of them');
});

// ------------------------------------------------------------------ bridge and idempotency
async function ledgerWorld() {
  const e = makeEnv(); const org = await signup(e, 'bridge@example.com');
  const plans = await all(e, `SELECT id, price_cents FROM plans WHERE billing_period = 'monthly' AND price_cents > 500 ORDER BY price_cents LIMIT 1`);
  const a = await addSub(e, org, { status: 'trialing', provider: 'fake', provider_subscription_id: 'sub_a' });
  const b = await addSub(e, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_b' });
  await derive(e, a, unix(T0)); await derive(e, b, unix(T0));                                   // day 0: b new
  await setSub(e, a, `status = 'active'`); await derive(e, a, unix(T0 + DAY));                    // day 1: a new
  await setSub(e, b, `plan_id = ?`, plans[0].id); await derive(e, b, unix(T0 + 2 * DAY));         // day 2: b expansion
  await setSub(e, b, `plan_id = ?`, STARTER); await derive(e, b, unix(T0 + 3 * DAY));             // day 3: b contraction
  await setSub(e, a, `status = 'canceled'`); await derive(e, a, unix(T0 + 4 * DAY));             // day 4: a churn
  return { e, expansion: plans[0].price_cents - 500 };
}

test('the bridge: every day, MRR end = MRR start + new + expansion - contraction - churned; kinds come from that day\'s movements', async () => {
  const { e, expansion } = await ledgerWorld();
  await job.runDailyRevenueJob(e, { now: T0 + 7 * DAY });
  const rows = await snaps(e); assert.equal(rows.length, 7, 'one row per day from the first movement to yesterday, one currency');
  assert.deepEqual(rows.map((r) => r.mrr_cents), [500, 1000, 1000 + expansion, 1000, 500, 500, 500]);
  assert.deepEqual(rows.map((r) => [r.new_mrr, r.expansion_mrr, r.contraction_mrr, r.churned_mrr]), [[500, 0, 0, 0], [500, 0, 0, 0], [0, expansion, 0, 0], [0, 0, expansion, 0], [0, 0, 0, 500], [0, 0, 0, 0], [0, 0, 0, 0]]);
  let prev = 0; for (const r of rows) { assert.equal(r.mrr_cents, prev + r.new_mrr + r.expansion_mrr - r.contraction_mrr - r.churned_mrr, r.day); assert.equal(r.arr_cents, 12 * r.mrr_cents); prev = r.mrr_cents; }
  assert.ok(rows.every((r) => r.contraction_mrr >= 0 && r.churned_mrr >= 0), 'contraction and churn are stored as positive magnitudes');
  assert.equal(rows.at(-1).mrr_cents, (await one(e, `SELECT SUM(mrr_cents) n FROM subscription_revenue_state`)).n, 'the last day equals the ledger head');
});

test('idempotent: re-running the job (same day, later day, again and again) leaves exactly the same rows', async () => {
  const { e } = await ledgerWorld();
  await job.runDailyRevenueJob(e, { now: T0 + 7 * DAY }); const first = await snaps(e);
  for (let i = 0; i < 3; i++) await job.runDailyRevenueJob(e, { now: T0 + 7 * DAY });
  assert.deepEqual(await snaps(e), first);
  const other = makeEnv(); const { e: e2 } = await ledgerWorld();
  await Promise.all([job.runDailyRevenueJob(e2, { now: T0 + 7 * DAY }), job.runDailyRevenueJob(e2, { now: T0 + 7 * DAY })]);   // two overlapping runs
  assert.deepEqual(await snaps(e2), first, 'overlapping runs converge to the same rows');
  assert.equal((await one(e2, `SELECT COUNT(*) n FROM revenue_snapshots`)).n, first.length);
  void other;
});

test('a late event that lands on an earlier day is picked up by the next run; older days are not rewritten blindly', async () => {
  const e = makeEnv(); const org = await signup(e, 'late@example.com'); const s = await addSub(e, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_l' });
  await derive(e, s, unix(T0)); await job.runDailyRevenueJob(e, { now: T0 + 5 * DAY });
  assert.deepEqual((await snaps(e)).map((r) => r.mrr_cents), [500, 500, 500, 500, 500]);
  const s2 = await addSub(e, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_l2', created_at: dayOf(T0 + 4 * DAY) + ' 00:00:00' });
  await derive(e, s2, unix(T0 + 4 * DAY)); await job.runDailyRevenueJob(e, { now: T0 + 5 * DAY + 1000 });
  assert.deepEqual((await snaps(e)).map((r) => r.mrr_cents), [500, 500, 500, 500, 1000], 'recent days are recomputed, so a one-day-late event shows up');
});

test('durable: a run bounded to a few days resumes where it stopped and ends in the same place as one long run', async () => {
  const { e } = await ledgerWorld(); const { e: ref } = await ledgerWorld();
  await job.runDailyRevenueJob(ref, { now: T0 + 7 * DAY }); const expected = (await snaps(ref)).map((r) => r.mrr_cents);
  const r1 = await job.runDailyRevenueJob(e, { now: T0 + 7 * DAY, maxDays: 3 }); assert.equal(r1.days, 3); assert.equal(r1.complete, false);
  assert.equal((await one(e, `SELECT COUNT(*) n FROM revenue_snapshots`)).n, 3);
  let guard = 0; while (!(await job.runDailyRevenueJob(e, { now: T0 + 7 * DAY, maxDays: 3 })).complete && guard++ < 10);
  assert.deepEqual((await snaps(e)).map((r) => r.mrr_cents), expected);
});

test('status counts are as of the day: a trial that converted counts as trialing before and active after', async () => {
  const e = makeEnv(); const org = await signup(e, 'counts@example.com');
  const s = await addSub(e, org, { status: 'trialing', provider: 'fake', provider_subscription_id: 'sub_c', created_at: dayOf(T0) + ' 08:00:00' });
  await run(e, `INSERT INTO subscription_status_events (subscription_id, from_status, to_status, created_at) VALUES (?, NULL, 'trialing', ?)`, s, dayOf(T0) + ' 08:00:00');
  await derive(e, s, unix(T0));
  await setSub(e, s, `status = 'active'`); await run(e, `INSERT INTO subscription_status_events (subscription_id, from_status, to_status, created_at) VALUES (?, 'trialing', 'active', ?)`, s, dayOf(T0 + 2 * DAY) + ' 09:00:00');
  await derive(e, s, unix(T0 + 2 * DAY));
  await job.runDailyRevenueJob(e, { now: T0 + 4 * DAY });
  assert.deepEqual((await snaps(e)).map((r) => [r.day, r.trialing, r.active, r.mrr_cents]), [[dayOf(T0), 1, 0, 0], [dayOf(T0 + DAY), 1, 0, 0], [dayOf(T0 + 2 * DAY), 0, 1, 500], [dayOf(T0 + 3 * DAY), 0, 1, 500]]);
});

test('REVENUE_METRICS=off writes nothing; unset, shadow and on write; an empty ledger writes nothing and says so', async () => {
  for (const [mode, writes] of [['off', false], ['shadow', true], [undefined, true], ['on', true]]) {
    const e = makeEnv(mode === undefined ? {} : { REVENUE_METRICS: mode }); const org = await signup(e, `m${mode}@example.com`); const s = await addSub(e, org, { status: 'active' });
    await run(e, `INSERT INTO subscription_movements (id, subscription_id, organization_id, seq, day, kind, mrr_delta_cents, mrr_after_cents, currency, source) VALUES (?, ?, ?, 1, ?, 'new', 500, 500, 'USD', 'webhook')`, `${s}:1`, s, org, dayOf(T0));
    const r = await job.runDailyRevenueJob(e, { now: T0 + 2 * DAY });
    assert.equal((await one(e, `SELECT COUNT(*) n FROM revenue_snapshots`)).n > 0, writes, String(mode));
    if (mode === 'off') assert.equal(r.status, 'disabled');
  }
  const empty = makeEnv(); await run(empty, `DELETE FROM subscriptions`);
  assert.equal((await job.runDailyRevenueJob(empty, { now: T0 })).status, 'no_data');
});

// ------------------------------------------------------------------ mixed currencies
test('mixed currencies: flagged, one row per currency, never summed into one figure, and the staff summary refuses a single total', async () => {
  const e = makeEnv({ REVENUE_REPORTING_CURRENCY: 'USD' }); const org = await signup(e, 'mix@example.com');
  await addPlan(e, 'plan_eur_x', { price: 900, currency: 'EUR' });
  const u = await addSub(e, org, { status: 'active' }); const eu = await addSub(e, org, { status: 'active', plan_id: 'plan_eur_x' });
  await derive(e, u, unix(T0)); await derive(e, eu, unix(T0));
  const { result, logs } = await capture(() => job.runDailyRevenueJob(e, { now: T0 + 2 * DAY }));
  assert.equal(result.mixedCurrency, true); assert.deepEqual(result.currencies, ['EUR', 'USD']);
  assert.ok(logs.some((l) => /revenue_mixed_currency/.test(l)), 'the flag is logged');
  const rows = await all(e, `SELECT day, currency, mrr_cents FROM revenue_snapshots WHERE day = ? ORDER BY currency`, dayOf(T0 + DAY));
  assert.deepEqual(rows.map((r) => [r.currency, r.mrr_cents]), [['EUR', 900], ['USD', 500]], 'per currency; no 1400 anywhere');
  assert.equal((await one(e, `SELECT COUNT(*) n FROM revenue_snapshots WHERE mrr_cents = 1400`)).n, 0);
  const s = await job.currentRevenueSummary(e, { now: T0 + 2 * DAY });
  assert.equal(s.mixedCurrency, true); assert.equal(s.mrrCents, null); assert.ok(s.flags.includes('mixed_currency'));
  assert.deepEqual(s.perCurrency.map((c) => [c.currency, c.mrrCents]), [['EUR', 900], ['USD', 500]]);
  const ops = await staff.opsSummary(e); assert.equal(ops.monthlyRecurringCents, null, 'the dashboard number is unknown, not a silent sum'); assert.equal(ops.revenue.mixedCurrency, true);
});

test('one currency that is not the reporting currency is reported as is, with a mismatch flag; an unconverted figure is never relabelled', async () => {
  const e = makeEnv({ REVENUE_REPORTING_CURRENCY: 'USD' }); const org = await signup(e, 'eur@example.com'); await addPlan(e, 'plan_eur_y', { price: 900, currency: 'EUR' });
  const s = await addSub(e, org, { status: 'active', plan_id: 'plan_eur_y' }); await derive(e, s, unix(T0));
  const { result } = await capture(() => job.runDailyRevenueJob(e, { now: T0 + 2 * DAY })); assert.equal(result.mixedCurrency, false);
  const sum = await job.currentRevenueSummary(e, { now: T0 + 2 * DAY });
  assert.equal(sum.currency, 'EUR'); assert.equal(sum.mrrCents, 900); assert.ok(sum.flags.includes('reporting_currency_mismatch'));
  assert.equal(job.assessCurrencies([], 'USD').mixed, false);
});

test('a trial in a second currency does not make the report mixed until it pays', async () => {
  const e = makeEnv(); const org = await signup(e, 'trialcur@example.com'); await addPlan(e, 'plan_eur_z', { price: 900, currency: 'EUR' });
  const u = await addSub(e, org, { status: 'active' }); await derive(e, u, unix(T0)); await addSub(e, org, { status: 'trialing', plan_id: 'plan_eur_z' });
  const { result } = await capture(() => job.runDailyRevenueJob(e, { now: T0 + 2 * DAY })); assert.equal(result.mixedCurrency, false);
});

// ------------------------------------------------------------------ staff summary reads snapshots; the naive query is gone
test('staff opsSummary: MRR is unknown (never zero) before the first snapshot, then comes from revenue_snapshots, not from list prices', async () => {
  const e = makeEnv(); const org = await signup(e, 'ops@example.com');
  const s = await addSub(e, org, { status: 'active' }); await derive(e, s, unix(T0));
  const before = await staff.opsSummary(e); assert.equal(before.monthlyRecurringCents, null); assert.equal(before.revenue.available, false);
  await run(e, `UPDATE plans SET price_cents = 99999 WHERE id = ?`, STARTER);       // a list-price change must not move a recorded snapshot
  await job.runDailyRevenueJob(e, { now: T0 + 2 * DAY });
  const after = await staff.opsSummary(e); assert.equal(after.monthlyRecurringCents, 500); assert.equal(after.revenue.currency, 'USD'); assert.equal(after.revenue.available, true);
  const off = makeEnv({ REVENUE_METRICS: 'off' }); assert.equal((await staff.opsSummary(off)).monthlyRecurringCents, null);
  const src = readFileSync(new URL('../worker/staff-saas.js', import.meta.url), 'utf8');
  assert.ok(!/SUM\(p\.price_cents\)/.test(src), 'the naive SUM(price_cents) MRR is removed from staff-saas.js');
});

test('stale snapshots are flagged so a dead job cannot show an old number as current', async () => {
  const e = makeEnv(); const org = await signup(e, 'stale@example.com'); const s = await addSub(e, org, { status: 'active' }); await derive(e, s, unix(T0));
  await job.runDailyRevenueJob(e, { now: T0 + 2 * DAY });
  assert.equal((await job.currentRevenueSummary(e, { now: T0 + 2 * DAY })).stale, false);
  const late = await job.currentRevenueSummary(e, { now: T0 + 9 * DAY }); assert.equal(late.stale, true); assert.ok(late.flags.includes('stale'));
});

// ------------------------------------------------------------------ wiring and configuration
test('the daily cron runs the revenue job after the backfill; the 5-minute tick does not', async () => {
  const { default: worker } = await import('../worker/index.js');
  const e = makeEnv({ ENVIRONMENT: 'test' }); const org = await signup(e, 'cron@example.com'); const s = await addSub(e, org, { status: 'active', created_at: '2020-01-01 00:00:00', updated_at: '2020-01-01 00:00:00' });
  const tasks = []; const ctx = { waitUntil(p) { tasks.push(Promise.resolve(p)); } };
  const tick = []; await worker.scheduled({ cron: '*/5 * * * *' }, e, { waitUntil(p) { tick.push(Promise.resolve(p)); } }); await Promise.allSettled(tick);
  assert.equal((await one(e, `SELECT COUNT(*) n FROM revenue_snapshots`)).n, 0);
  const o = [console.log, console.error, console.warn]; console.log = console.error = console.warn = () => {};
  try { await worker.scheduled({ cron: '0 2 * * *' }, e, ctx); await Promise.allSettled(tasks); } finally { [console.log, console.error, console.warn] = o; }
  assert.ok((await one(e, `SELECT COUNT(*) n FROM revenue_snapshots`)).n > 0, 'the daily tick backfilled the ledger and then wrote snapshots');
  void s;
});

test('REVENUE_REPORTING_CURRENCY: three-letter code, default USD, invalid values fall back and are flagged by the config check', () => {
  assert.equal(revenueReportingCurrency({}), 'USD'); assert.equal(revenueReportingCurrency({ REVENUE_REPORTING_CURRENCY: ' eur ' }), 'EUR'); assert.equal(revenueReportingCurrency({ REVENUE_REPORTING_CURRENCY: 'dollars' }), 'USD');
  assert.ok(!configIssues({ ENVIRONMENT: 'production' }).some((i) => /REVENUE_REPORTING_CURRENCY/.test(JSON.stringify(i))));
  assert.ok(!configIssues({ ENVIRONMENT: 'production', REVENUE_REPORTING_CURRENCY: 'EUR' }).some((i) => /REVENUE_REPORTING_CURRENCY/.test(JSON.stringify(i))));
  assert.ok(configIssues({ ENVIRONMENT: 'production', REVENUE_REPORTING_CURRENCY: 'dollars' }).some((i) => /REVENUE_REPORTING_CURRENCY/.test(JSON.stringify(i))));
});

test('nothing in this round builds 6.1C or 7.2: no conversion, cohorts, funnel or CSV in the job module', () => {
  const src = readFileSync(new URL('../worker/revenue-job.js', import.meta.url), 'utf8');
  for (const word of [/\bfx_rate/i, /exchange[_ ]rate/i, /\bcohort/i, /\bfunnel/i, /text\/csv/i]) assert.ok(!word.test(src), String(word));
});
