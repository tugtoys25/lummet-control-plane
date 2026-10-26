// v2.5.2.2: credit-pack grant/refund reversal through the webhook, dunning actions, four-eyes approvals,
// quote contact validation, and coupon redemption under concurrency. Real in-memory SQLite, all migrations applied.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeBillingProvider, simulateWebhook } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import * as commercial from '../worker/commercial.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as couponRepo from '../worker/repositories/coupons.js';

function makeEnv(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; }
let n = 0;
async function signup(env) {
  const email = `p5f${n++}@example.com`;
  const r = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.9' } }, env);
  return { orgId: r.organizationId, email };
}
const one = (env, sql, ...b) => env.LUMMET_DB.prepare(sql).bind(...b).first();
const run = (env, sql, ...b) => env.LUMMET_DB.prepare(sql).bind(...b).run();
async function addPack(env, id = 'pack1', credits = 100, price = 1000) {
  await run(env, `INSERT INTO credit_packs (id, credits, price_cents, currency, stripe_price_id, active) VALUES (?,?,?,?,?,1)`, id, credits, price, 'usd', 'price_x');
}
async function addSub(env, orgId, status, graceEndsAt = null) {
  const id = crypto.randomUUID();
  await run(env, `INSERT INTO subscriptions (id, organization_id, plan_id, status, grace_ends_at) VALUES (?,?,?,?,?)`, id, orgId, 'plan_casino_news_starter', status, graceEndsAt);
  return id;
}
const paid = (orgId, pi, id = 'cs_1') => ({ id, mode: 'payment', payment_status: 'paid', payment_intent: pi, client_reference_id: orgId, metadata: { lummet_purchase_type: 'credit_pack', organization_id: orgId, credit_pack_id: 'pack1' } });
async function webhook(env, type, object, id) {
  const provider = createFakeBillingProvider();
  return simulateWebhook(createBillingService(provider), provider, env, { id, type, created: Math.floor(Date.now() / 1000), data: { object } });
}

test('quote edit accepts ordinary emails (regression: double-escaped regex rejected any address containing "s")', async () => {
  const env = makeEnv();
  const created = await commercial.createQuote(env, { contact_name: 'Sam', contact_email: 'sales@business.example', lines: [{ plan_key: 'p', description: 'd', unit_amount_cents: 100 }] }, { staffId: 'staff-1' });
  assert.equal(created.ok, true);
  const edited = await commercial.editQuote(env, created.quoteId, { notes: 'updated' }, { staffId: 'staff-1' });
  assert.deepEqual(edited, { ok: true, quoteId: created.quoteId });
  const bad = await commercial.editQuote(env, created.quoteId, { contact_email: 'not-an-email' }, { staffId: 'staff-1' });
  assert.equal(bad.error, 'invalid_quote_contact');
});

test('credit-pack checkout webhook grants once; duplicate delivery and a second event for the same payment add nothing', async () => {
  const env = makeEnv(); const { orgId } = await signup(env); await addPack(env);
  await webhook(env, 'checkout.session.completed', paid(orgId, 'pi_1'), 'evt_a');
  await webhook(env, 'checkout.session.completed', paid(orgId, 'pi_1'), 'evt_b');
  assert.equal(await commercial.getNetCreditBalance(env, orgId), 100);
});

test('refunds reverse the refunded share of credits, never lower on replay, and a full refund reverses all', async () => {
  const env = makeEnv(); const { orgId } = await signup(env); await addPack(env);
  await webhook(env, 'checkout.session.completed', paid(orgId, 'pi_2'), 'evt_g');
  const charge = (refunded) => ({ id: 'ch_2', payment_intent: 'pi_2', amount: 1000, amount_captured: 1000, amount_refunded: refunded, currency: 'usd', metadata: { organization_id: orgId }, refunds: { data: [] } });
  await webhook(env, 'charge.refunded', charge(250), 'evt_r1');
  assert.equal(await commercial.getNetCreditBalance(env, orgId), 75);
  await webhook(env, 'charge.refunded', charge(100), 'evt_r0');
  assert.equal(await commercial.getNetCreditBalance(env, orgId), 75, 'an older, smaller refund event must not give credits back');
  await webhook(env, 'charge.refunded', charge(250), 'evt_r1b');
  assert.equal(await commercial.getNetCreditBalance(env, orgId), 75);
  await webhook(env, 'charge.refunded', charge(1000), 'evt_r2');
  assert.equal(await commercial.getNetCreditBalance(env, orgId), 0);
});

test('a refund for a charge that is not a credit pack is ignored by the reversal path', async () => {
  const env = makeEnv(); const { orgId } = await signup(env);
  const r = await commercial.reverseCreditPackForRefund(env, { payment_intent: 'pi_other', amount: 500, amount_refunded: 500 });
  assert.equal(r.handled, false);
  assert.equal(await commercial.getNetCreditBalance(env, orgId), 0);
});

test('extendGrace requires a reason, a past_due subscription and 1-30 days, and records the action', async () => {
  const env = makeEnv(); const { orgId } = await signup(env);
  const sub = await addSub(env, orgId, 'past_due', '2026-11-01T00:00:00.000Z');
  const now = new Date('2026-11-02T00:00:00Z');
  assert.equal((await commercial.extendGrace(env, sub, { days: 3, reason: '', staffId: 's1', now })).error, 'reason_required');
  assert.equal((await commercial.extendGrace(env, sub, { days: 0, reason: 'x', staffId: 's1', now })).error, 'invalid_grace_days');
  assert.equal((await commercial.extendGrace(env, sub, { days: 31, reason: 'x', staffId: 's1', now })).error, 'invalid_grace_days');
  const ok = await commercial.extendGrace(env, sub, { days: 3, reason: 'customer called', staffId: 's1', now });
  assert.equal(ok.graceEndsAt, '2026-11-05T00:00:00.000Z');
  assert.equal((await one(env, `SELECT grace_ends_at AS g FROM subscriptions WHERE id=?`, sub)).g, ok.graceEndsAt);
  assert.equal((await one(env, `SELECT COUNT(*) AS c FROM dunning_actions WHERE subscription_id=? AND action='extend_grace'`, sub)).c, 1);
  const active = await addSub(env, orgId, 'active');
  assert.equal((await commercial.extendGrace(env, active, { days: 3, reason: 'x', staffId: 's1', now })).error, 'subscription_not_past_due');
  assert.equal((await commercial.listDunningQueue(env)).some((r) => r.subscription_id === sub), true);
});

test('resendDunningNotice only emails verified, unsuppressed owners and de-duplicates per day', async () => {
  const env = makeEnv(); const { orgId, email } = await signup(env);
  const sub = await addSub(env, orgId, 'past_due');
  const now = new Date('2026-11-02T00:00:00Z');
  assert.equal((await commercial.resendDunningNotice(env, sub, { reason: 'follow up', staffId: 's1', now })).error, 'no_eligible_recipient');
  await run(env, `UPDATE customer_users SET email_verified_at=CURRENT_TIMESTAMP WHERE email=?`, email);
  const sent = await commercial.resendDunningNotice(env, sub, { reason: 'follow up', staffId: 's1', now });
  assert.equal(sent.ok, true);
  await commercial.resendDunningNotice(env, sub, { reason: 'again', staffId: 's1', now });
  assert.equal((await one(env, `SELECT COUNT(*) AS c FROM email_outbox WHERE dedupe_key LIKE 'dunning-resend:%'`)).c, 1);
  assert.equal((await one(env, `SELECT COUNT(*) AS c FROM dunning_actions WHERE action='resend_notice'`)).c, 2);
});

test('four-eyes: threshold fails closed, the requester cannot decide, and one approval executes a credit adjustment once', async () => {
  const env = makeEnv(); const { orgId } = await signup(env);
  assert.equal(commercial.fourEyesThreshold(env), 0);
  assert.equal(commercial.fourEyesThreshold({ FOUR_EYES_THRESHOLD_CENTS: 'abc' }), 0);
  assert.equal(commercial.fourEyesThreshold({ FOUR_EYES_THRESHOLD_CENTS: '5000' }), 5000);
  const req = await commercial.requestApproval(env, { kind: 'credit_adjustment', organizationId: orgId, amount: 500, reason: 'goodwill', staffId: 'a' });
  assert.equal(req.ok, true);
  assert.equal((await commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'a', reason: 'me' })).error, 'self_approval_forbidden');
  assert.equal((await commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'b', reason: '' })).error, 'reason_required');
  const [x, y] = await Promise.all([
    commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'b', reason: 'ok' }),
    commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'c', reason: 'ok' })
  ]);
  assert.equal([x, y].filter((r) => r.ok).length, 1, 'exactly one concurrent approver wins');
  assert.equal((await one(env, `SELECT COALESCE(SUM(amount),0) AS c FROM ai_credit_ledger WHERE organization_id=? AND kind='adjust'`, orgId)).c, 500);
  assert.equal((await one(env, `SELECT status FROM staff_approval_requests WHERE id=?`, req.requestId)).status, 'executed');
});

test('four-eyes: rejection executes nothing, and the table itself refuses a self-decided row', async () => {
  const env = makeEnv(); const { orgId } = await signup(env);
  const req = await commercial.requestApproval(env, { kind: 'credit_adjustment', organizationId: orgId, amount: -50, reason: 'correction', staffId: 'a' });
  const rej = await commercial.decideApproval(env, req.requestId, { decision: 'reject', staffId: 'b', reason: 'no' });
  assert.equal(rej.status, 'rejected');
  assert.equal((await one(env, `SELECT COUNT(*) AS c FROM ai_credit_ledger WHERE organization_id=? AND kind='adjust'`, orgId)).c, 0);
  assert.equal((await commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'c', reason: 'late' })).error, 'approval_not_pending');
  await assert.rejects(() => run(env, `UPDATE staff_approval_requests SET decided_by='a' WHERE id=?`, req.requestId));
});

test('four-eyes refunds: cannot exceed the payment, and approval sends one idempotent Stripe refund', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }); const { orgId } = await signup(env);
  await run(env, `INSERT INTO payments (id, organization_id, provider, provider_payment_id, status, amount_cents, currency) VALUES ('pay1', ?, 'stripe', 'ch_9', 'succeeded', 2000, 'usd')`, orgId);
  assert.equal((await commercial.requestApproval(env, { kind: 'refund', organizationId: orgId, paymentId: 'pay1', amount: 2500, reason: 'r', staffId: 'a' })).error, 'refund_exceeds_payment');
  assert.equal((await commercial.requestApproval(env, { kind: 'refund', organizationId: 'other', paymentId: 'pay1', amount: 100, reason: 'r', staffId: 'a' })).error, 'payment_not_found');
  const req = await commercial.requestApproval(env, { kind: 'refund', organizationId: orgId, paymentId: 'pay1', amount: 1500, reason: 'duplicate charge', staffId: 'a' });
  const calls = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), headers: init.headers, body: String(init.body) }); return new Response(JSON.stringify({ id: 're_1', status: 'succeeded' }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  try {
    const done = await commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'b', reason: 'verified' });
    assert.equal(done.status, 'executed');
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/refunds$/);
  assert.equal(calls[0].headers['Idempotency-Key'], `staff-refund:${req.requestId}`);
  assert.match(calls[0].body, /charge=ch_9/);
  assert.match(calls[0].body, /amount=1500/);
});

test('four-eyes refunds: a provider failure marks the request failed without a secret in the stored code', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_secret_value', STRIPE_RETRY_BASE_MS: '0' }); const { orgId } = await signup(env);
  await run(env, `INSERT INTO payments (id, organization_id, provider, provider_payment_id, status, amount_cents, currency) VALUES ('pay2', ?, 'stripe', 'ch_8', 'succeeded', 1000, 'usd')`, orgId);
  const req = await commercial.requestApproval(env, { kind: 'refund', organizationId: orgId, paymentId: 'pay2', amount: 500, reason: 'r', staffId: 'a' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'No such charge' } }), { status: 400, headers: { 'content-type': 'application/json' } });
  try {
    const out = await commercial.decideApproval(env, req.requestId, { decision: 'approve', staffId: 'b', reason: 'ok' });
    assert.equal(out.ok, false);
    assert.equal(out.error, 'approval_execution_failed');
  } finally { globalThis.fetch = realFetch; }
  const row = await one(env, `SELECT status, failure_code FROM staff_approval_requests WHERE id=?`, req.requestId);
  assert.equal(row.status, 'failed');
  assert.equal(String(row.failure_code).includes('sk_test'), false);
});

test('coupon redemption is once per organization even when two checkouts complete at the same time', async () => {
  const env = makeEnv(); const { orgId } = await signup(env);
  await run(env, `INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off, duration, status) VALUES ('c1','ONCE','stripe','sc1',10,'once','active')`);
  const results = await Promise.all([1, 2, 3, 4].map(() => couponRepo.addRedemption(env, { couponId: 'c1', organizationId: orgId, subscriptionId: null })));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await one(env, `SELECT COUNT(*) AS c FROM coupon_redemptions WHERE coupon_id='c1' AND organization_id=?`, orgId)).c, 1);
});

async function acceptedQuote(env, orgId, createdBy = 'staff-creator') {
  const created = await commercial.createQuote(env, { organization_id: orgId, contact_name: 'Pat', contact_email: 'pat@client.example', currency: 'usd', lines: [{ plan_key: 'custom', description: 'Setup', quantity: 2, unit_amount_cents: 5000 }, { plan_key: 'custom', description: 'Support', unit_amount_cents: 1200 }] }, { staffId: createdBy });
  await run(env, `UPDATE quotes SET status='accepted' WHERE id=?`, created.quoteId);
  return created.quoteId;
}
function stripeMock(calls, { failOn = null } = {}) {
  return async (url, init) => {
    const path = new URL(String(url)).pathname.replace('/v1', '');
    calls.push({ path, headers: init.headers, body: new URLSearchParams(String(init.body)) });
    if (failOn && path === failOn) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ id: path === '/invoices' ? 'in_draft_1' : 'ii_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

test('quote fulfillment creates one draft invoice with idempotent lines, marks the quote invoiced, grants nothing', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }); const { orgId } = await signup(env);
  await run(env, `INSERT INTO billing_customers (organization_id, provider, provider_customer_id) VALUES (?, 'stripe', 'cus_1')`, orgId);
  const quoteId = await acceptedQuote(env, orgId);
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = stripeMock(calls);
  try {
    assert.equal((await commercial.fulfillQuote(env, quoteId, { staffId: 'staff-creator', reason: 'x' })).error, 'creator_cannot_fulfill');
    assert.equal((await commercial.fulfillQuote(env, quoteId, { staffId: 'staff-2', reason: '' })).error, 'reason_required');
    const done = await commercial.fulfillQuote(env, quoteId, { staffId: 'staff-2', reason: 'contract signed' });
    assert.equal(done.providerInvoiceId, 'in_draft_1'); assert.equal(done.draft, true);
    const again = await commercial.fulfillQuote(env, quoteId, { staffId: 'staff-2', reason: 'retry' });
    assert.equal(again.alreadyFulfilled, true);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.length, 3, 'one invoice and two lines; the repeat made no calls');
  assert.equal(calls[0].path, '/invoices');
  assert.equal(calls[0].body.get('auto_advance'), 'false');
  assert.equal(calls[0].body.get('pending_invoice_items_behavior'), 'exclude');
  assert.equal(calls[0].headers['Idempotency-Key'], `quote-invoice:${quoteId}`);
  assert.equal(calls[1].body.get('invoice'), 'in_draft_1');
  assert.equal(calls[1].body.get('unit_amount'), '5000'); assert.equal(calls[1].body.get('quantity'), '2');
  const row = await one(env, `SELECT status, stripe_invoice_id, fulfilled_by FROM quotes WHERE id=?`, quoteId);
  assert.deepEqual({ ...row }, { status: 'invoiced', stripe_invoice_id: 'in_draft_1', fulfilled_by: 'staff-2' });
  assert.equal((await one(env, `SELECT COUNT(*) AS c FROM subscriptions WHERE organization_id=?`, orgId)).c, 0);
});

test('quote fulfillment: only accepted quotes, needs a billing customer, and a Stripe failure releases the claim for retry', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_RETRY_BASE_MS: '0' }); const { orgId } = await signup(env);
  const draft = await commercial.createQuote(env, { organization_id: orgId, contact_name: 'Pat', contact_email: 'pat@client.example', lines: [{ plan_key: 'c', description: 'd', unit_amount_cents: 1 }] }, { staffId: 'a' });
  assert.equal((await commercial.fulfillQuote(env, draft.quoteId, { staffId: 'b', reason: 'x' })).error, 'quote_not_accepted');
  const quoteId = await acceptedQuote(env, orgId);
  assert.equal((await commercial.fulfillQuote(env, quoteId, { staffId: 'b', reason: 'x' })).error, 'billing_customer_required');
  await run(env, `INSERT INTO billing_customers (organization_id, provider, provider_customer_id) VALUES (?, 'stripe', 'cus_2')`, orgId);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = stripeMock([], { failOn: '/invoiceitems' });
    assert.equal((await commercial.fulfillQuote(env, quoteId, { staffId: 'b', reason: 'x' })).error, 'quote_invoice_failed');
    assert.equal((await one(env, `SELECT fulfillment_claimed_at AS c FROM quotes WHERE id=?`, quoteId)).c, null);
    globalThis.fetch = stripeMock([]);
    assert.equal((await commercial.fulfillQuote(env, quoteId, { staffId: 'b', reason: 'retry' })).ok, true);
  } finally { globalThis.fetch = realFetch; }
});

test('quote fulfillment: two staff clicking at once create only one invoice', async () => {
  const env = makeEnv({ STRIPE_SECRET_KEY: 'sk_test_x' }); const { orgId } = await signup(env);
  await run(env, `INSERT INTO billing_customers (organization_id, provider, provider_customer_id) VALUES (?, 'stripe', 'cus_3')`, orgId);
  const quoteId = await acceptedQuote(env, orgId);
  const calls = []; const realFetch = globalThis.fetch; globalThis.fetch = stripeMock(calls);
  try {
    const rs = await Promise.all([commercial.fulfillQuote(env, quoteId, { staffId: 'b', reason: 'x' }), commercial.fulfillQuote(env, quoteId, { staffId: 'c', reason: 'x' })]);
    assert.equal(rs.filter((r) => r.ok && !r.alreadyFulfilled).length, 1);
  } finally { globalThis.fetch = realFetch; }
  assert.equal(calls.filter((c) => c.path === '/invoices').length, 1);
});
