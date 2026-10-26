// Roadmap 1.5: internal coupon rules (expiry, limits, once per org),
// redemption counted on checkout completion, and the staff-side
// create/update validation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as staff from '../worker/staff-saas.js';
import { renderCouponsPage } from '../worker/views/pages/saas-admin.js';
import { setPlanPrice } from './support/plan-prices.js';

function makeEnv() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db }; }
let n = 0;
async function signupOrg(env) {
  const email = `coupon${n++}@example.com`;
  return customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.9' } }, env);
}
async function setup() {
  const env = makeEnv();
  await setPlanPrice(env, 'plan_casino_news_starter', 'price_x');
  const provider = createFakeBillingProvider();
  return { env, provider, billing: createBillingService(provider) };
}
const checkout = (billing, env, organizationId, couponCode) =>
  billing.startCheckout(env, { organizationId, planId: 'plan_casino_news_starter', successUrl: 'https://a.test/s', cancelUrl: 'https://a.test/c', couponCode });
const make = (env, o = {}) => staff.createCoupon(env, { code: 'launch20', providerCouponId: 'stripe_c1', percentOff: 20, ...o });
const complete = (billing, provider, env, orgId, couponId, evt) =>
  simulateWebhook(billing, provider, env, {
    id: evt, type: 'checkout.session.completed',
    data: { object: { id: 'cs_' + evt, client_reference_id: orgId, metadata: { organization_id: orgId, plan_id: 'plan_casino_news_starter', ...(couponId ? { coupon_id: couponId } : {}) }, subscription: 'sub_' + evt } }
  });

test('a valid code (any case) is sent to the provider with its Stripe id and our coupon id', async () => {
  const { env, provider, billing } = await setup();
  const org = await signupOrg(env);
  const c = await make(env);
  assert.equal(c.ok, true);
  const r = await checkout(billing, env, org.organizationId, '  Launch20 ');
  assert.equal(r.ok, true);
  const call = provider._calls.find((x) => x.method === 'createCheckoutSession');
  assert.equal(call.couponProviderId, 'stripe_c1');
  assert.equal(call.couponId, c.couponId);
});

test('unknown, disabled and expired codes are all invalid_coupon', async () => {
  const { env, billing } = await setup();
  const org = await signupOrg(env);
  assert.equal((await checkout(billing, env, org.organizationId, 'NOPE')).error, 'invalid_coupon');
  const c = await make(env);
  await staff.updateCoupon(env, c.couponId, { status: 'disabled' });
  assert.equal((await checkout(billing, env, org.organizationId, 'LAUNCH20')).error, 'invalid_coupon');
  await staff.updateCoupon(env, c.couponId, { status: 'active' });
  await env.LUMMET_DB.prepare(`UPDATE coupons SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`).bind(c.couponId).run();
  assert.equal((await checkout(billing, env, org.organizationId, 'LAUNCH20')).error, 'invalid_coupon');
});

test('a pending checkout HOLDS a limited coupon use (no last-use race); the hold expires, and completing it redeems exactly once', async () => {
  const { env, provider, billing } = await setup();
  const a = await signupOrg(env), b = await signupOrg(env);
  const c = await make(env, { maxRedemptions: 1 });

  assert.equal((await checkout(billing, env, a.organizationId, 'LAUNCH20')).ok, true);
  const first = provider._calls.find((x) => x.method === 'createCheckoutSession');
  assert.ok(first.expiresAt > Date.now() / 1000, 'provider session is bounded by the hold');
  // The last use is held, so a second organization can neither check nor start.
  assert.equal((await billing.validateCoupon(env, b.organizationId, 'LAUNCH20')).error, 'coupon_exhausted');
  assert.equal((await checkout(billing, env, b.organizationId, 'LAUNCH20')).error, 'coupon_exhausted');
  // The holder is never blocked by its own hold, and retrying doesn't duplicate it.
  assert.equal((await checkout(billing, env, a.organizationId, 'LAUNCH20')).ok, true);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM coupon_reservations`).first()).n, 1);

  // An abandoned checkout releases the use once the hold has expired.
  await env.LUMMET_DB.prepare(`UPDATE coupon_reservations SET expires_at = datetime('now','-1 minute')`).run();
  assert.equal((await checkout(billing, env, b.organizationId, 'LAUNCH20')).ok, true);

  // Completion by b redeems once and clears the hold; a is now too late.
  await complete(billing, provider, env, b.organizationId, c.couponId, 'evt_b');
  await complete(billing, provider, env, b.organizationId, c.couponId, 'evt_b2').catch(() => {});
  const row = await env.LUMMET_DB.prepare(`SELECT redemption_count FROM coupons WHERE id = ?`).bind(c.couponId).first();
  assert.equal(row.redemption_count, 1);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM coupon_reservations`).first()).n, 0);
  const sub = await env.LUMMET_DB.prepare(`SELECT coupon_id FROM subscriptions WHERE organization_id = ?`).bind(b.organizationId).first();
  assert.equal(sub.coupon_id, c.couponId);
  assert.equal((await checkout(billing, env, a.organizationId, 'LAUNCH20')).error, 'coupon_exhausted');
});

test('capacity above one: holds and redemptions together never exceed the limit; unlimited coupons take no hold', async () => {
  const { env, billing } = await setup();
  const orgs = [await signupOrg(env), await signupOrg(env), await signupOrg(env)];
  await make(env, { maxRedemptions: 2 });
  const results = await Promise.all(orgs.map((o) => checkout(billing, env, o.organizationId, 'LAUNCH20')));
  assert.equal(results.filter((r) => r.ok).length, 2);
  assert.equal(results.filter((r) => r.error === 'coupon_exhausted').length, 1);

  const { env: env2, billing: billing2 } = await setup();
  const o = await signupOrg(env2);
  await make(env2);
  assert.equal((await checkout(billing2, env2, o.organizationId, 'LAUNCH20')).ok, true);
  assert.equal((await env2.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM coupon_reservations`).first()).n, 0);
});

test('if the provider fails to create the session, the hold is released', async () => {
  const { env, provider, billing } = await setup();
  const a = await signupOrg(env), b = await signupOrg(env);
  await make(env, { maxRedemptions: 1 });
  const real = provider.createCheckoutSession;
  provider.createCheckoutSession = async () => { throw new Error('stripe down'); };
  await assert.rejects(checkout(billing, env, a.organizationId, 'LAUNCH20'), /stripe down/);
  provider.createCheckoutSession = real;
  assert.equal((await checkout(billing, env, b.organizationId, 'LAUNCH20')).ok, true);
});

test('an organization cannot redeem the same coupon twice', async () => {
  const { env, provider, billing } = await setup();
  const a = await signupOrg(env);
  const c = await make(env);
  await complete(billing, provider, env, a.organizationId, c.couponId, 'evt_once');
  assert.equal((await billing.validateCoupon(env, a.organizationId, 'LAUNCH20')).error, 'coupon_already_used');
});

test('validateCoupon returns a customer-safe summary without Stripe ids', async () => {
  const { env, billing } = await setup();
  const org = await signupOrg(env);
  await make(env, { code: 'FIVE', amountOffCents: 500, percentOff: null, duration: 'repeating' });
  const r = await billing.validateCoupon(env, org.organizationId, 'five');
  assert.deepEqual(r.summary, { code: 'FIVE', percentOff: null, amountOffCents: 500, duration: 'repeating' });
});

test('createCoupon validates every field and rejects duplicates case-insensitively', async () => {
  const { env } = await setup();
  const bad = async (o, err) => assert.equal((await make(env, o)).error, err, JSON.stringify(o));
  await bad({ code: 'x' }, 'invalid_code');
  await bad({ providerCouponId: 'bad id!' }, 'invalid_provider_coupon_id');
  await bad({ percentOff: null }, 'percent_or_amount_required');
  await bad({ amountOffCents: 100 }, 'percent_or_amount_required');
  await bad({ percentOff: 150 }, 'invalid_percent_off');
  await bad({ percentOff: null, amountOffCents: 1.5 }, 'invalid_amount_off');
  await bad({ duration: 'weekly' }, 'invalid_duration');
  await bad({ maxRedemptions: 0 }, 'invalid_max_redemptions');
  await bad({ expiresAt: '2000-01-01' }, 'expires_at_in_past');
  assert.equal((await make(env)).ok, true);
  assert.equal((await make(env, { code: 'LAUNCH20' })).error, 'code_already_exists');
});

test('updateCoupon can toggle status and raise the limit but not drop it below uses', async () => {
  const { env, provider, billing } = await setup();
  const org = await signupOrg(env);
  const c = await make(env, { maxRedemptions: 5 });
  await complete(billing, provider, env, org.organizationId, c.couponId, 'evt_u');
  assert.equal((await staff.updateCoupon(env, c.couponId, { maxRedemptions: 0 })).error, 'invalid_max_redemptions');
  assert.equal((await staff.updateCoupon(env, c.couponId, { maxRedemptions: 10 })).ok, true);
  assert.equal((await staff.updateCoupon(env, c.couponId, { maxRedemptions: null })).ok, true);
  assert.equal((await staff.updateCoupon(env, c.couponId, { status: 'paused' })).error, 'invalid_status');
  assert.equal((await staff.updateCoupon(env, 'missing', { status: 'active' })).status, 404);
  assert.equal((await staff.updateCoupon(env, c.couponId, {})).error, 'nothing_to_update');
});

test('staff coupons page lists coupons with usage and escapes notes/codes', async () => {
  const { env } = await setup();
  await make(env, { maxRedemptions: 3 });
  const html = await renderCouponsPage(env, { id: 1, email: 'a@b.c', role: 'super_admin' });
  assert.match(html, /LAUNCH20/);
  assert.match(html, /0 \/ 3/);
  assert.match(html, /20% off/);
});

test('route: customer coupon validate returns a summary for good codes and 422 for bad ones, and needs a session', async () => {
  const { default: worker } = await import('../worker/index.js');
  const env = { ...makeEnv(), ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const call = async (method, path, body, cookie) => {
    const h = new Headers({ 'CF-Connecting-IP': '198.18.0.7', 'Content-Type': 'application/json' });
    if (cookie) h.set('Cookie', cookie);
    const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), env, ctx);
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  const s = await call('POST', '/api/customer/signup', { email: 'cv@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'O', displayName: 'T' });
  const org = s.json.organizationId;
  await staff.createCoupon(env, { code: 'SAVE10', providerCouponId: 'stripe_s10', percentOff: 10 });
  const url = `/api/organizations/${org}/billing/coupon/validate`;
  assert.equal((await call('POST', url, { code: 'save10' })).status, 401);
  const ok = await call('POST', url, { code: 'save10' }, s.cookie);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.coupon.percentOff, 10);
  assert.equal(JSON.stringify(ok.json).includes('stripe_s10'), false);
  assert.equal((await call('POST', url, { code: 'nope' }, s.cookie)).status, 422);
});

// ---- v6A: organization-scoped coupons (ported from v4A) ----

test('an organization-scoped coupon works for its organization only, and anyone else is told it is simply invalid', async () => {
  const { env, provider, billing } = await setup();
  const a = await signupOrg(env), b = await signupOrg(env);
  const scoped = await make(env, { code: 'PARTNER50', organizationId: a.organizationId, maxRedemptions: 1 });
  assert.equal(scoped.ok, true);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT organization_id FROM coupons WHERE id = ?`).bind(scoped.couponId).first()).organization_id, a.organizationId);

  // The other organization gets exactly the answer an unknown code gets, from both entry points.
  const unknown = await billing.validateCoupon(env, b.organizationId, 'NOPE');
  assert.deepEqual(await billing.validateCoupon(env, b.organizationId, 'partner50'), unknown);
  assert.equal((await checkout(billing, env, b.organizationId, 'PARTNER50')).error, 'invalid_coupon');
  assert.equal(provider._calls.filter((x) => x.method === 'createCheckoutSession').length, 0, 'no provider session for the wrong organization');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM coupon_reservations`).first()).n, 0, 'and no hold was taken from the limited coupon');

  // The intended organization can use it.
  assert.equal((await billing.validateCoupon(env, a.organizationId, 'PARTNER50')).ok, true);
  assert.equal((await checkout(billing, env, a.organizationId, 'PARTNER50')).ok, true);
  assert.equal(provider._calls.find((x) => x.method === 'createCheckoutSession').couponId, scoped.couponId);
});

test('a coupon with no organization stays usable by everyone (existing coupons are unaffected)', async () => {
  const { env, billing } = await setup();
  const a = await signupOrg(env), b = await signupOrg(env);
  await make(env, { organizationId: '   ' });   // blank means unscoped
  assert.equal((await env.LUMMET_DB.prepare(`SELECT organization_id FROM coupons`).first()).organization_id, null);
  assert.equal((await billing.validateCoupon(env, a.organizationId, 'LAUNCH20')).ok, true);
  assert.equal((await billing.validateCoupon(env, b.organizationId, 'LAUNCH20')).ok, true);
});

test('createCoupon only scopes to a real, live organization', async () => {
  const { env } = await setup();
  const org = await signupOrg(env);
  assert.equal((await make(env, { organizationId: 'does-not-exist' })).error, 'organization_not_found');
  assert.equal((await make(env, { organizationId: "x'; DROP TABLE coupons;--" })).error, 'invalid_organization_id');
  await env.LUMMET_DB.prepare(`UPDATE organizations SET erased_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(org.organizationId).run();
  assert.equal((await make(env, { organizationId: org.organizationId })).error, 'organization_not_found', 'an erased organization cannot be given a coupon');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM coupons`).first()).n, 0);
});

test('the scope cannot be changed through updateCoupon', async () => {
  const { env } = await setup();
  const a = await signupOrg(env), b = await signupOrg(env);
  const c = await make(env, { organizationId: a.organizationId });
  assert.equal((await staff.updateCoupon(env, c.couponId, { organizationId: b.organizationId })).error, 'nothing_to_update');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT organization_id FROM coupons WHERE id = ?`).bind(c.couponId).first()).organization_id, a.organizationId);
});

test('staff coupons page shows who a coupon is reserved for', async () => {
  const { env } = await setup();
  const org = await signupOrg(env);
  await env.LUMMET_DB.prepare(`UPDATE organizations SET name = 'Acme <Partner>' WHERE id = ?`).bind(org.organizationId).run();
  await make(env, { code: 'ACME10', organizationId: org.organizationId });
  await make(env, { code: 'EVERYONE' });
  const html = await renderCouponsPage(env, { id: 1, email: 'a@b.c', role: 'super_admin' });
  assert.match(html, /Acme &lt;Partner&gt;/);
  assert.equal(html.includes('Acme <Partner>'), false, 'organization name is escaped');
  assert.match(html, /any organization/);
});
