// CARD_REQUIRED_TRIAL: a trial starts only in Stripe Checkout; the chosen plan goes straight there and is then forgotten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { cardRequiredTrial } from '../worker/billing-config.js';
import { listPricing } from '../worker/repositories/pricing.js';
import { renderBillingPage } from '../worker/views/customer-pages/billing.js';
import { setPlanPrice } from './support/plan-prices.js';

const STARTER = 'plan_casino_news_starter';
const plan = (o = {}) => ({ id: 'p1', name: 'Starter', price_cents: 500, currency: 'USD', billing_period: 'monthly', trial_days: 7, active_price_id: 'price_1', ...o });
const base = { plan: null, invoices: [], canManage: true, subscription: null };

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', STRIPE_SECRET_KEY: 'sk_test_x', ...extra }; }
const ctx = { waitUntil() {} };
async function call(e, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.5' }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('flag: only the exact word "on" turns it on; unset and anything else is off', () => {
  assert.equal(cardRequiredTrial({}), false);
  assert.equal(cardRequiredTrial(undefined), false);
  assert.equal(cardRequiredTrial({ CARD_REQUIRED_TRIAL: 'off' }), false);
  assert.equal(cardRequiredTrial({ CARD_REQUIRED_TRIAL: 'true' }), false);
  assert.equal(cardRequiredTrial({ CARD_REQUIRED_TRIAL: ' ON ' }), true);
});

test('billing page, flag off: unchanged (no-card trial button, no auto checkout, nothing cleared)', () => {
  const out = renderBillingPage({ ...base, availablePlans: [plan()], selectedPlanId: 'p1' });
  assert.match(out, /Start 7-day trial/);
  assert.match(out, /A free trial needs no card/);
  assert.doesNotMatch(out, /removeItem\('lummetSignupIntent'\)/);
  assert.doesNotMatch(out, /\nlummetCheckout\(/);
});

test('billing page, flag on: no no-card trial button; the trial is started from Checkout', () => {
  const out = renderBillingPage({ ...base, availablePlans: [plan(), plan({ id: 'p2', name: 'Pro' })], cardRequiredTrial: true });
  assert.doesNotMatch(out, /lummetStartTrial", "args|data-onclick="lummetStartTrial"/);
  assert.match(out, /data-onclick="lummetCheckout" data-args="\[&quot;p2&quot;\]"[^>]*>Start 7-day trial/);
  assert.match(out, /you are not charged until the trial ends/);
});

test('billing page, flag on: a chosen buyable plan goes straight to Checkout and the saved choice is cleared', () => {
  const out = renderBillingPage({ ...base, availablePlans: [plan()], selectedPlanId: 'p1', cardRequiredTrial: true });
  assert.match(out, /lummetCheckout\("p1"\);/);
  assert.match(out, /localStorage\.removeItem\('lummetSignupIntent'\)/);
});

test('billing page, flag on: no auto checkout after cancelling out of it, for a plan with no price, for a viewer, or with a subscription', () => {
  const canceled = renderBillingPage({ ...base, availablePlans: [plan()], selectedPlanId: 'p1', cardRequiredTrial: true, checkoutStatus: 'canceled' });
  assert.doesNotMatch(canceled, /\nlummetCheckout\(|;\s*lummetCheckout\("p1"\)/);
  assert.match(canceled, /removeItem\('lummetSignupIntent'\)/); // the stale choice still goes away, so it cannot loop
  const noPrice = renderBillingPage({ ...base, availablePlans: [plan({ active_price_id: null })], selectedPlanId: 'p1', cardRequiredTrial: true });
  assert.doesNotMatch(noPrice, /lummetCheckout\("p1"\)/);
  assert.doesNotMatch(noPrice, /Not available online/); // unpriced plans are not even listed
  const viewer = renderBillingPage({ ...base, canManage: false, availablePlans: [plan()], selectedPlanId: 'p1', cardRequiredTrial: true });
  assert.doesNotMatch(viewer, /lummetCheckout\("p1"\)/);
  const subscribed = renderBillingPage({ ...base, subscription: { status: 'active', provider: 'stripe' }, plan: { name: 'Starter' }, availablePlans: [plan({ id: 'p2' })], selectedPlanId: 'p2', cardRequiredTrial: true });
  assert.doesNotMatch(subscribed, /lummetCheckout\("p2"\)/);
  assert.match(subscribed, /removeItem\('lummetSignupIntent'\)/);
});

test('billing page: an unsafe plan id cannot break out of the script', () => {
  const out = renderBillingPage({ ...base, availablePlans: [plan({ id: '</script><b>' })], selectedPlanId: '</script><b>', cardRequiredTrial: true });
  assert.doesNotMatch(out, /lummetCheckout\("<\/script>/);
});

test('pricing read model: requirePrice lists only plans with an active Stripe price', async () => {
  const e = env();
  const all = await listPricing(e);
  assert.ok(all.length > 0);
  assert.equal((await listPricing(e, { requirePrice: true })).length, 0);
  await setPlanPrice(e, STARTER, 'price_s');
  const priced = await listPricing(e, { requirePrice: true });
  assert.deepEqual(priced.map((p) => p.id), [STARTER]);
  assert.equal((await listPricing(e)).length, all.length); // default path unchanged
});

test('route: POST /trial is refused with the flag on, and still works with it off', async () => {
  const off = env();
  const s1 = await call(off, 'POST', '/api/customer/signup', { body: { email: 'a@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'A' } });
  const ok = await call(off, 'POST', `/api/organizations/${s1.json.organizationId}/trial`, { cookie: s1.cookie, body: { planId: STARTER } });
  assert.equal(ok.status, 200, ok.text);

  const on = env({ CARD_REQUIRED_TRIAL: 'on' });
  const s2 = await call(on, 'POST', '/api/customer/signup', { body: { email: 'b@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'B' } });
  const org = s2.json.organizationId;
  const refused = await call(on, 'POST', `/api/organizations/${org}/trial`, { cookie: s2.cookie, body: { planId: STARTER } });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'card_required_for_trial');
  const rows = await on.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE organization_id = ?`).bind(org).all();
  assert.equal(rows.results.length, 0); // nothing was created
});

test('route: starting checkout clears the saved plan on the user record (flag on only)', async () => {
  for (const flag of ['on', 'off']) {
    const e = env({ PORTAL_BASE_URL: 'https://app.example.test', CARD_REQUIRED_TRIAL: flag });
    await setPlanPrice(e, STARTER, 'price_s');
    const s = await call(e, 'POST', '/api/customer/signup', { body: { email: `c-${flag}@example.com`, password: 'Correct-Horse-Battery-9', organizationName: 'C', planId: STARTER, billingPeriod: 'monthly' } });
    assert.equal(s.status, 200, s.text);
    const before = await e.LUMMET_DB.prepare(`SELECT signup_plan_id FROM customer_users WHERE email = ?`).bind(`c-${flag}@example.com`).first();
    assert.equal(before.signup_plan_id, STARTER);

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (u) => new Response(JSON.stringify(String(u).endsWith('/customers') ? { id: 'cus_1' } : { id: 'cs_1', url: 'https://checkout.stripe.test/c/pay' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    try {
      const r = await call(e, 'POST', `/api/organizations/${s.json.organizationId}/billing/checkout`, { cookie: s.cookie, body: { planId: STARTER } });
      assert.equal(r.status, 200, r.text);
    } finally { globalThis.fetch = realFetch; }
    const after = await e.LUMMET_DB.prepare(`SELECT signup_plan_id, signup_billing_period FROM customer_users WHERE email = ?`).bind(`c-${flag}@example.com`).first();
    if (flag === 'on') { assert.equal(after.signup_plan_id, null); assert.equal(after.signup_billing_period, null); }
    else assert.equal(after.signup_plan_id, STARTER);
  }
});
