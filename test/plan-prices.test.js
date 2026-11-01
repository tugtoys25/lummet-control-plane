// Phase 3, sprint 3.1: migration 0052, checkout and plan changes reading plan_prices, webhook mapping, the read-only
// staff screen and the immutability rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestDb, applyMigrations, splitSqlStatements } from './support/d1-shim.js';
import { createFakeBillingProvider } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import { setPlanPrice } from './support/plan-prices.js';
import * as planPrices from '../worker/plan-prices.js';
import * as plansService from '../worker/plans.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as subscriptionRepo from '../worker/repositories/billing-subscriptions.js';
import worker from '../worker/index.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra }; }
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;
const run = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).run();
const STARTER = 'plan_casino_news_starter';
const MIGRATION = readFileSync(new URL('../migrations/0052_plan_prices.sql', import.meta.url), 'utf8');
async function rerunMigration(e) { for (const s of splitSqlStatements(MIGRATION)) await e.LUMMET_DB.prepare(s).run(); }

function signupRequest(email, org) { return { async json() { return { email, password: 'correct-horse-battery', organizationName: org }; }, headers: { get: () => '203.0.113.9' } }; }
async function org(e, email = 'o@example.com') { return (await customerAuth.signUp(signupRequest(email, 'Org ' + email), e)).organizationId; }
const urls = { successUrl: 'https://x.test/ok', cancelUrl: 'https://x.test/no' };

// ------------------------------------------------------------------ migration 0052
test('0052 creates plan_prices empty on a fresh database (nothing is invented)', async () => {
  const e = env();
  assert.equal((await one(e, `SELECT COUNT(*) n FROM plan_prices`)).n, 0);
  const cols = (await all(e, `PRAGMA table_info(plan_prices)`)).map((c) => c.name);
  for (const c of ['id', 'plan_id', 'currency', 'interval', 'unit_amount_cents', 'tax_behavior', 'stripe_price_id', 'lookup_key', 'stripe_mode', 'version', 'active', 'created_at']) assert.ok(cols.includes(c), c);
});

test('0052 backfills one row per existing plans.stripe_price_id, mode unknown, and is safe to run twice', async () => {
  const e = env();
  await run(e, `UPDATE plans SET stripe_price_id = 'price_s' WHERE id = ?`, STARTER);
  await run(e, `UPDATE plans SET stripe_price_id = 'price_a' WHERE id = 'plan_casino_news_starter_annual'`);
  await run(e, `UPDATE plans SET stripe_price_id = '  price_trim  ' WHERE id = 'plan_casino_news_growth'`);
  await rerunMigration(e); await rerunMigration(e);
  const rows = await all(e, `SELECT * FROM plan_prices ORDER BY plan_id`);
  assert.equal(rows.length, 3);
  const s = rows.find((r) => r.plan_id === STARTER);
  assert.deepEqual({ currency: s.currency, interval: s.interval, amount: s.unit_amount_cents, id: s.stripe_price_id, key: s.lookup_key, mode: s.stripe_mode, v: s.version, active: s.active, tax: s.tax_behavior },
    { currency: 'usd', interval: 'month', amount: 500, id: 'price_s', key: 'casino_news_starter_month_usd_v1', mode: 'unknown', v: 1, active: 1, tax: 'unspecified' });
  const a = rows.find((r) => r.plan_id === 'plan_casino_news_starter_annual');
  assert.equal(a.interval, 'year'); assert.equal(a.lookup_key, 'casino_news_starter_annual_year_usd_v1'); assert.equal(a.unit_amount_cents, 5000);
  assert.equal(rows.find((r) => r.plan_id === 'plan_casino_news_growth').stripe_price_id, 'price_trim');
});

test('0052 carries a shared legacy price id over once, skips custom and unpriced plans, and never fails', async () => {
  const e = env();
  await run(e, `UPDATE plans SET stripe_price_id = 'price_shared' WHERE id IN ('plan_casino_news_starter', 'plan_casino_news_growth')`);
  await run(e, `UPDATE plans SET stripe_price_id = 'price_master' WHERE key = 'master'`);
  await run(e, `UPDATE plans SET stripe_price_id = '' WHERE id = 'plan_casino_news_pro'`);
  await rerunMigration(e);
  const rows = await all(e, `SELECT plan_id, stripe_price_id FROM plan_prices`);
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ plan_id: 'plan_casino_news_growth', stripe_price_id: 'price_shared' }], 'lowest plan id wins; custom and empty are skipped');
});

test('at most one active price per plan, currency and interval; any number of retired versions', async () => {
  const e = env();
  await setPlanPrice(e, STARTER, 'price_v1');
  await setPlanPrice(e, STARTER, 'price_v2');
  assert.deepEqual((await all(e, `SELECT version, active FROM plan_prices ORDER BY version`)).map((r) => ({ ...r })), [{ version: 1, active: 0 }, { version: 2, active: 1 }]);
  await assert.rejects(() => run(e, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key, version, active) VALUES ('x', ?, 'usd', 'month', 500, 'price_dup', 'k_dup', 9, 1)`, STARTER), /UNIQUE|constraint/i);
  await run(e, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key, version, active) VALUES ('y', ?, 'usd', 'month', 500, 'price_old', 'k_old', 8, 0)`, STARTER);
  await run(e, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key, version, active) VALUES ('z', ?, 'eur', 'month', 450, 'price_eur', 'k_eur', 1, 1)`, STARTER);
  await assert.rejects(() => run(e, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key) VALUES ('q', ?, 'usd', 'week', 1, 'p', 'l')`, STARTER), /CHECK|constraint/i);
  await assert.rejects(() => run(e, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key, stripe_mode) VALUES ('q2', ?, 'usd', 'month', 1, 'p2', 'l2', 'staging')`, STARTER), /CHECK|constraint/i);
  await assert.rejects(() => run(e, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key) VALUES ('q3', ?, 'usd', 'month', 1, 'price_v2', 'l3')`, STARTER), /UNIQUE/i, 'a Stripe price id belongs to one row');
});

// ------------------------------------------------------------------ checkout
test('checkout refuses a plan with no price row, and does not read the old free-text field', async () => {
  const e = env(); const o = await org(e); const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  await run(e, `UPDATE plans SET stripe_price_id = 'price_legacy_only' WHERE id = ?`, STARTER);
  const r = await billing.startCheckout(e, { organizationId: o, planId: STARTER, ...urls });
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.equal(r.error, 'plan_not_billing_configured');
  assert.equal(provider._calls.filter((c) => c.method === 'createCheckoutSession').length, 0);
});

test('checkout sends the active plan_prices row to the provider', async () => {
  const e = env(); const o = await org(e); const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  await setPlanPrice(e, STARTER, 'price_good');
  const r = await billing.startCheckout(e, { organizationId: o, planId: STARTER, ...urls });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(provider._calls.find((c) => c.method === 'createCheckoutSession').priceId, 'price_good');
});

test('a new price version goes to new customers; the old version still maps to its plan for existing subscribers', async () => {
  const e = env(); const o = await org(e); const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  await setPlanPrice(e, STARTER, 'price_v1'); await setPlanPrice(e, STARTER, 'price_v2');
  await billing.startCheckout(e, { organizationId: o, planId: STARTER, ...urls });
  assert.equal(provider._calls.find((c) => c.method === 'createCheckoutSession').priceId, 'price_v2');
  assert.equal(await subscriptionRepo.planIdForPrice(e, 'price_v1'), STARTER, 'retired version still resolves');
  assert.equal(await subscriptionRepo.planIdForPrice(e, 'price_v2'), STARTER);
  assert.equal(await planPrices.planIdForPrice(e, 'price_unknown'), null);
  assert.equal(await subscriptionRepo.planIdForPrice(e, null), null);
});

test('an annual plan is sold at its yearly price, a monthly plan at its monthly one', async () => {
  const e = env();
  await setPlanPrice(e, STARTER, 'price_m'); await setPlanPrice(e, 'plan_casino_news_starter_annual', 'price_y');
  assert.equal((await planPrices.resolveCheckoutPrice(e, await plansService.getPlan(e, STARTER))).price.stripe_price_id, 'price_m');
  assert.equal((await planPrices.resolveCheckoutPrice(e, await plansService.getPlan(e, 'plan_casino_news_starter_annual'))).price.interval, 'year');
  // a monthly price cannot be used for the annual plan
  const e2 = env();
  await run(e2, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key) VALUES ('w', 'plan_casino_news_starter_annual', 'usd', 'month', 5000, 'price_wrong', 'k_wrong')`);
  assert.equal((await planPrices.resolveCheckoutPrice(e2, await plansService.getPlan(e2, 'plan_casino_news_starter_annual'))).error, 'plan_not_billing_configured');
});

test('a price from the other Stripe mode is refused; unknown mode and matching mode are accepted', async () => {
  const live = env({ STRIPE_SECRET_KEY: 'sk_live_dummy' }); const test_ = env({ STRIPE_SECRET_KEY: 'rk_test_dummy' }); const none = env();
  assert.equal(planPrices.stripeModeFromEnv(live), 'live'); assert.equal(planPrices.stripeModeFromEnv(test_), 'test'); assert.equal(planPrices.stripeModeFromEnv(none), null);
  assert.equal(planPrices.stripeModeFromEnv({ STRIPE_SECRET_KEY: 'garbage' }), null);
  for (const e of [live, test_, none]) await setPlanPrice(e, STARTER, 'price_t', { mode: 'test' });
  const plan = await plansService.getPlan(live, STARTER);
  const r = await planPrices.resolveCheckoutPrice(live, plan);
  assert.equal(r.ok, false); assert.equal(r.status, 409); assert.equal(r.error, 'price_mode_mismatch');
  assert.equal((await planPrices.resolveCheckoutPrice(test_, plan)).ok, true);
  assert.equal((await planPrices.resolveCheckoutPrice(none, plan)).ok, true, 'no key configured: nothing to compare with');
  await run(live, `UPDATE plan_prices SET stripe_mode = 'unknown'`);
  assert.equal((await planPrices.resolveCheckoutPrice(live, plan)).ok, true);
  await run(live, `UPDATE plan_prices SET stripe_mode = 'live'`);
  assert.equal((await planPrices.resolveCheckoutPrice(live, plan)).ok, true);
});

test('checkout surfaces the mode mismatch and creates no session', async () => {
  const e = env({ STRIPE_SECRET_KEY: 'sk_live_dummy' }); const o = await org(e); const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  await setPlanPrice(e, STARTER, 'price_t', { mode: 'test' });
  const r = await billing.startCheckout(e, { organizationId: o, planId: STARTER, ...urls });
  assert.deepEqual({ ok: r.ok, status: r.status, error: r.error }, { ok: false, status: 409, error: 'price_mode_mismatch' });
  assert.equal(provider._calls.filter((c) => c.method === 'createCheckoutSession').length, 0);
});

test('plan change uses the target plan\'s active price and refuses one with none', async () => {
  const e = env(); const o = await org(e); const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  await run(e, `INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id) VALUES ('s1', ?, ?, 'active', 'fake', 'sub_1')`, o, STARTER);
  const refused = await billing.changePlan(e, o, 'plan_casino_news_growth');
  assert.equal(refused.error, 'plan_not_billing_configured');
  await setPlanPrice(e, 'plan_casino_news_growth', 'price_g1'); await setPlanPrice(e, 'plan_casino_news_growth', 'price_g2');
  assert.equal((await billing.changePlan(e, o, 'plan_casino_news_growth')).ok, true);
  assert.equal(provider._calls.find((c) => c.method === 'changePlan').newPriceId, 'price_g2');
});

test('the customer plan list says which plans can be bought online', async () => {
  const e = env();
  await setPlanPrice(e, 'plan_casino_news_growth', 'price_g');
  const list = await plansService.listPlans(e, 'prod_casino_news');
  assert.equal(list.find((p) => p.id === 'plan_casino_news_growth').active_price_id, 'price_g');
  assert.equal(list.find((p) => p.id === STARTER).active_price_id, null);
  await run(e, `UPDATE plan_prices SET active = 0`);
  assert.equal((await plansService.listPlans(e, 'prod_casino_news')).find((p) => p.id === 'plan_casino_news_growth').active_price_id, null);
});

// ------------------------------------------------------------------ staff screen and API
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(e) {
  assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).status, 200);
  return (await call(e, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;
}

test('the staff plans page shows prices read-only: no edit buttons, the active price, its version and mode, and a mismatch flag', async () => {
  const e = env(); const staff = await staffLogin(e);
  await setPlanPrice(e, STARTER, 'price_shown', { mode: 'test' });
  await setPlanPrice(e, 'plan_casino_news_growth', 'price_diff', { mode: 'live', amountCents: 999 });
  const page = await call(e, 'GET', '/platform/saas/plans', null, staff);
  assert.equal(page.status, 200);
  assert.match(page.text, /price_shown/); assert.match(page.text, /casino_news_starter_month_usd_v1/); assert.match(page.text, /not synced/);
  assert.match(page.text, /amount differs: Stripe \$9\.99/);
  assert.doesNotMatch(page.text, /actPromptStripeId|actPromptPrice|Stripe id<\/button>|>Price<\/button>/);
  assert.match(page.text, /catalog\/plans\.v1\.json/);
  assert.match(page.text, /Retire/);
});

test('GET /api/platform/saas/plan-prices is staff-only, filterable and paged', async () => {
  const e = env();
  assert.equal((await call(e, 'GET', '/api/platform/saas/plan-prices')).status, 401);
  const staff = await staffLogin(e);
  for (let i = 0; i < 55; i++) await run(e, `INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, stripe_price_id, lookup_key, version, active) VALUES (?, ?, 'usd', 'month', 500, ?, ?, ?, 0)`, 'id' + i, STARTER, 'price_' + i, 'lk_' + i, i + 1);
  await setPlanPrice(e, 'plan_casino_news_growth', 'price_growth');
  const p1 = await call(e, 'GET', '/api/platform/saas/plan-prices', null, staff);
  assert.equal(p1.status, 200); assert.equal(p1.json.data.length, 50); assert.equal(p1.json.hasMore, true);
  const p2 = await call(e, 'GET', '/api/platform/saas/plan-prices?page=2', null, staff);
  assert.equal(p2.json.data.length, 6); assert.equal(p2.json.hasMore, false);
  const f = await call(e, 'GET', `/api/platform/saas/plan-prices?plan=plan_casino_news_growth`, null, staff);
  assert.deepEqual(f.json.data.map((r) => r.stripe_price_id), ['price_growth']);
  assert.ok('plan_key' in f.json.data[0]);
});

// ------------------------------------------------------------------ immutability
// The ONE module allowed to write plan_prices is the price-version repository behind the staff "add a price version" action
// (worker/plan-catalog.js setPlanPrice). Everything else stays forbidden, and that module is held to two statements.
const PRICE_VERSION_WRITER = '../worker/repositories/plan-price-versions.js';
test('no Worker code except the price-version repository updates or deletes a plan_prices row, or writes plans.stripe_price_id', () => {
  const files = [];
  const walk = (dir) => { for (const d of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) { const p = dir + d.name; if (d.isDirectory()) walk(p + '/'); else if (p.endsWith('.js')) files.push(p); } };
  walk('../worker/');
  assert.ok(files.length > 50);
  assert.ok(files.includes(PRICE_VERSION_WRITER));
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /DELETE\s+FROM\s+plan_prices/i, f);
    assert.doesNotMatch(text, /UPDATE\s+plans\s+SET[^`"']*stripe_price_id/i, f);
    if (f === PRICE_VERSION_WRITER) continue;
    assert.doesNotMatch(text, /UPDATE\s+plan_prices/i, f);
    assert.doesNotMatch(text, /INSERT\s+(OR\s+\w+\s+)?INTO\s+plan_prices/i, f);
  }
});

test('the price-version repository can only add a version row and retire the previous active flag: it never edits an amount, id, key or interval', () => {
  const text = readFileSync(new URL(PRICE_VERSION_WRITER, import.meta.url), 'utf8');
  const updates = [...text.matchAll(/UPDATE\s+plan_prices\s+SET\s+([^`]*?)\s+WHERE/gi)].map((m) => m[1].trim());
  assert.deepEqual(updates, ['active = 0']);
  const inserts = [...text.matchAll(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual(inserts, ['plan_prices']);
  assert.doesNotMatch(text, /INSERT\s+OR\s+(REPLACE|IGNORE)/i, 'a plain INSERT: a clash must fail, never overwrite');
});
