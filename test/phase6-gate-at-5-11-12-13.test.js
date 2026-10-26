// Round 6.G (release 2.6.0.15). Acceptance tests that had no AT-labelled test on the fake provider before this round:
//   AT-5  plan switch sync and unknown price alert
//   AT-11 hand edit in Stripe raises drift
//   AT-12 EU reverse charge (local half only; Stripe Tax itself is NOT VERIFIED without Stripe test mode)
//   AT-13 refund and dispute
// AT-1 to AT-4, AT-6 to AT-10, AT-14 and AT-15 already have labelled tests in other files; scripts/phase6-gate.mjs
// checks that each of those labels still exists. No product code is changed by this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import { reconcileSubscriptions, resolveDrift } from '../worker/phase3-source-of-truth.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as alertState from '../worker/repositories/alert-state.js';
import { setPlanPrice } from './support/plan-prices.js';

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra };
}
async function wired(extra = {}) {
  const env = makeEnv({ BILLING_ENFORCE: 'enforce', ...extra });
  const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  const signup = await customerAuth.signUp({ async json() { return { email: `at-${Math.random()}@example.com`, password: 'correct-horse-battery', organizationName: 'AT Org' }; }, headers: { get: () => '203.0.113.9' } }, env);
  const org = signup.organizationId;
  const hook = (type, object, created, id = 'evt_' + Math.random()) => simulateWebhook(billing, provider, env, { id, created, type, data: { object } });
  return { env, provider, billing, org, hook };
}
async function addPlan(env, id, key, cents) {
  await env.LUMMET_DB.prepare(`INSERT INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status) VALUES (?, 'prod_casino_news', ?, ?, 'monthly', ?, 'USD', 0, 'active')`).bind(id, key, key, cents).run();
}
const sub = (env, org) => env.LUMMET_DB.prepare('SELECT * FROM subscriptions WHERE organization_id = ?').bind(org).first();
const priceOf = (id) => ({ items: { data: [{ price: { id } }] } });

test('AT-5: a known price moves the plan; an unknown price changes nothing and raises unknown_price_id; replays add no second issue', async () => {
  const { env, org, hook } = await wired();
  await addPlan(env, 'plan_at5_growth', 'at5_growth', 4900);
  await setPlanPrice(env, 'plan_casino_news_starter', 'price_at5_starter');
  await setPlanPrice(env, 'plan_at5_growth', 'price_at5_growth');
  await hook('checkout.session.completed', { id: 'cs_at5', client_reference_id: org, subscription: 'sub_at5', metadata: { organization_id: org, plan_id: 'plan_casino_news_starter' } }, 100);
  assert.equal((await sub(env, org)).plan_id, 'plan_casino_news_starter');

  // Switch made in Stripe: the webhook maps items.data[0].price.id through plan_prices to the plan.
  await hook('customer.subscription.updated', { id: 'sub_at5', status: 'active', ...priceOf('price_at5_growth') }, 200);
  assert.equal((await sub(env, org)).plan_id, 'plan_at5_growth', 'a mapped price syncs the plan');
  assert.equal(await alertState.countFor(env, 'unknown_price_id'), 0);

  // A price Lummet does not hold: nothing about the subscription changes, the alert counts it, the event is not retried into a second issue.
  const before = await sub(env, org);
  for (let i = 0; i < 2; i++) await hook('customer.subscription.updated', { id: 'sub_at5', status: 'active', ...priceOf('price_at5_UNKNOWN') }, 300 + i);
  const after = await sub(env, org);
  assert.equal(after.plan_id, before.plan_id); assert.equal(after.status, before.status);
  assert.equal(await alertState.countFor(env, 'unknown_price_id'), 1, 'one open issue, not one per delivery');
  const issue = await env.LUMMET_DB.prepare(`SELECT kind, stripe_price_id, resolved_at FROM plan_sync_issues WHERE kind='unknown_price_id'`).first();
  assert.equal(issue.stripe_price_id, 'price_at5_UNKNOWN'); assert.equal(issue.resolved_at, null);

  // Once the price is mapped, the next event resolves the issue by itself.
  await setPlanPrice(env, 'plan_at5_growth', 'price_at5_UNKNOWN');
  await hook('customer.subscription.updated', { id: 'sub_at5', status: 'active', ...priceOf('price_at5_UNKNOWN') }, 400);
  assert.equal(await alertState.countFor(env, 'unknown_price_id'), 0);
});

test('AT-11: a hand edit in Stripe raises drift, once; resolution needs a reason; a clean run adds nothing', async () => {
  const { env, org, hook } = await wired();
  await setPlanPrice(env, 'plan_casino_news_starter', 'price_at11_starter');
  await hook('checkout.session.completed', { id: 'cs_at11', client_reference_id: org, subscription: 'sub_at11', metadata: { organization_id: org, plan_id: 'plan_casino_news_starter' } }, 100);
  const local = await sub(env, org);
  const periodEnd = local.current_period_end ? Math.floor(Date.parse(local.current_period_end) / 1000) : null;
  const clean = () => ({ status: local.status, current_period_end: periodEnd, cancel_at_period_end: Boolean(local.cancel_at_period_end), items: { data: [{ price: { id: 'price_at11_starter' } }] } });

  const quiet = await reconcileSubscriptions(env, { fetchSubscription: async () => clean() });
  assert.equal(quiet.findings.length, 0, 'no edit, no drift');
  assert.equal(await alertState.countFor(env, 'reconcile_drift'), 0);

  const edited = () => ({ ...clean(), status: 'past_due', cancel_at_period_end: true });   // someone edited the subscription in the Stripe dashboard
  const first = await reconcileSubscriptions(env, { fetchSubscription: async () => edited() });
  assert.ok(first.findings.some((f) => f.field === 'status') && first.findings.some((f) => f.field === 'cancel_at_period_end'));
  const openAfterFirst = await alertState.countFor(env, 'reconcile_drift');
  assert.ok(openAfterFirst >= 2);
  await reconcileSubscriptions(env, { fetchSubscription: async () => edited() });
  assert.equal(await alertState.countFor(env, 'reconcile_drift'), openAfterFirst, 'a second run does not duplicate open findings');
  assert.equal((await sub(env, org)).status, local.status, 'reconciliation reports; it never edits on its own');

  const finding = (await env.LUMMET_DB.prepare(`SELECT id FROM reconciliation_findings WHERE status='open' AND field='status'`).first()).id;
  await assert.rejects(() => resolveDrift(env, { findingId: finding, decision: 'accept_stripe', actorId: 'staff:1' }), /reason/);
  const done = await resolveDrift(env, { findingId: finding, decision: 'accept_stripe', actorId: 'staff:1', reason: 'AT-11: dashboard edit confirmed with the account owner' });
  assert.equal(done.status, 'accepted_stripe');
});

test('AT-12 (local half): a customer tax ID round-trips through the webhook and a zero-tax invoice is recorded as issued; Stripe Tax reverse-charge computation is NOT VERIFIED here', async () => {
  const { env, billing, org, hook } = await wired();
  const customer = await billing.ensureBillingCustomer(env, org);
  const cus = customer.provider_customer_id;
  await hook('customer.tax_id.created', { id: 'txi_at12', customer: cus, type: 'eu_vat', value: 'DE123456789' }, 100);
  let p = await env.LUMMET_DB.prepare('SELECT tax_id FROM organization_billing_profiles WHERE organization_id=?').bind(org).first();
  assert.equal(p.tax_id, 'DE123456789');
  const invoice = { id: 'in_at12', customer: cus, metadata: { organization_id: org }, status: 'paid', amount_due: 1000, amount_paid: 1000, currency: 'eur', subtotal: 1000, tax: 0, total: 1000, number: 'INV-AT12', lines: { data: [{ id: 'il_at12', description: 'Plan', quantity: 1, amount: 1000, currency: 'eur', price: { id: 'price_x', unit_amount: 1000 } }] } };
  assert.equal((await hook('invoice.finalized', invoice, 110)).ok, true);
  const row = await env.LUMMET_DB.prepare('SELECT subtotal_cents, tax_cents, total_cents FROM invoices WHERE provider_invoice_id=?').bind('in_at12').first();
  assert.deepEqual([row.subtotal_cents, row.tax_cents, row.total_cents].map(Number), [1000, 0, 1000], 'reverse-charge invoice: no tax added, total equals subtotal');
  await hook('customer.tax_id.deleted', { id: 'txi_at12', customer: cus }, 120);
  p = await env.LUMMET_DB.prepare('SELECT tax_id FROM organization_billing_profiles WHERE organization_id=?').bind(org).first();
  assert.equal(p.tax_id, null);
});

test('AT-13: a refund and a dispute are recorded once each; replays and older deliveries cannot roll them back', async () => {
  const { env, billing, org, hook } = await wired();
  const customer = await billing.ensureBillingCustomer(env, org);
  const charge = { id: 'ch_at13', customer: customer.provider_customer_id, metadata: { organization_id: org }, currency: 'usd', refunds: { data: [{ id: 're_at13', amount: 500, currency: 'usd', status: 'succeeded', reason: 'requested_by_customer' }] } };
  await hook('charge.refunded', charge, 50, 'evt_at13_refund');
  const dup = await hook('charge.refunded', charge, 50, 'evt_at13_refund');
  assert.equal(dup.duplicate, true, 'the same event id is a duplicate');
  await hook('charge.refunded', { ...charge, refunds: { data: [{ id: 're_at13', amount: 500, currency: 'usd', status: 'pending' }] } }, 40);
  assert.equal((await env.LUMMET_DB.prepare('SELECT COUNT(*) n FROM refunds WHERE provider_refund_id=?').bind('re_at13').first()).n, 1);
  assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM refunds WHERE provider_refund_id=?').bind('re_at13').first()).status, 'succeeded');

  const dispute = { id: 'dp_at13', charge: 'ch_at13', metadata: { organization_id: org }, amount: 500, currency: 'usd', status: 'needs_response', reason: 'fraudulent' };
  await hook('charge.dispute.created', dispute, 60);
  assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM disputes WHERE provider_dispute_id=?').bind('dp_at13').first()).status, 'needs_response');
  await hook('charge.dispute.closed', { ...dispute, status: 'lost' }, 70);
  await hook('charge.dispute.created', dispute, 65);   // out of order, older
  const d = await env.LUMMET_DB.prepare('SELECT status FROM disputes WHERE provider_dispute_id=?').bind('dp_at13').first();
  assert.equal(d.status, 'lost'); 
  assert.equal((await env.LUMMET_DB.prepare('SELECT COUNT(*) n FROM disputes WHERE provider_dispute_id=?').bind('dp_at13').first()).n, 1);
});
