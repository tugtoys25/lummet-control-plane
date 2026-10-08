// test/billing.test.js
//
// Covers worker/billing.js's actual state-machine logic (checkout
// gating, webhook dispatch, idempotency, cancel/resume/change-plan)
// against a real SQLite schema (D1 shim) and a fake billing provider
// standing in for Stripe (test/support/fake-billing-provider.js) --
// no network access needed for any of this, since none of it is
// Stripe-API-shape-specific (that part is billing-stripe.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';

import { createBillingService } from '../worker/billing.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as entitlements from '../worker/entitlements.js';

function makeEnv() {
  const db = createTestDb();
  applyMigrations(db);
  return { LUMMET_DB: db };
}

function fakeSignupRequest(email, organizationName) {
  return {
    async json() { return { email, password: 'correct-horse-battery', organizationName }; },
    headers: { get: () => '203.0.113.9' }
  };
}

/** Gives the seeded Phase-1 plan a Stripe price id so checkout can proceed against it. */
async function configurePlanForBilling(env, planId = 'plan_casino_news_starter', priceId = 'price_fake_starter_monthly') {
  await env.LUMMET_DB.prepare(`UPDATE plans SET stripe_price_id = ? WHERE id = ?`).bind(priceId, planId).run();
}

async function signupOrg(env, email, orgName) {
  return customerAuth.signUp(fakeSignupRequest(email, orgName), env);
}

// -----------------------------------------------------
// startCheckout gating
// -----------------------------------------------------

test('startCheckout refuses a plan with no provider price configured, without calling the provider at all', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'unconfigured-plan@example.com', 'Org');

  const result = await billing.startCheckout(env, {
    organizationId: signup.organizationId, planId: 'plan_casino_news_starter',
    successUrl: 'https://app.test/success', cancelUrl: 'https://app.test/cancel'
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'plan_not_billing_configured');
  assert.equal(provider._calls.length, 0, 'a misconfigured plan must never reach the provider');
});

test('startCheckout refuses when the organization already has a real provider subscription', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'already-subbed@example.com', 'Org');
  await configurePlanForBilling(env);

  const first = await billing.startCheckout(env, {
    organizationId: signup.organizationId, planId: 'plan_casino_news_starter',
    successUrl: 'https://app.test/success', cancelUrl: 'https://app.test/cancel'
  });
  assert.equal(first.ok, true);

  await simulateWebhook(billing, provider, env, {
    id: 'evt_checkout_1', type: 'checkout.session.completed',
    data: { object: { id: 'fake_cs_x', client_reference_id: signup.organizationId, metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' }, subscription: 'fake_sub_1' } }
  });

  const second = await billing.startCheckout(env, {
    organizationId: signup.organizationId, planId: 'plan_casino_news_starter',
    successUrl: 'https://app.test/success', cancelUrl: 'https://app.test/cancel'
  });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'organization_already_subscribed');
});

test('startCheckout creates a billing_customers row once and reuses it on a second call', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'reuse-customer@example.com', 'Org');
  await configurePlanForBilling(env);

  await billing.ensureBillingCustomer(env, signup.organizationId);
  await billing.ensureBillingCustomer(env, signup.organizationId);

  const createCustomerCalls = provider._calls.filter((c) => c.method === 'createCustomer');
  assert.equal(createCustomerCalls.length, 1, 'a second ensureBillingCustomer call must not create a second provider customer');
});

// -----------------------------------------------------
// Webhook dispatch + idempotency
// -----------------------------------------------------

test('checkout.session.completed converts an existing Phase-1 trial subscription in place, not a second row', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'convert-trial@example.com', 'Org');
  await configurePlanForBilling(env);

  const trial = await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  assert.equal(trial.ok, true);

  const webhookResult = await simulateWebhook(billing, provider, env, {
    id: 'evt_convert_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_1', client_reference_id: signup.organizationId, subscription: 'sub_converted_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });
  assert.equal(webhookResult.ok, true);

  const subs = await env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).all();
  assert.equal(subs.results.length, 1, 'converting a trial must not leave two subscription rows');
  assert.equal(subs.results[0].id, trial.subscriptionId, 'the same row must be reused, not replaced');
  assert.equal(subs.results[0].status, 'active');
  assert.equal(subs.results[0].provider, 'fake');
  assert.equal(subs.results[0].provider_subscription_id, 'sub_converted_1');
});

test('checkout.session.completed with no existing subscription creates a new one', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'fresh-checkout@example.com', 'Org');
  await configurePlanForBilling(env);

  await simulateWebhook(billing, provider, env, {
    id: 'evt_fresh_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_2', client_reference_id: signup.organizationId, subscription: 'sub_fresh_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });

  const sub = await plans.getActiveSubscription(env, signup.organizationId);
  assert.equal(sub.status, 'active');
  assert.equal(sub.provider_subscription_id, 'sub_fresh_1');

  const sitesMax = await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max');
  assert.equal(sitesMax, 1, 'entitlements must resolve from the real plan once billing activates it');
});

test('a redelivered webhook event (same provider event id) is a guaranteed no-op the second time', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'idempotent@example.com', 'Org');
  await configurePlanForBilling(env);

  const event = {
    id: 'evt_dupe_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_3', client_reference_id: signup.organizationId, subscription: 'sub_dupe_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  };

  const first = await simulateWebhook(billing, provider, env, event);
  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);

  const second = await simulateWebhook(billing, provider, env, event);
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);

  const subs = await env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).all();
  assert.equal(subs.results.length, 1, 'replaying the same event must not create a second subscription');

  const events = await env.LUMMET_DB.prepare(`SELECT * FROM subscription_status_events WHERE subscription_id = ?`).bind(subs.results[0].id).all();
  assert.equal(events.results.length, 1, 'replaying the same event must not double the audit trail');
});

test('invoice.payment_failed moves a subscription to past_due but entitlements stay usable (grace period), and invoice.paid recovers it', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'grace-period@example.com', 'Org');
  await configurePlanForBilling(env);

  await simulateWebhook(billing, provider, env, {
    id: 'evt_activate_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_4', client_reference_id: signup.organizationId, subscription: 'sub_grace_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });

  await simulateWebhook(billing, provider, env, {
    id: 'evt_failed_1', type: 'invoice.payment_failed',
    data: { object: { id: 'in_1', subscription: 'sub_grace_1', customer: 'cus_x', amount_due: 500, metadata: { organization_id: signup.organizationId } } }
  });

  const afterFail = await plans.getActiveSubscription(env, signup.organizationId);
  assert.equal(afterFail.status, 'past_due');

  const sitesMaxDuringGrace = await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max');
  assert.equal(sitesMaxDuringGrace, 1);

  const invoiceRow = await env.LUMMET_DB.prepare(`SELECT * FROM invoices WHERE provider_invoice_id = 'in_1'`).first();
  assert.equal(invoiceRow.status, 'open');

  await simulateWebhook(billing, provider, env, {
    id: 'evt_paid_1', type: 'invoice.paid',
    data: { object: { id: 'in_1', subscription: 'sub_grace_1', customer: 'cus_x', amount_due: 500, amount_paid: 500, payment_intent: 'pi_1', metadata: { organization_id: signup.organizationId } } }
  });

  const afterPaid = await plans.getActiveSubscription(env, signup.organizationId);
  assert.equal(afterPaid.status, 'active');

  const paidInvoiceRow = await env.LUMMET_DB.prepare(`SELECT * FROM invoices WHERE provider_invoice_id = 'in_1'`).first();
  assert.equal(paidInvoiceRow.status, 'paid');
  assert.equal(paidInvoiceRow.amount_paid_cents, 500);

  const payment = await env.LUMMET_DB.prepare(`SELECT * FROM payments WHERE provider_payment_id = 'pi_1'`).first();
  assert.equal(payment.status, 'succeeded');
  assert.equal(payment.amount_cents, 500);
});

test('customer.subscription.deleted cancels the local subscription', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'deleted-sub@example.com', 'Org');
  await configurePlanForBilling(env);

  await simulateWebhook(billing, provider, env, {
    id: 'evt_activate_2', type: 'checkout.session.completed',
    data: { object: { id: 'cs_5', client_reference_id: signup.organizationId, subscription: 'sub_del_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });

  await simulateWebhook(billing, provider, env, {
    id: 'evt_deleted_1', type: 'customer.subscription.deleted',
    data: { object: { id: 'sub_del_1' } }
  });

  const sub = await env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE provider_subscription_id = 'sub_del_1'`).first();
  assert.equal(sub.status, 'canceled');

  const sitesMax = await entitlements.checkEntitlement(env, signup.organizationId, 'sites.max');
  assert.equal(sitesMax, 0, 'a canceled subscription must fall back to the zero-access floor');
});

test('a webhook whose processing throws is marked failed, not silently swallowed', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);

  const result = await simulateWebhook(billing, provider, env, {
    id: 'evt_orphan_1', type: 'customer.subscription.updated',
    data: { object: { id: 'sub_never_created', status: 'active' } }
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);

  const row = await env.LUMMET_DB.prepare(`SELECT * FROM billing_webhook_events WHERE provider_event_id = 'evt_orphan_1'`).first();
  assert.equal(row.status, 'failed');
  assert.ok(row.error_message.includes('sub_never_created'));
});

// -----------------------------------------------------
// Cancel / resume / change plan
// -----------------------------------------------------

test('canceling a Phase-1 trial (no provider subscription) cancels locally without calling the provider', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'cancel-trial@example.com', 'Org');
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');

  const result = await billing.cancelSubscription(env, signup.organizationId, { actorUserId: signup.userId });
  assert.equal(result.ok, true);
  assert.equal(result.canceledImmediately, true);
  assert.equal(provider._calls.filter((c) => c.method === 'cancelSubscription').length, 0);

  const sub = await env.LUMMET_DB.prepare(`SELECT status FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).first();
  assert.equal(sub.status, 'canceled');
});

test('canceling a real provider subscription at period end sets the flag but waits for the webhook to confirm status', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'cancel-real@example.com', 'Org');
  await configurePlanForBilling(env);
  await simulateWebhook(billing, provider, env, {
    id: 'evt_cr_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_6', client_reference_id: signup.organizationId, subscription: 'sub_cr_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });

  const result = await billing.cancelSubscription(env, signup.organizationId, { atPeriodEnd: true });
  assert.equal(result.ok, true);
  assert.equal(result.canceledImmediately, false);

  const providerCall = provider._calls.find((c) => c.method === 'cancelSubscription');
  assert.equal(providerCall.providerSubscriptionId, 'sub_cr_1');
  assert.equal(providerCall.atPeriodEnd, true);

  const sub = await env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).first();
  assert.equal(sub.cancel_at_period_end, 1);
  assert.equal(sub.status, 'active', 'status itself must not be assumed canceled until the provider confirms via webhook');
});

test('resumeSubscription refuses when nothing is pending cancellation', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'resume-nothing@example.com', 'Org');
  await configurePlanForBilling(env);
  await simulateWebhook(billing, provider, env, {
    id: 'evt_rn_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_7', client_reference_id: signup.organizationId, subscription: 'sub_rn_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });

  const result = await billing.resumeSubscription(env, signup.organizationId);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not_pending_cancellation');
});

test('changePlan refuses a target plan with no provider price, and succeeds against a configured one', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'change-plan@example.com', 'Org');
  await configurePlanForBilling(env);
  await simulateWebhook(billing, provider, env, {
    id: 'evt_cp_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_8', client_reference_id: signup.organizationId, subscription: 'sub_cp_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });

  await env.LUMMET_DB.prepare(
    `INSERT INTO plans (id, product_id, key, name, billing_period, price_cents) VALUES ('plan_growth', 'prod_casino_news', 'test_change_plan_growth', 'Growth', 'monthly', 800)`
  ).run();

  const refused = await billing.changePlan(env, signup.organizationId, 'plan_growth');
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'plan_not_billing_configured');

  await env.LUMMET_DB.prepare(`UPDATE plans SET stripe_price_id = 'price_growth' WHERE id = 'plan_growth'`).run();
  const succeeded = await billing.changePlan(env, signup.organizationId, 'plan_growth');
  assert.equal(succeeded.ok, true);

  const providerCall = provider._calls.find((c) => c.method === 'changePlan');
  assert.equal(providerCall.newPriceId, 'price_growth');

  const sub = await env.LUMMET_DB.prepare(`SELECT plan_id FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).first();
  assert.equal(sub.plan_id, 'plan_growth');
});
