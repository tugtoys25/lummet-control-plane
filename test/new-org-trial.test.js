// A brand-new organization is NEW, not "trial expired": wording, abandoned-checkout false positives, and a repeat click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { computeAccess, refusalFor } from '../worker/access.js';
import { renderBillingPage } from '../worker/views/customer-pages/billing.js';

const STARTER = 'plan_casino_news_starter';
const plan = (o = {}) => ({ id: 'p1', name: 'Starter', price_cents: 500, currency: 'USD', billing_period: 'monthly', trial_days: 7, active_price_id: null, ...o });
const base = { plan: null, invoices: [], canManage: true, subscription: null, availablePlans: [plan()] };

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra }; }
const ctx = { waitUntil() {} };
async function call(e, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.5' }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
const signup = (e, email) => call(e, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: email } });

test('never-subscribed org: banner welcomes the user instead of saying the trial ended', () => {
  const access = { state: 'trial_expired', reason: 'no subscription', subscriptionId: null };
  const out = renderBillingPage({ ...base, access });
  assert.doesNotMatch(out, /The trial has ended/);
  assert.match(out, /Welcome:<\/strong> start your free 7-day trial/);
});

test('an org whose trial really ended still sees the trial-ended banner', () => {
  const access = { state: 'trial_expired', reason: 'trial ended, still live and read-only', subscriptionId: 's1' };
  assert.match(renderBillingPage({ ...base, access }), /The trial has ended/);
});

test('enforcement unchanged: no subscription is still read-only; only the message differs', () => {
  const cfg = { restrictedDays: 7, suspendedDays: 30, graceDays: 14 };
  const a = computeAccess({ sub: null, org: null, now: Date.now(), cfg });
  assert.equal(a.state, 'trial_expired'); assert.equal(a.canMutate, false); assert.equal(a.canServe, true);
  assert.match(refusalFor(a).message, /Start your free trial/);
  assert.equal(refusalFor(a).reasonCode, 'billing_trial_expired');
  assert.match(refusalFor({ ...a, reason: 'trial ended' }).message, /trial has ended/);
});

test('client script explains trial_already_used and confirms a started trial', () => {
  const out = renderBillingPage({ ...base, access: null });
  assert.match(out, /trial_already_used/);
  assert.match(out, /Your free trial has started/);
});

test('new org: trial starts; clicking again reports it as running instead of failing', async () => {
  const e = env();
  const s = await signup(e, 'new@example.com');
  const url = `/api/organizations/${s.json.organizationId}/trial`;
  const first = await call(e, 'POST', url, { cookie: s.cookie, body: { planId: STARTER } });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.alreadyStarted, false);
  const again = await call(e, 'POST', url, { cookie: s.cookie, body: { planId: STARTER } });
  assert.equal(again.status, 200, again.text);
  assert.equal(again.json.alreadyStarted, true);
  assert.equal(again.json.subscriptionId, first.json.subscriptionId);
  const rows = await e.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE organization_id = ?`).bind(s.json.organizationId).all();
  assert.equal(rows.results.length, 1);
});

test('abandoned checkout elsewhere (incomplete row) does not make a new trial "already used"', async () => {
  const e = env();
  const a = await signup(e, 'owner@example.com');
  await e.LUMMET_DB.prepare(`INSERT INTO subscriptions (id, organization_id, plan_id, status) VALUES ('inc1', ?, ?, 'incomplete')`).bind(a.json.organizationId, STARTER).run();
  // same person, second organization
  const user = await e.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = 'owner@example.com'`).first();
  await e.LUMMET_DB.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('org2', 'Second', 'second')`).run();
  await e.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES ('org2', ?, 'owner')`).bind(user.id).run();
  const r = await call(e, 'POST', '/api/organizations/org2/trial', { cookie: a.cookie, body: { planId: STARTER } });
  assert.equal(r.status, 200, r.text);
});

test('a genuinely used trial elsewhere (same owner) is still refused', async () => {
  const e = env();
  const a = await signup(e, 'owner2@example.com');
  const t = await call(e, 'POST', `/api/organizations/${a.json.organizationId}/trial`, { cookie: a.cookie, body: { planId: STARTER } });
  assert.equal(t.status, 200, t.text);
  const user = await e.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = 'owner2@example.com'`).first();
  await e.LUMMET_DB.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('org3', 'Third', 'third')`).run();
  await e.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES ('org3', ?, 'owner')`).bind(user.id).run();
  const r = await call(e, 'POST', '/api/organizations/org3/trial', { cookie: a.cookie, body: { planId: STARTER } });
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'trial_already_used');
});
