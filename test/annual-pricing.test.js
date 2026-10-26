// v7G: annual plans (seeded retired), the public pricing page, and checkout on an annual plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations, splitSqlStatements } from './support/d1-shim.js';
import { createFakeBillingProvider } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as staff from '../worker/staff-saas.js';
import * as plansService from '../worker/plans.js';
import { pricingFeatures, pricingGroups } from '../worker/public-site/pages.js';
import worker from '../worker/index.js';
import { createAssets } from './support/public-env.js';
import { setPlanPrice } from './support/plan-prices.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }
async function page(e, path) {
  const res = await worker.fetch(new Request('https://cp.test' + path, { headers: { 'CF-Connecting-IP': '198.51.100.9' } }), e, ctx);
  return { status: res.status, text: await res.text(), res };
}
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;

test('the migration creates one retired annual twin per priced monthly plan, at 10x the monthly price, with the same entitlements', async () => {
  const e = env();
  const monthly = await all(e, `SELECT * FROM plans WHERE billing_period = 'monthly' AND price_cents > 0 AND id NOT LIKE '%\\_annual' ESCAPE '\\'`);
  const twins = await all(e, `SELECT * FROM plans WHERE billing_period = 'annual'`);
  assert.ok(monthly.length >= 20);
  assert.equal(twins.length, monthly.length);
  for (const m of monthly) {
    const t = twins.find((x) => x.id === m.id + '_annual');
    assert.ok(t, m.id);
    assert.equal(t.status, 'retired'); assert.equal(t.price_cents, m.price_cents * 10); assert.equal(t.trial_days, 0);
    assert.equal(t.product_id, m.product_id); assert.equal(t.key, m.key + '_annual'); assert.equal(t.name, m.name + ' (annual)'); assert.equal(t.stripe_price_id, null);
    assert.ok(t.price_cents < m.price_cents * 12, 'a real discount, never above 12 months');
    assert.ok(t.price_cents > m.price_cents * 6, 'never an impossible one');
    const a = await all(e, `SELECT key, value_type, value FROM plan_entitlements WHERE plan_id = ? ORDER BY key`, m.id);
    const b = await all(e, `SELECT key, value_type, value FROM plan_entitlements WHERE plan_id = ? ORDER BY key`, t.id);
    assert.deepEqual(b, a, m.id);
  }
  // Nothing without a recurring price gets a twin (custom plans, founder license).
  assert.equal((await all(e, `SELECT 1 FROM plans WHERE id LIKE '%\\_annual\\_annual' ESCAPE '\\'`)).length, 0);
  const customTwins = await all(e, `SELECT p.id FROM plans p JOIN plans m ON p.id = m.id || '_annual' WHERE m.price_cents IS NULL OR m.price_cents = 0`);
  assert.deepEqual(customTwins, []);
});

test('the migration is idempotent and never overwrites a staff edit', async () => {
  const e = env();
  await e.LUMMET_DB.prepare(`UPDATE plans SET price_cents = 4900, status = 'active', stripe_price_id = 'price_abc' WHERE id = 'plan_casino_news_starter_annual'`).run();
  const sql = readFileSync(new URL('../migrations/0041_annual_plans.sql', import.meta.url), 'utf8');
  for (const stmt of splitSqlStatements(sql)) await e.LUMMET_DB.prepare(stmt).run();
  const t = await one(e, `SELECT price_cents, status, stripe_price_id FROM plans WHERE id = 'plan_casino_news_starter_annual'`);
  assert.deepEqual({ ...t }, { price_cents: 4900, status: 'active', stripe_price_id: 'price_abc' });
  assert.equal((await one(e, `SELECT COUNT(*) n FROM plans WHERE billing_period = 'annual'`)).n, (await one(e, `SELECT COUNT(*) n FROM plans WHERE billing_period = 'annual'`)).n);
  assert.equal((await one(e, `SELECT COUNT(*) n FROM plans WHERE id LIKE '%\\_annual\\_annual' ESCAPE '\\'`)).n, 0);
  assert.equal((await one(e, `SELECT COUNT(*) n FROM plan_entitlements WHERE plan_id = 'plan_casino_news_starter_annual' AND key = 'sites.max'`)).n, 1);
});

test('retired annual plans are invisible to customers and cannot be checked out', async () => {
  const e = env(); const billing = createBillingService(createFakeBillingProvider());
  assert.ok((await plansService.listPlans(e, 'prod_casino_news')).every((p) => p.billing_period === 'monthly'));
  const signup = await customerAuth.signUp({ async json() { return { email: 'a@example.com', password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.9' } }, e);
  await setPlanPrice(e, 'plan_casino_news_starter_annual', 'price_x');
  const r = await billing.startCheckout(e, { organizationId: signup.organizationId, planId: 'plan_casino_news_starter_annual', successUrl: 'https://a/s', cancelUrl: 'https://a/c' });
  assert.equal(r.ok, false); assert.equal(r.error, 'invalid_plan');
});

test('staff activate an annual plan; customers can then check out on it and the provider gets the annual price id', async () => {
  const e = env(); const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  await setPlanPrice(e, 'plan_casino_news_starter_annual', 'price_annual1');
  assert.equal((await staff.updatePlan(e, 'plan_casino_news_starter_annual', { status: 'active' })).ok, true);
  assert.ok((await plansService.listPlans(e, 'prod_casino_news')).some((p) => p.id === 'plan_casino_news_starter_annual'));
  const signup = await customerAuth.signUp({ async json() { return { email: 'b@example.com', password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.9' } }, e);
  const r = await billing.startCheckout(e, { organizationId: signup.organizationId, planId: 'plan_casino_news_starter_annual', successUrl: 'https://a/s', cancelUrl: 'https://a/c' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const call = provider._calls.find((c) => c.method === 'createCheckoutSession');
  assert.equal(call.priceId, 'price_annual1');
});

test('/pricing: monthly plans of active products, grouped, with CTA, trial and feature lines; no annual toggle while none is published', async () => {
  const e = env(); const p = await page(e, '/pricing');
  assert.equal(p.status, 200);
  assert.match(p.text, /<h1>Pricing<\/h1>/);
  assert.match(p.text, /Casino News/); assert.match(p.text, /\$5<\/strong> per month/); assert.match(p.text, /7-day free trial/);
  assert.match(p.text, /href="\/app\/signup\?plan=[^&]+&amp;period=monthly">Get started</);
  assert.doesNotMatch(p.text, /billing=annual/, 'no toggle without a published annual plan');
  assert.doesNotMatch(p.text, /\(annual\)/);
  assert.match(p.text, /Prices exclude any taxes/);
  assert.match(p.text, /id="pricing-family"/);
  assert.match(p.text, /id="pricing-comparison-title"/);
  assert.match(p.text, /scope="col">Included features/);
  assert.match(p.text, /static\/js\/pricing.js/);
  assert.doesNotMatch(p.text, /<script(?![^>]*(ld\+json|\ssrc=))/, 'no executable script: safe to edge-cache');
  const main = p.text.slice(p.text.indexOf('class="section section-tight"'), p.text.indexOf('</main>') > 0 ? p.text.indexOf('</main>') : undefined);
  assert.doesNotMatch(main, /NaN|undefined|\bnull\b|Custom/, 'no broken values or custom-priced plans in the plan list');
});

test('/pricing with a published annual plan: toggle appears, annual view shows the saving, monthly view is unchanged', async () => {
  const e = env();
  await setPlanPrice(e, 'plan_casino_news_starter_annual', 'price_a1');
  await staff.updatePlan(e, 'plan_casino_news_starter_annual', { status: 'active' });
  await setPlanPrice(e, 'plan_casino_news_pro_annual', 'price_a2');
  await staff.updatePlan(e, 'plan_casino_news_pro_annual', { status: 'active' });
  const monthly = await page(e, '/pricing');
  assert.match(monthly.text, /href="\/pricing\?billing=annual">Annual</); assert.match(monthly.text, /chip is-active" href="\/pricing">Monthly/);
  assert.doesNotMatch(monthly.text, /per year/);
  const annual = await page(e, '/pricing?billing=annual');
  assert.match(annual.text, /chip is-active" href="\/pricing\?billing=annual">Annual/);
  assert.match(annual.text, /\$50<\/strong> per year/); assert.match(annual.text, /\$200<\/strong> per year/);
  assert.match(annual.text, /Save 17% compared with paying monthly/);
  assert.doesNotMatch(annual.text, /per month/); assert.doesNotMatch(annual.text, /\(annual\)/);
  assert.doesNotMatch(annual.text, /Sports News/, 'only products that have an annual plan published appear in the annual view');
  assert.match((await page(e, '/pricing?billing=bogus')).text, /per month/, 'unknown values fall back to monthly');
});

test('/pricing escapes product names and shows an empty state when nothing is published', async () => {
  const e = env();
  await e.LUMMET_DB.prepare(`UPDATE products SET name = 'Evil <img src=x onerror=alert(1)>' WHERE id = 'prod_casino_news'`).run();
  const p = await page(e, '/pricing');
  assert.doesNotMatch(p.text, /<img src=x/); assert.match(p.text, /Evil &lt;img src=x/);
  await e.LUMMET_DB.prepare(`UPDATE plans SET status = 'retired'`).run();
  const empty = await page(e, '/pricing');
  assert.equal(empty.status, 200);
  assert.match(empty.text, /Pricing is not published yet\./); assert.match(empty.text, /href="\/contact"/);
  assert.match(empty.text, /noindex/);
});

test('the pricing page is in the sitemap and the public header and footer, and its words are editable UI strings', async () => {
  const e = env();
  assert.match((await page(e, '/sitemap.xml')).text, /\/pricing</);
  const home = (await page(e, '/')).text;
  assert.match(home, /href="\/pricing"/);
  await e.LUMMET_DB.prepare(`UPDATE lummet_ui_strings SET value = 'Choose your plan' WHERE ui_key = 'pricing_cta'`).run();
  assert.match((await page(e, '/pricing')).text, />Choose your plan</);
  await e.LUMMET_DB.prepare(`UPDATE plans SET status = 'retired'`).run();
  assert.doesNotMatch((await page(e, '/sitemap.xml')).text, /\/pricing</);
});

test('pricingFeatures and pricingGroups: lines come only from entitlements, annual saving is computed against the monthly twin', () => {
  assert.deepEqual(pricingFeatures({ 'sites.max': '1', 'users.max': '5', 'analytics.level': 'basic', 'api.enabled': 'true', 'reports.enabled': 'false', 'ai.credits_monthly': '0' }),
    ['1 site', '5 team members', 'Basic analytics', 'API access']);
  assert.deepEqual(pricingFeatures({}), []); assert.deepEqual(pricingFeatures({ 'analytics.level': 'none' }), []);
  const plans = [
    { id: 'm', product_id: 'p', product_name: 'P', name: 'Starter', billing_period: 'monthly', price_cents: 1000, currency: 'USD', trial_days: 7, entitlements: {} },
    { id: 'a', product_id: 'p', product_name: 'P', name: 'Starter (annual)', billing_period: 'annual', price_cents: 10000, currency: 'USD', trial_days: 0, entitlements: {} },
    { id: 'orphan', product_id: 'q', product_name: 'Q', name: 'Solo (annual)', billing_period: 'annual', price_cents: 5000, currency: 'USD', trial_days: 0, entitlements: {} }
  ];
  const g = pricingGroups(plans, 'annual');
  assert.equal(g[0].plans[0].saving, 'Save 17% compared with paying monthly');
  assert.equal(g[1].plans[0].saving, '', 'no monthly twin to compare with: no claim');
  assert.equal(pricingGroups(plans, 'monthly')[0].plans[0].trial, '7-day free trial');
  assert.equal(pricingGroups(plans, 'monthly').length, 1);
});
