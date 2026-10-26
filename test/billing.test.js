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
import { setPlanPrice } from './support/plan-prices.js';

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
  await setPlanPrice(env, planId, priceId);
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

test('temporary pause is off by default and only mutates provider state behind BILLING_SAVE_FLOW', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const billing = createBillingService(provider);
  const signup = await signupOrg(env, 'pause-feature@example.com', 'Org');
  await configurePlanForBilling(env);
  await simulateWebhook(billing, provider, env, {
    id: 'evt_pause_1', type: 'checkout.session.completed',
    data: { object: { id: 'cs_pause_1', client_reference_id: signup.organizationId, subscription: 'sub_pause_1', metadata: { organization_id: signup.organizationId, plan_id: 'plan_casino_news_starter' } } }
  });
  const disabled = await billing.pauseSubscription(env, signup.organizationId, { resumesAt: new Date(Date.now() + 86400000).toISOString(), actorUserId: signup.userId });
  assert.equal(disabled.ok, false); assert.equal(disabled.error, 'save_flow_disabled');
  assert.equal(provider._calls.filter((c) => c.method === 'pauseSubscription').length, 0);
  env.BILLING_SAVE_FLOW = 'on';
  const invalid = await billing.pauseSubscription(env, signup.organizationId, { resumesAt: 'not-a-date', actorUserId: signup.userId });
  assert.equal(invalid.ok, false); assert.equal(invalid.error, 'invalid_pause_resume_time');
  const resumesAt = new Date(Date.now() + 86400000).toISOString();
  const paused = await billing.pauseSubscription(env, signup.organizationId, { resumesAt, actorUserId: signup.userId });
  assert.equal(paused.ok, true);
  assert.equal(provider._calls.filter((c) => c.method === 'pauseSubscription').length, 1);
  assert.ok(await env.LUMMET_DB.prepare(`SELECT pause_resumes_at FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).first());
  const resumed = await billing.resumePausedSubscription(env, signup.organizationId, { actorUserId: signup.userId });
  assert.equal(resumed.ok, true);
  assert.equal(provider._calls.filter((c) => c.method === 'resumePausedSubscription').length, 1);
  const row = await env.LUMMET_DB.prepare(`SELECT pause_resumes_at FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).first();
  assert.equal(row.pause_resumes_at, null);
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

  await setPlanPrice(env, 'plan_growth', 'price_growth');
  const succeeded = await billing.changePlan(env, signup.organizationId, 'plan_growth');
  assert.equal(succeeded.ok, true);

  const providerCall = provider._calls.find((c) => c.method === 'changePlan');
  assert.equal(providerCall.newPriceId, 'price_growth');

  const sub = await env.LUMMET_DB.prepare(`SELECT plan_id FROM subscriptions WHERE organization_id = ?`).bind(signup.organizationId).first();
  assert.equal(sub.plan_id, 'plan_growth');
});

test('payment-method attached, automatically-updated and detached events are idempotent and never store card numbers', async () => {
  const env = makeEnv();
  const provider = createFakeBillingProvider();
  const service = createBillingService(provider);
  const signup = await signupOrg(env, 'payment-method-events@example.com', 'Payment Method Org');
  const customer = await service.ensureBillingCustomer(env, signup.organizationId);
  const attached = { id: 'evt_pm_attached', created: 10, type: 'payment_method.attached', data: { object: { id: 'pm_test_1', customer: customer.provider_customer_id, type: 'card', card: { brand: 'visa', last4: '4242', fingerprint: 'fp_test' } } } };
  const attachedResult = await simulateWebhook(service, provider, env, attached); assert.equal(attachedResult.ok, true, JSON.stringify(attachedResult));
  assert.equal((await simulateWebhook(service, provider, env, attached)).duplicate, true);
  const updated = { id: 'evt_pm_updated', created: 20, type: 'payment_method.automatically_updated', data: { object: { id: 'pm_test_1', customer: customer.provider_customer_id, type: 'card', card: { brand: 'mastercard', last4: '4444', fingerprint: 'fp_test_2' } } } };
  assert.equal((await simulateWebhook(service, provider, env, updated)).ok, true);
  const row = await env.LUMMET_DB.prepare('SELECT * FROM billing_payment_methods WHERE provider_payment_method_id=?').bind('pm_test_1').first();
  assert.equal(row.card_brand, 'mastercard'); assert.equal(row.card_last4, '4444'); assert.equal(row.card_fingerprint, 'fp_test_2');
  const detached = { id: 'evt_pm_detached', created: 30, type: 'payment_method.detached', data: { object: { id: 'pm_test_1', customer: null, type: 'card', card: { brand: 'mastercard', last4: '4444', fingerprint: 'fp_test_2' } } } };
  assert.equal((await simulateWebhook(service, provider, env, detached)).ok, true);
  const detachedRow = await env.LUMMET_DB.prepare('SELECT * FROM billing_payment_methods WHERE provider_payment_method_id=?').bind('pm_test_1').first();
  assert.equal(detachedRow.status, 'detached');
  assert.equal(Object.hasOwn(detachedRow, 'card_number'), false);
  const lateAttach = { id: 'evt_pm_late_attach', created: 15, type: 'payment_method.attached', data: { object: { id: 'pm_test_1', customer: customer.provider_customer_id, type: 'card', card: { brand: 'visa', last4: '4242', fingerprint: 'fp_old' } } } };
  assert.equal((await simulateWebhook(service, provider, env, lateAttach)).ok, true);
  const afterLate = await env.LUMMET_DB.prepare('SELECT * FROM billing_payment_methods WHERE provider_payment_method_id=?').bind('pm_test_1').first();
  assert.equal(afterLate.status, 'detached', 'out-of-order older attach must not undo the later detach');
  assert.equal(afterLate.card_fingerprint, 'fp_test_2');
});

test('Phase 3 money, customer and tax webhook fixtures are idempotent and stale deliveries cannot roll state backwards', async () => {
  const env = makeEnv(); const provider = createFakeBillingProvider(); const service = createBillingService(provider);
  const signup = await signupOrg(env, 'phase3-ledger-events@example.com', 'Phase 3 Ledger Org');
  const customer = await service.ensureBillingCustomer(env, signup.organizationId);
  const send = (id, created, type, object) => simulateWebhook(service, provider, env, { id, created, type, data: { object } });

  const invoice = { id: 'in_phase3', customer: customer.provider_customer_id, metadata: { organization_id: signup.organizationId }, status: 'open', amount_due: 1200, amount_paid: 0, currency: 'usd', subtotal: 1000, tax: 200, total: 1200, number: 'INV-3', lines: { data: [{ id: 'il_phase3', description: 'Plan', quantity: 1, amount: 1000, currency: 'usd', price: { id: 'price_fixture', unit_amount: 1000 } }] } };
  assert.equal((await send('evt_invoice_voided_new', 30, 'invoice.voided', invoice)).ok, true);
  assert.equal((await send('evt_invoice_finalized_old', 20, 'invoice.finalized', { ...invoice, status: 'open' })).ok, true);
  assert.equal((await send('evt_invoice_voided_new', 30, 'invoice.voided', invoice)).duplicate, true);
  const invRow = await env.LUMMET_DB.prepare('SELECT status, provider_event_created, total_cents FROM invoices WHERE provider_invoice_id=?').bind(invoice.id).first();
  assert.equal(invRow.status, 'void'); assert.equal(invRow.provider_event_created, 30); assert.equal(invRow.total_cents, 1200);
  assert.equal((await send('evt_invoice_uncollectible', 40, 'invoice.marked_uncollectible', invoice)).ok, true);
  assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM invoices WHERE provider_invoice_id=?').bind(invoice.id).first()).status, 'uncollectible');

  const charge = { id: 'ch_phase3', customer: customer.provider_customer_id, metadata: { organization_id: signup.organizationId }, currency: 'usd', refunds: { data: [{ id: 're_phase3', amount: 500, currency: 'usd', status: 'succeeded', reason: 'requested_by_customer' }] } };
  assert.equal((await send('evt_refund_new', 50, 'charge.refunded', charge)).ok, true);
  assert.equal((await send('evt_refund_old', 40, 'charge.refunded', { ...charge, refunds: { data: [{ id: 're_phase3', amount: 500, currency: 'usd', status: 'pending' }] } })).ok, true);
  assert.equal((await env.LUMMET_DB.prepare('SELECT status, provider_event_created FROM refunds WHERE provider_refund_id=?').bind('re_phase3').first()).status, 'succeeded');

  const dispute = { id: 'dp_phase3', charge: 'ch_phase3', metadata: { organization_id: signup.organizationId }, amount: 500, currency: 'usd', status: 'won', reason: 'product_not_received' };
  assert.equal((await send('evt_dispute_closed', 70, 'charge.dispute.closed', dispute)).ok, true);
  assert.equal((await send('evt_dispute_created_old', 60, 'charge.dispute.created', { ...dispute, status: 'needs_response' })).ok, true);
  assert.equal((await env.LUMMET_DB.prepare('SELECT status FROM disputes WHERE provider_dispute_id=?').bind('dp_phase3').first()).status, 'won');

  const credit = { id: 'cn_phase3', invoice: invoice.id, metadata: { organization_id: signup.organizationId }, amount: 100, currency: 'usd', status: 'issued', reason: 'product_not_received' };
  assert.equal((await send('evt_credit_note', 80, 'credit_note.created', credit)).ok, true);
  assert.equal((await send('evt_credit_note_old', 75, 'credit_note.created', { ...credit, amount: 50 })).ok, true);
  assert.equal((await env.LUMMET_DB.prepare('SELECT amount_cents FROM credit_notes WHERE provider_credit_note_id=?').bind('cn_phase3').first()).amount_cents, 100);

  const cust = { id: customer.provider_customer_id, name: 'Newest Legal Name', email: 'billing-new@example.com', address: { line1: '1 New Street', city: 'London', country: 'GB' }, tax_exempt: 'none' };
  assert.equal((await send('evt_customer_new', 100, 'customer.updated', cust)).ok, true);
  assert.equal((await send('evt_customer_old', 90, 'customer.updated', { ...cust, name: 'Stale Name' })).ok, true);
  assert.equal((await send('evt_tax_id_new', 120, 'customer.tax_id.created', { id: 'tax_phase3', customer: customer.provider_customer_id, type: 'eu_vat', value: 'GB123456789' })).ok, true);
  assert.equal((await send('evt_tax_id_old', 110, 'customer.tax_id.updated', { id: 'tax_phase3', customer: customer.provider_customer_id, type: 'eu_vat', value: 'STALE' })).ok, true);
  let profile = await env.LUMMET_DB.prepare('SELECT legal_name, tax_id, provider_event_created FROM organization_billing_profiles WHERE organization_id=?').bind(signup.organizationId).first();
  assert.equal(profile.legal_name, 'Newest Legal Name'); assert.equal(profile.tax_id, 'GB123456789'); assert.equal(profile.provider_event_created, 120);
  assert.equal((await send('evt_tax_delete_new', 130, 'customer.tax_id.deleted', { id: 'tax_phase3', customer: customer.provider_customer_id })).ok, true);
  assert.equal((await send('evt_tax_create_old', 125, 'customer.tax_id.created', { id: 'tax_phase3', customer: customer.provider_customer_id, type: 'eu_vat', value: 'STALE' })).ok, true);
  profile = await env.LUMMET_DB.prepare('SELECT tax_id, provider_event_created FROM organization_billing_profiles WHERE organization_id=?').bind(signup.organizationId).first();
  assert.equal(profile.tax_id, null); assert.equal(profile.provider_event_created, 130, 'a stale tax-id create cannot undo a later deletion');
});

test('AT-6 downgrade guard blocks over-limit/unmetered-storage downgrades; audited staff override schedules at period end', async () => {
  const env = makeEnv({ BILLING_ENFORCE: 'off' });
  const provider = createFakeBillingProvider(); const service = createBillingService(provider);
  const signup = await signupOrg(env, 'guarded-downgrade@example.com', 'Guarded Downgrade Org');
  await env.LUMMET_DB.prepare(`INSERT INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status) VALUES ('plan_guard_growth','prod_casino_news','guard_growth','Guard Growth','monthly',2000,'USD',0,'active')`).run();
  await setPlanPrice(env, 'plan_guard_growth', 'price_guard_growth');
  await setPlanPrice(env, 'plan_casino_news_starter', 'price_guard_starter');
  await env.LUMMET_DB.prepare(`INSERT INTO plan_entitlements (plan_id,key,value_type,value) VALUES
    ('plan_guard_growth','sites.max','number','10'),('plan_guard_growth','users.max','number','10'),('plan_guard_growth','domains.custom.max','number','10'),('plan_guard_growth','storage.max_mb','number','1000')`).run();
  await simulateWebhook(service, provider, env, { id: 'evt_guard_sub', type: 'checkout.session.completed', data: { object: { id: 'cs_guard', client_reference_id: signup.organizationId, subscription: 'sub_guard', metadata: { organization_id: signup.organizationId, plan_id: 'plan_guard_growth' } } } });
  const refused = await service.changePlan(env, signup.organizationId, 'plan_casino_news_starter', { actorUserId: 'customer-1' });
  assert.equal(refused.ok, false); assert.equal(refused.error, 'downgrade_blocked'); assert.ok(refused.blockers.some(x => x.metric === 'storageMb'));
  assert.equal(provider._calls.filter(c => c.method === 'changePlan').length, 0, 'a blocked downgrade never reaches the provider');
  const overridden = await service.changePlan(env, signup.organizationId, 'plan_casino_news_starter', { actorUserId: 'staff:42', staffOverrideReason: 'Verified account owner requested the downgrade; storage meter is pending implementation.' });
  assert.equal(overridden.ok, true); assert.equal(overridden.scheduled, true);
  const providerCall = provider._calls.find(c => c.method === 'changePlan'); assert.equal(providerCall.atPeriodEnd, true);
  const sub = await env.LUMMET_DB.prepare('SELECT plan_id FROM subscriptions WHERE organization_id=?').bind(signup.organizationId).first();
  assert.equal(sub.plan_id, 'plan_guard_growth', 'entitlements remain on the current plan until Stripe confirms the period-end change');
  const auditEvent = await env.LUMMET_DB.prepare("SELECT reason, actor_type, actor_id FROM subscription_status_events WHERE subscription_id=(SELECT id FROM subscriptions WHERE organization_id=?) AND reason LIKE 'STAFF DOWNGRADE OVERRIDE%' ORDER BY id DESC LIMIT 1").bind(signup.organizationId).first();
  assert.equal(auditEvent.actor_type, 'lummet_admin'); assert.equal(auditEvent.actor_id, 'staff:42'); assert.match(auditEvent.reason, /Verified account owner/);
});


test('billing profile saves to Stripe before local persistence and preserves Stripe-managed tax IDs', async () => {
  const env = makeEnv(); const provider = createFakeBillingProvider(); const service = createBillingService(provider);
  const signup = await signupOrg(env, 'billing-profile-roundtrip@example.com', 'Billing Profile Org');
  await env.LUMMET_DB.prepare(`INSERT INTO organization_billing_profiles (organization_id,tax_id_type,tax_id) VALUES (?,?,?)`).bind(signup.organizationId,'eu_vat','GB123456789').run();
  const input = { legal_name:'Example Limited', billing_email:'finance@example.com', address_line1:'1 High Street', city:'London', country:'gb', tax_exempt:false, po_number:'PO-123' };
  const result = await service.updateBillingProfile(env, signup.organizationId, input, { actorUserId:'customer-1' });
  assert.equal(result.ok,true); assert.equal(result.profile.country,'GB'); assert.equal(result.profile.tax_id,'GB123456789');
  const providerCall = provider._calls.find(c=>c.method==='updateCustomer'); assert.ok(providerCall); assert.equal(providerCall.profile.legal_name,'Example Limited'); assert.ok(providerCall.idempotencyKey);
  provider._failUpdateCustomer = true;
  const failed = await service.updateBillingProfile(env, signup.organizationId, { ...input, legal_name:'Should Not Persist' }, { actorUserId:'customer-1' });
  assert.equal(failed.ok,false); assert.equal(failed.error,'billing_profile_sync_failed');
  const saved = await service.getBillingProfile(env, signup.organizationId); assert.equal(saved.legal_name,'Example Limited','provider failure must not overwrite the local billing profile');
});
