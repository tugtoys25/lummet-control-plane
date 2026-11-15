// All sites: conversions and earnings across an organization's sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as sites from '../worker/sites.js';
import * as plans from '../worker/plans.js';
import * as insights from '../worker/views/customer-pages/insights.js';
import { summarizeCrossSite, loadCrossSite, MAX_SITES, defaultRange } from '../worker/cross-site.js';
import { renderCustomerShell } from '../worker/views/customer-layout.js';

const S = (id, name) => ({ id, name, primary_domain: `${id}.example.com` });
const row = (id, name, currency, clicks, conversions, revenue, commission) => ({ dimensionId: id, name, currency, clicks, conversions, revenue, commission });

test('summary adds sites and programs up, keeps every currency apart, and merges the same program by name', () => {
  const out = summarizeCrossSite([
    { site: S('a', 'Site A'), ok: true, rows: [row(1, 'Pin-Up', 'EUR', 100, 5, 500, 200), row(2, 'Parimatch', 'USD', 50, 1, 80, 30)] },
    { site: S('b', 'Site B'), ok: true, rows: [row(7, ' pin-up ', 'EUR', 40, 2, 150, 60.555), row(7, 'pin-up', 'USD', 0, 0, 10, 4)] },
    { site: S('c', 'Site C'), ok: false, status: 'error', message: 'Could not be reached.' },
    { site: S('d', 'Site D'), ok: false, status: 'not_deployed', message: 'This site is not live yet.' }
  ]);
  assert.equal(out.totals.clicks, 190); assert.equal(out.totals.conversions, 8);
  assert.deepEqual(out.totals.by_currency.EUR, { revenue: 650, commission: 260.56 });
  assert.deepEqual(out.totals.by_currency.USD, { revenue: 90, commission: 34 });
  const pin = out.programs.find((p) => p.name.toLowerCase().trim() === 'pin-up');
  assert.deepEqual(pin.sites, ['Site A', 'Site B']); assert.equal(pin.conversions, 7); assert.equal(pin.clicks, 140);
  assert.equal(out.programs.length, 2);
  assert.equal(out.programs[0].name.toLowerCase().trim(), 'pin-up', 'sorted by conversions');
  assert.equal(out.sites.find((s) => s.id === 'c').status, 'error'); assert.equal(out.sites.find((s) => s.id === 'd').status, 'not_deployed');
  assert.equal(out.sites.find((s) => s.id === 'a').conversion_rate, 4);
});

test('rows without a name or currency are still counted', () => {
  const out = summarizeCrossSite([{ site: S('a', 'A'), ok: true, rows: [{ dimensionId: 9, name: null, currency: null, clicks: 10, conversions: 1, revenue: 5, commission: 1 }] }]);
  assert.equal(out.programs[0].name, 'Program 9'); assert.ok(out.totals.by_currency['(none)']);
});

test('one site failing does not hide the others, and only the first sites are queried', async () => {
  const calls = [];
  const portal = { async getAnalyticsOverview(env, site) {
    calls.push(site.id);
    if (site.id === 's2') return { ok: false, status: 502, reason: 'tenant_unreachable', message: 'Site did not answer.' };
    if (site.id === 's3') throw new Error('boom');
    return { ok: true, data: { rows: [row(1, 'Alpha', 'EUR', 10, 1, 20, 5)] } };
  } };
  const many = [{ id: 's1', name: 'One', tenant_id: 't1' }, { id: 's2', name: 'Two', tenant_id: 't2' }, { id: 's3', name: 'Three', tenant_id: 't3' }, { id: 's4', name: 'Four', tenant_id: null }, { id: 's5', name: 'Gone', tenant_id: 't5', status: 'deleted' }];
  const out = await loadCrossSite({}, portal, many, { startDate: '2026-10-01', endDate: '2026-10-31' });
  assert.equal(out.sites.length, 4); assert.equal(calls.includes('s5'), false); assert.equal(calls.includes('s4'), false);
  assert.equal(out.sites.find((s) => s.id === 's2').message, 'Site did not answer.');
  assert.equal(out.sites.find((s) => s.id === 's3').status, 'error');
  assert.equal(out.totals.clicks, 10);
  const lots = Array.from({ length: MAX_SITES + 5 }, (_, i) => ({ id: 'x' + i, name: 'X' + i, tenant_id: 't' + i }));
  const big = await loadCrossSite({}, { getAnalyticsOverview: async () => ({ ok: true, data: { rows: [] } }) }, lots, { startDate: 'a', endDate: 'b' });
  assert.equal(big.sites.length, MAX_SITES); assert.equal(big.skipped, 5);
  assert.match(defaultRange(new Date('2026-11-15T00:00:00Z')).startDate, /^2026-10-17$/);
});

// ---- route, page and navigation ----
function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, res };
}
async function org(e, email, name = 'Acme') {
  const s = await (async () => { const h = new Headers({ 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' }); const r = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: h, body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', organizationName: name }) }), e, ctx); return { json: await r.json(), cookie: (r.headers.get('Set-Cookie') || '').split(';')[0] }; })();
  await plans.startTrialSubscription(e, s.json.organizationId, 'plan_casino_news_starter');
  return { id: s.json.organizationId, userId: s.json.userId, cookie: s.cookie };
}
async function site(e, o, { name, tenant }) {
  const s = await sites.createSite(e, { organizationId: o.id, name, productId: 'prod_casino_news', actorUserId: o.userId });
  if (tenant) {
    const t = `t-${s.siteId}`;
    await e.LUMMET_DB.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, 'T', ?, ?)`).bind(t, t + '.example.test', 'https://' + t + '.example.test').run();
    await e.LUMMET_DB.prepare(`UPDATE sites SET tenant_id = ?, primary_domain = ?, status = 'active' WHERE id = ?`).bind(t, name.toLowerCase().replace(/\W/g, '') + '.example.com', s.siteId).run();
  }
  return s.siteId;
}

test('the API needs a signed-in member and answers for the right organization only', async () => {
  const e = env(); const a = await org(e, 'a@example.com', 'A'); const b = await org(e, 'b@example.com', 'B');
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/analytics/cross-site`)).status, 401);
  assert.ok([403, 404].includes((await call(e, 'GET', `/api/organizations/${a.id}/analytics/cross-site`, null, b.cookie)).status), 'not another organization');
});

test('the API lists every site, flags the one that is not live, never fails the whole page, and rejects a backwards range', async () => {
  const e = env(); const o = await org(e, 'o@example.com');
  await site(e, o, { name: 'Pending Site', tenant: false }); await site(e, o, { name: 'Live Site', tenant: true });
  const realFetch = globalThis.fetch; globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const r = await call(e, 'GET', `/api/organizations/${o.id}/analytics/cross-site?start_date=2026-10-01&end_date=2026-10-31`, null, o.cookie);
    assert.equal(r.status, 200); assert.equal(r.json.success, true);
    assert.equal(r.json.start_date, '2026-10-01');
    const byName = Object.fromEntries(r.json.sites.map((s) => [s.name, s]));
    assert.equal(byName['Pending Site'].status, 'not_deployed'); assert.equal(byName['Live Site'].status, 'error');
    const bad = await call(e, 'GET', `/api/organizations/${o.id}/analytics/cross-site?start_date=2026-11-01&end_date=2026-10-01`, null, o.cookie);
    assert.equal(bad.status, 422);
    const dflt = await call(e, 'GET', `/api/organizations/${o.id}/analytics/cross-site?start_date=garbage`, null, o.cookie);
    assert.match(dflt.json.start_date, /^\d{4}-\d{2}-\d{2}$/);
  } finally { globalThis.fetch = realFetch; }
});

test('the page is in the Insights menu, hidden when the plan has no analytics, and renders for a customer', async () => {
  const links = (html) => [...html.matchAll(/<a href="(\/app\/[a-z-]+)"/g)].map((m) => m[1]);
  const base = { title: 'All sites', activeKey: 'overview', bodyHtml: '<p>x</p>', customer: { email: 'x@example.com' }, organizations: [], activeOrganizationId: null };
  assert.ok(links(renderCustomerShell(base)).includes('/app/all-sites'));
  assert.ok(!links(renderCustomerShell({ ...base, hiddenNavKeys: ['all-sites'] })).includes('/app/all-sites'));
  const e = env(); const o = await org(e, 'p@example.com');
  await site(e, o, { name: 'Live Site', tenant: true });
  const page = await call(e, 'GET', '/app/all-sites', null, o.cookie);
  assert.equal(page.status, 200); assert.match(page.text, /<h1>All sites<\/h1>/); assert.match(page.text, /Load<\/button>/);
  assert.equal((await call(e, 'GET', '/app/all-sites')).res.headers.get('Location'), '/app/login');
  for (const m of page.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!/src=/.test(m[1])) new vm.Script(m[2]);
});

test('with no live site the page explains instead of showing an empty table', () => {
  assert.match(insights.renderInsightCrossSite({ sites: [{ id: 's', name: 'S', tenant_id: null }], entitled: true }), /None of your sites is live yet/);
  assert.match(insights.renderInsightCrossSite({ sites: [], entitled: false }), /not included in your plan/);
});

// ---- the page script against a stub browser ----
function pageScript(html) { return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'); }
function browser(html, responses, ids = {}) {
  const calls = []; const boxes = {};
  const box = (id) => (boxes[id] ||= { innerHTML: '', value: ids[id] ?? '' });
  const sandbox = {
    document: { getElementById: (id) => (id === 'org-switcher' ? { value: 'org-1' } : box(id)), createElement: () => ({}) },
    fetch: async (url, opts = {}) => { calls.push({ url }); const hit = responses.find((r) => url.includes(r.match)); return { status: hit?.status || 200, json: async () => (hit ? hit.body : {}) }; },
    encodeURIComponent, JSON, Promise, Number, String, Array, Object, alert() {}, location: { reload() {} }, console
  };
  vm.createContext(sandbox); vm.runInContext(pageScript(html), sandbox);
  return { sandbox, calls, box, settle: () => new Promise((r) => setTimeout(r, 15)) };
}

test('page script: shows totals, sites and programs, keeps currencies apart, and escapes names', async () => {
  const html = insights.renderInsightCrossSite({ sites: [{ id: 's1', name: 'S', tenant_id: 't1' }], entitled: true });
  const b = browser(html, [{ match: '/analytics/cross-site', body: { success: true,
    totals: { clicks: 190, conversions: 8, conversion_rate: 4.21, by_currency: { EUR: { revenue: 650, commission: 260 }, USD: { revenue: 90, commission: 34 } } },
    sites: [{ id: 'a', name: '<img src=x onerror=alert(1)>', domain: 'a.example.com', status: 'ok', clicks: 190, conversions: 8, conversion_rate: 4.21, by_currency: { EUR: { revenue: 650, commission: 260 } } }, { id: 'b', name: 'Down', status: 'error', message: 'Could not be reached.', by_currency: {} }],
    programs: [{ name: 'Pin-Up', sites: ['A', 'B'], clicks: 140, conversions: 7, by_currency: { EUR: { revenue: 650, commission: 260 } } }], skipped: 2 } }], { start: '2026-10-01', end: '2026-10-31' });
  b.sandbox.lummetLoadCrossSite(); await b.settle();
  assert.ok(b.calls[0].url.endsWith('/api/organizations/org-1/analytics/cross-site?start_date=2026-10-01&end_date=2026-10-31'), b.calls[0].url);
  const out = b.box('out').innerHTML;
  assert.match(out, /190 clicks/); assert.match(out, /650 EUR/); assert.match(out, /<td>USD<\/td><td>90<\/td>/); assert.match(out, /Pin-Up/); assert.match(out, /Could not be reached/); assert.match(out, /2 more site/);
  assert.doesNotMatch(out, /<img src=x/); assert.match(out, /&lt;img/);
});

test('page script: an API error is shown as a message', async () => {
  const html = insights.renderInsightCrossSite({ sites: [{ id: 's1', name: 'S', tenant_id: 't1' }], entitled: true });
  const b = browser(html, [{ match: '/analytics/cross-site', status: 403, body: { success: false, message: 'Analytics is not included <b>here</b>' } }], { start: 'a', end: 'b' });
  b.sandbox.lummetLoadCrossSite(); await b.settle();
  assert.match(b.box('out').innerHTML, /Analytics is not included/); assert.doesNotMatch(b.box('out').innerHTML, /<b>here/);
});
