// Public pricing page: instant Monthly/Yearly switch (both periods in one cached page + public/static/js/pricing.js),
// trial-aware plan buttons, and the guarded copy migration 0090.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createTestDb, applyMigrations, splitSqlStatements } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import { setPlanPrice } from './support/plan-prices.js';
import * as staff from '../worker/staff-saas.js';
import worker from '../worker/index.js';

const ctx = { waitUntil() {} };
function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; }
async function page(e, path) {
  const res = await worker.fetch(new Request('https://cp.test' + path, { headers: { 'CF-Connecting-IP': '198.51.100.7' } }), e, ctx);
  return { status: res.status, text: await res.text() };
}
async function withAnnual(e) {
  await setPlanPrice(e, 'plan_casino_news_starter_annual', 'price_a1PPPPPP');
  await staff.updatePlan(e, 'plan_casino_news_starter_annual', { status: 'active' });
  await setPlanPrice(e, 'plan_casino_news_pro_annual', 'price_a2PPPPPP');
  await staff.updatePlan(e, 'plan_casino_news_pro_annual', { status: 'active' });
}
const ids = (html) => [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

test('both billing periods are in the one page, the requested one visible, and ids stay unique', async () => {
  const e = env(); await withAnnual(e);
  for (const [path, shown, hidden] of [['/pricing', 'monthly', 'annual'], ['/pricing?billing=annual', 'annual', 'monthly']]) {
    const { text } = await page(e, path);
    assert.match(text, new RegExp(`data-period-panel="${shown}">`)); assert.match(text, new RegExp(`data-period-panel="${hidden}" hidden>`));
    const all = ids(text); assert.deepEqual(all.filter((x, i) => all.indexOf(x) !== i), [], 'no duplicate element ids');
  }
  const { text } = await page(e, '/pricing');
  assert.match(text, /id="pricing-comparison-title"/, 'the monthly ids are the ones the page always had');
  assert.match(text, /data-period="monthly"[^>]*href="\/pricing"/); assert.match(text, /data-period="annual"[^>]*href="\/pricing\?billing=annual"/, 'the chips are still real links without scripts');
  assert.equal((text.match(/id="pricing-family"/g) || []).length <= 1, true);
  assert.match(text, /per year/); assert.match(text, /per month/);
});

test('no annual plan published: a single panel, no toggle', async () => {
  const { text } = await page(env(), '/pricing');
  assert.equal((text.match(/data-period-panel=/g) || []).length, 1);
  assert.doesNotMatch(text, /data-period="annual"/); assert.doesNotMatch(text, /billing=annual/);
});

test('plan buttons: a plan with a trial says "Start free trial", one without keeps the generic label, a label set on the plan wins', async () => {
  const e = env();
  await e.LUMMET_DB.prepare(`UPDATE plans SET trial_days = 0 WHERE id = 'plan_casino_news_pro'`).run();
  await e.LUMMET_DB.prepare(`UPDATE plans SET cta_label = 'Try it' WHERE id = 'plan_casino_news_growth'`).run();
  const { text } = await page(e, '/pricing');
  const btn = (id) => (text.match(new RegExp(`href="/app/signup\\?plan=${id}&amp;period=monthly">([^<]*)<`)) || [])[1];
  assert.equal(btn('plan_casino_news_starter'), 'Start free trial');
  assert.equal(btn('plan_casino_news_pro'), 'Get started');
  assert.equal(btn('plan_casino_news_growth'), 'Try it');
  // without the new UI string (migration not applied) the generic label is used: nothing breaks
  await e.LUMMET_DB.prepare(`DELETE FROM lummet_ui_strings WHERE ui_key = 'pricing_cta_trial'`).run();
  const fallback = await page(e, '/pricing?x=1');
  assert.match(fallback.text, /period=monthly">Get started</);
});

test('migration 0090: shipped defaults change, edited rows and re-runs are left alone', async () => {
  const e = env(); const db = e.LUMMET_DB;
  const one = (sql, ...b) => db.prepare(sql).bind(...b).first();
  assert.equal((await one(`SELECT value FROM lummet_site_settings WHERE key = 'hero_cta_primary_label'`)).value, 'Start for free');
  const nav = await one(`SELECT label, href FROM lummet_nav_links WHERE placement = 'header_cta' AND label = 'Start for free'`);
  assert.deepEqual({ ...nav }, { label: 'Start for free', href: '/pricing' });
  assert.equal((await one(`SELECT value FROM lummet_ui_strings WHERE ui_key = 'pricing_cta_trial'`)).value, 'Start free trial');

  const statements = splitSqlStatements(fs.readFileSync(new URL('../migrations/0090_cta_copy.sql', import.meta.url), 'utf8'));
  const rerun = async () => { for (const s of statements) await db.prepare(s).run(); };
  // an admin edited the hero label and renamed the header button: a re-run keeps both
  await db.prepare(`UPDATE lummet_site_settings SET value = 'Join now' WHERE key = 'hero_cta_primary_label'`).run();
  await db.prepare(`UPDATE lummet_nav_links SET label = 'Get going', href = '/app/signup' WHERE placement = 'header_cta' AND label = 'Start for free'`).run();
  await db.prepare(`UPDATE lummet_ui_strings SET value = 'Begin' WHERE ui_key = 'pricing_cta_trial'`).run();
  await rerun();
  assert.equal((await one(`SELECT value FROM lummet_site_settings WHERE key = 'hero_cta_primary_label'`)).value, 'Join now');
  assert.deepEqual({ ...(await one(`SELECT label, href FROM lummet_nav_links WHERE label = 'Get going'`)) }, { label: 'Get going', href: '/app/signup' });
  assert.equal((await one(`SELECT value FROM lummet_ui_strings WHERE ui_key = 'pricing_cta_trial'`)).value, 'Begin');
  // the older migration re-creating the shipped default next to the renamed row must not collide
  await db.prepare(`INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES ('header_cta', 'Start for free', '/pricing', 'always', 'published', 31), ('header_cta', 'Start free trial', '/app/signup', 'always', 'published', 30)`).run();
  await rerun();
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM lummet_nav_links WHERE placement = 'header_cta' AND label = 'Start free trial'`).first()).n, 0);
});

// ---- the browser script, run against a tiny fake DOM
function fakeDom({ search = '' } = {}) {
  const mk = (attrs) => {
    const a = { ...attrs }; const cls = new Set((a.class || '').split(' ').filter(Boolean)); const handlers = {};
    return { hidden: 'hidden' in a, attrs: a, handlers,
      classList: { toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, has: (c) => cls.has(c) },
      getAttribute: (k) => (k in a ? a[k] : null), setAttribute: (k, v) => { a[k] = String(v); }, removeAttribute: (k) => { delete a[k]; },
      addEventListener: (t, f) => { handlers[t] = f; } };
  };
  const chips = [mk({ 'data-period': 'monthly', class: 'chip is-active', 'aria-current': 'true' }), mk({ 'data-period': 'annual', class: 'chip' })];
  const panels = [mk({ 'data-period-panel': 'monthly' }), Object.assign(mk({ 'data-period-panel': 'annual', hidden: '' }), { hidden: true })];
  const calls = { replaceState: [] };
  const sandbox = {
    document: { querySelectorAll: (q) => (q === '[data-period]' ? chips : q === '[data-period-panel]' ? panels : []), getElementById: () => null },
    window: { location: { href: 'https://cp.test/pricing' + search } },
    history: { replaceState: (...a) => calls.replaceState.push(a) }, URL, console
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/static/js/pricing.js', import.meta.url), 'utf8'), sandbox);
  const click = (chip, extra = {}) => { const ev = { defaultPrevented: false, button: 0, preventDefault() { this.defaultPrevented = true; }, ...extra }; chip.handlers.click(ev); return ev; };
  return { chips, panels, calls, click };
}

test('pricing.js: a click switches panels at once, keeps the URL shareable, and never blocks modified clicks', () => {
  const d = fakeDom();
  const ev = d.click(d.chips[1]);
  assert.equal(ev.defaultPrevented, true, 'no navigation');
  assert.deepEqual(d.panels.map((p) => p.hidden), [true, false]);
  assert.equal(d.chips[1].classList.has('is-active'), true); assert.equal(d.chips[1].getAttribute('aria-current'), 'true');
  assert.equal(d.chips[0].classList.has('is-active'), false); assert.equal(d.chips[0].getAttribute('aria-current'), null);
  assert.equal(d.calls.replaceState.at(-1)[2], '/pricing?billing=annual');
  d.click(d.chips[0]);
  assert.deepEqual(d.panels.map((p) => p.hidden), [false, true]);
  assert.equal(d.calls.replaceState.at(-1)[2], '/pricing');
  // switching back and forth many times never gets stuck
  for (let i = 0; i < 10; i++) { d.click(d.chips[i % 2 ? 0 : 1]); }
  assert.deepEqual(d.panels.map((p) => p.hidden), [false, true], 'ten more clicks later (the last one on Monthly) it is still in step');
  // ctrl/cmd/middle clicks are left to the browser (open in a new tab)
  const before = d.panels.map((p) => p.hidden);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) assert.equal(d.click(d.chips[1], extra).defaultPrevented, false);
  assert.deepEqual(d.panels.map((p) => p.hidden), before);
});

test('pricing.js: other query parameters survive the switch', () => {
  const d = fakeDom({ search: '?family=casino-news' });
  d.click(d.chips[1]);
  assert.equal(d.calls.replaceState.at(-1)[2], '/pricing?family=casino-news&billing=annual');
  d.click(d.chips[0]);
  assert.equal(d.calls.replaceState.at(-1)[2], '/pricing?family=casino-news');
});
