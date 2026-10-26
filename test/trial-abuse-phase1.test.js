// Phase 1.5: one trial per card and per business domain; fix N3 (agency staff are not blocked).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as plans from '../worker/plans.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as organizations from '../worker/organizations.js';
import { businessDomain, cardHash } from '../worker/trial-abuse.js';
import { setPlanPrice } from './support/plan-prices.js';

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), BILLING_ENFORCE: 'enforce', ...extra };
}
async function signup(env, email, name) {
  const r = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: name || 'Org ' + email }; }, headers: { get: () => '203.0.113.9' } }, env);
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}
const owner = async (env, orgId) => (await organizations.listMembers(env, orgId))[0].user_id;
const STARTER = 'plan_casino_news_starter';

test('businessDomain: free-mail and malformed addresses identify nobody', () => {
  assert.equal(businessDomain('a@Acme.com'), 'acme.com');
  assert.equal(businessDomain('a@gmail.com'), null);
  assert.equal(businessDomain('a@proton.me'), null);
  assert.equal(businessDomain('nodomain'), null);
  assert.equal(businessDomain('a@b'), null);
});

test('second trial from the same business domain is refused (enforce), by a different person', async () => {
  const env = makeEnv();
  const a = await signup(env, 'alice@acme-media.com');
  assert.ok((await plans.startTrialSubscription(env, a.organizationId, STARTER)).ok);
  const b = await signup(env, 'bob@acme-media.com');
  const r = await plans.startTrialSubscription(env, b.organizationId, STARTER);
  assert.equal(r.ok, false); assert.equal(r.error, 'trial_already_used'); assert.equal(r.reason, 'domain');
});

test('free-mail domains never trigger the domain rule', async () => {
  const env = makeEnv();
  const a = await signup(env, 'one@gmail.com');
  assert.ok((await plans.startTrialSubscription(env, a.organizationId, STARTER)).ok);
  const b = await signup(env, 'two@gmail.com');
  assert.ok((await plans.startTrialSubscription(env, b.organizationId, STARTER)).ok);
});

test('shadow mode records the would-be refusal and lets the trial through; off mode ignores the domain', async () => {
  const shadow = makeEnv({ BILLING_ENFORCE: 'shadow' });
  const a = await signup(shadow, 'alice@shadow-co.com');
  await plans.startTrialSubscription(shadow, a.organizationId, STARTER);
  const b = await signup(shadow, 'bob@shadow-co.com');
  assert.ok((await plans.startTrialSubscription(shadow, b.organizationId, STARTER)).ok);
  const row = await shadow.LUMMET_DB.prepare(`SELECT * FROM subscription_access_shadow WHERE reason = 'trial_refused:domain'`).first();
  assert.equal(row.organization_id, b.organizationId);

  const off = makeEnv({ BILLING_ENFORCE: 'off' });
  const c = await signup(off, 'alice@off-co.com');
  await plans.startTrialSubscription(off, c.organizationId, STARTER);
  const d = await signup(off, 'bob@off-co.com');
  assert.ok((await plans.startTrialSubscription(off, d.organizationId, STARTER)).ok);
  assert.equal((await off.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM trial_fingerprints`).first()).c, 0, 'off records nothing');
});

test('N3: agency staff invited into a client organization do not block the client trial', async () => {
  const env = makeEnv();
  // The agency owner has an organization with a subscription.
  const agency = await signup(env, 'staff@gmail.com', 'Agency');
  assert.ok((await plans.startTrialSubscription(env, agency.organizationId, STARTER)).ok);
  // A client signs up and invites the agency staff member as an admin.
  const client = await signup(env, 'client@clientco.example', 'Client');
  const staffUser = await owner(env, agency.organizationId);
  await env.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, 'admin')`).bind(client.organizationId, staffUser).run();
  const r = await plans.startTrialSubscription(env, client.organizationId, STARTER);
  assert.ok(r.ok, JSON.stringify(r));
});

test('N3: the same person owning a second organization is still refused', async () => {
  const env = makeEnv();
  const first = await signup(env, 'repeat@gmail.com');
  await plans.startTrialSubscription(env, first.organizationId, STARTER);
  const second = await organizations.createOrganization(env, { name: 'Second', ownerUserId: await owner(env, first.organizationId) });
  const r = await plans.startTrialSubscription(env, second.organizationId, STARTER);
  assert.equal(r.error, 'trial_already_used');
});

// ---------------------------------------------------------------- card fingerprint at checkout
function checkoutEvent(orgId, subId, extra = {}) {
  return { id: 'evt_' + Math.random().toString(36).slice(2), type: 'checkout.session.completed', livemode: false,
    data: { object: { id: 'cs_1', client_reference_id: orgId, subscription: subId, customer: 'cus_1', metadata: { organization_id: orgId, plan_id: STARTER, has_trial: '1', trial_end: String(Math.floor(Date.now() / 1000) + 7 * 86400) }, ...extra } } };
}

test('a card that already had a trial in another organization: the trial is ended at once (enforce)', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider(); const svc = createBillingService(provider);
  const a = await signup(env, 'a1@gmail.com'); const b = await signup(env, 'b1@gmail.com');
  provider._cardFingerprints.set('sub_a', 'card_fp_1'); provider._cardFingerprints.set('sub_b', 'card_fp_1');
  assert.ok((await simulateWebhook(svc, provider, env, checkoutEvent(a.organizationId, 'sub_a'))).ok);
  assert.equal(provider._calls.filter((c) => c.method === 'endTrialNow').length, 0, 'the first use of a card keeps its trial');
  assert.ok((await simulateWebhook(svc, provider, env, checkoutEvent(b.organizationId, 'sub_b'))).ok);
  const ended = provider._calls.filter((c) => c.method === 'endTrialNow');
  assert.deepEqual(ended.map((c) => c.providerSubscriptionId), ['sub_b']);
  const ev = await env.LUMMET_DB.prepare(`SELECT reason FROM subscription_status_events WHERE reason LIKE 'trial refused%'`).first();
  assert.ok(ev);
  // Only a hash is stored.
  const rows = (await env.LUMMET_DB.prepare(`SELECT fingerprint_hash FROM trial_fingerprints`).all()).results;
  assert.ok(rows.every((r) => !r.fingerprint_hash.includes('card_fp_1')));
  assert.equal(rows[0].fingerprint_hash, await cardHash(env, 'card_fp_1'));
});

test('card check: shadow only records; redelivery of the same checkout does not double-refuse the first org', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'shadow' });
  const provider = createFakeBillingProvider(); const svc = createBillingService(provider);
  const a = await signup(env, 'a2@gmail.com'); const b = await signup(env, 'b2@gmail.com');
  provider._cardFingerprints.set('sub_a', 'card_fp_2'); provider._cardFingerprints.set('sub_b', 'card_fp_2');
  const evA = checkoutEvent(a.organizationId, 'sub_a');
  await simulateWebhook(svc, provider, env, evA);
  await simulateWebhook(svc, provider, env, { ...evA, id: 'evt_redelivered' });
  await simulateWebhook(svc, provider, env, checkoutEvent(b.organizationId, 'sub_b'));
  assert.equal(provider._calls.filter((c) => c.method === 'endTrialNow').length, 0, 'shadow never changes Stripe');
  assert.ok(await env.LUMMET_DB.prepare(`SELECT 1 x FROM subscription_access_shadow WHERE reason = 'trial_refused:card'`).first());
});

test('a failed fingerprint lookup fails the webhook (so Stripe redelivers) instead of being swallowed', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider(); const svc = createBillingService(provider);
  const a = await signup(env, 'a3@gmail.com');
  provider._failFingerprint = true;
  const r = await simulateWebhook(svc, provider, env, checkoutEvent(a.organizationId, 'sub_x'));
  assert.equal(r.ok, false); assert.equal(r.status, 500);
  provider._failFingerprint = false; provider._cardFingerprints.set('sub_x', 'card_fp_3');
  const retry = await simulateWebhook(svc, provider, env, { ...checkoutEvent(a.organizationId, 'sub_x'), id: 'evt_retry' });
  assert.ok(retry.ok);
});

test('checkout for an owner who already trialed elsewhere carries no trial and says why', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider(); const svc = createBillingService(provider);
  const first = await signup(env, 'again@gmail.com');
  await plans.startTrialSubscription(env, first.organizationId, STARTER);
  await setPlanPrice(env, STARTER, 'price_test');
  const second = await organizations.createOrganization(env, { name: 'Second', ownerUserId: await owner(env, first.organizationId) });
  const r = await svc.startCheckout(env, { organizationId: second.organizationId, planId: STARTER, successUrl: 'https://x/s', cancelUrl: 'https://x/c' });
  assert.ok(r.ok); assert.equal(r.trialRefused, 'owner');
  const call = provider._calls.find((c) => c.method === 'createCheckoutSession');
  assert.equal(call.trialDays, 0);
});
