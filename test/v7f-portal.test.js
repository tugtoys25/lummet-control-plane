// v7F: customer portal pages for analytics, reports, campaigns, alerts, notifications, search and content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as sites from '../worker/sites.js';
import * as plans from '../worker/plans.js';
import * as insights from '../worker/views/customer-pages/insights.js';
import * as notifications from '../worker/repositories/notifications.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0], res };
}
async function org(e, email, name = 'Acme') {
  const s = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: name });
  await plans.startTrialSubscription(e, s.json.organizationId, 'plan_casino_news_starter');
  return { id: s.json.organizationId, userId: s.json.userId, cookie: s.cookie };
}
async function grant(e, keys) {
  for (const k of keys) await e.LUMMET_DB.prepare(`INSERT INTO plan_entitlements (plan_id, key, value_type, value) SELECT DISTINCT plan_id, ?, 'boolean', 'true' FROM subscriptions WHERE 1=1
     ON CONFLICT(plan_id, key) DO UPDATE SET value = 'true'`).bind(k).run();
}
async function liveSite(e, o, { name = 'Main site', domain = 'main.example.com', tenant = true } = {}) {
  const s = await sites.createSite(e, { organizationId: o.id, name, productId: 'prod_casino_news', actorUserId: o.userId });
  if (tenant) {
    const t = `t-${s.siteId}`;
    await e.LUMMET_DB.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, 'T', ?, ?)`).bind(t, t + '.example.test', 'https://' + t + '.example.test').run();
    await e.LUMMET_DB.prepare(`UPDATE sites SET tenant_id = ?, primary_domain = ?, status = 'active' WHERE id = ?`).bind(t, domain, s.siteId).run();
  }
  return s.siteId;
}
const nav = (html) => [...html.matchAll(/<a href="(\/app\/[a-z]+)"/g)].map((m) => m[1]);

test('Starter organization: analytics page works, reports/campaigns/alerts pages explain the upgrade and are hidden from the nav', async () => {
  const e = env(); const o = await org(e, 'a@example.com'); await liveSite(e, o);
  const analytics = await call(e, 'GET', '/app/analytics', null, o.cookie);
  assert.equal(analytics.status, 200);
  assert.match(analytics.text, /Load<\/button>/); assert.match(analytics.text, /<select id="site">/);
  for (const k of ['reports', 'campaigns', 'alerts']) {
    const p = await call(e, 'GET', '/app/' + k, null, o.cookie);
    assert.equal(p.status, 200, k);
    assert.match(p.text, /is not included in your plan/, k);
  }
  const links = nav(analytics.text);
  assert.ok(links.includes('/app/analytics') && links.includes('/app/notifications') && links.includes('/app/content') && links.includes('/app/search'));
  assert.ok(!links.includes('/app/reports') && !links.includes('/app/campaigns') && !links.includes('/app/alerts'), links.join());
  const reportsNav = nav((await call(e, 'GET', '/app/reports', null, o.cookie)).text);
  assert.ok(reportsNav.includes('/app/reports'), 'the page you are on stays in the nav so it can explain itself');
});

test('with the entitlements granted the pages show the site picker and their controls; without a live site they say so', async () => {
  const e = env(); const o = await org(e, 'b@example.com');
  await grant(e, ['reports.enabled', 'affiliate.enabled', 'alerts.enabled']);
  assert.match((await call(e, 'GET', '/app/reports', null, o.cookie)).text, /None of your sites is live yet/);
  await liveSite(e, o, { name: 'Live <i>one</i>' }); await liveSite(e, o, { name: 'Not deployed', tenant: false });
  for (const [k, marker] of [['reports', 'Refresh'], ['campaigns', 'New campaign'], ['alerts', 'Refresh'], ['analytics', 'Load']]) {
    const p = await call(e, 'GET', '/app/' + k, null, o.cookie);
    assert.match(p.text, new RegExp(marker), k);
    assert.doesNotMatch(p.text, /not included in your plan/, k);
    assert.match(p.text, /Live &lt;i&gt;one&lt;\/i&gt;/, k + ' escapes the site name');
    assert.doesNotMatch(p.text, /Not deployed<\/option>/, k + ' lists only sites that are deployed');
  }
  const links = nav((await call(e, 'GET', '/app/analytics', null, o.cookie)).text);
  for (const k of ['reports', 'campaigns', 'alerts']) assert.ok(links.includes('/app/' + k), k);
});

test('read-only roles do not get the write controls (and the server would refuse them anyway)', async () => {
  const e = env(); const o = await org(e, 'c@example.com');
  await grant(e, ['reports.enabled', 'affiliate.enabled', 'alerts.enabled']); await liveSite(e, o);
  await e.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'viewer' WHERE organization_id = ?`).bind(o.id).run();
  assert.match((await call(e, 'GET', '/app/reports', null, o.cookie)).text, /var CAN_RUN = false/);
  assert.doesNotMatch((await call(e, 'GET', '/app/campaigns', null, o.cookie)).text, /New campaign/);
  assert.match((await call(e, 'GET', '/app/alerts', null, o.cookie)).text, /var CAN_ACK = false/);
  const run = await call(e, 'POST', `/api/organizations/${o.id}/sites/x/reports/1/run`, {}, o.cookie);
  assert.equal(run.status, 403);
});

test('notifications API: lists only this organization\'s, counts open ones, and enforces role, tenant isolation and transitions', async () => {
  const e = env(); const a = await org(e, 'n1@example.com', 'A'); const b = await org(e, 'n2@example.com', 'B'); const db = e.LUMMET_DB;
  const add = (orgId, msg, status = 'open') => db.prepare(`INSERT INTO automation_alerts (organization_id, message, status) VALUES (?, ?, ?)`).bind(orgId, msg, status).run();
  await add(a.id, 'A open one'); await add(a.id, 'A open two'); await add(a.id, 'A old', 'resolved'); await add(b.id, 'B secret');
  const open = await call(e, 'GET', `/api/organizations/${a.id}/notifications`, null, a.cookie);
  assert.equal(open.status, 200); assert.deepEqual(open.json.data.map((n) => n.message).sort(), ['A open one', 'A open two']); assert.equal(open.json.open, 2);
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/notifications?status=all`, null, a.cookie)).json.data.length, 3);
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/notifications`, null, b.cookie)).status, 403, 'another organization cannot read it');
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/notifications`)).status, 401);

  const first = open.json.data[0].id; const bId = (await db.prepare(`SELECT id FROM automation_alerts WHERE organization_id = ?`).bind(b.id).first()).id;
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/notifications/${bId}/acknowledge`, {}, a.cookie)).status, 404, 'cannot touch another organization\'s row by id');
  assert.equal((await db.prepare(`SELECT status FROM automation_alerts WHERE id = ?`).bind(bId).first()).status, 'open');
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/notifications/${first}/acknowledge`, {}, a.cookie)).status, 200);
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/notifications/${first}/acknowledge`, {}, a.cookie)).status, 404, 'already acknowledged');
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/notifications/${first}/resolve`, {}, a.cookie)).status, 200);
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/notifications/${first}/acknowledge`, {}, a.cookie)).status, 404, 'a resolved one does not go back');
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/notifications`, null, a.cookie)).json.open, 1);
  const audit = await db.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource = 'notification' AND organization_id = ?`).bind(a.id).first();
  assert.equal(audit.n, 5, 'every attempt is audited, including the refused ones');
  await db.prepare(`UPDATE organization_users SET role = 'viewer' WHERE organization_id = ?`).bind(a.id).run();
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/notifications/${first}/resolve`, {}, a.cookie)).status, 403, 'viewers can read but not change');
});

test('notifications page: shows open items with actions, escapes messages, and the nav carries the open count', async () => {
  const e = env(); const o = await org(e, 'p@example.com');
  await e.LUMMET_DB.prepare(`INSERT INTO automation_alerts (organization_id, message) VALUES (?, ?), (?, ?)`).bind(o.id, '<img src=x onerror=alert(1)>', o.id, 'second').run();
  const page = await call(e, 'GET', '/app/notifications', null, o.cookie);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<img src=x/); assert.match(page.text, /&lt;img src=x/);
  assert.match(page.text, /data-onclick="lummetNotify" data-args="\[\d+,&quot;acknowledge&quot;\]"/);
  assert.match(page.text, /Notifications<span class="nav-badge"[^>]*>2<\/span>/);
  const other = await call(e, 'GET', '/app/notifications?status=all', null, o.cookie);
  assert.match(other.text, /Show open only/);
  const clean = await org(e, 'q@example.com');
  assert.doesNotMatch((await call(e, 'GET', '/app/overview', null, clean.cookie)).text, /class="nav-badge"/);
});

test('search page: finds this organization\'s sites, domains and members, escapes everything, and ignores other organizations', async () => {
  const e = env(); const o = await org(e, 'owner@acme.example', 'Acme'); const other = await org(e, 'x@other.example', 'Other');
  await liveSite(e, o, { name: 'Acme <b>Casino</b>', domain: 'acme-casino.example.com' }); await liveSite(e, other, { name: 'Acme Secret Site', domain: 'acme-secret.example.com' });
  await e.LUMMET_DB.prepare(`INSERT INTO domains (id, site_id, hostname, status, verification_token) SELECT 'd1', id, 'acme-casino.example.com', 'active', 'tok' FROM sites WHERE organization_id = ?`).bind(o.id).run();
  const page = await call(e, 'GET', '/app/search?q=' + encodeURIComponent('acme'), null, o.cookie);
  assert.equal(page.status, 200);
  assert.match(page.text, /Acme &lt;b&gt;Casino&lt;\/b&gt;/); assert.match(page.text, /acme-casino\.example\.com/); assert.match(page.text, /owner@acme\.example/);
  assert.doesNotMatch(page.text, /Secret Site|acme-secret/);
  const q = await call(e, 'GET', '/app/search?q=' + encodeURIComponent('"><script>alert(1)</script>'), null, o.cookie);
  assert.doesNotMatch(q.text, /<script>alert\(1\)/); assert.match(q.text, /No results/);
  assert.match((await call(e, 'GET', '/app/search', null, o.cookie)).text, /<h1>Search<\/h1>/);
});

test('content page links to a site\'s own dashboard only when the site is live with a domain', async () => {
  const e = env(); const o = await org(e, 'k@example.com');
  await liveSite(e, o, { name: 'Live', domain: 'live.example.com' }); await liveSite(e, o, { name: 'Pending', tenant: false });
  const page = await call(e, 'GET', '/app/content', null, o.cookie);
  assert.match(page.text, /href="https:\/\/live\.example\.com\/en\/dashboard"/);
  assert.equal((page.text.match(/\/en\/dashboard/g) || []).length, 1);
  assert.match(page.text, /Available when the site is live/);
});

test('all seven pages require a signed-in customer', async () => {
  const e = env();
  for (const p of ['analytics', 'reports', 'campaigns', 'alerts', 'notifications', 'search', 'content']) {
    const r = await call(e, 'GET', '/app/' + p);
    assert.equal(r.status, 302, p); assert.equal(r.res.headers.get('Location'), '/app/login', p);
  }
});

// ---- the page scripts, run against a stub browser ----
function pageScript(html) { return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n'); }
function browser(html, responses, ids = {}) {
  const calls = []; const boxes = {};
  const box = (id) => (boxes[id] ||= { innerHTML: '', value: ids[id] ?? '' });
  const sandbox = {
    document: { getElementById: (id) => (id === 'org-switcher' ? { value: 'org-1' } : box(id)), createElement: () => ({}) },
    fetch: async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      const hit = responses.find((r) => url.includes(r.match));
      return { status: hit?.status || 200, json: async () => (hit ? hit.body : {}) };
    },
    encodeURIComponent, JSON, Promise, Number, String, Array, Object, alert() {}, location: { reload() {} }, console
  };
  vm.createContext(sandbox); vm.runInContext(pageScript(html), sandbox);
  const settle = () => new Promise((r) => setTimeout(r, 15));
  return { sandbox, calls, box, settle };
}
const ONE_SITE = [{ id: 's1', name: 'S', tenant_id: 't1' }];

test('analytics script: builds the tables, escapes names the tenant sent, and shows API errors as messages', async () => {
  const html = insights.renderInsightAnalytics({ sites: ONE_SITE, entitled: true });
  const b = browser(html, [
    { match: '/analytics/overview', body: { success: true, rows: [{ dimensionId: 7, name: '<img src=x onerror=alert(1)>', views: 10, clicks: 3, conversions: 1, revenue: 12.5, commission: 4 }] } },
    { match: '/analytics/tracking-health', body: { success: true, counts: { healthy: 4, broken: 1 }, unhealthy_links: [{ name: 'L<b>', status: 'broken' }] } },
    { match: '/analytics/revenue', body: { success: false, message: 'Currency <x> unknown' }, status: 422 }
  ], { site: 's1', start: '2026-09-01', end: '2026-09-30', dim: 'casino', currency: 'eur' });
  b.sandbox.lummetLoadAnalytics(); await b.settle();
  const out = b.box('out').innerHTML;
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.doesNotMatch(out, /<img src=x/);
  assert.match(out, /healthy: 4/); assert.match(out, /L&lt;b&gt;/);
  assert.match(out, /flash-error">Currency &lt;x&gt; unknown/);
  const urls = b.calls.map((c) => c.url);
  assert.ok(urls.some((u) => u === '/api/organizations/org-1/sites/s1/analytics/overview?start_date=2026-09-01&end_date=2026-09-30&dimension_type=casino&currency=EUR'), urls.join('\n'));
  assert.ok(urls.some((u) => /analytics\/revenue\?start_date=2026-09-01&end_date=2026-09-30&currency=EUR$/.test(u)));
});

test('analytics script: without a currency it does not request the revenue series', async () => {
  const b = browser(insights.renderInsightAnalytics({ sites: ONE_SITE, entitled: true }), [{ match: '/analytics/', body: { success: true, rows: [], counts: {}, unhealthy_links: [] } }], { site: 's1', start: 'a', end: 'b', dim: 'offer', currency: '' });
  b.sandbox.lummetLoadAnalytics(); await b.settle();
  assert.equal(b.calls.some((c) => c.url.includes('/analytics/revenue')), false);
  assert.equal(b.calls.length, 2);
});

test('reports script: lists reports, offers Run only to analysts, and posts the run to the right path', async () => {
  for (const canRun of [true, false]) {
    const b = browser(insights.renderInsightReports({ sites: ONE_SITE, entitled: true, canRun }), [
      { match: '/reports/9/run', body: { success: true } }, { match: '/reports', body: { success: true, data: [{ id: 9, name: 'Weekly <b>', status: 'active', created_at: '2026-09-01' }] } }
    ], { site: 's1' });
    await b.settle();
    const out = b.box('out').innerHTML;
    assert.match(out, /Weekly &lt;b&gt;/);
    assert.equal(/data-onclick="lummetRunReport"/.test(out), canRun);
    if (canRun) {
      assert.match(out, /data-args="\[&quot;9&quot;\]"/);
      b.sandbox.lummetRunReport('9'); await b.settle();
      const run = b.calls.find((c) => c.method === 'POST');
      assert.equal(run.url, '/api/organizations/org-1/sites/s1/reports/9/run');
      assert.match(b.box('run-result').innerHTML, /The report ran/);
    }
  }
});

test('campaigns script: creates with a JSON body and reloads; shows the server\'s refusal', async () => {
  const b = browser(insights.renderInsightCampaigns({ sites: ONE_SITE, entitled: true, canCreate: true }), [
    { match: '/campaigns', body: { success: true, data: [] } }
  ], { site: 's1', cname: 'Autumn push' });
  await b.settle();
  b.sandbox.lummetCreateCampaign(); await b.settle();
  const post = b.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, '/api/organizations/org-1/sites/s1/campaigns'); assert.deepEqual(JSON.parse(post.body), { name: 'Autumn push' });
  assert.match(b.box('create-result').innerHTML, /Campaign created/);
  const denied = browser(insights.renderInsightCampaigns({ sites: ONE_SITE, entitled: true, canCreate: true }), [
    { match: '/campaigns', body: { success: false, error: 'not_entitled', message: 'No campaigns on this plan' }, status: 403 }
  ], { site: 's1', cname: 'x' });
  await denied.settle(); denied.sandbox.lummetCreateCampaign(); await denied.settle();
  assert.match(denied.box('create-result').innerHTML, /No campaigns on this plan/);
});

test('alerts script: acknowledge posts to the alert\'s own path and refreshes', async () => {
  const b = browser(insights.renderInsightAlerts({ sites: ONE_SITE, entitled: true, canAck: true }), [
    { match: '/alerts/5/acknowledge', body: { success: true } }, { match: '/alerts', body: { success: true, data: [{ id: 5, rule_name: 'Link down', metric: 'clicks', status: 'open', triggered_at: 't' }] } }
  ], { site: 's1' });
  await b.settle();
  assert.match(b.box('out').innerHTML, /Link down/); assert.match(b.box('out').innerHTML, /data-onclick="lummetAckAlert"/);
  b.sandbox.lummetAckAlert('5'); await b.settle();
  assert.ok(b.calls.some((c) => c.method === 'POST' && c.url === '/api/organizations/org-1/sites/s1/alerts/5/acknowledge'));
});

test('repository: setStatus only moves forward and only within the organization', async () => {
  const e = env(); const a = await org(e, 'r1@example.com'); const b = await org(e, 'r2@example.com');
  await e.LUMMET_DB.prepare(`INSERT INTO automation_alerts (organization_id, message) VALUES (?, 'm')`).bind(a.id).run();
  const id = (await e.LUMMET_DB.prepare(`SELECT id FROM automation_alerts`).first()).id;
  assert.equal(await notifications.setStatus(e, b.id, id, 'resolved'), false);
  assert.equal(await notifications.setStatus(e, a.id, id, 'acknowledged'), true);
  assert.equal(await notifications.setStatus(e, a.id, id, 'acknowledged'), false);
  assert.equal(await notifications.setStatus(e, a.id, id, 'resolved'), true);
  assert.equal(await notifications.countOpen(e, a.id), 0);
});

test('the new pages satisfy the v7E policy: every script carries this response\'s nonce, no inline handlers, every named function exists on the page', async () => {
  const e = env(); const o = await org(e, 'csp@example.com');
  await grant(e, ['reports.enabled', 'affiliate.enabled', 'alerts.enabled']); await liveSite(e, o);
  await e.LUMMET_DB.prepare(`INSERT INTO automation_alerts (organization_id, message) VALUES (?, 'hello')`).bind(o.id).run();
  let withScripts = 0;
  for (const p of ['analytics', 'reports', 'campaigns', 'alerts', 'notifications', 'search', 'content']) {
    const r = await call(e, 'GET', '/app/' + p, null, o.cookie);
    assert.equal(r.status, 200, p);
    const header = r.res.headers.get('Content-Security-Policy');
    const nonce = header.match(/'nonce-([^']+)'/)?.[1];
    assert.ok(nonce, p + ' has a nonce');
    assert.doesNotMatch(r.text, /lnt[0-9a-f]{32}/, p + ': secret token never leaves the Worker');
    assert.doesNotMatch(r.text, /<[^>]*(?<![\w.-])on(click|submit|change|input)=/, p + ': no inline handler');
    const scripts = [...r.text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    for (const [, attrs] of scripts) assert.ok(attrs.includes(`nonce="${nonce}"`), `${p}: script without nonce`);
    if (scripts.length) withScripts++;
    const defined = scripts.map((s) => s[2]).join('\n');
    for (const m of r.text.matchAll(/\sdata-on(?:click|submit|change|input)="([^"]+)"/g)) assert.match(defined, new RegExp(`function\\s+${m[1]}\\s*\\(|window\\.${m[1]}\\s*=`), `${p}: ${m[1]} defined`);
  }
  assert.ok(withScripts >= 5);
});
