// Staff plan catalog management: full CRUD, publish/unpublish, bulk actions, labels, features, entitlements, SEO,
// promotions and price versions, plus how the public pricing page reflects them. Existing behaviour (the legacy plan
// endpoint refusing prices, immutable price history) is covered by staff-console.test.js and plan-prices.test.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { setPlanPrice as seedPrice } from './support/plan-prices.js';
import { createAssets } from './support/public-env.js';
import * as catalog from '../worker/plan-catalog.js';
import worker from '../worker/index.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra }; }
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;
const run = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).run();
const STARTER = 'plan_casino_news_starter', GROWTH = 'plan_casino_news_growth';
const PRODUCT = async (e) => (await one(e, `SELECT id FROM products WHERE status = 'active' ORDER BY id LIMIT 1`)).id;

async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffLogin(e) {
  assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).status, 200);
  return (await call(e, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;
}
const API = '/api/platform/saas/plan-catalog';
async function newPlan(e, staff, over = {}) {
  const r = await call(e, 'POST', API, { name: 'Test Plan', productId: await PRODUCT(e), billingPeriod: 'monthly', priceCents: 1500, ...over }, staff);
  assert.equal(r.status, 200, r.text); return r.json.planId;
}

test('migration 0078 is additive: existing plans keep their status, order and presentation defaults', async () => {
  const e = env();
  const p = await one(e, 'SELECT status, sort_order, is_featured, tagline, published_at FROM plans WHERE id = ?', STARTER);
  assert.equal(p.status, 'active'); assert.equal(p.sort_order, 0); assert.equal(p.is_featured, 0); assert.equal(p.tagline, null); assert.ok(p.published_at);
  assert.ok((await all(e, 'SELECT id FROM plan_labels')).length >= 6);
});

test('the plan manager is staff-only: API and page refuse anonymous callers', async () => {
  const e = env();
  for (const [m, p] of [['GET', API], ['POST', API], ['POST', API + '/bulk'], ['GET', API + '/export.csv'], ['POST', '/api/platform/saas/plan-labels'], ['POST', '/api/platform/saas/products']]) {
    assert.equal((await call(e, m, p, m === 'POST' ? {} : null)).status, 401, m + ' ' + p);
  }
  assert.ok([301, 302, 303].includes((await call(e, 'GET', '/platform/saas/plans')).status));
});

test('the page renders the manager: selection, bulk bar, filters, existing price cell, no inline handlers', async () => {
  const e = env(); const staff = await staffLogin(e);
  await seedPrice(e, STARTER, 'price_shown', { mode: 'test' });
  const page = await call(e, 'GET', '/platform/saas/plans?status=active&sort=price&dir=desc', null, staff);
  assert.equal(page.status, 200);
  for (const re of [/id="pc-bulk"/, /pc-select-all/, /data-bulk="publish"/, /data-bulk="delete"/, /data-pc="new"/, /role="switch"/, /price_shown/, /Export CSV/, /aria-sort="descending"/]) assert.match(page.text, re);
  assert.doesNotMatch(page.text, /\sonclick=/);
  const q = await call(e, 'GET', '/platform/saas/plans?q=nonexistent-zzz', null, staff);
  assert.match(q.text, /No plans match these filters/);
});

test('create is a draft; it validates; the key is unique and immutable', async () => {
  const e = env(); const staff = await staffLogin(e); const product = await PRODUCT(e);
  assert.equal((await call(e, 'POST', API, { name: 'x', productId: product }, staff)).error ?? (await call(e, 'POST', API, { name: 'x', productId: product }, staff)).json.error, 'invalid_name');
  assert.equal((await call(e, 'POST', API, { name: 'Okay', productId: 'nope' }, staff)).json.error, 'product_not_found');
  assert.equal((await call(e, 'POST', API, { name: 'Okay', productId: product, priceCents: -5 }, staff)).json.error, 'invalid_price_cents');
  assert.equal((await call(e, 'POST', API, { name: 'Okay', productId: product, key: 'Bad Key' }, staff)).json.error, 'invalid_key');
  const id = await newPlan(e, staff, { name: 'Launch Pro', key: 'launch_pro', trialDays: 7, tagline: 'Fast', labelIds: ['label_new'] });
  const row = await one(e, 'SELECT * FROM plans WHERE id = ?', id);
  assert.equal(row.status, 'draft'); assert.equal(row.trial_days, 7); assert.equal(row.currency, 'USD'); assert.equal(row.published_at, null);
  assert.equal((await all(e, 'SELECT * FROM plan_label_links WHERE plan_id = ?', id)).length, 1);
  assert.equal((await call(e, 'POST', API, { name: 'Dup', productId: await PRODUCT(e), key: 'launch_pro' }, staff)).json.error, 'key_already_exists');
  assert.equal((await call(e, 'POST', `${API}/${id}`, { key: 'other' }, staff)).json.error, 'key_is_immutable');
  const custom = await newPlan(e, staff, { name: 'Contract', billingPeriod: 'custom', priceCents: 999 });
  assert.equal((await one(e, 'SELECT price_cents FROM plans WHERE id = ?', custom)).price_cents, null);
});

test('edit changes fields, audits a before/after summary, and a draft is invisible to customers and the public page', async () => {
  const e = env(); const staff = await staffLogin(e);
  const id = await newPlan(e, staff, { name: 'Hidden Gem', trialDays: 0 });
  const r = await call(e, 'POST', `${API}/${id}`, { name: 'Renamed Gem', trialDays: 21, seoDescription: 'Great plan', isFeatured: true }, staff);
  assert.equal(r.status, 200); assert.deepEqual(r.json.changed.sort(), ['isFeatured', 'name', 'seoDescription', 'trialDays']);
  assert.equal((await call(e, 'POST', `${API}/${id}`, { trialDays: 120 }, staff)).json.error, 'invalid_trial_days');
  const audit = await one(e, `SELECT reason FROM lummet_audit_logs WHERE resource='plan' AND resource_id=? AND action='update' ORDER BY id LIMIT 1`, id);
  assert.match(audit.reason, /name: "Hidden Gem" -> "Renamed Gem"/);
  assert.equal((await all(e, `SELECT id FROM plans WHERE status = 'active' AND id = ?`, id)).length, 0);
  await seedPrice(e, id, 'price_hidden');
  assert.doesNotMatch((await call(e, 'GET', '/pricing')).text, /Renamed Gem/);
});

test('publish, unpublish, retire, restore: status moves, first publish stamps published_at, listing follows', async () => {
  const e = env(); const staff = await staffLogin(e);
  const id = await newPlan(e, staff, { name: 'Lifecycle' });
  const pub = await call(e, 'POST', `${API}/${id}/publish`, {}, staff);
  assert.equal(pub.status, 200); assert.ok(pub.json.warnings.includes('no_active_stripe_price'), 'publishing without a Stripe price warns, it does not block');
  const stamped = (await one(e, 'SELECT published_at, status FROM plans WHERE id = ?', id));
  assert.equal(stamped.status, 'active'); assert.ok(stamped.published_at);
  assert.equal((await call(e, 'POST', `${API}/${id}/unpublish`, {}, staff)).status, 200);
  assert.equal((await one(e, 'SELECT status FROM plans WHERE id = ?', id)).status, 'draft');
  assert.equal((await call(e, 'POST', `${API}/${id}/restore`, {}, staff)).json.error, 'not_archived');
  assert.equal((await call(e, 'POST', `${API}/${id}/archive`, {}, staff)).status, 200);
  assert.equal((await call(e, 'POST', `${API}/${id}/restore`, {}, staff)).status, 200);
  assert.equal((await one(e, 'SELECT status FROM plans WHERE id = ?', id)).status, 'draft');
  const list = await call(e, 'GET', `${API}?status=draft`, null, staff);
  assert.ok(list.json.data.some((p) => p.id === id)); assert.ok(list.json.counts.draft >= 1);
  assert.equal((await call(e, 'POST', `${API}/missing/publish`, {}, staff)).status, 404);
});

test('unpublishing or retiring a plan with live subscribers never touches the subscriptions', async () => {
  const e = env(); const staff = await staffLogin(e);
  const o = (await call(e, 'POST', '/api/customer/signup', { email: 'sub@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Sub Org' })).json.organizationId;
  await run(e, `INSERT INTO subscriptions (id, organization_id, plan_id, status) VALUES ('sub1', ?, ?, 'active')`, o, GROWTH);
  assert.equal((await call(e, 'POST', `${API}/${GROWTH}/unpublish`, {}, staff)).status, 200);
  assert.equal((await call(e, 'POST', `${API}/${GROWTH}/archive`, {}, staff)).status, 200);
  assert.equal((await one(e, `SELECT status, plan_id FROM subscriptions WHERE id='sub1'`)).status, 'active');
  const d = await call(e, 'POST', `${API}/${GROWTH}/delete`, {}, staff);
  assert.equal(d.status, 409); assert.equal(d.json.error, 'plan_in_use'); assert.ok(d.json.blockers.subscriptions >= 1);
  assert.ok(await one(e, 'SELECT id FROM plans WHERE id = ?', GROWTH));
});

test('delete: only unused non-published plans; published and price-history plans are refused; children go with it', async () => {
  const e = env(); const staff = await staffLogin(e);
  const id = await newPlan(e, staff, { name: 'Disposable' });
  await call(e, 'POST', `${API}/${id}/features`, { features: ['One', 'Two'] }, staff);
  await call(e, 'POST', `${API}/${id}/publish`, {}, staff);
  assert.equal((await call(e, 'POST', `${API}/${id}/delete`, {}, staff)).json.error, 'unpublish_before_delete');
  await call(e, 'POST', `${API}/${id}/unpublish`, {}, staff);
  assert.equal((await call(e, 'POST', `${API}/${id}/delete`, {}, staff)).status, 200);
  assert.equal(await one(e, 'SELECT id FROM plans WHERE id = ?', id), null);
  assert.equal((await all(e, 'SELECT id FROM plan_features WHERE plan_id = ?', id)).length, 0);
  await seedPrice(e, STARTER, 'price_hist');
  await call(e, 'POST', `${API}/${STARTER}/unpublish`, {}, staff);
  assert.equal((await call(e, 'POST', `${API}/${STARTER}/delete`, {}, staff)).json.error, 'plan_in_use');
});

test('duplicate makes a draft copy with features, entitlements and labels but no price or promotion', async () => {
  const e = env(); const staff = await staffLogin(e);
  await call(e, 'POST', `${API}/${GROWTH}/features`, { features: ['A line'] }, staff);
  await call(e, 'POST', `${API}/${GROWTH}/labels`, { labelIds: ['label_popular'] }, staff);
  await seedPrice(e, GROWTH, 'price_g');
  const d = await call(e, 'POST', `${API}/${GROWTH}/duplicate`, {}, staff);
  assert.equal(d.status, 200);
  const copy = await one(e, 'SELECT * FROM plans WHERE id = ?', d.json.planId);
  assert.equal(copy.status, 'draft'); assert.match(copy.name, /\(copy\)$/);
  assert.equal((await all(e, 'SELECT id FROM plan_prices WHERE plan_id = ?', copy.id)).length, 0);
  assert.equal((await all(e, 'SELECT id FROM plan_features WHERE plan_id = ?', copy.id)).length, 1);
  assert.equal((await all(e, 'SELECT label_id FROM plan_label_links WHERE plan_id = ?', copy.id)).length, 1);
  assert.ok((await all(e, 'SELECT key FROM plan_entitlements WHERE plan_id = ?', copy.id)).length > 0);
  const d2 = await call(e, 'POST', `${API}/${GROWTH}/duplicate`, {}, staff);
  assert.notEqual(d2.json.planId, d.json.planId);
});

test('bulk: publish/unpublish/label/trial/feature/delete report per plan, skip what cannot be done, audit each plan', async () => {
  const e = env(); const staff = await staffLogin(e);
  const a = await newPlan(e, staff, { name: 'Bulk A' }), b = await newPlan(e, staff, { name: 'Bulk B' });
  let r = await call(e, 'POST', API + '/bulk', { action: 'publish', ids: [a, b, 'ghost'] }, staff);
  assert.equal(r.status, 200); assert.equal(r.json.done, 2); assert.equal(r.json.failed, 1);
  assert.equal(r.json.results.find((x) => x.id === 'ghost').error, 'not_found');
  r = await call(e, 'POST', API + '/bulk', { action: 'add_label', ids: [a, b], labelId: 'label_best_value' }, staff);
  assert.equal(r.json.done, 2); assert.equal((await all(e, `SELECT * FROM plan_label_links WHERE label_id='label_best_value'`)).length, 2);
  r = await call(e, 'POST', API + '/bulk', { action: 'remove_label', ids: [a], labelId: 'label_best_value' }, staff);
  assert.equal((await all(e, `SELECT * FROM plan_label_links WHERE label_id='label_best_value'`)).length, 1);
  r = await call(e, 'POST', API + '/bulk', { action: 'set_trial_days', ids: [a, b], trialDays: 30 }, staff);
  assert.equal((await one(e, 'SELECT trial_days FROM plans WHERE id = ?', b)).trial_days, 30);
  assert.equal((await call(e, 'POST', API + '/bulk', { action: 'set_trial_days', ids: [a], trialDays: 999 }, staff)).json.error, 'invalid_trial_days');
  r = await call(e, 'POST', API + '/bulk', { action: 'feature', ids: [a, b] }, staff);
  assert.equal((await all(e, `SELECT id FROM plans WHERE is_featured = 1 AND id IN (?, ?)`, a, b)).length, 1, 'only one recommended plan per product and period');
  r = await call(e, 'POST', API + '/bulk', { action: 'delete', ids: [a, b] }, staff);
  assert.equal(r.json.done, 0, 'published plans are not deleted');
  await call(e, 'POST', API + '/bulk', { action: 'unpublish', ids: [a, b] }, staff);
  r = await call(e, 'POST', API + '/bulk', { action: 'delete', ids: [a, b, STARTER] }, staff);
  assert.equal(r.json.done, 2);
  assert.equal((await call(e, 'POST', API + '/bulk', { action: 'explode', ids: [a] }, staff)).json.error, 'invalid_action');
  assert.equal((await call(e, 'POST', API + '/bulk', { action: 'publish', ids: [] }, staff)).json.error, 'nothing_selected');
  assert.equal((await call(e, 'POST', API + '/bulk', { action: 'publish', ids: Array.from({ length: 101 }, (_, i) => 'p' + i) }, staff)).json.error, 'too_many_selected');
  const audits = await all(e, `SELECT resource_id FROM lummet_audit_logs WHERE action = 'bulk_publish' AND resource = 'plan'`);
  assert.ok(audits.length >= 3);
});

test('labels: create, rename, recolor, assign to a plan, delete; limits are enforced', async () => {
  const e = env(); const staff = await staffLogin(e);
  const L = '/api/platform/saas/plan-labels';
  assert.equal((await call(e, 'POST', L, { name: 'x' }, staff)).json.error, 'invalid_name');
  assert.equal((await call(e, 'POST', L, { name: 'Agency pick', color: 'pink' }, staff)).json.error, 'invalid_color');
  const c = await call(e, 'POST', L, { name: 'Agency pick', color: 'teal' }, staff); assert.equal(c.status, 200);
  assert.equal((await call(e, 'POST', L, { name: 'Agency pick' }, staff)).json.error, 'label_already_exists');
  assert.equal((await call(e, 'POST', `${L}/${c.json.labelId}`, { name: 'Agency choice', color: 'red' }, staff)).status, 200);
  assert.equal((await call(e, 'POST', `${API}/${GROWTH}/labels`, { labelIds: [c.json.labelId, 'ghost'] }, staff)).json.error, 'label_not_found');
  assert.equal((await call(e, 'POST', `${API}/${GROWTH}/labels`, { labelIds: [c.json.labelId] }, staff)).status, 200);
  const d = await call(e, 'GET', `${API}/${GROWTH}`, null, staff);
  assert.equal(d.json.data.labels[0].name, 'Agency choice');
  assert.equal((await call(e, 'POST', `${L}/${c.json.labelId}/delete`, {}, staff)).status, 200);
  assert.equal((await all(e, 'SELECT * FROM plan_label_links WHERE plan_id = ?', GROWTH)).length, 0);
  assert.equal((await call(e, 'POST', `${API}/${GROWTH}/labels`, { labelIds: ['label_new', 'label_popular', 'label_best_value', 'label_recommended', 'label_limited', 'label_enterprise', 'a', 'b', 'c'] }, staff)).json.error, 'too_many_labels');
});

test('feature lines and entitlements: validated, replaced atomically, typed keys are protected', async () => {
  const e = env(); const staff = await staffLogin(e);
  const id = await newPlan(e, staff, { name: 'Config' });
  assert.equal((await call(e, 'POST', `${API}/${id}/features`, { features: Array(31).fill('x') }, staff)).json.error, 'too_many_features');
  await call(e, 'POST', `${API}/${id}/features`, { features: [{ label: 'Priority support', highlight: true }, { label: 'White label', included: false }, '', 'Plain'] }, staff);
  const f = await all(e, 'SELECT label, included, highlight FROM plan_features WHERE plan_id = ? ORDER BY sort_order', id);
  assert.deepEqual(f.map((x) => [x.label, x.included, x.highlight]), [['Priority support', 1, 1], ['White label', 0, 0], ['Plain', 1, 0]]);
  const E = `${API}/${id}/entitlements`;
  assert.equal((await call(e, 'POST', E, { entitlements: [{ key: 'sites.max', valueType: 'text', value: 'many' }] }, staff)).json.error, 'entitlement_type_mismatch');
  assert.equal((await call(e, 'POST', E, { entitlements: [{ key: 'sites.max', valueType: 'number', value: '-3' }] }, staff)).json.error, 'invalid_number');
  assert.equal((await call(e, 'POST', E, { entitlements: [{ key: 'Bad Key', valueType: 'number', value: '1' }] }, staff)).json.error, 'invalid_key');
  assert.equal((await call(e, 'POST', E, { entitlements: [{ key: 'api.enabled', valueType: 'boolean', value: true }, { key: 'api.enabled', valueType: 'boolean', value: false }] }, staff)).json.error, 'duplicate_key');
  assert.equal((await call(e, 'POST', E, { entitlements: [{ key: 'sites.max', valueType: 'number', value: 7 }, { key: 'api.enabled', valueType: 'boolean', value: true }, { key: 'custom.beta_tools', valueType: 'text', value: 'yes' }] }, staff)).status, 200);
  assert.deepEqual((await all(e, 'SELECT key, value FROM plan_entitlements WHERE plan_id = ? ORDER BY key', id)).map((x) => `${x.key}=${x.value}`), ['api.enabled=true', 'custom.beta_tools=yes', 'sites.max=7']);
  // a failed save leaves the previous set intact
  await call(e, 'POST', E, { entitlements: [{ key: 'sites.max', valueType: 'text', value: 'x' }] }, staff);
  assert.equal((await all(e, 'SELECT key FROM plan_entitlements WHERE plan_id = ?', id)).length, 3);
});

test('entitlement edits change what a subscriber of the plan resolves to', async () => {
  const e = env(); const staff = await staffLogin(e);
  const o = (await call(e, 'POST', '/api/customer/signup', { email: 'ent@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Ent Org' })).json.organizationId;
  await run(e, `INSERT INTO subscriptions (id, organization_id, plan_id, status) VALUES ('s-ent', ?, ?, 'active')`, o, GROWTH);
  const ents = await import('../worker/entitlements.js');
  await call(e, 'POST', `${API}/${GROWTH}/entitlements`, { entitlements: [{ key: 'sites.max', valueType: 'number', value: 42 }] }, staff);
  assert.equal((await ents.resolveForOrganization(e, o))['sites.max'].value, 42);
});

test('legacy plan endpoint is unchanged: a price edit through it is still refused', async () => {
  const e = env(); const staff = await staffLogin(e);
  const r = await call(e, 'POST', `/api/platform/saas/plans/${GROWTH}`, { priceCents: 900 }, staff);
  assert.equal(r.status, 422); assert.equal(r.json.error, 'price_managed_by_catalog');
});

test('price: list price is editable only until the first price version; then a new version is the only way', async () => {
  const e = env(); const staff = await staffLogin(e);
  const id = await newPlan(e, staff, { name: 'Priced', priceCents: 1000, key: 'priced_plan' });
  assert.equal((await call(e, 'POST', `${API}/${id}`, { priceCents: 1200 }, staff)).status, 200);
  const P = `${API}/${id}/price`;
  assert.equal((await call(e, 'POST', P, { amountCents: 1200, stripePriceId: 'bad', reason: 'x' }, staff)).json.error, 'invalid_stripe_price_id');
  assert.equal((await call(e, 'POST', P, { amountCents: 1200, stripePriceId: 'price_AAAAAAAA1', reason: '' }, staff)).json.error, 'reason_required');
  assert.equal((await call(e, 'POST', P, { amountCents: -1, stripePriceId: 'price_AAAAAAAA1', reason: 'r' }, staff)).json.error, 'invalid_price_cents');
  const v1 = await call(e, 'POST', P, { amountCents: 1200, stripePriceId: 'price_AAAAAAAA1', reason: 'launch' }, staff);
  assert.equal(v1.status, 200); assert.equal(v1.json.version, 1); assert.equal(v1.json.verified, false, 'no Stripe key here: stored unverified, mode unknown');
  const v2 = await call(e, 'POST', P, { amountCents: 1500, stripePriceId: 'price_BBBBBBBB2', reason: 'raise' }, staff);
  assert.equal(v2.json.version, 2);
  const rows = await all(e, 'SELECT version, active, unit_amount_cents, lookup_key, stripe_mode FROM plan_prices WHERE plan_id = ? ORDER BY version', id);
  assert.deepEqual(rows.map((r) => [r.version, r.active, r.unit_amount_cents]), [[1, 0, 1200], [2, 1, 1500]], 'old version kept, only its active flag flipped');
  assert.equal(rows[1].lookup_key, 'priced_plan_month_usd_v2'); assert.equal(rows[1].stripe_mode, 'unknown');
  assert.equal((await one(e, 'SELECT price_cents FROM plans WHERE id = ?', id)).price_cents, 1500);
  assert.equal((await call(e, 'POST', `${API}/${id}`, { priceCents: 99 }, staff)).json.error, 'price_managed_by_versions');
  assert.equal((await call(e, 'POST', P, { amountCents: 1500, stripePriceId: 'price_BBBBBBBB2', reason: 'again' }, staff)).json.error, 'stripe_price_already_used');
  assert.equal((await call(e, 'POST', `${API}/${id}`, { billingPeriod: 'annual' }, staff)).json.error, 'billing_period_locked_after_sales');
  const sold = await import('../worker/plan-prices.js');
  const plan = await one(e, 'SELECT * FROM plans WHERE id = ?', id);
  assert.equal((await sold.resolveCheckoutPrice(e, plan)).price.stripe_price_id, 'price_BBBBBBBB2', 'checkout uses the new version');
  const audit = await one(e, `SELECT reason FROM lummet_audit_logs WHERE action='set_price' AND success=1 AND resource_id=? ORDER BY id DESC LIMIT 1`, id);
  assert.match(audit.reason, /NOT verified/);
});

test('price with Stripe connected: amount, currency and interval must match Stripe or nothing is saved', async () => {
  const e = env({ STRIPE_SECRET_KEY: 'sk_test_x' }); const staff = await staffLogin(e);
  const id = await newPlan(e, staff, { name: 'Verified', key: 'verified_plan', priceCents: 2000 });
  const realFetch = globalThis.fetch; let stripe;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://api.stripe.com/v1/prices/')) return stripe ? new Response(JSON.stringify(stripe), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 404 });
    return realFetch(url, init);
  };
  try {
    const P = `${API}/${id}/price`; const body = { amountCents: 2000, stripePriceId: 'price_VERIFIED1', reason: 'go' };
    stripe = null; assert.equal((await call(e, 'POST', P, body, staff)).json.error, 'stripe_price_not_found');
    stripe = { id: 'price_VERIFIED1', active: true, type: 'recurring', currency: 'usd', unit_amount: 2500, livemode: false, recurring: { interval: 'month', interval_count: 1 } };
    assert.equal((await call(e, 'POST', P, body, staff)).json.error, 'stripe_price_amount_mismatch');
    stripe.unit_amount = 2000; stripe.recurring.interval = 'year';
    assert.equal((await call(e, 'POST', P, body, staff)).json.error, 'stripe_price_interval_mismatch');
    stripe.recurring.interval = 'month'; stripe.currency = 'eur';
    assert.equal((await call(e, 'POST', P, body, staff)).json.error, 'stripe_price_currency_mismatch');
    stripe.currency = 'usd'; stripe.livemode = true;
    assert.equal((await call(e, 'POST', P, body, staff)).json.error, 'price_mode_mismatch');
    assert.equal((await all(e, 'SELECT id FROM plan_prices WHERE plan_id = ?', id)).length, 0, 'every refusal saved nothing');
    stripe.livemode = false;
    const ok = await call(e, 'POST', P, body, staff);
    assert.equal(ok.status, 200); assert.equal(ok.json.verified, true);
    assert.equal((await one(e, 'SELECT stripe_mode FROM plan_prices WHERE plan_id = ?', id)).stripe_mode, 'test');
  } finally { globalThis.fetch = realFetch; }
});

test('promotions: validated, scheduled, and shown on the public pricing page only while live', async () => {
  const e = env(); const staff = await staffLogin(e);
  await seedPrice(e, STARTER, 'price_promo');
  const coupon = await call(e, 'POST', '/api/platform/saas/coupons', { code: 'LAUNCH20', providerCouponId: 'cpn_1', percentOff: 20, duration: 'once' }, staff);
  assert.equal(coupon.status, 200, coupon.text);
  const cid = (await one(e, `SELECT id FROM coupons WHERE code='LAUNCH20'`)).id;
  const P = `${API}/${STARTER}/promotions`;
  assert.equal((await call(e, 'POST', P, { name: 'x', badgeText: 'y' }, staff)).json.error, 'invalid_name');
  assert.equal((await call(e, 'POST', P, { name: 'Launch', badgeText: '20% off', startsAt: '2030-01-02', endsAt: '2030-01-01' }, staff)).json.error, 'ends_before_start');
  assert.equal((await call(e, 'POST', P, { name: 'Launch', badgeText: '20% off', couponId: 'ghost' }, staff)).json.error, 'coupon_not_found');
  const made = await call(e, 'POST', P, { name: 'Launch', badgeText: '20% off year one', couponId: cid }, staff);
  assert.equal(made.status, 200);
  let pricing = (await call(e, 'GET', '/pricing')).text;
  assert.match(pricing, /20% off year one/); assert.match(pricing, /Use code LAUNCH20 at checkout/);
  await call(e, 'POST', `${API}/promotions/${made.json.promotionId}`, { status: 'paused' }, staff);
  assert.doesNotMatch((await call(e, 'GET', '/pricing')).text, /20% off year one/);
  await call(e, 'POST', `${API}/promotions/${made.json.promotionId}`, { status: 'active' }, staff);
  await call(e, 'POST', '/api/platform/saas/coupons/' + cid, { status: 'disabled' }, staff);
  assert.doesNotMatch((await call(e, 'GET', '/pricing')).text, /20% off year one/, 'a disabled coupon hides its banner');
  await call(e, 'POST', '/api/platform/saas/coupons/' + cid, { status: 'active' }, staff);
  await call(e, 'POST', `${API}/promotions/${made.json.promotionId}`, { endsAt: '2020-01-01' }, staff);
  assert.doesNotMatch((await call(e, 'GET', '/pricing')).text, /20% off year one/, 'an ended promotion disappears');
  assert.equal((await call(e, 'POST', `${API}/promotions/${made.json.promotionId}/delete`, {}, staff)).status, 200);
});

test('public pricing reflects staff presentation: labels, tagline, custom lines, recommended plan, order, button text, JSON-LD', async () => {
  const e = env(); const staff = await staffLogin(e);
  for (const id of [STARTER, GROWTH]) await seedPrice(e, id, 'price_' + id);
  const before = (await call(e, 'GET', '/pricing')).text;
  assert.match(before, /Starter/); assert.doesNotMatch(before, /plan-tagline/);
  await call(e, 'POST', `${API}/${GROWTH}`, { tagline: 'For serious teams', isFeatured: true, ctaLabel: 'Start growing', seoDescription: 'Growth plan for casino news teams.' }, staff);
  await call(e, 'POST', `${API}/${GROWTH}/labels`, { labelIds: ['label_best_value'] }, staff);
  await call(e, 'POST', `${API}/${GROWTH}/features`, { features: [{ label: 'Dedicated <b>manager</b>', highlight: true }, { label: 'Not here', included: false }] }, staff);
  const after = (await call(e, 'GET', '/pricing')).text;
  for (const re of [/For serious teams/, /Best value/, /Start growing/, /Dedicated &lt;b&gt;manager&lt;\/b&gt;/, /is-featured/, /Growth plan for casino news teams\./, /"@type":"Offer"/]) assert.match(after, re);
  assert.doesNotMatch(after, /<b>manager<\/b>/, 'staff text is escaped, never HTML');
  await call(e, 'POST', `${API}/${GROWTH}`, { sortOrder: -1 }, staff);
  const names = [...(await call(e, 'GET', '/pricing')).text.matchAll(/<h3>([^<]*)</g)].map((m) => m[1]).join('|');
  assert.match(names, /Growth\|Starter\|Pro/, 'a lower sort_order lists first inside its product');
});

test('retired or unpublished plans leave the public pricing page and the customer plan list immediately', async () => {
  const e = env(); const staff = await staffLogin(e);
  await seedPrice(e, STARTER, 'price_vis');
  assert.match((await call(e, 'GET', '/pricing')).text, /Starter/);
  await call(e, 'POST', `${API}/${STARTER}/unpublish`, {}, staff);
  assert.doesNotMatch((await call(e, 'GET', '/pricing')).text, /price_vis|href="\/app\/signup\?plan=plan_casino_news_starter/);
  await call(e, 'POST', `${API}/${STARTER}/publish`, {}, staff);
  assert.match((await call(e, 'GET', '/pricing')).text, /plan=plan_casino_news_starter/);
});

test('products: create validates, retired products block publishing their plans', async () => {
  const e = env(); const staff = await staffLogin(e);
  const R = '/api/platform/saas/products';
  assert.equal((await call(e, 'POST', R, { name: 'New Thing', category: 'bogus' }, staff)).json.error, 'invalid_category');
  const p = await call(e, 'POST', R, { name: 'Podcast Network', category: 'news' }, staff); assert.equal(p.status, 200);
  assert.equal((await call(e, 'POST', R, { name: 'Podcast Network', category: 'news' }, staff)).json.error, 'key_already_exists');
  const id = await newPlan(e, staff, { name: 'Pod Plan', productId: p.json.productId });
  await call(e, 'POST', `${R}/${p.json.productId}`, { status: 'retired' }, staff);
  assert.equal((await call(e, 'POST', `${API}/${id}/publish`, {}, staff)).json.error, 'product_not_active');
  assert.equal((await call(e, 'POST', API, { name: 'Another', productId: p.json.productId }, staff)).json.error, 'product_not_active');
});

test('list API: search, filters, sort, paging, labels attached; CSV export is formula-safe and audited', async () => {
  const e = env(); const staff = await staffLogin(e);
  await newPlan(e, staff, { name: '=HYPERLINK("x")', key: 'evil_plan' });
  const s = await call(e, 'GET', `${API}?q=evil`, null, staff);
  assert.equal(s.json.total, 1);
  const p1 = await call(e, 'GET', `${API}?pageSize=25&sort=name&dir=desc`, null, staff);
  assert.ok(p1.json.data.length <= 25 && p1.json.total >= 10);
  assert.ok(p1.json.data.every((x) => Array.isArray(x.labels)));
  assert.equal((await call(e, 'GET', `${API}?status=draft`, null, staff)).json.data.every((x) => x.status === 'draft'), true);
  assert.equal((await call(e, 'GET', `${API}?sort=1;DROP TABLE plans`, null, staff)).status, 200);
  const csv = await call(e, 'GET', `${API}/export.csv`, null, staff);
  assert.equal(csv.status, 200); assert.match(csv.text, /^id,key,name,/); assert.match(csv.text, /'=HYPERLINK/);
  assert.ok(await one(e, `SELECT id FROM lummet_audit_logs WHERE action='export_csv' AND resource='plan'`));
  const opts = await call(e, 'GET', `${API}/options`, null, staff);
  assert.ok(opts.json.data.entitlementCatalog.length > 10 && opts.json.data.products.length && opts.json.data.labels.length);
  assert.equal((await call(e, 'GET', `${API}/nope`, null, staff)).status, 404);
});

test('service-level: warnings describe what staff should fix; failures never throw', async () => {
  const e = env();
  const d = await catalog.planDetail(e, STARTER);
  assert.ok(d.warnings.includes('no_active_stripe_price'));
  assert.deepEqual((await catalog.bulkAction(e, 'publish', ['a'.repeat(300)])).results.map((r) => r.ok), [false]);
});
