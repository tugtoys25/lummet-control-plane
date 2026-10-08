// Customer checkout page: states, coupon box, server-built return URLs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as staff from '../worker/staff-saas.js';
import { renderBillingPage } from '../worker/views/customer-pages/billing.js';

const plan = (o = {}) => ({ id: 'p1', name: 'Starter', price_cents: 500, currency: 'USD', billing_period: 'monthly', trial_days: 7, stripe_price_id: 'price_1', ...o });
const base = { plan: null, invoices: [], canManage: true };

test('new customer: trial and subscribe buttons, coupon box, no cancel', () => {
  const out = renderBillingPage({ ...base, subscription: null, availablePlans: [plan()] });
  assert.match(out, /Start 7-day trial/); assert.match(out, /data-onclick="lummetCheckout" data-args="\[&quot;p1&quot;\]"/);
  assert.match(out, /id="coupon-code"/); assert.match(out, /Available plans/);
  assert.doesNotMatch(out, /Cancel at period end/);
});

test('plans without a Stripe price cannot be bought online', () => {
  const out = renderBillingPage({ ...base, subscription: null, availablePlans: [plan({ stripe_price_id: null })] });
  assert.match(out, /Not available online/); assert.doesNotMatch(out, /onclick="lummetCheckout/);
});

test('trial without a card can subscribe or cancel, and gets no second trial button', () => {
  const out = renderBillingPage({ ...base, subscription: { status: 'trialing', provider: null, trial_ends_at: '2026-12-01' }, plan: { name: 'Starter' }, availablePlans: [plan()] });
  assert.match(out, /no payment method on file/); assert.match(out, /data-onclick="lummetCheckout" data-args="\[&quot;p1&quot;\]"/);
  assert.match(out, /Cancel trial/); assert.doesNotMatch(out, /day trial<\/button>/);
});

test('paying customer: switch plan, cancel at period end, or keep subscription when cancelling', () => {
  const sub = { status: 'active', provider: 'stripe', cancel_at_period_end: 0 };
  const active = renderBillingPage({ ...base, subscription: sub, plan: { name: 'Starter' }, availablePlans: [plan({ id: 'p2', name: 'Pro' })] });
  assert.match(active, /Change plan/); assert.match(active, /data-onclick="lummetChangePlan" data-args="\[&quot;p2&quot;\]"/); assert.match(active, /Cancel at period end/);
  assert.doesNotMatch(active, /id="coupon-code"/);
  const ending = renderBillingPage({ ...base, subscription: { ...sub, cancel_at_period_end: 1 }, plan: { name: 'Starter' }, availablePlans: [] });
  assert.match(ending, /Keep my subscription/); assert.doesNotMatch(ending, /Cancel at period end<\/button>/);
});

test('members who cannot manage billing see no buttons; past due and return banners render; names are escaped', () => {
  const viewer = renderBillingPage({ ...base, canManage: false, subscription: null, availablePlans: [plan()] });
  assert.doesNotMatch(viewer, /onclick="lummet(Checkout|StartTrial)/);
  const due = renderBillingPage({ ...base, subscription: { status: 'past_due', provider: 'stripe' }, plan: { name: 'S' }, availablePlans: [] });
  assert.match(due, /last payment failed/);
  assert.match(renderBillingPage({ ...base, subscription: null, availablePlans: [], checkoutStatus: 'success' }), /confirming your payment/);
  assert.match(renderBillingPage({ ...base, subscription: null, availablePlans: [], checkoutStatus: 'canceled' }), /Nothing was charged/);
  assert.doesNotMatch(renderBillingPage({ ...base, subscription: null, availablePlans: [plan({ name: '<img src=x>' })] }), /<img src=x>/);
});

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', STRIPE_SECRET_KEY: 'sk_test_x', ...extra }; }
const ctx = { waitUntil() {} };
async function call(e, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.5' }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('route: checkout ignores client-supplied return URLs, uses the portal origin, and passes the coupon', async () => {
  const e = env({ PORTAL_BASE_URL: 'https://app.example.test' });
  await e.LUMMET_DB.prepare(`UPDATE plans SET stripe_price_id = 'price_x' WHERE id = 'plan_casino_news_starter'`).run();
  const s = await call(e, 'POST', '/api/customer/signup', { body: { email: 'co@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'O' } });
  const org = s.json.organizationId;
  assert.equal((await staff.createCoupon(e, { code: 'SAVE10', providerCouponId: 'stripe_s10', percentOff: 10 })).ok, true);

  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    sent.push({ url: String(u), body: init && init.body ? String(init.body) : '' });
    const json = String(u).endsWith('/customers') ? { id: 'cus_1' } : { id: 'cs_1', url: 'https://checkout.stripe.test/c/pay' };
    return new Response(JSON.stringify(json), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const r = await call(e, 'POST', `/api/organizations/${org}/billing/checkout`, { cookie: s.cookie, body: { planId: 'plan_casino_news_starter', couponCode: 'save10', successUrl: 'https://evil.example.com/steal', cancelUrl: 'https://evil.example.com/x' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.checkoutUrl, 'https://checkout.stripe.test/c/pay');
    const session = sent.find((x) => x.url.endsWith('/checkout/sessions'));
    const params = new URLSearchParams(session.body);
    assert.equal(params.get('success_url'), 'https://app.example.test/app/billing?checkout=success');
    assert.equal(params.get('cancel_url'), 'https://app.example.test/app/billing?checkout=canceled');
    assert.equal(session.body.includes('evil.example.com'), false);
    assert.ok(session.body.includes('stripe_s10'), 'coupon reached Stripe');
  } finally { globalThis.fetch = realFetch; }
});

test('route: /app/billing shows the checkout UI and honours ?checkout= only for known values', async () => {
  const e = env();
  const s = await call(e, 'POST', '/api/customer/signup', { body: { email: 'pg@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'O' } });
  const page = await call(e, 'GET', '/app/billing?checkout=success', { cookie: s.cookie });
  assert.equal(page.status, 200); assert.match(page.text, /confirming your payment/); assert.match(page.text, /Available plans/);
  assert.doesNotMatch((await call(e, 'GET', '/app/billing?checkout=%3Cscript%3E', { cookie: s.cookie })).text, /confirming your payment|<script>alert/);
});
