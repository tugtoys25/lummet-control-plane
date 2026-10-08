// test/billing-stripe.test.js
//
// Covers the parts of billing-stripe.js that don't require a live
// Stripe account: HMAC webhook signature verification (built and
// verified with the same Web Crypto API the Worker runtime provides
// -- no network involved) and internal status normalization. The
// outbound REST calls (createCustomer, createCheckoutSession, etc.)
// are NOT covered here -- see billing-stripe.js's header comment for
// why, and worker/billing.js's tests (test/billing.test.js) for how
// the service layer around those calls IS fully tested, via a fake
// provider standing in for real Stripe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyAndParseWebhook, normalizeSubscriptionStatus } from '../worker/billing-stripe.js';

const WEBHOOK_SECRET = 'whsec_test_secret_for_unit_tests_only';

async function signPayload(secret, timestamp, rawBody) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  return [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function fakeRequest(rawBody, signatureHeader) {
  return {
    headers: { get: (name) => (name === 'Stripe-Signature' ? signatureHeader : null) },
    async text() { return rawBody; }
  };
}

test('verifyAndParseWebhook accepts a correctly signed, fresh payload', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const rawBody = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(WEBHOOK_SECRET, timestamp, rawBody);

  const result = await verifyAndParseWebhook(fakeRequest(rawBody, `t=${timestamp},v1=${signature}`), env);
  assert.equal(result.valid, true);
  assert.equal(result.event.id, 'evt_1');
});

test('verifyAndParseWebhook rejects a tampered body even with a signature that looked valid for the original body', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const originalBody = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', amount: 100 });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload(WEBHOOK_SECRET, timestamp, originalBody);

  const tamperedBody = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', amount: 999999 });
  const result = await verifyAndParseWebhook(fakeRequest(tamperedBody, `t=${timestamp},v1=${signature}`), env);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('verifyAndParseWebhook rejects a signature made with the wrong secret', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const rawBody = JSON.stringify({ id: 'evt_3', type: 'invoice.paid' });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = await signPayload('whsec_totally_different_secret', timestamp, rawBody);

  const result = await verifyAndParseWebhook(fakeRequest(rawBody, `t=${timestamp},v1=${signature}`), env);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_mismatch');
});

test('verifyAndParseWebhook rejects a stale timestamp (replay protection)', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const rawBody = JSON.stringify({ id: 'evt_4', type: 'invoice.paid' });
  const oldTimestamp = Math.floor(Date.now() / 1000) - 60 * 60; // 1 hour old
  const signature = await signPayload(WEBHOOK_SECRET, oldTimestamp, rawBody);

  const result = await verifyAndParseWebhook(fakeRequest(rawBody, `t=${oldTimestamp},v1=${signature}`), env);
  assert.equal(result.valid, false);
  assert.equal(result.reason, 'signature_too_old');
});

test('verifyAndParseWebhook rejects a missing signature header and a missing webhook secret', async () => {
  const env = { STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  const noHeaderResult = await verifyAndParseWebhook(fakeRequest('{}', null), env);
  assert.equal(noHeaderResult.valid, false);
  assert.equal(noHeaderResult.reason, 'missing_signature');

  const noSecretResult = await verifyAndParseWebhook(fakeRequest('{}', 't=1,v1=whatever'), {});
  assert.equal(noSecretResult.valid, false);
  assert.equal(noSecretResult.reason, 'webhook_secret_not_configured');
});

test('normalizeSubscriptionStatus maps every Stripe status to an internal one, defaulting unknowns to incomplete', () => {
  assert.equal(normalizeSubscriptionStatus('trialing'), 'trialing');
  assert.equal(normalizeSubscriptionStatus('active'), 'active');
  assert.equal(normalizeSubscriptionStatus('past_due'), 'past_due');
  assert.equal(normalizeSubscriptionStatus('unpaid'), 'past_due');
  assert.equal(normalizeSubscriptionStatus('canceled'), 'canceled');
  assert.equal(normalizeSubscriptionStatus('some_future_stripe_status_this_code_has_never_seen'), 'incomplete');
});
