// test/webhooks.test.js
//
// dispatchEvent() calls the global fetch() directly (it's the
// customer's own endpoint being called, not a provider this codebase
// already abstracts) -- these tests temporarily replace globalThis.fetch
// with a controllable fake, restoring the original afterward, rather
// than adding a provider-injection seam for a single outbound call.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';

import * as webhooks from '../worker/webhooks.js';
import { decryptSecret } from '../worker/crypto.js';
import * as customerAuth from '../worker/customer-auth.js';

function makeTestKek() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Buffer.from(bytes).toString('base64');
}

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: makeTestKek() };
}

function fakeSignupRequest(email) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; },
    headers: { get: () => '203.0.113.70' }
  };
}

function withFakeFetch(impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = original; };
}

async function hmacSha256Hex(secret, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// -----------------------------------------------------
// Subscription management
// -----------------------------------------------------

test('createWebhook rejects a non-https URL and invalid/empty event types', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webhook-invalid@example.com'), env);

  const httpUrl = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'http://example.com/hook', eventTypes: ['site.created']
  });
  assert.equal(httpUrl.ok, false);
  assert.equal(httpUrl.error, 'url_must_be_https');

  const badType = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: ['not.a.real.event']
  });
  assert.equal(badType.ok, false);
  assert.equal(badType.error, 'invalid_event_types');

  const empty = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: []
  });
  assert.equal(empty.ok, false);
});

test('createWebhook succeeds, returns a secret once, and listWebhooks never exposes it', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webhook-create@example.com'), env);

  const created = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: ['site.created', 'site.provisioned']
  });
  assert.equal(created.ok, true);
  assert.ok(created.secret);

  const listed = await webhooks.listWebhooks(env, signup.organizationId);
  assert.equal(listed.length, 1);
  assert.deepEqual(listed[0].event_types, ['site.created', 'site.provisioned']);
  assert.equal('secret' in listed[0], false);
  assert.equal('encrypted_secret' in listed[0], false);
});

test('deleteWebhook and rotateSecret refuse a webhook id from a different organization', async () => {
  const env = makeEnv();
  const orgA = await customerAuth.signUp(fakeSignupRequest('webhook-org-a@example.com'), env);
  const orgB = await customerAuth.signUp(fakeSignupRequest('webhook-org-b@example.com'), env);
  const created = await webhooks.createWebhook(env, {
    organizationId: orgA.organizationId, url: 'https://example.com/hook', eventTypes: ['site.created']
  });

  const deleteResult = await webhooks.deleteWebhook(env, orgB.organizationId, created.webhookId);
  assert.equal(deleteResult.ok, false);
  assert.equal(deleteResult.error, 'not_found');

  const rotateResult = await webhooks.rotateSecret(env, orgB.organizationId, created.webhookId);
  assert.equal(rotateResult.ok, false);

  const stillThere = await webhooks.listWebhooks(env, orgA.organizationId);
  assert.equal(stillThere.length, 1);
});

// -----------------------------------------------------
// Delivery
// -----------------------------------------------------

test('dispatchEvent delivers only to webhooks subscribed to that event type, with a correctly signed body', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webhook-dispatch@example.com'), env);

  const subscribed = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/subscribed', eventTypes: ['site.provisioned']
  });
  await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/not-subscribed', eventTypes: ['domain.verified']
  });

  const calls = [];
  const restore = withFakeFetch(async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });

  try {
    await webhooks.dispatchEvent(env, signup.organizationId, 'site.provisioned', { siteId: 'site-1' });
  } finally {
    restore();
  }

  assert.equal(calls.length, 1, 'only the subscribed webhook should have been called');
  assert.equal(calls[0].url, 'https://example.com/subscribed');

  const signatureHeader = calls[0].opts.headers['Lummet-Signature'];
  assert.match(signatureHeader, /^t=\d+,v1=[0-9a-f]{64}$/);

  const [, timestamp] = signatureHeader.match(/^t=(\d+),v1=/);
  const webhookRow = await env.LUMMET_DB.prepare(`SELECT encrypted_secret, secret_iv FROM webhooks WHERE id = ?`)
    .bind(subscribed.webhookId).first();
  const plainSecret = await decryptSecret(env, webhookRow.encrypted_secret, webhookRow.secret_iv);
  const expectedSignature = await hmacSha256Hex(plainSecret, `${timestamp}.${calls[0].opts.body}`);
  assert.equal(signatureHeader, `t=${timestamp},v1=${expectedSignature}`);

  const parsedBody = JSON.parse(calls[0].opts.body);
  assert.equal(parsedBody.type, 'site.provisioned');
  assert.deepEqual(parsedBody.data, { siteId: 'site-1' });

  const deliveries = await webhooks.listDeliveries(env, signup.organizationId, subscribed.webhookId);
  assert.equal(deliveries.data.length, 1);
  assert.equal(deliveries.data[0].status, 'delivered');
  assert.equal(deliveries.data[0].response_code, 200);
});

test('dispatchEvent records a failed delivery on a non-2xx response, without throwing', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webhook-failed-response@example.com'), env);
  const created = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/broken', eventTypes: ['payment.failed']
  });

  const restore = withFakeFetch(async () => ({ ok: false, status: 500 }));
  try {
    await assert.doesNotReject(webhooks.dispatchEvent(env, signup.organizationId, 'payment.failed', { invoiceId: 'in_1' }));
  } finally {
    restore();
  }

  const deliveries = await webhooks.listDeliveries(env, signup.organizationId, created.webhookId);
  assert.equal(deliveries.data[0].status, 'failed');
  assert.equal(deliveries.data[0].response_code, 500);
});

test('dispatchEvent records a failed delivery when the fetch itself throws (endpoint unreachable), without throwing', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webhook-unreachable@example.com'), env);
  const created = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/unreachable', eventTypes: ['site.failed']
  });

  const restore = withFakeFetch(async () => { throw new Error('simulated network failure'); });
  try {
    await assert.doesNotReject(webhooks.dispatchEvent(env, signup.organizationId, 'site.failed', { siteId: 'site-2' }));
  } finally {
    restore();
  }

  const deliveries = await webhooks.listDeliveries(env, signup.organizationId, created.webhookId);
  assert.equal(deliveries.data[0].status, 'failed');
  assert.ok(deliveries.data[0].error_message.includes('simulated network failure'));
});

test('dispatchEvent for an organization with no webhooks at all is a silent no-op', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webhook-none@example.com'), env);

  let fetchCalled = false;
  const restore = withFakeFetch(async () => { fetchCalled = true; return { ok: true, status: 200 }; });
  try {
    await webhooks.dispatchEvent(env, signup.organizationId, 'site.created', {});
  } finally {
    restore();
  }
  assert.equal(fetchCalled, false);
});

test('rotateSecret changes future signatures without needing a new webhook', async () => {
  const env = makeEnv();
  const signup = await customerAuth.signUp(fakeSignupRequest('webhook-rotate@example.com'), env);
  const created = await webhooks.createWebhook(env, {
    organizationId: signup.organizationId, url: 'https://example.com/hook', eventTypes: ['site.created']
  });

  const signatures = [];
  const restore = withFakeFetch(async (url, opts) => {
    signatures.push(opts.headers['Lummet-Signature']);
    return { ok: true, status: 200 };
  });

  try {
    await webhooks.dispatchEvent(env, signup.organizationId, 'site.created', { n: 1 });
    const rotated = await webhooks.rotateSecret(env, signup.organizationId, created.webhookId);
    assert.equal(rotated.ok, true);
    assert.notEqual(rotated.secret, created.secret);
    await webhooks.dispatchEvent(env, signup.organizationId, 'site.created', { n: 2 });
  } finally {
    restore();
  }

  assert.equal(signatures.length, 2);
  assert.notEqual(signatures[0], signatures[1]);
});
