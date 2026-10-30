// NOWPayments gateway + gateway switch. Network is stubbed (globalThis.fetch); everything else is the real code over an in-memory D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider } from './support/fake-billing-provider.js';
import worker from '../worker/index.js';
import { __setBillingProviderForTests } from '../worker/billing.js';
import * as np from '../worker/billing-nowpayments.js';
import * as gateways from '../worker/billing-gateways.js';
import { cryptoBilling } from '../worker/billing-nowpayments-service.js';

const ctx = { waitUntil() {} };
const SECRET = 'ipn-secret-test';
let n = 1;
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), PORTAL_BASE_URL: 'https://cp.test', ...extra };
}
const NP_ENV = { NOWPAYMENTS_API_KEY: 'np_key', NOWPAYMENTS_IPN_SECRET: SECRET };
async function call(env, method, path, { body, cookie, headers = {}, raw } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${n++ % 250 + 1}`, ...headers });
  if (cookie) h.set('Cookie', cookie);
  if (body !== undefined || raw !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(env, email) {
  const s = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } });
  return { orgId: s.json.organizationId, cookie: s.cookie };
}
async function addPlan(env, id = 'plan_np', cents = 2500, period = 'monthly') {
  await env.LUMMET_DB.prepare(`INSERT INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status) VALUES (?, 'prod_casino_news', ?, 'NP Plan', ?, ?, 'USD', 0, 'active')`).bind(id, 'k_' + id, period, cents).run();
}
async function sign(payload, secret = SECRET) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(JSON.stringify(np.sortKeysDeep(payload))));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// Stubs NOWPayments: POST /invoice records the order id; GET /payment/:id answers from `payments`.
function stubNowPayments(payments = {}) {
  const real = globalThis.fetch; const seen = { invoices: [], gets: [] };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/invoice')) { const body = JSON.parse(init.body); seen.invoices.push(body); return new Response(JSON.stringify({ id: '4522625843', invoice_url: 'https://nowpayments.test/payment/?iid=4522625843', order_id: body.order_id }), { status: 200 }); }
    const m = String(url).match(/\/payment\/(\d+)$/);
    if (m) { seen.gets.push(m[1]); return new Response(JSON.stringify(payments[m[1]] || { message: 'not found' }), { status: payments[m[1]] ? 200 : 404 }); }
    return new Response('{}', { status: 404 });
  };
  return { seen, restore: () => { globalThis.fetch = real; } };
}
async function ipn(env, payload, { secret = SECRET } = {}) {
  return call(env, 'POST', '/api/billing/webhook/nowpayments', { raw: JSON.stringify(payload), headers: { 'x-nowpayments-sig': await sign(payload, secret) } });
}
async function startCrypto(env, orgId, planId = 'plan_np') {
  const r = await cryptoBilling.startCryptoCheckout(env, { organizationId: orgId, planId, successUrl: 'https://cp.test/ok', cancelUrl: 'https://cp.test/no', ipnUrl: 'https://cp.test/api/billing/webhook/nowpayments' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (await env.LUMMET_DB.prepare('SELECT * FROM crypto_checkouts WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').bind(orgId).first());
}

// ---------- signature ----------
test('IPN signature: key order does not matter, any change or wrong secret is refused, missing pieces are refused', async () => {
  const payload = { payment_id: 5077125051, payment_status: 'finished', order_id: 'o1', price_amount: 25, nested: { b: 1, a: 2 } };
  const mk = async (body, sig, env = NP_ENV) => np.verifyAndParseWebhook(new Request('https://x.test/w', { method: 'POST', headers: sig ? { 'x-nowpayments-sig': sig } : {}, body }), env);
  const good = await sign(payload);
  const reordered = JSON.stringify({ nested: { a: 2, b: 1 }, order_id: 'o1', price_amount: 25, payment_status: 'finished', payment_id: 5077125051 });
  const v = await mk(reordered, good);
  assert.equal(v.valid, true); assert.equal(v.event.type, 'nowpayments.payment.finished'); assert.equal(v.event.id, 'np_5077125051_finished');
  assert.equal((await mk(JSON.stringify({ ...payload, price_amount: 1 }), good)).reason, 'signature_mismatch');
  assert.equal((await mk(JSON.stringify(payload), await sign(payload, 'other'))).reason, 'signature_mismatch');
  assert.equal((await mk(JSON.stringify(payload), null)).reason, 'missing_signature');
  assert.equal((await mk('not json', good)).reason, 'invalid_json');
  assert.equal((await mk(JSON.stringify(payload), good, {})).reason, 'webhook_secret_not_configured');
  assert.equal((await mk(JSON.stringify(payload), await sign(payload, 'old'), { ...NP_ENV, NOWPAYMENTS_IPN_SECRET_PREVIOUS: 'old' })).valid, true);
});

// ---------- gateway switch ----------
test('switch: fresh install is Stripe-only; NOWPayments needs secrets AND the switch; the last gateway cannot be switched off; every change is recorded', async () => {
  const env = makeEnv();
  assert.deepEqual((await gateways.availableGateways(env)).map((g) => g.gateway), ['stripe']);
  assert.equal((await gateways.setGatewayEnabled(env, { gateway: 'nowpayments', enabled: true, actorId: 'staff:1', reason: 'r' })).error, 'gateway_not_configured');
  assert.equal((await gateways.setGatewayEnabled(env, { gateway: 'stripe', enabled: false, actorId: 'staff:1', reason: 'r' })).error, 'cannot_disable_last_gateway');

  const env2 = { ...env, ...NP_ENV };
  assert.equal((await gateways.setGatewayEnabled(env2, { gateway: 'nowpayments', enabled: true, actorId: 'staff:1', reason: '' })).error, 'reason_required');
  assert.equal((await gateways.setGatewayEnabled(env2, { gateway: 'nowpayments', enabled: true, actorId: 'staff:1', reason: 'Stripe account restricted' })).ok, true);
  assert.deepEqual((await gateways.availableGateways(env2)).map((g) => g.gateway), ['stripe', 'nowpayments']);
  assert.equal((await gateways.setGatewayEnabled(env2, { gateway: 'stripe', enabled: false, actorId: 'staff:1', reason: 'restricted' })).ok, true);
  assert.deepEqual((await gateways.availableGateways(env2)).map((g) => g.gateway), ['nowpayments']);
  assert.equal((await gateways.resolveGateway(env2, 'stripe')).error, 'gateway_unavailable');
  assert.equal((await gateways.resolveGateway(env2)).gateway, 'nowpayments');
  assert.equal((await gateways.resolveGateway(env2, 'paypal')).error, 'unknown_gateway');
  assert.equal((await gateways.listGatewayEvents(env2)).length, 2);
  // Secrets removed later while Stripe is off: nothing is offered, and checkout says so plainly instead of failing inside a provider.
  assert.deepEqual(await gateways.availableGateways(env), []);
  assert.deepEqual(await gateways.resolveGateway(env), { ok: false, status: 503, error: 'no_payment_gateway_available', available: [] });
});

test('switch: with the migration missing, behaviour is exactly the legacy Stripe-only path', async () => {
  const env = makeEnv(NP_ENV);
  await env.LUMMET_DB.prepare('DROP TABLE payment_gateways').run();
  assert.deepEqual((await gateways.availableGateways(env)).map((g) => g.gateway), ['stripe']);
});

// ---------- routes ----------
test('route: default checkout still goes to Stripe; naming nowpayments while it is off is refused', async (t) => {
  const fake = createFakeBillingProvider(); __setBillingProviderForTests(fake); t.after(() => __setBillingProviderForTests(null));
  const env = makeEnv(NP_ENV); const a = await signup(env, 'a@example.com'); await addPlan(env);
  const off = await call(env, 'POST', `/api/organizations/${a.orgId}/billing/checkout`, { cookie: a.cookie, body: { planId: 'plan_np', gateway: 'nowpayments' } });
  assert.equal(off.status, 409); assert.equal(off.json.error, 'gateway_unavailable'); assert.deepEqual(off.json.available, ['stripe']);
  const listed = await call(env, 'GET', `/api/organizations/${a.orgId}/billing/gateways`, { cookie: a.cookie });
  assert.deepEqual(listed.json.data.map((g) => g.gateway), ['stripe']);
});

test('route: with Stripe switched off, checkout is refused for Stripe and offered for crypto; webhooks stay open for both', async () => {
  const env = makeEnv(NP_ENV); const a = await signup(env, 'b@example.com'); await addPlan(env);
  await gateways.setGatewayEnabled(env, { gateway: 'nowpayments', enabled: true, actorId: 'staff:1', reason: 'go' });
  await gateways.setGatewayEnabled(env, { gateway: 'stripe', enabled: false, actorId: 'staff:1', reason: 'restricted' });
  const stub = stubNowPayments();
  try {
    const stripeTry = await call(env, 'POST', `/api/organizations/${a.orgId}/billing/checkout`, { cookie: a.cookie, body: { planId: 'plan_np', gateway: 'stripe' } });
    assert.equal(stripeTry.json.error, 'gateway_unavailable');
    const r = await call(env, 'POST', `/api/organizations/${a.orgId}/billing/checkout`, { cookie: a.cookie, body: { planId: 'plan_np' } });
    assert.equal(r.status, 200, r.text); assert.match(r.json.checkoutUrl, /nowpayments\.test/);
    assert.equal(stub.seen.invoices[0].price_amount, 25); assert.equal(stub.seen.invoices[0].price_currency, 'usd');
    assert.equal(stub.seen.invoices[0].ipn_callback_url, 'https://cp.test/api/billing/webhook/nowpayments');
    // The Stripe webhook route is still reachable (unsigned -> refused by signature, not by the switch).
    assert.equal((await call(env, 'POST', '/api/billing/webhook/stripe', { raw: '{}' })).status, 400);
  } finally { stub.restore(); }
});

test('route: staff switch endpoint is super-admin only, needs a reason, refuses the last gateway, and is audited', async () => {
  const env = makeEnv(NP_ENV);
  assert.equal((await call(env, 'PUT', '/api/platform/saas/payment-gateways/nowpayments', { body: { enabled: true, reason: 'x' } })).status, 401);
  assert.equal((await call(env, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).status, 200);
  const cookie = (await call(env, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
  const put = (gw, body) => call(env, 'PUT', `/api/platform/saas/payment-gateways/${gw}`, { cookie, body });

  const list = await call(env, 'GET', '/api/platform/saas/payment-gateways', { cookie });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.data.map((g) => [g.gateway, g.enabled, g.available]), [['stripe', true, true], ['nowpayments', false, false]]);

  assert.equal((await put('nowpayments', { enabled: true })).json.error, 'reason_required');
  assert.equal((await put('stripe', { enabled: false, reason: 'test' })).json.error, 'cannot_disable_last_gateway');
  assert.equal((await put('paypal', { enabled: true, reason: 'test' })).status, 404);
  const on = await put('nowpayments', { enabled: true, reason: 'Stripe account restricted' });
  assert.equal(on.status, 200, on.text);
  assert.deepEqual(on.json.data.map((g) => g.available), [true, true]);
  const off = await put('stripe', { enabled: false, reason: 'Stripe restricted our account' });
  assert.equal(off.status, 200, off.text);
  const events = (await call(env, 'GET', '/api/platform/saas/payment-gateways', { cookie })).json.events;
  assert.deepEqual(events.map((e) => [e.gateway, e.action]), [['stripe', 'disable'], ['nowpayments', 'enable']]);
  const audited = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM audit_log WHERE resource = 'payment_gateway' AND success = 1`).first().catch(() => null);
  if (audited) assert.equal(audited.c, 2);
});

// ---------- payment flow ----------
test('flow: finished payment activates the subscription, records invoice + payment, and a redelivered IPN changes nothing', async () => {
  const env = makeEnv(NP_ENV); const a = await signup(env, 'c@example.com'); await addPlan(env);
  const real = globalThis.fetch;
  const stub = stubNowPayments();
  try {
    const co = await startCrypto(env, a.orgId);
    stub.seen.payments = { 777: { payment_id: 777, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' } };
    stubNowPayments({ 777: { payment_id: 777, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' } });
    const payload = { payment_id: 777, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' };

    const waiting = await ipn(env, { ...payload, payment_status: 'waiting' });
    assert.equal(waiting.status, 200);
    assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM subscriptions WHERE organization_id=?').bind(a.orgId).first())?.status === 'active', false);

    assert.equal((await ipn(env, payload)).status, 200);
    const sub = await env.LUMMET_DB.prepare('SELECT * FROM subscriptions WHERE organization_id=? ORDER BY created_at DESC').bind(a.orgId).first();
    assert.equal(sub.status, 'active'); assert.equal(sub.provider, 'nowpayments'); assert.equal(sub.plan_id, 'plan_np');
    assert.ok(Date.parse(sub.current_period_end) > Date.now() + 27 * 86400000);
    const inv = await env.LUMMET_DB.prepare('SELECT * FROM invoices WHERE organization_id=?').bind(a.orgId).first();
    assert.equal(inv.status, 'paid'); assert.equal(inv.amount_paid_cents, 2500); assert.equal(inv.provider, 'nowpayments');
    assert.equal((await env.LUMMET_DB.prepare('SELECT COUNT(*) c FROM payments WHERE organization_id=?').bind(a.orgId).first()).c, 1);
    assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM crypto_checkouts WHERE id=?').bind(co.id).first()).status, 'paid');

    const again = await ipn(env, payload);
    assert.equal(again.status, 200);
    assert.equal((await env.LUMMET_DB.prepare('SELECT COUNT(*) c FROM subscriptions WHERE organization_id=?').bind(a.orgId).first()).c, 1);
    assert.equal((await env.LUMMET_DB.prepare('SELECT COUNT(*) c FROM invoices WHERE organization_id=?').bind(a.orgId).first()).c, 1);
  } finally { globalThis.fetch = real; }
});

test('flow: a forged or mismatched payment grants nothing (wrong signature, wrong amount, not finished at NOWPayments, unknown order)', async () => {
  const env = makeEnv(NP_ENV); const a = await signup(env, 'd@example.com'); await addPlan(env);
  const real = globalThis.fetch;
  try {
    stubNowPayments(); const co = await startCrypto(env, a.orgId);
    const payload = { payment_id: 888, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' };
    const subCount = async () => (await env.LUMMET_DB.prepare('SELECT COUNT(*) c FROM subscriptions WHERE organization_id=? AND provider=?').bind(a.orgId, 'nowpayments').first()).c;

    assert.equal((await ipn(env, payload, { secret: 'attacker' })).status, 400);
    assert.equal(await subCount(), 0);

    stubNowPayments({ 888: { payment_id: 888, payment_status: 'finished', order_id: co.id, price_amount: 1, price_currency: 'usd' } });
    assert.equal((await ipn(env, payload)).status, 500);                       // amount mismatch -> failed event, redelivery retries
    assert.equal(await subCount(), 0);

    stubNowPayments({ 888: { payment_id: 888, payment_status: 'waiting', order_id: co.id, price_amount: 25, price_currency: 'usd' } });
    assert.equal((await ipn(env, payload)).status, 500);                       // body says finished, NOWPayments says otherwise
    assert.equal(await subCount(), 0);

    const unknown = { ...payload, payment_id: 999, order_id: 'someone-elses-order' };
    assert.equal((await ipn(env, unknown)).status, 200);                       // not ours: ignored, not retried forever
    assert.equal(await subCount(), 0);

    const partial = { ...payload, payment_id: 889, payment_status: 'partially_paid' };
    assert.equal((await ipn(env, partial)).status, 200);
    assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM crypto_checkouts WHERE id=?').bind(co.id).first()).status, 'partially_paid');
    assert.equal(await subCount(), 0);

    // The failed event is retried by redelivery and succeeds once NOWPayments agrees.
    stubNowPayments({ 888: { payment_id: 888, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' } });
    assert.equal((await ipn(env, payload)).status, 200);
    assert.equal(await subCount(), 1);
  } finally { globalThis.fetch = real; }
});

test('flow: renewing early extends from the paid period end; a lapsed period becomes past_due; cancel-at-period-end lapses to canceled', async () => {
  const env = makeEnv(NP_ENV); const a = await signup(env, 'e@example.com'); await addPlan(env);
  const real = globalThis.fetch;
  try {
    for (const [pid, i] of [[1001, 0], [1002, 1]]) {
      stubNowPayments(); const co = await startCrypto(env, a.orgId);
      stubNowPayments({ [pid]: { payment_id: pid, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' } });
      assert.equal((await ipn(env, { payment_id: pid, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' })).status, 200);
      const subs = (await env.LUMMET_DB.prepare('SELECT * FROM subscriptions WHERE organization_id=?').bind(a.orgId).all()).results;
      assert.equal(subs.length, 1);
      if (i === 1) assert.ok(Date.parse(subs[0].current_period_end) > Date.now() + 58 * 86400000, 'second payment adds a second period on top');
    }
    const sub = await env.LUMMET_DB.prepare('SELECT * FROM subscriptions WHERE organization_id=?').bind(a.orgId).first();
    assert.equal((await env.LUMMET_DB.prepare('SELECT COUNT(*) c FROM invoices WHERE organization_id=?').bind(a.orgId).first()).c, 2);

    assert.deepEqual(await cryptoBilling.expireLapsedPeriods(env, Date.now()), { pastDue: 0, canceled: 0 });
    assert.deepEqual(await cryptoBilling.expireLapsedPeriods(env, Date.now() + 70 * 86400000), { pastDue: 1, canceled: 0 });
    const lapsed = await env.LUMMET_DB.prepare('SELECT status, grace_ends_at FROM subscriptions WHERE id=?').bind(sub.id).first();
    assert.equal(lapsed.status, 'past_due'); assert.ok(lapsed.grace_ends_at);
    assert.deepEqual(await cryptoBilling.expireLapsedPeriods(env, Date.now() + 70 * 86400000), { pastDue: 0, canceled: 0 });  // idempotent

    // Paying again recovers it.
    stubNowPayments(); const co = await startCrypto(env, a.orgId);
    stubNowPayments({ 1003: { payment_id: 1003, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' } });
    assert.equal((await ipn(env, { payment_id: 1003, payment_status: 'finished', order_id: co.id, price_amount: 25, price_currency: 'usd' })).status, 200);
    assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM subscriptions WHERE id=?').bind(sub.id).first()).status, 'active');

    await env.LUMMET_DB.prepare('UPDATE subscriptions SET cancel_at_period_end=1 WHERE id=?').bind(sub.id).run();
    assert.deepEqual(await cryptoBilling.expireLapsedPeriods(env, Date.now() + 200 * 86400000), { pastDue: 0, canceled: 1 });
  } finally { globalThis.fetch = real; }
});

test('checkout guards: coupons refused, Stripe subscribers refused, custom plans refused; NOWPayments error marks the checkout failed', async () => {
  const env = makeEnv(NP_ENV); const a = await signup(env, 'f@example.com'); await addPlan(env);
  const args = { organizationId: a.orgId, planId: 'plan_np', successUrl: 'https://cp.test/ok', cancelUrl: 'https://cp.test/no', ipnUrl: 'https://cp.test/w' };
  assert.equal((await cryptoBilling.startCryptoCheckout(env, { ...args, couponCode: 'X' })).error, 'coupon_not_supported_for_gateway');
  assert.equal((await cryptoBilling.startCryptoCheckout(env, { ...args, planId: 'nope' })).error, 'invalid_plan');
  await env.LUMMET_DB.prepare(`INSERT INTO plans (id, product_id, key, name, billing_period, price_cents, status) VALUES ('plan_custom','prod_casino_news','k_custom','C','custom',NULL,'active')`).run();
  assert.equal((await cryptoBilling.startCryptoCheckout(env, { ...args, planId: 'plan_custom' })).error, 'plan_not_billing_configured');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ message: 'bad key' }), { status: 403 });
    await assert.rejects(() => cryptoBilling.startCryptoCheckout(env, args), (e) => e.kind === 'rejected');
    assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM crypto_checkouts WHERE organization_id=?').bind(a.orgId).first()).status, 'failed');
    await env.LUMMET_DB.prepare(`INSERT INTO subscriptions (id, organization_id, plan_id, status, provider, provider_subscription_id) VALUES ('s1', ?, 'plan_np', 'active', 'stripe', 'sub_x')`).bind(a.orgId).run();
    assert.equal((await cryptoBilling.startCryptoCheckout(env, args)).error, 'organization_already_subscribed');
  } finally { globalThis.fetch = real; }
});

// ---------- wrangler.jsonc override (PAYMENT_GATEWAYS) ----------
test('config override: PAYMENT_GATEWAYS decides which gateways are on and their order; the database switch and staff PUT stand down', async () => {
  const env = makeEnv({ ...NP_ENV, PAYMENT_GATEWAYS: 'nowpayments' });
  assert.deepEqual((await gateways.availableGateways(env)).map((g) => g.gateway), ['nowpayments']);
  assert.equal((await gateways.listGateways(env)).every((g) => g.source === 'config'), true);
  assert.equal((await gateways.resolveGateway(env)).gateway, 'nowpayments');
  assert.equal((await gateways.resolveGateway(env, 'stripe')).error, 'gateway_unavailable');
  assert.equal((await gateways.setGatewayEnabled(env, { gateway: 'stripe', enabled: true, actorId: 'staff:1', reason: 'r' })).error, 'controlled_by_config');

  const both = { ...env, PAYMENT_GATEWAYS: ' NOWPayments , stripe ' };            // order = offer order; case and spaces tolerated
  assert.deepEqual((await gateways.availableGateways(both)).map((g) => g.gateway), ['nowpayments', 'stripe']);
  assert.equal((await gateways.resolveGateway(both)).gateway, 'nowpayments');
  assert.equal((await gateways.resolveGateway({ ...env, PAYMENT_GATEWAYS: 'stripe,nowpayments' })).gateway, 'stripe');
});

test('config override: empty or unrecognised values leave the database switch in charge; a listed gateway without secrets is not offered', async () => {
  const dbOnly = makeEnv({ ...NP_ENV });
  for (const value of [undefined, '', '   ', 'paypal', 'bitcoin,card']) {
    const env = { ...dbOnly, PAYMENT_GATEWAYS: value };
    assert.equal(gateways.configOverride(env), null);
    assert.deepEqual((await gateways.availableGateways(env)).map((g) => g.gateway), ['stripe']);
    assert.equal((await gateways.listGateways(env))[0].source, 'database');
  }
  const noSecrets = makeEnv({ PAYMENT_GATEWAYS: 'nowpayments' });
  assert.deepEqual(await gateways.availableGateways(noSecrets), []);
  assert.deepEqual(await gateways.resolveGateway(noSecrets), { ok: false, status: 503, error: 'no_payment_gateway_available', available: [] });
});
