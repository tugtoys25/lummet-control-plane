// 1) "Create in Stripe" for a plan (worker/plan-stripe.js): Stripe is stubbed, everything else is the real code over an in-memory D1.
// 2) Plans with no Stripe price yet: registrable, listed and payable by crypto when crypto checkout is on; unchanged when it is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import { createStripePriceForPlan } from '../worker/plan-stripe.js';
import * as gateways from '../worker/billing-gateways.js';
import { renderBillingPage } from '../worker/views/customer-pages/billing.js';
import worker from '../worker/index.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const NP = { NOWPAYMENTS_API_KEY: 'np_key', NOWPAYMENTS_IPN_SECRET: 'ipn-secret' };
let ip = 1;
function env(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ASSETS: createAssets(), ENVIRONMENT: 'production', CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), PORTAL_BASE_URL: 'https://cp.test', STRIPE_SECRET_KEY: 'sk_test_x', ...extra };
}
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;
async function call(e, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${ip++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie); if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function addPlan(e, id = 'plan_zeta', { cents = 1234, trial = 0, name = 'Zeta Crypto Plan', period = 'monthly' } = {}) {
  await e.LUMMET_DB.prepare(`INSERT INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status) VALUES (?, 'prod_casino_news', ?, ?, ?, ?, 'USD', ?, 'active')`).bind(id, id.replace('plan_', ''), name, period, cents, trial).run();
  return id;
}

// Stubs the parts of Stripe the feature talks to and records what it was asked.
function stubStripe({ product = 'missing', existingPrice = null, livemode = false, failPriceWith = null, verifyAmount = null } = {}) {
  const real = globalThis.fetch; const seen = { products: [], prices: [], gets: [] }; let created = null;
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url); if (!u.startsWith('https://api.stripe.com/v1')) return real(url, init);
    const path = u.slice('https://api.stripe.com/v1'.length); const method = init.method || 'GET';
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    const idem = init.headers?.['Idempotency-Key'];
    if (method === 'GET' && path.startsWith('/products/')) { seen.gets.push(path); return product === 'missing' && !seen.products.length ? json({ error: { code: 'resource_missing', message: 'No such product' } }, 404) : json({ id: path.split('/')[2] }); }
    if (method === 'POST' && path === '/products') { seen.products.push({ form, idem }); return json({ id: form.id }); }
    if (method === 'GET' && path.startsWith('/prices?')) { seen.gets.push(path); return json({ data: existingPrice ? [existingPrice] : [] }); }
    if (method === 'POST' && path === '/prices') {
      seen.prices.push({ form, idem });
      if (failPriceWith) return json({ error: { message: failPriceWith } }, 400);
      created = { id: 'price_NEWPRICE123', active: true, type: 'recurring', currency: form.currency, unit_amount: Number(form.unit_amount), livemode, recurring: { interval: form['recurring[interval]'], interval_count: 1 } };
      return json(created);
    }
    if (method === 'GET' && path.startsWith('/prices/')) {
      const id = decodeURIComponent(path.split('/')[2]);
      const base = existingPrice && existingPrice.id === id ? existingPrice : created;
      return base ? json({ ...base, ...(verifyAmount ? { unit_amount: verifyAmount } : {}) }) : json({ error: { message: 'No such price' } }, 404);
    }
    return json({ error: { message: 'unexpected ' + method + ' ' + path } }, 404);
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

// ---------------------------------------------------------------- Create in Stripe
test('create in Stripe: product found-or-created by the sync script\'s id, price created with its lookup key, attached through the existing checks', async () => {
  const e = env(); const id = await addPlan(e); const s = stubStripe();
  try {
    const r = await createStripePriceForPlan(e, id, { reason: 'launch' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.stripePriceId, 'price_NEWPRICE123'); assert.equal(r.version, 1); assert.equal(r.verified, true); assert.equal(r.mode, 'test');
    assert.equal(r.lookupKey, 'zeta_month_usd_v1'.replace('zeta', 'zeta')); // plan key is "zeta"
    const row = await one(e, 'SELECT * FROM plan_prices WHERE plan_id = ?', id);
    assert.equal(row.stripe_price_id, 'price_NEWPRICE123'); assert.equal(row.unit_amount_cents, 1234); assert.equal(row.active, 1); assert.equal(row.stripe_mode, 'test');
    assert.match(row.lookup_key, /^zeta_month_usd_v1$/);
    assert.equal(s.seen.products.length, 1); assert.equal(s.seen.products[0].form.id, 'prod_lummet_casino_news'); assert.equal(s.seen.products[0].idem, 'product:prod_lummet_casino_news');
    assert.equal(s.seen.prices.length, 1); assert.equal(s.seen.prices[0].idem, 'price:zeta_month_usd_v1');
    assert.equal(s.seen.prices[0].form.unit_amount, '1234'); assert.equal(s.seen.prices[0].form['recurring[interval]'], 'month'); assert.equal(s.seen.prices[0].form.lookup_key, 'zeta_month_usd_v1');
    assert.equal(s.seen.prices[0].form.product, 'prod_lummet_casino_news');
  } finally { s.restore(); }
});

test('create in Stripe: refusals save nothing and call no Stripe write', async () => {
  const e = env(); const id = await addPlan(e); const s = stubStripe();
  try {
    assert.equal((await createStripePriceForPlan(e, 'ghost', { reason: 'x' })).status, 404);
    assert.equal((await createStripePriceForPlan(e, id, {})).error, 'reason_required');
    assert.equal((await createStripePriceForPlan(e, id, { reason: 'x', amountCents: 0 })).error, 'invalid_price_cents');
    assert.equal((await createStripePriceForPlan(e, id, { reason: 'x', taxBehavior: 'maybe' })).error, 'invalid_tax_behavior');
    assert.equal((await createStripePriceForPlan({ ...e, STRIPE_SECRET_KEY: '' }, id, { reason: 'x' })).error, 'stripe_not_configured');
    await e.LUMMET_DB.prepare(`UPDATE plans SET billing_period = 'custom' WHERE id = ?`).bind(id).run();
    assert.equal((await createStripePriceForPlan(e, id, { reason: 'x' })).error, 'plan_not_recurring');
    assert.equal(s.seen.products.length + s.seen.prices.length, 0);
    assert.equal((await all(e, 'SELECT id FROM plan_prices WHERE plan_id = ?', id)).length, 0);
  } finally { s.restore(); }
});

test('create in Stripe: a LIVE key needs an explicit confirmation, and only then writes', async () => {
  const e = env({ STRIPE_SECRET_KEY: 'sk_live_x' }); const id = await addPlan(e); const s = stubStripe({ livemode: true });
  try {
    const refused = await createStripePriceForPlan(e, id, { reason: 'go live' });
    assert.equal(refused.error, 'live_confirmation_required'); assert.equal(refused.mode, 'live');
    assert.equal(s.seen.products.length + s.seen.prices.length + s.seen.gets.length, 0, 'Stripe was not even asked');
    const ok = await createStripePriceForPlan(e, id, { reason: 'go live', confirmLive: true });
    assert.equal(ok.ok, true, JSON.stringify(ok)); assert.equal(ok.mode, 'live');
  } finally { s.restore(); }
});

test('create in Stripe: a matching price already under the lookup key is adopted; a different one is refused; Stripe errors surface', async () => {
  const match = { id: 'price_OLDPRICE123', active: true, type: 'recurring', currency: 'usd', unit_amount: 1234, livemode: false, recurring: { interval: 'month', interval_count: 1 } };
  let e = env(); let id = await addPlan(e); let s = stubStripe({ product: 'exists', existingPrice: match });
  try {
    const r = await createStripePriceForPlan(e, id, { reason: 'retry' });
    assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.adopted, true); assert.equal(r.stripePriceId, 'price_OLDPRICE123');
    assert.equal(s.seen.prices.length, 0, 'nothing was created'); assert.equal(s.seen.products.length, 0, 'the product existed');
  } finally { s.restore(); }
  e = env(); id = await addPlan(e); s = stubStripe({ product: 'exists', existingPrice: { ...match, unit_amount: 999 } });
  try {
    const r = await createStripePriceForPlan(e, id, { reason: 'x' });
    assert.equal(r.error, 'lookup_key_in_use'); assert.equal(r.stripePriceId, 'price_OLDPRICE123');
    assert.equal((await all(e, 'SELECT id FROM plan_prices WHERE plan_id = ?', id)).length, 0);
  } finally { s.restore(); }
  e = env(); id = await addPlan(e); s = stubStripe({ failPriceWith: 'Invalid currency' });
  try {
    const r = await createStripePriceForPlan(e, id, { reason: 'x' });
    assert.equal(r.error, 'stripe_rejected'); assert.match(r.detail, /Invalid currency/);
    assert.equal((await all(e, 'SELECT id FROM plan_prices WHERE plan_id = ?', id)).length, 0);
  } finally { s.restore(); }
});

test('create in Stripe: if the attach step refuses after Stripe made the price, the error carries the price id and nothing is recorded', async () => {
  const e = env(); const id = await addPlan(e); const s = stubStripe({ verifyAmount: 5000 });
  try {
    const r = await createStripePriceForPlan(e, id, { reason: 'x' });
    assert.equal(r.ok, false); assert.equal(r.error, 'stripe_price_amount_mismatch'); assert.equal(r.stripePriceId, 'price_NEWPRICE123');
    assert.equal((await all(e, 'SELECT id FROM plan_prices WHERE plan_id = ?', id)).length, 0);
  } finally { s.restore(); }
});

test('staff API: create-in-Stripe is staff-only and audited', async () => {
  const e = env(); const id = await addPlan(e); const s = stubStripe();
  try {
    const P = `/api/platform/saas/plan-catalog/${id}/stripe-price`;
    assert.equal((await call(e, 'POST', P, { body: { reason: 'x' } })).status, 401);
    assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
    const cookie = (await call(e, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
    const bad = await call(e, 'POST', P, { body: {}, cookie });
    assert.equal(bad.status, 422); assert.equal(bad.json.error, 'reason_required');
    const ok = await call(e, 'POST', P, { body: { reason: 'launch' }, cookie });
    assert.equal(ok.status, 200, ok.text); assert.equal(ok.json.stripePriceId, 'price_NEWPRICE123'); assert.equal(ok.json.verified, true);
    assert.ok((await all(e, `SELECT 1 FROM lummet_audit_logs WHERE resource = 'plan' AND action = 'create_stripe_price' AND success = 1`)).length >= 1);
  } finally { s.restore(); }
});

// ---------------------------------------------------------------- plans with no Stripe price yet
const ON = { ...NP, PAYMENT_GATEWAYS: 'stripe,nowpayments' };

test('helpers: crypto must be on AND configured; only a sellable plan with no Stripe price is "crypto only"', async () => {
  const off = env(); const on = env(ON); await addPlan(off); await addPlan(on);
  assert.equal(await gateways.cryptoReady(off), false);
  assert.equal(await gateways.cryptoReady(env({ ...NP })), false, 'secrets alone are not enough: the switch is off');
  assert.equal(await gateways.cryptoReady(on), true);
  assert.equal(await gateways.isCryptoOnlyPlan(on, 'plan_zeta'), true);
  assert.equal(await gateways.isCryptoOnlyPlan(on, 'ghost'), false);
  await on.LUMMET_DB.prepare(`UPDATE plans SET price_cents = 0 WHERE id = 'plan_zeta'`).run();
  assert.equal(await gateways.isCryptoOnlyPlan(on, 'plan_zeta'), false, 'no list price: not sellable');
  await addPlan(on, 'plan_priced', { name: 'Priced' });
  await on.LUMMET_DB.prepare(`INSERT INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, tax_behavior, stripe_price_id, lookup_key, stripe_mode, version, active) VALUES ('pp1', 'plan_priced', 'usd', 'month', 1234, 'unspecified', 'price_PPPPPPPP1', 'priced_month_usd_v1', 'test', 1, 1)`).run();
  assert.equal(await gateways.isCryptoOnlyPlan(on, 'plan_priced'), false, 'it has a Stripe price: card works');
});

test('registration with a plan that has no Stripe price: refused as before with crypto off, accepted with crypto on', async () => {
  const body = (n) => ({ email: `u${n}@example.com`, password: 'Correct-Horse-Battery-9', organizationName: 'Org', planId: 'plan_zeta', billingPeriod: 'monthly' });
  const off = env(); await addPlan(off);
  const refused = await call(off, 'POST', '/api/customer/signup', { body: body(1) });
  assert.equal(refused.status, 409); assert.equal(refused.json.error, 'plan_not_billing_configured');
  assert.equal((await all(off, 'SELECT id FROM customer_users')).length, 0, 'nothing was created');
  const on = env(ON); await addPlan(on);
  const ok = await call(on, 'POST', '/api/customer/signup', { body: body(2) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await one(on, 'SELECT signup_plan_id FROM customer_users')).signup_plan_id, 'plan_zeta');
  // a plan with no price at all stays refused even with crypto on
  await on.LUMMET_DB.prepare(`UPDATE plans SET price_cents = 0 WHERE id = 'plan_zeta'`).run();
  assert.equal((await call(on, 'POST', '/api/customer/signup', { body: body(3) })).status, 409);
});

test('pricing page with card-required trials: a plan with no Stripe price is hidden as before, and listed (without a trial) when crypto is on', async () => {
  const off = env({ CARD_REQUIRED_TRIAL: 'on' }); await addPlan(off, 'plan_zeta', { trial: 11 });
  assert.doesNotMatch((await call(off, 'GET', '/pricing')).text, /Zeta Crypto Plan/);
  const on = env({ CARD_REQUIRED_TRIAL: 'on', ...ON }); await addPlan(on, 'plan_zeta', { trial: 11 });
  const html = (await call(on, 'GET', '/pricing')).text;
  assert.match(html, /Zeta Crypto Plan/);
  assert.doesNotMatch(html, /11-day free trial/, 'no trial is advertised for a plan sold by crypto (a card-required trial starts in Stripe Checkout)');
  // positive control: the same plan DOES advertise its trial when card-required trials are off, so the check above is meaningful
  const plain = env(); await addPlan(plain, 'plan_zeta', { trial: 11 });
  assert.match((await call(plain, 'GET', '/pricing')).text, /11-day free trial/);
});

test('billing page: with crypto on a no-price plan gets a crypto button and is listed; with crypto off nothing changes', () => {
  const plan = (o = {}) => ({ id: 'p1', name: 'Starter', price_cents: 500, currency: 'USD', billing_period: 'monthly', trial_days: 7, active_price_id: null, ...o });
  const base = { plan: null, invoices: [], canManage: true, subscription: null };
  const offOut = renderBillingPage({ ...base, availablePlans: [plan()] });
  assert.match(offOut, /Not available online/); assert.doesNotMatch(offOut, /Subscribe with crypto/);
  const onOut = renderBillingPage({ ...base, availablePlans: [plan()], cryptoReady: true });
  assert.match(onOut, /Subscribe with crypto/); assert.doesNotMatch(onOut, /Not available online/);
  assert.match(onOut, /data-args="\[&quot;p1&quot;,&quot;nowpayments&quot;\]"/);
  // card-required trials hide unpriced plans today; crypto on lists them, crypto off still hides them
  assert.doesNotMatch(renderBillingPage({ ...base, availablePlans: [plan()], cardRequiredTrial: true }), /Starter/);
  assert.match(renderBillingPage({ ...base, availablePlans: [plan()], cardRequiredTrial: true, cryptoReady: true }), /Subscribe with crypto/);
  // a plan that has a Stripe price is rendered exactly as before
  assert.match(renderBillingPage({ ...base, availablePlans: [plan({ active_price_id: 'price_1' })], cryptoReady: true }), />Subscribe<\/button>/);
});

test('checkout route: a plan with no Stripe price goes to crypto when no gateway is named; an explicit choice and crypto-off are untouched', async () => {
  const real = globalThis.fetch; const invoices = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/invoice')) { const b = JSON.parse(init.body); invoices.push(b); return new Response(JSON.stringify({ id: '1', invoice_url: 'https://nowpayments.test/pay?iid=1', order_id: b.order_id }), { status: 200 }); }
    return real(url, init);
  };
  try {
    const on = env(ON); await addPlan(on);
    const s = await call(on, 'POST', '/api/customer/signup', { body: { email: 'a@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org' } });
    const P = `/api/organizations/${s.json.organizationId}/billing/checkout`;
    const crypto = await call(on, 'POST', P, { cookie: s.cookie, body: { planId: 'plan_zeta' } });
    assert.equal(crypto.status, 200, crypto.text); assert.equal(crypto.json.checkoutUrl, 'https://nowpayments.test/pay?iid=1');
    assert.equal(invoices.length, 1); assert.equal(invoices[0].price_amount, 12.34);
    const card = await call(on, 'POST', P, { cookie: s.cookie, body: { planId: 'plan_zeta', gateway: 'stripe' } });
    assert.equal(card.status, 409); assert.equal(card.json.error, 'plan_not_billing_configured'); assert.equal(invoices.length, 1);

    const off = env(); await addPlan(off);
    const s2 = await call(off, 'POST', '/api/customer/signup', { body: { email: 'b@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org' } });
    const refused = await call(off, 'POST', `/api/organizations/${s2.json.organizationId}/billing/checkout`, { cookie: s2.cookie, body: { planId: 'plan_zeta' } });
    assert.equal(refused.status, 409); assert.equal(refused.json.error, 'plan_not_billing_configured');
  } finally { globalThis.fetch = real; }
});
