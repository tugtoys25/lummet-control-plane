// One trial per organization, trial extension requests, and pausing sites when a trial ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as te from '../worker/trial-extensions.js';
import { sweep } from '../worker/billing-lifecycle.js';
import { resolveAccess } from '../worker/access.js';

const PLAN = 'plan_casino_news_starter';
function makeEnv(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ...extra }; }
async function signup(env, email) {
  const r = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.9' } }, env);
  return r;
}
async function addSite(env, orgId, id = 's1', status = 'active') {
  const prod = await env.LUMMET_DB.prepare('SELECT id FROM products LIMIT 1').first();
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) VALUES (?, ?, ?, 'S', ?, ?)`).bind(id, orgId, prod.id, 'slug-' + id, status).run();
}
/** Starts a trial and lets it run out: the trial end is moved into the past. */
async function endedTrial(env, orgId) {
  const t = await plans.startTrialSubscription(env, orgId, PLAN);
  assert.equal(t.ok, true);
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET trial_ends_at = ? WHERE id = ?`).bind(new Date(Date.now() - 3600e3).toISOString(), t.subscriptionId).run();
  return t;
}
const siteStatus = async (env, id) => ({ ...(await env.LUMMET_DB.prepare('SELECT status, suspension_reason FROM sites WHERE id = ?').bind(id).first()) });

test('a trial can never be started a second time by the same organization', async () => {
  const env = makeEnv(); const s = await signup(env, 'one@example.com');
  await endedTrial(env, s.organizationId);
  const again = await plans.startTrialSubscription(env, s.organizationId, PLAN);
  assert.equal(again.ok, false); // still a (lapsed) trialing row: refused as already subscribed
  // also after the sweep has marked the first one expired
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'expired' WHERE organization_id = ?`).bind(s.organizationId).run();
  assert.equal((await plans.startTrialSubscription(env, s.organizationId, PLAN)).error, 'trial_already_used_by_organization');
});

test('a customer who never had a trial can still start one', async () => {
  const env = makeEnv(); const s = await signup(env, 'fresh@example.com');
  assert.equal((await plans.startTrialSubscription(env, s.organizationId, PLAN)).ok, true);
});

test('extension request: only after the trial ended, one at a time, message required', async () => {
  const env = makeEnv(); const s = await signup(env, 'req@example.com');
  assert.equal((await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'please' })).error, 'no_trial_to_extend');
  const t = await plans.startTrialSubscription(env, s.organizationId, PLAN);
  assert.equal((await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'please more time' })).error, 'trial_still_running');
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET trial_ends_at = ? WHERE id = ?`).bind(new Date(Date.now() - 1000).toISOString(), t.subscriptionId).run();
  assert.equal((await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'x' })).error, 'message_required');
  assert.equal((await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'need time', wantedDays: 500 })).error, 'invalid_days');
  const ok = await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'we need another week', wantedDays: 7 });
  assert.equal(ok.ok, true);
  assert.equal((await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'again please' })).error, 'request_already_pending');
  const st = await te.extensionStateFor(env, s.organizationId);
  assert.equal(st.hadTrial, true); assert.equal(st.trialEnded, true); assert.equal(st.canRequest, false); assert.ok(st.pending);
});

test('approve: a new trial of the chosen days, paused sites come back, the request closes once', async () => {
  const env = makeEnv({ BILLING_TRIAL_END_SITES: 'on' }); const s = await signup(env, 'ok@example.com');
  await addSite(env, s.organizationId); await endedTrial(env, s.organizationId);
  const sw = await sweep(env, Date.now());
  assert.equal(sw.trialSitesPaused, 1);
  assert.deepEqual(await siteStatus(env, 's1'), { status: 'suspended', suspension_reason: te.TRIAL_END_SUSPENSION_REASON });
  const rq = await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'need more time to finish' });
  assert.equal((await te.decideExtension(env, rq.id, { decision: 'approve', staffId: 'a1', days: 0 })).error, 'invalid_days');
  assert.equal((await te.decideExtension(env, rq.id, { decision: 'approve', staffId: 'a1', days: 91 })).error, 'invalid_days');
  const r = await te.decideExtension(env, rq.id, { decision: 'approve', staffId: 'a1', days: 10, comment: 'welcome back' });
  assert.equal(r.ok, true); assert.equal(r.days, 10);
  assert.equal((await siteStatus(env, 's1')).status, 'active');
  const acc = await resolveAccess(env, s.organizationId);
  assert.equal(acc.state, 'trialing');
  assert.equal((await te.decideExtension(env, rq.id, { decision: 'approve', staffId: 'a2', days: 5 })).error, 'already_decided');
  const trials = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM subscriptions WHERE organization_id = ? AND status = 'trialing'`).bind(s.organizationId).first();
  assert.equal(trials.c, 1);
  // and the extension does not re-open "start a fresh trial"
  assert.equal((await plans.startTrialSubscription(env, s.organizationId, PLAN)).ok, false);
});

test('decline needs a comment, keeps sites paused, and the customer may ask again', async () => {
  const env = makeEnv({ BILLING_TRIAL_END_SITES: 'on' }); const s = await signup(env, 'no@example.com');
  await addSite(env, s.organizationId); await endedTrial(env, s.organizationId); await sweep(env, Date.now());
  const rq = await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'we need time' });
  assert.equal((await te.decideExtension(env, rq.id, { decision: 'decline', staffId: 'a1', comment: '' })).error, 'comment_required');
  assert.equal((await te.decideExtension(env, rq.id, { decision: 'decline', staffId: 'a1', comment: 'Please choose a plan.' })).ok, true);
  assert.equal((await siteStatus(env, 's1')).status, 'suspended');
  const row = await env.LUMMET_DB.prepare('SELECT status, decision_comment FROM trial_extension_requests WHERE id = ?').bind(rq.id).first();
  assert.deepEqual({ ...row }, { status: 'declined', decision_comment: 'Please choose a plan.' });
  assert.equal((await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'asking again' })).ok, true);
});

test('sites are paused only when BILLING_TRIAL_END_SITES is on, and only for ended trials', async () => {
  const off = makeEnv(); const a = await signup(off, 'off@example.com');
  await addSite(off, a.organizationId); await endedTrial(off, a.organizationId); await sweep(off, Date.now());
  assert.equal((await siteStatus(off, 's1')).status, 'active', 'switch off: nothing changes');

  const on = makeEnv({ BILLING_TRIAL_END_SITES: 'on' });
  const running = await signup(on, 'run@example.com'); await addSite(on, running.organizationId, 'r1'); await plans.startTrialSubscription(on, running.organizationId, PLAN);
  const never = await signup(on, 'never@example.com'); await addSite(on, never.organizationId, 'n1');
  const ended = await signup(on, 'ended@example.com'); await addSite(on, ended.organizationId, 'e1'); await endedTrial(on, ended.organizationId);
  await sweep(on, Date.now());
  assert.equal((await siteStatus(on, 'r1')).status, 'active', 'running trial untouched');
  assert.equal((await siteStatus(on, 'n1')).status, 'active', 'never trialed untouched');
  assert.equal((await siteStatus(on, 'e1')).status, 'suspended');
});

test('a site staff suspended is never restored by the trial logic', async () => {
  const env = makeEnv({ BILLING_TRIAL_END_SITES: 'on' }); const s = await signup(env, 'staff@example.com');
  await addSite(env, s.organizationId, 'x1', 'suspended');
  await env.LUMMET_DB.prepare(`UPDATE sites SET suspension_reason = 'abuse report' WHERE id = 'x1'`).run();
  await endedTrial(env, s.organizationId);
  const rq = await te.requestExtension(env, { organizationId: s.organizationId, userId: s.userId, message: 'extension please' });
  await te.decideExtension(env, rq.id, { decision: 'approve', staffId: 'a1', days: 5 });
  assert.deepEqual(await siteStatus(env, 'x1'), { status: 'suspended', suspension_reason: 'abuse report' });
});

test('paying restores the paused sites (sweep self-heals when the subscription becomes active)', async () => {
  const env = makeEnv({ BILLING_TRIAL_END_SITES: 'on' }); const s = await signup(env, 'pay@example.com');
  await addSite(env, s.organizationId); const t = await endedTrial(env, s.organizationId); await sweep(env, Date.now());
  assert.equal((await siteStatus(env, 's1')).status, 'suspended');
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'active', provider = 'stripe', provider_subscription_id = 'sub_x' WHERE id = ?`).bind(t.subscriptionId).run();
  await sweep(env, Date.now());
  assert.equal((await siteStatus(env, 's1')).status, 'active');
});

import { createFakeBillingProvider } from './support/fake-billing-provider.js';
import { createBillingService } from '../worker/billing.js';
import { setPlanPrice } from './support/plan-prices.js';

test('checkout after a finished trial never offers another trial (even with BILLING_ENFORCE off)', async () => {
  const env = makeEnv(); const s = await signup(env, 'co@example.com');
  await env.LUMMET_DB.prepare(`UPDATE plans SET trial_days = 7 WHERE id = ?`).bind(PLAN).run();
  await setPlanPrice(env, PLAN, 'price_x');
  await endedTrial(env, s.organizationId);
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET status = 'expired' WHERE organization_id = ?`).bind(s.organizationId).run();
  const provider = createFakeBillingProvider(); const billing = createBillingService(provider);
  const r = await billing.startCheckout(env, { organizationId: s.organizationId, planId: PLAN, successUrl: 'https://a.test/s', cancelUrl: 'https://a.test/c' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const call = provider._calls.find((c) => c.method === 'createCheckoutSession');
  assert.equal(call.trialDays, 0); assert.equal(call.trialEnd, undefined);
});
