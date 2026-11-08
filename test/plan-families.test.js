// Generic, editable plan families (migration 0089): public name, slug with history, visibility switches, clone as generic family,
// and what the pricing page and the site type picker show. Nothing here may change a price, a limit or a subscription.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import { slugify, validateProductFields, RESERVED_SLUGS } from '../worker/plan-families.js';
import * as catalog from '../worker/plan-catalog.js';
import * as plans from '../worker/plans.js';
import * as pricing from '../worker/repositories/pricing.js';
import worker from '../worker/index.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }
const one = (e, sql, ...b) => e.LUMMET_DB.prepare(sql).bind(...b).first();
const all = async (e, sql, ...b) => (await e.LUMMET_DB.prepare(sql).bind(...b).all()).results;
const NEWS = 'prod_casino_news';
async function page(e, path) { const r = await worker.fetch(new Request('https://cp.test' + path, { headers: { 'CF-Connecting-IP': '198.51.100.7' } }), e, ctx); return { status: r.status, text: await r.text() }; }

test('slugify and field validation', () => {
  assert.equal(slugify('Affiliate Platform & Tools'), 'affiliate-platform-and-tools');
  assert.equal(slugify('  Café  '), 'cafe');
  assert.equal(validateProductFields({ name: 'A' }).error, 'invalid_name');
  assert.equal(validateProductFields({ name: 'Platform', slug: 'pricing' }).error, 'reserved_slug');
  assert.equal(validateProductFields({ name: 'Platform', slug: '---' }).error, 'invalid_slug');
  assert.equal(validateProductFields({ sortOrder: 5000 }, { partial: true }).error, 'invalid_sort_order');
  const ok = validateProductFields({ name: 'Platform', slug: 'My Platform', showInSiteCreation: false }).value;
  assert.equal(ok.slug, 'my-platform'); assert.equal(ok.show_in_site_creation, 0);
  assert.ok(RESERVED_SLUGS.has('admin'));
});

test('migration 0089 is additive: every product keeps both switches on, a slug and no public name', async () => {
  const e = env();
  const rows = await all(e, 'SELECT key, slug, public_name, show_on_pricing, show_in_site_creation, sort_order FROM products');
  assert.ok(rows.length > 5);
  for (const r of rows) { assert.equal(r.show_on_pricing, 1); assert.equal(r.show_in_site_creation, 1); assert.equal(r.public_name, null); assert.equal(r.sort_order, 0); assert.equal(r.slug, r.key.replace(/_/g, '-')); }
  assert.equal(new Set(rows.map((r) => r.slug)).size, rows.length, 'slugs are unique');
});

test('editing a product: public name, slug history, uniqueness, reserved words; the key never changes', async () => {
  const e = env();
  const before = await one(e, 'SELECT key FROM products WHERE id = ?', NEWS);
  assert.equal((await catalog.updateProduct(e, NEWS, { publicName: 'News Suite', slug: 'news-suite', description: 'Everything for news sites' })).ok, true);
  const p = await one(e, 'SELECT * FROM products WHERE id = ?', NEWS);
  assert.equal(p.public_name, 'News Suite'); assert.equal(p.slug, 'news-suite'); assert.equal(p.key, before.key); assert.ok(p.updated_at);
  assert.equal((await one(e, 'SELECT product_id FROM product_slug_history WHERE slug = ?', 'casino-news')).product_id, NEWS);
  assert.equal((await catalog.updateProduct(e, 'prod_sports_news', { slug: 'casino-news' })).error, 'slug_taken', 'an old slug is never reused for another product');
  assert.equal((await catalog.updateProduct(e, 'prod_sports_news', { slug: 'news-suite' })).error, 'slug_taken');
  assert.equal((await catalog.updateProduct(e, NEWS, { slug: 'admin' })).error, 'reserved_slug');
  assert.equal((await catalog.updateProduct(e, NEWS, { slug: 'casino-news' })).ok, true, 'the owner can take its own old slug back');
  assert.equal((await catalog.updateProduct(e, 'nope', { name: 'xx' })).status, 404);
  assert.equal((await pricing.resolveFamilySlug(e, 'news-suite')), NEWS, 'history resolves');
});

test('clone as generic family: drafts with limits and features, no prices, not a site type', async () => {
  const e = env();
  const r = await catalog.cloneFamily(e, 'prod_casino_affiliate', { name: 'Affiliate Platform' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const prod = await one(e, 'SELECT * FROM products WHERE id = ?', r.productId);
  assert.equal(prod.slug, 'affiliate-platform'); assert.equal(prod.show_on_pricing, 1); assert.equal(prod.show_in_site_creation, 0); assert.equal(prod.public_name, 'Affiliate Platform');
  const copies = await all(e, 'SELECT * FROM plans WHERE product_id = ? ORDER BY price_cents', r.productId);
  assert.deepEqual(copies.map((p) => p.name), ['Starter', 'Growth', 'Pro']);
  assert.ok(copies.every((p) => p.status === 'draft' && p.billing_period === 'monthly'));
  const src = await one(e, `SELECT id FROM plans WHERE key = 'casino_affiliate_pro'`);
  const a = await all(e, 'SELECT key, value FROM plan_entitlements WHERE plan_id = ? ORDER BY key', src.id);
  const b = await all(e, 'SELECT key, value FROM plan_entitlements WHERE plan_id = ? ORDER BY key', copies[2].id);
  assert.deepEqual(b, a, 'limits are copied');
  assert.equal((await one(e, 'SELECT COUNT(*) n FROM plan_prices WHERE plan_id IN (SELECT id FROM plans WHERE product_id = ?)', r.productId)).n, 0, 'no price or Stripe object is copied');
  assert.equal((await catalog.cloneFamily(e, 'prod_casino_affiliate', { name: 'Affiliate Platform' })).error, 'key_already_exists');
  assert.equal((await catalog.cloneFamily(e, 'prod_casino_affiliate', { name: 'Other', slug: 'affiliate-platform' })).error, 'slug_taken');
  assert.equal((await catalog.cloneFamily(e, 'prod_founder_license', { name: 'Licences' })).error, 'source_has_no_plans');
  // the original is untouched
  assert.equal((await one(e, `SELECT status FROM plans WHERE key = 'casino_affiliate_pro'`)).status, 'active');
});

test('site types and plan families are separate lists; the default keeps everything', async () => {
  const e = env();
  const base = (await plans.listProducts(e)).length;
  assert.equal((await plans.listProducts(e, { scope: 'site_types' })).length, base);
  const r = await catalog.cloneFamily(e, 'prod_casino_affiliate', { name: 'Affiliate Platform' });
  const site = (await plans.listProducts(e, { scope: 'site_types' })).map((p) => p.id);
  const fam = (await plans.listProducts(e, { scope: 'plan_families' })).map((p) => p.id);
  assert.ok(!site.includes(r.productId) && fam.includes(r.productId));
  await catalog.updateProduct(e, NEWS, { showInSiteCreation: false, publicName: 'News' });
  assert.ok(!(await plans.listProducts(e, { scope: 'site_types' })).some((p) => p.id === NEWS));
  assert.equal((await plans.listProducts(e, { scope: 'plan_families' })).find((p) => p.id === NEWS).name, 'News', 'public name is what customers see');
});

test('pricing page: hidden families disappear, a single family has no filter, old slugs resolve', async () => {
  const e = env();
  // price two plans so they list
  await e.LUMMET_DB.prepare(`UPDATE plans SET price_cents = 900 WHERE status = 'active' AND product_id IN ('prod_casino_news','prod_sports_news')`).run();
  let html = (await page(e, '/pricing')).text;
  assert.match(html, /id="pricing-family"/);
  await catalog.updateProduct(e, 'prod_sports_news', { showOnPricing: false });
  html = (await page(e, '/pricing')).text;
  assert.doesNotMatch(html, /Sports News/);
  for (const p of (await all(e, `SELECT id FROM products WHERE id <> ?`, NEWS))) if (p.id !== 'prod_sports_news') await catalog.updateProduct(e, p.id, { showOnPricing: false });
  html = (await page(e, '/pricing')).text;
  assert.doesNotMatch(html, /id="pricing-family"/, 'one family: no filter');
  assert.match(html, /Casino News/);
  await catalog.updateProduct(e, NEWS, { publicName: 'Platform' });
  assert.match((await page(e, '/pricing')).text, />Platform</);
});

test('pricing and site types fall back to the original queries when the migration is missing', async () => {
  const e = env();
  const real = e.LUMMET_DB.prepare.bind(e.LUMMET_DB);
  e.LUMMET_DB.prepare = (sql) => { if (/show_on_pricing|show_in_site_creation|public_name/.test(sql)) throw new Error('no such column'); return real(sql); };
  const rows = await pricing.listPricing(e);
  assert.ok(rows.length > 0 && rows.every((r) => r.product_name));
  assert.ok((await plans.listProducts(e, { scope: 'site_types' })).length > 5);
});

async function staff(e) {
  const call = async (method, path, body, cookie) => {
    const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
    if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
    const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  await call('POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  const login = await call('POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  return { call, cookie: login.cookie };
}

test('staff API: edit and clone are staff-only, audited, and the page offers the manager', async () => {
  const e = env(); const base = '/api/platform/saas';
  const { call, cookie } = await staff(e);
  assert.equal((await call('POST', base + '/products/prod_casino_news', { publicName: 'X' })).status, 401);
  assert.equal((await call('POST', base + '/products/prod_casino_news/clone', { name: 'Platform' })).status, 401);
  const up = await call('POST', base + '/products/prod_casino_news', { publicName: 'News Suite', slug: 'news-suite' }, cookie);
  assert.equal(up.status, 200, up.text);
  const bad = await call('POST', base + '/products/prod_casino_news', { slug: 'pricing' }, cookie);
  assert.ok(bad.status >= 400 && bad.json.error === 'reserved_slug');
  const cl = await call('POST', base + '/products/prod_casino_affiliate/clone', { name: 'Platform' }, cookie);
  assert.equal(cl.status, 200, cl.text); assert.equal(cl.json.planIds.length, 3);
  const opts = await call('GET', base + '/plan-catalog/options', null, cookie);
  assert.ok(opts.json.data.products.some((p) => p.slug === 'platform' && p.show_in_site_creation === 0));
  const pg = await call('GET', '/platform/saas/plans', null, cookie);
  assert.match(pg.text, /Plan families &amp; site types/);
  assert.ok((await all(e, `SELECT 1 FROM lummet_audit_logs WHERE resource = 'product' AND action IN ('clone','update') AND success = 1`)).length >= 2);
});
