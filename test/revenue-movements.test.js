// Round 6.1A (release 2.6.0.1): migration 0071_revenue, the revenue repository, movement derivation and the deterministic backfill.
// Acceptance: movements are idempotent on re-run and on duplicate or out-of-order webhooks; the backfill is deterministic;
// movements come from subscription state and provider-confirmed events only (never from a UI action).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestDb, applyMigrations, splitSqlStatements } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import { billingConfig, revenueMode } from '../worker/billing-config.js';
import * as revenue from '../worker/revenue.js';
import * as repo from '../worker/repositories/revenue.js';
import * as lifecycle from '../worker/billing-lifecycle.js';
import { configIssues } from '../worker/config-check.js';
import { setPlanPrice } from './support/plan-prices.js';
import * as customerAuth from '../worker/customer-auth.js';

const DAY = 86400000;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const unix = (ms) => Math.floor(ms / 1000);
const STARTER = 'plan_casino_news_starter';
const MIGRATION = readFileSync(new URL('../migrations/0071_revenue.sql', import.meta.url), 'utf8');

function makeEnv(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; }
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;
const run = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).run();
async function signup(env, email) {
  return (await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.9' } }, env)).organizationId;
}
async function addSub(env, orgId, f = {}) {
  const id = f.id || crypto.randomUUID();
  await run(env, `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id, created_at, updated_at, canceled_at, current_period_start) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, orgId, f.plan_id || STARTER, f.status || 'active', f.provider ?? null, f.provider_subscription_id ?? null, f.created_at || '2026-09-01 10:00:00', f.updated_at || '2026-09-01 10:00:00', f.canceled_at ?? null, f.current_period_start ?? null);
  return id;
}
const setSub = (env, id, set, ...b) => run(env, `UPDATE subscriptions SET ${set} WHERE id = ?`, ...b, id);
const movements = (env, id) => all(env, `SELECT seq, day, kind, mrr_delta_cents, mrr_after_cents, currency, plan_id, quantity, source FROM subscription_movements WHERE subscription_id = ? ORDER BY seq`, id);
const state = (env, id) => one(env, `SELECT * FROM subscription_revenue_state WHERE subscription_id = ?`, id);
async function invariant(env, id) {
  const sum = (await one(env, `SELECT COALESCE(SUM(mrr_delta_cents),0) n FROM subscription_movements WHERE subscription_id = ?`, id)).n;
  const st = await state(env, id);
  assert.equal(sum, st ? st.mrr_cents : 0, 'the sum of movement deltas always equals the recorded MRR of the subscription');
}
async function wired(extra = {}) {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce', ...extra });
  const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  const org = await signup(env, `rev-${Math.random()}@example.com`);
  const hook = (type, object, { id = 'evt_' + Math.random(), created = unix(T0) } = {}) => simulateWebhook(billing, provider, env, { id, type, created, data: { object } });
  return { env, provider, billing, org, hook };
}

// ------------------------------------------------------------------ migration 0071
test('0071 creates the three revenue tables empty, with the blueprint columns and idempotency keys', async () => {
  const e = makeEnv();
  for (const t of ['revenue_snapshots', 'subscription_movements', 'subscription_revenue_state']) assert.equal((await one(e, `SELECT COUNT(*) n FROM ${t}`)).n, 0);
  const cols = async (t) => (await all(e, `PRAGMA table_info(${t})`)).map((c) => c.name);
  for (const c of ['day', 'currency', 'mrr_cents', 'arr_cents', 'active', 'trialing', 'past_due', 'new_mrr', 'expansion_mrr', 'contraction_mrr', 'churned_mrr']) assert.ok((await cols('revenue_snapshots')).includes(c), c);
  for (const c of ['id', 'subscription_id', 'day', 'kind', 'mrr_delta_cents', 'seq', 'currency', 'source']) assert.ok((await cols('subscription_movements')).includes(c), c);
  // a daily job can only ever write one row per (day, currency)
  await run(e, `INSERT INTO revenue_snapshots (day, currency) VALUES ('2026-11-01','USD')`);
  await assert.rejects(() => run(e, `INSERT INTO revenue_snapshots (day, currency) VALUES ('2026-11-01','USD')`), /UNIQUE/);
  await run(e, `INSERT INTO revenue_snapshots (day, currency) VALUES ('2026-11-01','EUR')`);
});

test('0071 is safe to run twice and rejects malformed movements', async () => {
  const e = makeEnv();
  for (const s of splitSqlStatements(MIGRATION)) await e.LUMMET_DB.prepare(s).run();
  const org = await signup(e, 'm@example.com'); const sid = await addSub(e, org);
  const ins = (over = {}) => { const v = { id: 'x1', seq: 1, day: '2026-11-01', kind: 'new', delta: 500, ...over }; return run(e, `INSERT INTO subscription_movements (id, subscription_id, organization_id, seq, day, kind, mrr_delta_cents, currency, mrr_after_cents, source) VALUES (?,?,?,?,?,?,?,'USD',500,'webhook')`, v.id, sid, org, v.seq, v.day, v.kind, v.delta); };
  await ins();
  await assert.rejects(() => ins({ id: 'x2' }), /UNIQUE/, 'the same (subscription, seq) can never be written twice');
  await assert.rejects(() => ins({ id: 'x3', seq: 2, kind: 'upsell' }), /CHECK/);
  await assert.rejects(() => ins({ id: 'x4', seq: 3, delta: 0 }), /CHECK/);
  await assert.rejects(() => ins({ id: 'x5', seq: 4, day: '11/01/2026' }), /CHECK/);
});

test('migration numbering stays consecutive and 0071 directly follows 0070', () => {
  // Round 6.4A (2.6.0.9) changed this from "0071 is the newest": 0072_org_security_policy now follows it. The consecutive chain is unchanged.
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
  const i = files.indexOf('0071_revenue.sql');
  assert.ok(i > 0); assert.equal(files[i - 1], '0070_phase5_completion.sql'); assert.equal(files[i + 1], '0072_org_security_policy.sql');
});

// ------------------------------------------------------------------ pure MRR contribution and the flag
test('mrrCents: active and past_due only; annual divided by 12; custom and unpriced count nothing', () => {
  const m = (o) => revenue.mrrCents({ status: 'active', priceCents: 500, billingPeriod: 'monthly', quantity: 1, ...o });
  assert.equal(m({}), 500); assert.equal(m({ status: 'past_due' }), 500); assert.equal(m({ quantity: 3 }), 1500);
  for (const status of ['trialing', 'restricted', 'suspended', 'canceled', 'expired', 'paused', 'incomplete']) assert.equal(m({ status }), 0, status);
  assert.equal(m({ billingPeriod: 'annual', priceCents: 5000 }), 417); assert.equal(m({ billingPeriod: 'annual', priceCents: 4800 }), 400);
  assert.equal(m({ billingPeriod: 'custom' }), 0); assert.equal(m({ priceCents: null }), 0); assert.equal(m({ priceCents: 0 }), 0);
  assert.equal(m({ quantity: 0 }), 500, 'an invalid quantity is treated as one');
});

test('REVENUE_METRICS defaults to shadow, accepts off|shadow|on, and an invalid value falls back to shadow', () => {
  assert.equal(revenueMode({}), 'shadow'); assert.equal(revenueMode({ REVENUE_METRICS: ' OFF ' }), 'off'); assert.equal(revenueMode({ REVENUE_METRICS: 'on' }), 'on');
  assert.equal(revenueMode({ REVENUE_METRICS: 'banana' }), 'shadow');
  assert.ok(!configIssues({ ENVIRONMENT: 'production', REVENUE_METRICS: 'shadow' }).some((i) => /REVENUE_METRICS/.test(JSON.stringify(i))));
  assert.ok(configIssues({ ENVIRONMENT: 'production', REVENUE_METRICS: 'banana' }).some((i) => /REVENUE_METRICS/.test(JSON.stringify(i))), 'config check flags an invalid value');
  assert.ok(!configIssues({ ENVIRONMENT: 'production' }).some((i) => /REVENUE_METRICS/.test(JSON.stringify(i))), 'unset is valid: the default is shadow');
});

// ------------------------------------------------------------------ derivation: kinds, idempotency, ordering
test('derivation: trial -> active is new; plan up is expansion; plan down is contraction; cancel is churn; every step keeps the invariant', async () => {
  const e = makeEnv(); const org = await signup(e, 'd@example.com');
  const id = await addSub(e, org, { status: 'trialing', provider: 'fake', provider_subscription_id: 'sub_d' });
  const d = (over = {}) => revenue.deriveSubscriptionMovement(e, { subscriptionId: id, source: 'webhook', ...over });
  assert.equal((await d({ eventCreated: unix(T0) })).status, 'unchanged', 'a trial carries no MRR');
  await setSub(e, id, `status = 'active'`);
  assert.equal((await d({ eventCreated: unix(T0 + DAY) })).status, 'applied');
  const plans = await all(e, `SELECT id, price_cents FROM plans WHERE billing_period = 'monthly' AND price_cents > 500 ORDER BY price_cents LIMIT 1`);
  await setSub(e, id, `plan_id = ?`, plans[0].id); await d({ eventCreated: unix(T0 + 2 * DAY) });
  await setSub(e, id, `plan_id = ?`, STARTER); await d({ eventCreated: unix(T0 + 3 * DAY) });
  await setSub(e, id, `status = 'canceled'`); await d({ eventCreated: unix(T0 + 4 * DAY) });
  const rows = await movements(e, id);
  assert.deepEqual(rows.map((r) => [r.seq, r.kind, r.mrr_delta_cents]), [[1, 'new', 500], [2, 'expansion', plans[0].price_cents - 500], [3, 'contraction', 500 - plans[0].price_cents], [4, 'churn', -500]]);
  assert.deepEqual(rows.map((r) => r.day), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
  assert.ok(rows.every((r) => r.currency === 'USD' && r.source === 'webhook'));
  await invariant(e, id); assert.equal((await state(e, id)).mrr_cents, 0);
});

test('derivation is idempotent: the same state seen again, or re-run any number of times, writes nothing', async () => {
  const e = makeEnv(); const org = await signup(e, 'i@example.com'); const id = await addSub(e, org, { status: 'active' });
  const d = (ev) => revenue.deriveSubscriptionMovement(e, { subscriptionId: id, source: 'webhook', eventCreated: ev });
  await d(unix(T0));
  const before = await movements(e, id);
  for (const ev of [unix(T0), unix(T0), unix(T0 + 1), unix(T0 + DAY)]) assert.equal((await d(ev)).status, 'unchanged');
  assert.deepEqual(await movements(e, id), before);
  await invariant(e, id);
});

test('out of order: an older event arriving after a newer one is ignored and never rewrites the ledger', async () => {
  const e = makeEnv(); const org = await signup(e, 'o@example.com'); const id = await addSub(e, org, { status: 'active', provider: 'fake', provider_subscription_id: 'sub_o' });
  const d = (ev, extra = {}) => revenue.deriveSubscriptionMovement(e, { subscriptionId: id, source: 'webhook', eventCreated: ev, ...extra });
  await d(unix(T0 + 1000));
  await d(unix(T0 + 3000), { quantity: 1 });                       // newest event, nothing changed: the watermark still advances
  const late = await d(unix(T0 + 2000), { quantity: 4 });          // an older event about 4 seats shows up late
  assert.equal(late.status, 'stale');
  assert.deepEqual((await movements(e, id)).map((r) => [r.kind, r.mrr_delta_cents]), [['new', 500]]);
  assert.equal((await state(e, id)).quantity, 1);
  await d(unix(T0 + 4000), { quantity: 4 });                       // the genuinely newer event is applied
  assert.deepEqual((await movements(e, id)).map((r) => [r.kind, r.mrr_delta_cents]), [['new', 500], ['expansion', 1500]]);
  await invariant(e, id);
});

test('concurrent writers: a second writer that read the same ledger position cannot double-count', async () => {
  const e = makeEnv(); const org = await signup(e, 'c@example.com'); const id = await addSub(e, org, { status: 'active' });
  const mv = (seq) => ({ seq, day: '2026-11-01', kind: 'new', deltaCents: 500, currency: 'USD', mrrAfterCents: 500, planId: STARTER, quantity: 1, source: 'webhook', eventCreated: 1 });
  const commit = () => repo.commitObservation(e, { subscriptionId: id, organizationId: org, expectedSeq: 0, movements: [mv(1)], next: { mrrCents: 500, currency: 'USD', planId: STARTER, quantity: 1 }, eventCreated: 1 });
  assert.deepEqual(await commit(), { applied: true });
  assert.deepEqual(await commit(), { applied: false, conflict: true });
  assert.equal((await movements(e, id)).length, 1); await invariant(e, id);
});

test('quantity changes confirmed by the provider move MRR; the plan item is found among add-on items', async () => {
  const { env, org, hook } = await wired();
  await setPlanPrice(env, STARTER, 'price_starter');
  await hook('customer.subscription.created', { id: 'sub_q', status: 'active', customer: 'cus_q', metadata: { organization_id: org, plan_id: STARTER }, current_period_start: unix(T0), current_period_end: unix(T0 + 30 * DAY), items: { data: [{ price: { id: 'price_starter' }, quantity: 1 }] } }, { created: unix(T0) });
  const sid = (await one(env, `SELECT id FROM subscriptions WHERE provider_subscription_id = 'sub_q'`)).id;
  await hook('customer.subscription.updated', { id: 'sub_q', status: 'active', current_period_end: unix(T0 + 30 * DAY), items: { data: [{ price: { id: 'price_addon_x' }, quantity: 9 }, { price: { id: 'price_starter' }, quantity: 3 }] } }, { created: unix(T0 + DAY) });
  assert.deepEqual((await movements(env, sid)).map((r) => [r.kind, r.mrr_delta_cents, r.quantity]), [['new', 500, 1], ['expansion', 1000, 3]]);
  await invariant(env, sid);
});

// ------------------------------------------------------------------ webhook and lifecycle wiring
test('webhooks: created -> new, payment failed keeps MRR, restricted -> churn, paid again -> new, deleted -> churn; duplicates add nothing', async () => {
  const { env, org, hook } = await wired();
  await setPlanPrice(env, STARTER, 'price_starter');
  const subObj = (status, extra = {}) => ({ id: 'sub_w', status, customer: 'cus_w', metadata: { organization_id: org, plan_id: STARTER }, current_period_start: unix(T0), current_period_end: unix(T0 + 30 * DAY), items: { data: [{ price: { id: 'price_starter' }, quantity: 1 }] }, ...extra });
  await hook('customer.subscription.created', subObj('active'), { id: 'evt_a', created: unix(T0) });
  const sid = (await one(env, `SELECT id FROM subscriptions WHERE provider_subscription_id = 'sub_w'`)).id;
  await hook('customer.subscription.created', subObj('active'), { id: 'evt_a', created: unix(T0) });                         // exact duplicate delivery
  await hook('customer.subscription.updated', subObj('active'), { id: 'evt_b', created: unix(T0 + DAY) });                  // same state, new event
  await hook('invoice.payment_failed', { id: 'in_1', subscription: 'sub_w', metadata: { organization_id: org }, amount_due: 500 }, { id: 'evt_c', created: unix(T0 + 2 * DAY) });
  assert.equal((await one(env, `SELECT status FROM subscriptions WHERE id = ?`, sid)).status, 'past_due');
  assert.equal((await movements(env, sid)).length, 1, 'past_due still counts: no movement');
  await hook('customer.subscription.updated', subObj('restricted'), { id: 'evt_d', created: unix(T0 + 3 * DAY) });
  await hook('invoice.paid', { id: 'in_2', subscription: 'sub_w', metadata: { organization_id: org }, amount_paid: 500, amount_due: 500 }, { id: 'evt_e', created: unix(T0 + 4 * DAY) });
  await hook('customer.subscription.deleted', subObj('canceled'), { id: 'evt_f', created: unix(T0 + 5 * DAY) });
  await hook('customer.subscription.deleted', subObj('canceled'), { id: 'evt_f', created: unix(T0 + 5 * DAY) });               // duplicate
  assert.deepEqual((await movements(env, sid)).map((r) => [r.kind, r.mrr_delta_cents]), [['new', 500], ['churn', -500], ['new', 500], ['churn', -500]]);
  await invariant(env, sid);
});

test('a movement failure never fails the billing webhook in shadow mode, and the next event repairs the ledger', async () => {
  const { env, org, hook } = await wired();
  await setPlanPrice(env, STARTER, 'price_starter');
  const obj = { id: 'sub_f', status: 'active', customer: 'cus_f', metadata: { organization_id: org, plan_id: STARTER }, current_period_start: unix(T0), current_period_end: unix(T0 + 30 * DAY), items: { data: [{ price: { id: 'price_starter' }, quantity: 1 }] } };
  await run(env, `ALTER TABLE subscription_movements RENAME TO subscription_movements_off`);
  const logged = []; const orig = console.error; console.error = (m) => logged.push(String(m));
  let r; try { r = await hook('customer.subscription.created', obj, { id: 'evt_x', created: unix(T0) }); } finally { console.error = orig; }
  assert.equal(r.ok, true, 'billing still succeeds'); assert.ok(logged.some((l) => l.includes('revenue_movement_failed')), 'the failure is logged, not swallowed');
  await run(env, `ALTER TABLE subscription_movements_off RENAME TO subscription_movements`);
  await hook('customer.subscription.updated', obj, { id: 'evt_y', created: unix(T0 + DAY) });
  const sid = (await one(env, `SELECT id FROM subscriptions WHERE provider_subscription_id = 'sub_f'`)).id;
  assert.deepEqual((await movements(env, sid)).map((r) => [r.kind, r.mrr_delta_cents]), [['new', 500]]); await invariant(env, sid);
});

test('REVENUE_METRICS=off records nothing; shadow and on record', async () => {
  for (const [mode, expected] of [['off', 0], ['shadow', 1], ['on', 1]]) {
    const { env, org, hook } = await wired({ REVENUE_METRICS: mode }); await setPlanPrice(env, STARTER, 'price_starter');
    await hook('customer.subscription.created', { id: 'sub_m', status: 'active', customer: 'cus_m', metadata: { organization_id: org, plan_id: STARTER }, current_period_start: unix(T0), current_period_end: unix(T0 + 30 * DAY), items: { data: [{ price: { id: 'price_starter' }, quantity: 1 }] } });
    assert.equal((await one(env, `SELECT COUNT(*) n FROM subscription_movements`)).n, expected, mode);
  }
});

test('lifecycle sweep: past_due -> restricted derives a churn; the UI paths (plan change, cancel request) derive nothing themselves', async () => {
  const e = makeEnv({ BILLING_ENFORCE: 'enforce' }); const org = await signup(e, 'l@example.com');
  const id = await addSub(e, org, { status: 'past_due', created_at: '2026-09-01 00:00:00' });
  await run(e, `UPDATE subscriptions SET grace_ends_at = ? WHERE id = ?`, new Date(T0 - DAY).toISOString(), id);
  await revenue.deriveSubscriptionMovement(e, { subscriptionId: id, source: 'lifecycle', now: T0 - 20 * DAY });
  assert.equal((await state(e, id)).mrr_cents, 500);
  const s = await lifecycle.sweep(e, T0 + DAY, { cfg: billingConfig({ BILLING_ENFORCE: 'enforce' }) });
  assert.equal(s.restricted, 1);
  assert.deepEqual((await movements(e, id)).map((r) => [r.kind, r.source]), [['new', 'backfill'], ['churn', 'lifecycle']]);
  await invariant(e, id);
  const src = readFileSync(new URL('../worker/billing.js', import.meta.url), 'utf8');
  const fnBody = (name) => src.slice(src.indexOf(`async function ${name}(`), src.indexOf('\n  async function ', src.indexOf(`async function ${name}(`) + 10));
  for (const fn of ['changePlan', 'cancelSubscription', 'resumeSubscription']) assert.ok(!/revenue|deriveSubscriptionMovement/.test(fnBody(fn)), `${fn} is a customer action and must not write movements`);
});

// ------------------------------------------------------------------ backfill
async function seedBackfillWorld(e) {
  const mk = async (n, f) => addSub(e, await signup(e, `bf${n}@example.com`), { id: `sub_${String(n).padStart(2, '0')}`, ...f });
  const annual = (await one(e, `SELECT id FROM plans WHERE billing_period = 'annual' AND price_cents = 5000`))?.id;
  await mk(1, { status: 'active', created_at: '2026-08-10 09:00:00' });
  await mk(2, { status: 'trialing', created_at: '2026-10-01 09:00:00' });
  await mk(3, { status: 'canceled', created_at: '2026-07-01 09:00:00', canceled_at: '2026-10-15 08:00:00' });
  await mk(4, { status: 'past_due', created_at: '2026-06-01 09:00:00' });
  if (annual) await mk(5, { status: 'active', plan_id: annual, created_at: '2026-05-05 09:00:00' });
  await mk(6, { status: 'suspended', created_at: '2026-04-01 09:00:00' });
  const ev = (sub, to, at) => run(e, `INSERT INTO subscription_status_events (subscription_id, from_status, to_status, created_at) VALUES (?,?,?,?)`, sub, null, to, at);
  await ev('sub_03', 'trialing', '2026-07-01 09:00:00'); await ev('sub_03', 'active', '2026-07-08 09:00:00'); await ev('sub_03', 'canceled', '2026-10-15 08:00:00');
  await ev('sub_06', 'active', '2026-04-08 09:00:00'); await ev('sub_06', 'past_due', '2026-09-01 09:00:00'); await ev('sub_06', 'restricted', '2026-09-15 09:00:00'); await ev('sub_06', 'suspended', '2026-09-22 09:00:00');
}
const dump = (e) => all(e, `SELECT subscription_id, seq, id, day, kind, mrr_delta_cents, mrr_after_cents, currency, plan_id, quantity, source FROM subscription_movements ORDER BY subscription_id, seq`);

test('backfill derives history from existing subscriptions and status events, and the state ends at the live MRR', async () => {
  const e = makeEnv(); await seedBackfillWorld(e);
  const r = await revenue.backfillRevenueMovements(e, { limit: 100 });
  assert.equal(r.processed, (await one(e, `SELECT COUNT(*) n FROM subscriptions`)).n); assert.equal(r.nextCursor, null);
  const by = async (id) => (await movements(e, id)).map((m) => [m.day, m.kind, m.mrr_delta_cents, m.source]);
  assert.deepEqual(await by('sub_01'), [['2026-08-10', 'new', 500, 'backfill']]);
  assert.deepEqual(await by('sub_02'), []);
  assert.deepEqual(await by('sub_03'), [['2026-07-08', 'new', 500, 'backfill'], ['2026-10-15', 'churn', -500, 'backfill']]);
  assert.deepEqual(await by('sub_04'), [['2026-06-01', 'new', 500, 'backfill']]);
  assert.deepEqual(await by('sub_06'), [['2026-04-08', 'new', 500, 'backfill'], ['2026-09-15', 'churn', -500, 'backfill']], 'past_due still counted; the churn is the day it left past_due for restricted');
  for (const id of ['sub_01', 'sub_02', 'sub_03', 'sub_04', 'sub_06']) await invariant(e, id);
  assert.equal((await state(e, 'sub_02')).mrr_cents, 0, 'a trial gets a zero state row so later events have a watermark');
  assert.ok((await dump(e)).every((m) => m.id === `${m.subscription_id}:${m.seq}`));
});

test('backfill is deterministic: two databases, two runs, identical rows; a second run changes nothing; batches resume by cursor', async () => {
  const a = makeEnv(); const b = makeEnv(); await seedBackfillWorld(a); await seedBackfillWorld(b);
  await revenue.backfillRevenueMovements(a, { limit: 100 });
  let cursor = null, guard = 0; do { const r = await revenue.backfillRevenueMovements(b, { limit: 2, afterId: cursor || '' }); cursor = r.nextCursor; guard++; } while (cursor && guard < 10);
  assert.ok(guard > 1, 'the small batches really were batches');
  assert.deepEqual(await dump(a), await dump(b));
  const again = await revenue.backfillRevenueMovements(a, { limit: 100 });
  assert.equal(again.created, 0); assert.deepEqual(await dump(a), await dump(b));
  assert.deepEqual(await all(a, `SELECT subscription_id, seq, mrr_cents FROM subscription_revenue_state ORDER BY subscription_id`), await all(b, `SELECT subscription_id, seq, mrr_cents FROM subscription_revenue_state ORDER BY subscription_id`));
});

test('backfill never overwrites or duplicates what webhooks already recorded, and is inert when REVENUE_METRICS=off', async () => {
  const e = makeEnv(); const org = await signup(e, 'live@example.com'); const id = await addSub(e, org, { status: 'active', created_at: '2026-08-01 00:00:00' });
  await revenue.deriveSubscriptionMovement(e, { subscriptionId: id, source: 'webhook', eventCreated: unix(T0) });
  const before = await dump(e); await revenue.backfillRevenueMovements(e, { limit: 100 }); assert.deepEqual(await dump(e), before);
  const off = makeEnv({ REVENUE_METRICS: 'off' }); await seedBackfillWorld(off);
  assert.equal((await revenue.runBackfillTick(off)).skipped, 'off'); assert.equal((await one(off, `SELECT COUNT(*) n FROM subscription_movements`)).n, 0);
  const on = makeEnv(); await seedBackfillWorld(on); const t = await revenue.runBackfillTick(on); assert.ok(t.created > 0);
});

test('a subscription first seen by a webhook after rollout is baselined from its history, not booked as new on the event day', async () => {
  const e = makeEnv(); const org = await signup(e, 'old@example.com'); const id = await addSub(e, org, { status: 'active', created_at: '2026-03-01 00:00:00' });
  await revenue.deriveSubscriptionMovement(e, { subscriptionId: id, source: 'webhook', eventCreated: unix(T0) });
  assert.deepEqual((await movements(e, id)).map((m) => [m.day, m.kind, m.source]), [['2026-03-01', 'new', 'backfill']]);
});

// ------------------------------------------------------------------ boundaries
test('SQL boundary: the revenue modules hold no SQL; the repository owns it and never uses numbered placeholders', () => {
  const biz = readFileSync(new URL('../worker/revenue.js', import.meta.url), 'utf8');
  const repoSrc = readFileSync(new URL('../worker/repositories/revenue.js', import.meta.url), 'utf8');
  assert.ok(!biz.includes('.prepare('), 'worker/revenue.js must not contain SQL'); assert.ok(repoSrc.includes('.prepare('));
  assert.ok(!/\?\d+(?![\w])/.test(repoSrc.replace(/\/\/.*$/gm, '')));
});

test('version pinning: package.json is 2.6.0 and the Phase F gate pins 2.6.0 (RELEASE_ID is checked by the release documents, not here)', () => {
  assert.equal(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version, '2.6.0');
  const gate = readFileSync(new URL('../scripts/phase-f-gate.mjs', import.meta.url), 'utf8');
  assert.ok(gate.includes("version === '2.6.0'") && !gate.includes("'2.5.2'"));
});

test('retention: revenue movements and state are retained with the subscription and swept with it after the financial retention period', async () => {
  const policy = await import('../worker/retention-policy.js');
  for (const t of ['subscription_movements', 'subscription_revenue_state']) { assert.ok(policy.FINANCIAL_RETAINED.includes(t), t); assert.ok(policy.SUBSCRIPTION_SCOPED.includes(t), t); }
});
