// v7C: a failed or crashed billing webhook event is reprocessed when the provider redelivers it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as events from '../worker/repositories/billing-webhooks.js';

function setup() {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db };
  const provider = createFakeBillingProvider();
  return { env, provider, billing: createBillingService(provider) };
}
const signup = (env, email) => customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.9' } }, env);
const row = (env, id) => env.LUMMET_DB.prepare(`SELECT * FROM billing_webhook_events WHERE provider_event_id = ?`).bind(id).first();
const checkoutEvent = (id, orgId, sub, couponId) => ({ id, type: 'checkout.session.completed',
  data: { object: { id: 'cs_' + id, client_reference_id: orgId, subscription: sub, metadata: { organization_id: orgId, plan_id: 'plan_casino_news_starter', ...(couponId ? { coupon_id: couponId } : {}) } } } });

test('a failed event that the provider redelivers is processed once the cause is fixed', async () => {
  const { env, provider, billing } = setup();
  const org = await signup(env, 'retry@example.com');
  // The subscription this update is about does not exist yet, so the first attempt fails.
  const update = { id: 'evt_retry_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_late', status: 'active' } } };
  assert.equal((await simulateWebhook(billing, provider, env, update)).ok, false);
  assert.equal((await row(env, 'evt_retry_1')).status, 'failed');
  assert.equal((await row(env, 'evt_retry_1')).attempts, 1);

  // The subscription now exists (its checkout event arrived late); Stripe redelivers the SAME update event.
  assert.equal((await simulateWebhook(billing, provider, env, checkoutEvent('evt_checkout_1', org.organizationId, 'sub_late'))).ok, true);
  const again = await simulateWebhook(billing, provider, env, update);
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, false, 'the redelivery was really processed, not acknowledged as a duplicate');
  const r = await row(env, 'evt_retry_1');
  assert.equal(r.status, 'processed'); assert.equal(r.attempts, 2); assert.equal(r.error_message, null);

  // From now on it is an ordinary duplicate.
  assert.equal((await simulateWebhook(billing, provider, env, update)).duplicate, true);
  assert.equal((await row(env, 'evt_retry_1')).attempts, 2);
});

test('an event that keeps failing stops being retried after MAX_ATTEMPTS and stays failed', async () => {
  const { env, provider, billing } = setup();
  const bad = { id: 'evt_never', type: 'customer.subscription.updated', data: { object: { id: 'sub_missing', status: 'active' } } };
  const seen = [];
  for (let i = 0; i < events.MAX_ATTEMPTS + 2; i++) seen.push((await simulateWebhook(billing, provider, env, bad)).duplicate === true ? 'skipped' : 'ran');
  assert.deepEqual(seen.slice(0, events.MAX_ATTEMPTS), Array(events.MAX_ATTEMPTS).fill('ran'));
  assert.deepEqual(seen.slice(events.MAX_ATTEMPTS), ['skipped', 'skipped']);
  const r = await row(env, 'evt_never');
  assert.equal(r.status, 'failed'); assert.equal(r.attempts, events.MAX_ATTEMPTS);
});

test('an event stuck in received (the Worker died mid-way) is retried only once it is stale', async () => {
  const { env, provider, billing } = setup();
  const org = await signup(env, 'stale@example.com');
  assert.equal(await events.recordReceived(env, 'fake', 'evt_stuck', 'checkout.session.completed'), true);
  assert.equal(await events.claimRetry(env, 'fake', 'evt_stuck'), false, 'just received: another request may still be working on it');
  await env.LUMMET_DB.prepare(`UPDATE billing_webhook_events SET last_attempt_at = datetime('now','-10 minutes') WHERE provider_event_id = 'evt_stuck'`).run();
  assert.equal(await events.claimRetry(env, 'fake', 'evt_stuck'), true);
  assert.equal(await events.claimRetry(env, 'fake', 'evt_stuck'), false, 'a second concurrent redelivery cannot also claim it');
  assert.equal((await row(env, 'evt_stuck')).attempts, 2);
});

test('a processed event is never reprocessed', async () => {
  const { env, provider, billing } = setup();
  const org = await signup(env, 'done@example.com');
  const ev = checkoutEvent('evt_ok', org.organizationId, 'sub_ok');
  assert.equal((await simulateWebhook(billing, provider, env, ev)).duplicate, false);
  await env.LUMMET_DB.prepare(`UPDATE billing_webhook_events SET last_attempt_at = datetime('now','-1 day'), received_at = datetime('now','-1 day')`).run();
  assert.equal((await simulateWebhook(billing, provider, env, ev)).duplicate, true);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM subscriptions WHERE organization_id = ?`).bind(org.organizationId).first()).n, 1);
});

test('redelivering a checkout whose first attempt got partway does not create a second subscription or count the coupon twice', async () => {
  const { env, provider, billing } = setup();
  const org = await signup(env, 'partial@example.com');
  await env.LUMMET_DB.prepare(`INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off) VALUES ('c1','HALF','stripe','st_c1',50)`).run();
  const ev = checkoutEvent('evt_partial', org.organizationId, 'sub_partial', 'c1');
  assert.equal((await simulateWebhook(billing, provider, env, ev)).ok, true);
  // Pretend the response was lost / the attempt crashed after the subscription was written.
  await env.LUMMET_DB.prepare(`UPDATE billing_webhook_events SET status = 'failed', error_message = 'boom' WHERE provider_event_id = 'evt_partial'`).run();
  const again = await simulateWebhook(billing, provider, env, ev);
  assert.equal(again.ok, true); assert.equal(again.duplicate, false);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM subscriptions WHERE organization_id = ?`).bind(org.organizationId).first()).n, 1);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM coupon_redemptions WHERE coupon_id = 'c1'`).first()).n, 1);
  assert.equal((await row(env, 'evt_partial')).status, 'processed');
});

test('a second, different provider subscription is still refused on redelivery (the race guard is intact)', async () => {
  const { env, provider, billing } = setup();
  const org = await signup(env, 'race@example.com');
  assert.equal((await simulateWebhook(billing, provider, env, checkoutEvent('evt_a', org.organizationId, 'sub_a'))).ok, true);
  const other = await simulateWebhook(billing, provider, env, checkoutEvent('evt_b', org.organizationId, 'sub_b'));
  assert.equal(other.ok, false);
  assert.equal((await row(env, 'evt_b')).status, 'failed');
});

test('SQL guard: no numbered ?N placeholders anywhere in worker/ (they differ between SQLite builds)', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(d + '/' + e.name) : [d + '/' + e.name]);
  const offenders = walk(new URL('../worker', import.meta.url).pathname).filter((f) => f.endsWith('.js'))
    .filter((f) => /\?\d+(?![\w])/.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\?\.\d|\?\d\.\d/g, '')));
  assert.deepEqual(offenders, []);
});

test('npm test quotes its glob so Node expands it (an unquoted ** is expanded by sh and can silently skip root tests)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts.test, /"test\/\*\*\/\*\.test\.js"/);
});
