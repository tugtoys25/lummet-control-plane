// Phase 3, sprint 3.1: catalog/plans.v1.json is valid, matches what the migrations seed, and the validator catches mistakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { validateCatalog, catalogPrices, priceLookupKey, stripeProductId, limitsOf } from '../worker/catalog.js';

const catalog = () => JSON.parse(readFileSync(new URL('../catalog/plans.v1.json', import.meta.url), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const all = async (db, sql) => (await db.prepare(sql).all()).results;

test('the shipped catalog is valid', () => {
  assert.deepEqual(validateCatalog(catalog()), []);
});

test('the shipped catalog matches the plans, prices and limits the migrations seed', async () => {
  const db = createTestDb(); applyMigrations(db);
  const c = catalog();
  const rows = await all(db, `SELECT p.*, pr.key AS product_key FROM plans p JOIN products pr ON pr.id = p.product_id`);
  assert.deepEqual(c.plans.map((p) => p.key).sort(), rows.map((r) => r.key).sort(), 'same set of plans');
  assert.deepEqual(c.products.map((p) => p.key).sort(), (await all(db, `SELECT key FROM products`)).map((r) => r.key).sort());
  const ents = await all(db, `SELECT plan_id, key, value_type, value FROM plan_entitlements`);
  const cast = (e) => (e.value_type === 'boolean' ? e.value === 'true' : e.value_type === 'number' ? Number(e.value) : e.value_type === 'json' ? JSON.parse(e.value) : e.value);
  for (const plan of c.plans) {
    const row = rows.find((r) => r.key === plan.key);
    assert.equal(plan.product, row.product_key, plan.key);
    assert.equal(plan.period, row.billing_period, plan.key);
    assert.equal(plan.trial_days, row.trial_days, plan.key);
    assert.equal(plan.status, row.status, plan.key);
    assert.equal(plan.currency, row.currency.toLowerCase(), plan.key);
    if (row.price_cents > 0 && plan.period !== 'custom') {
      assert.equal(plan.prices.length, 1, plan.key);
      assert.equal(plan.prices[0].unit_amount_cents, row.price_cents, plan.key);
      assert.equal(plan.prices[0].interval, plan.period === 'annual' ? 'year' : 'month', plan.key);
    } else assert.deepEqual(plan.prices, [], plan.key);
    const seeded = Object.fromEntries(ents.filter((e) => e.plan_id === row.id).map((e) => [e.key, cast(e)]));
    assert.deepEqual(limitsOf(c, plan), seeded, `limits of ${plan.key}`);
  }
});

test('lookup keys are stable, unique and within Stripe\'s length limit', () => {
  const prices = catalogPrices(catalog());
  assert.equal(prices.length, 48);
  assert.equal(new Set(prices.map((p) => p.lookupKey)).size, prices.length);
  assert.ok(prices.every((p) => p.lookupKey.length <= 200 && /^[a-z0-9_]+$/.test(p.lookupKey)));
  assert.equal(priceLookupKey('casino_news_starter', 'month', 'USD', 1), 'casino_news_starter_month_usd_v1');
  assert.ok(prices.some((p) => p.lookupKey === 'casino_news_starter_month_usd_v1'));
  assert.ok(prices.some((p) => p.lookupKey === 'casino_news_starter_annual_year_usd_v1'));
  assert.equal(stripeProductId('casino_news'), 'prod_lummet_casino_news');
});

test('the catalog carries no secret and no live identifier', () => {
  const text = readFileSync(new URL('../catalog/plans.v1.json', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /sk_(live|test)_|rk_(live|test)_|whsec_|price_[A-Za-z0-9]{6,}/);
});

test('tax behavior resolves from the catalog default and stays generic', () => {
  const c = catalog();
  assert.equal(c.tax.default_tax_behavior, 'unspecified');
  assert.ok(catalogPrices(c).every((p) => p.taxBehavior === 'unspecified'));
  c.tax.default_tax_behavior = 'exclusive';
  assert.ok(catalogPrices(c).every((p) => p.taxBehavior === 'exclusive'));
  c.plans[0].prices[0].tax_behavior = 'inclusive';
  assert.equal(catalogPrices(c)[0].taxBehavior, 'inclusive');
});

test('the owner decisions are editable data and the floor is enforced', () => {
  const c = catalog();
  assert.equal(c.decisions.entry_price_floor_cents, null);
  assert.equal(c.decisions.annual_default, false);
  c.decisions.entry_price_floor_cents = 900;
  const errs = validateCatalog(c);
  assert.ok(errs.some((e) => /below the entry price floor 900/.test(e)), errs.slice(0, 3).join('|'));
  // a floor of 500 is satisfied by the cheapest seeded price (500)
  c.decisions.entry_price_floor_cents = 500;
  assert.deepEqual(validateCatalog(c), []);
  c.decisions.entry_price_floor_cents = -5;
  assert.ok(validateCatalog(c).some((e) => /entry_price_floor_cents/.test(e)));
  // an inactive old version does not count against the floor
  c.decisions.entry_price_floor_cents = 600;
  const p = c.plans.find((x) => x.key === 'casino_news_starter');
  p.prices[0].active = false;
  p.prices.push({ version: 2, currency: 'usd', interval: 'month', unit_amount_cents: 700, tax_behavior: null, active: true });
  assert.ok(!validateCatalog(c).some((e) => /casino_news_starter v/.test(e) && /floor/.test(e)));
});

const mutate = (fn) => { const c = clone(catalog()); fn(c); return validateCatalog(c); };
const find = (c, k) => c.plans.find((p) => p.key === k);

test('the validator names each kind of mistake', () => {
  assert.ok(mutate((c) => { c.plans.push(clone(find(c, 'casino_news_starter'))); }).some((e) => /duplicate plan key casino_news_starter/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').product = 'nope'; }).some((e) => /unknown product nope/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').prices[0].interval = 'year'; }).some((e) => /sold per month, not per year/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').prices[0].unit_amount_cents = 5.5; }).some((e) => /positive integer/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').prices[0].unit_amount_cents = 0; }).some((e) => /positive integer/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').prices[0].currency = 'USD'; }).some((e) => /lower-case ISO/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').prices[0].tax_behavior = 'maybe'; }).some((e) => /tax_behavior/.test(e)));
  assert.ok(mutate((c) => { find(c, 'master').prices.push({ version: 1, currency: 'usd', interval: 'month', unit_amount_cents: 100 }); }).some((e) => /custom plan has no self-serve price/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').prices = []; }).some((e) => /needs at least one price/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').trial_days = 120; }).some((e) => /trial_days/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter').status = 'live'; }).some((e) => /status must be/.test(e)));
  assert.ok(mutate((c) => { find(c, 'casino_news_starter_annual').same_limits_as = 'ghost'; }).some((e) => /same_limits_as ghost/.test(e)));
  assert.ok(mutate((c) => { delete find(c, 'casino_news_starter').limits; }).some((e) => /needs limits or same_limits_as/.test(e)));
  assert.ok(mutate((c) => { c.tax.default_tax_code = 'SaaS'; }).some((e) => /default_tax_code/.test(e)));
  assert.ok(mutate((c) => { c.products[0].tax_code = '123'; }).some((e) => /tax_code/.test(e)));
  assert.ok(mutate((c) => { c.catalog_version = 0; }).some((e) => /catalog_version/.test(e)));
  assert.ok(mutate((c) => { c.plans[0].key = 'Bad Key'; }).some((e) => /lower_snake_case/.test(e)));
  assert.deepEqual(validateCatalog(null), ['catalog is not an object']);
});

test('two active prices for one plan, currency and interval are rejected; a second version needs the old one switched off', () => {
  const errs = mutate((c) => { find(c, 'casino_news_starter').prices.push({ version: 2, currency: 'usd', interval: 'month', unit_amount_cents: 600 }); });
  assert.ok(errs.some((e) => /more than one active price for usd\/month/.test(e)), errs.join('|'));
  const ok = mutate((c) => { const p = find(c, 'casino_news_starter'); p.prices[0].active = false; p.prices.push({ version: 2, currency: 'usd', interval: 'month', unit_amount_cents: 600 }); });
  assert.deepEqual(ok, []);
  const dupVersion = mutate((c) => { const p = find(c, 'casino_news_starter'); p.prices[0].active = false; p.prices.push({ version: 1, currency: 'usd', interval: 'month', unit_amount_cents: 600 }); });
  assert.ok(dupVersion.some((e) => /version is used twice|duplicate lookup key/.test(e)));
  const noActive = mutate((c) => { find(c, 'casino_news_starter').prices[0].active = false; });
  assert.ok(noActive.some((e) => /active plan with no active price/.test(e)));
});
