// v7H: automations that react to a site's own tracking-link health, and disabling links from the portal.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as sites from '../worker/sites.js';
import * as plans from '../worker/plans.js';
import * as automations from '../worker/automations.js';
import * as tenantLinks from '../worker/tenant-links.js';
import { sweepTrackingLinkEvents } from '../worker/automation-sweep.js';
import { encryptSecret } from '../worker/crypto.js';
import { renderInsightAnalytics } from '../worker/views/customer-pages/insights.js';
import { renderAutomationsPage } from '../worker/views/customer-pages/automations.js';

const API = 'https://t1.tenant.test';
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
let realFetch, sent;

beforeEach(() => {
  realFetch = globalThis.fetch; sent = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    sent.push({ method: opts.method || 'GET', path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers || {} });
    const m = u.pathname.match(/tracking-links\/(\d+)$/);
    if (m && Number(m[1]) === 9) return { ok: false, status: 422, json: async () => ({ success: false, error: 'Invalid destination' }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

async function env() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') };
}
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function grant(e, keys) {
  for (const k of keys) await e.LUMMET_DB.prepare(`INSERT INTO plan_entitlements (plan_id, key, value_type, value) VALUES ('plan_casino_news_starter', ?, 'boolean', 'true') ON CONFLICT(plan_id, key) DO UPDATE SET value = 'true'`).bind(k).run();
}
async function org(e, email, { entitled = true } = {}) {
  const s = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email });
  await plans.startTrialSubscription(e, s.json.organizationId, 'plan_casino_news_starter');
  if (entitled) await grant(e, ['affiliate.enabled', 'automations.enabled']);
  return { id: s.json.organizationId, userId: s.json.userId, cookie: s.cookie };
}
let tenantSeq = 0;
async function liveSite(e, o, { status = 'active', tenant = true } = {}) {
  const s = await sites.createSite(e, { organizationId: o.id, name: 'Site ' + (++tenantSeq), productId: 'prod_casino_news', actorUserId: o.userId });
  if (tenant) {
    const t = `tenant-${tenantSeq}`;
    await e.LUMMET_DB.prepare(`INSERT INTO tenants (id, name, host, api_base_url, status) VALUES (?, 'T', ?, ?, 'active')`).bind(t, `t${tenantSeq}.tenant.test`, API).run();
    const { encryptedSecret, secretIv } = await encryptSecret(e, 'hmac-secret');
    await e.LUMMET_DB.prepare(`INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv, status) VALUES (?, ?, ?, ?, 'active')`).bind(t, 'cred-' + tenantSeq, encryptedSecret, secretIv).run();
    await e.LUMMET_DB.prepare(`UPDATE sites SET tenant_id = ?, status = ? WHERE id = ?`).bind(t, status, s.siteId).run();
  }
  return s.siteId;
}
const puts = () => sent.filter((r) => r.method === 'PUT');

test('rule validation knows the new trigger and action, and still refuses unknown ones', () => {
  const base = { name: 'r', triggerEvent: 'tracking_link.unhealthy', conditions: [{ field: 'healthStatus', op: 'eq', value: 'broken' }], actions: [{ type: 'disable_tracking_link' }] };
  assert.equal(automations.validateRule(base), null);
  assert.equal(automations.validateRule({ ...base, triggerEvent: 'tracking_link.exploded' }), 'invalid_trigger_event');
  assert.equal(automations.validateRule({ ...base, actions: [{ type: 'delete_tracking_link' }] }), 'unknown_action');
});

test('disableTrackingLinks: one signed PUT per link with ONLY status=disabled, each answered on its own', async () => {
  const e = await env(); const o = await org(e, 'a@example.com'); const siteId = await liveSite(e, o);
  const r = await tenantLinks.disableTrackingLinks(e, { organizationId: o.id, siteId, ids: [5, '6', 5, 9] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.results.map((x) => [x.id, x.ok]), [[5, true], [6, true], [9, false]]);
  assert.equal(r.disabled, 2); assert.equal(r.failed, 1);
  assert.deepEqual(puts().map((p) => p.path), ['/en/api/super/tracking-links/5', '/en/api/super/tracking-links/6', '/en/api/super/tracking-links/9']);
  for (const p of puts()) { assert.deepEqual(p.body, { status: 'disabled' }); assert.ok(Object.keys(p.headers).length >= 3, 'signed request'); }
  assert.equal(sent.some((s) => s.method === 'DELETE'), false);
});

test('disableTrackingLinks refusals reach no site: bad ids, other organization, site not live, plan without affiliate tools', async () => {
  const e = await env(); const o = await org(e, 'b@example.com'); const x = await org(e, 'x@example.com'); const siteId = await liveSite(e, o);
  const pending = await liveSite(e, o, { status: 'provisioning' });
  const go = (over) => tenantLinks.disableTrackingLinks(e, { organizationId: o.id, siteId, ids: [1], ...over });
  for (const ids of [[], undefined, 'x', [0], [-1], [1.5], ['a'], Array.from({ length: 51 }, (_, i) => i + 1)]) assert.equal((await go({ ids })).error, 'invalid_ids', JSON.stringify(ids)?.slice(0, 30));
  assert.equal((await go({ organizationId: x.id })).status, 404);
  assert.equal((await go({ siteId: 'nope' })).status, 404);
  assert.equal((await go({ siteId: pending })).error, 'site_not_live');
  await e.LUMMET_DB.prepare(`UPDATE plan_entitlements SET value = 'false' WHERE key = 'affiliate.enabled'`).run();
  assert.equal((await go({})).error, 'not_entitled');
  assert.equal(sent.length, 0);
});

test('route: editors may disable links; viewers, outsiders and signed-out callers may not; the call is audited with counts only', async () => {
  const e = await env(); const o = await org(e, 'r@example.com'); const x = await org(e, 'rx@example.com'); const siteId = await liveSite(e, o);
  const url = `/api/organizations/${o.id}/sites/${siteId}/tracking-links/disable`;
  assert.equal((await call(e, 'POST', url, { ids: [1] })).status, 401);
  assert.equal((await call(e, 'POST', url, { ids: [1] }, x.cookie)).status, 403);
  await e.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'viewer' WHERE organization_id = ?`).bind(o.id).run();
  assert.equal((await call(e, 'POST', url, { ids: [1] }, o.cookie)).status, 403);
  assert.equal(sent.length, 0);
  await e.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'editor' WHERE organization_id = ?`).bind(o.id).run();
  const ok = await call(e, 'POST', url, { ids: [4, 9] }, o.cookie);
  assert.equal(ok.status, 200); assert.equal(ok.json.disabled, 1); assert.equal(ok.json.failed, 1);
  assert.equal((await call(e, 'POST', url, { ids: [] }, o.cookie)).status, 422);
  assert.equal((await call(e, 'POST', `/api/organizations/${x.id}/sites/${siteId}/tracking-links/disable`, { ids: [1] }, x.cookie)).status, 404, 'another organization\'s site id');
  const audit = (await e.LUMMET_DB.prepare(`SELECT action, success, error_message FROM lummet_audit_logs WHERE resource = 'tracking_link' AND organization_id = ? ORDER BY id`).bind(o.id).all()).results;
  assert.deepEqual(audit.map((a) => a.action), ['disable:1/2', 'disable:0']);
  assert.equal(audit[0].success, 0); assert.match(audit[0].error_message, /1 failed/);
});

test('automation: an unhealthy link event disables exactly that link, once, and only when the conditions match', async () => {
  const e = await env(); const o = await org(e, 'auto@example.com'); const siteId = await liveSite(e, o);
  const made = await automations.createRule(e, o.id, { name: 'Disable broken', triggerEvent: 'tracking_link.unhealthy', conditions: [{ field: 'healthStatus', op: 'eq', value: 'broken' }], actions: [{ type: 'disable_tracking_link' }] }, o.userId);
  assert.equal(made.ok, true);
  const data = (over) => ({ siteId, siteName: 'S', trackingLinkId: 5, name: 'L', healthStatus: 'broken', ...over });
  assert.equal((await automations.runAutomations(e, o.id, 'tracking_link.unhealthy', data({ healthStatus: 'warning' }), 'ev0')).ran, 0, 'condition not met');
  assert.equal(puts().length, 0);
  assert.equal((await automations.runAutomations(e, o.id, 'tracking_link.unhealthy', data(), 'ev1')).ran, 1);
  assert.deepEqual(puts().map((p) => p.path), ['/en/api/super/tracking-links/5']);
  await automations.runAutomations(e, o.id, 'tracking_link.unhealthy', data(), 'ev1');
  assert.equal(puts().length, 1, 'a replayed event does nothing');
  const run = await e.LUMMET_DB.prepare(`SELECT status, action_results FROM automation_runs WHERE event_id = 'ev1'`).first();
  assert.equal(run.status, 'success'); assert.deepEqual(JSON.parse(run.action_results)[0].disabled, 5);
  const audit = await e.LUMMET_DB.prepare(`SELECT actor_type, initiated_by, action, success, resource_id FROM lummet_audit_logs WHERE resource = 'tracking_link'`).first();
  assert.deepEqual({ ...audit }, { actor_type: 'system', initiated_by: 'automation', action: 'disable', success: 1, resource_id: `${siteId}:5` });
});

test('automation safety: an event naming another organization\'s site, or no link, disables nothing and the run is recorded as failed', async () => {
  const e = await env(); const o = await org(e, 'safe@example.com'); const other = await org(e, 'other@example.com'); const theirSite = await liveSite(e, other);
  await automations.createRule(e, o.id, { name: 'd', triggerEvent: 'tracking_link.unhealthy', conditions: [], actions: [{ type: 'disable_tracking_link' }] }, o.userId);
  await automations.runAutomations(e, o.id, 'tracking_link.unhealthy', { siteId: theirSite, trackingLinkId: 3 }, 'e-cross');
  await automations.runAutomations(e, o.id, 'tracking_link.unhealthy', { siteId: theirSite }, 'e-nolink');
  await automations.runAutomations(e, o.id, 'tracking_link.unhealthy', { siteId: "x'; DROP TABLE sites;--", trackingLinkId: '3 OR 1=1' }, 'e-junk');
  assert.equal(sent.length, 0);
  const runs = (await e.LUMMET_DB.prepare(`SELECT status FROM automation_runs ORDER BY event_id`).all()).results.map((r) => r.status);
  assert.deepEqual(runs, ['failed', 'failed', 'failed']);
});

test('automation: a plan without automations or affiliate tools never reaches the site', async () => {
  const e = await env(); const o = await org(e, 'noent@example.com'); const siteId = await liveSite(e, o);
  await automations.createRule(e, o.id, { name: 'd', triggerEvent: 'tracking_link.unhealthy', conditions: [], actions: [{ type: 'disable_tracking_link' }] }, o.userId);
  await e.LUMMET_DB.prepare(`UPDATE plan_entitlements SET value = 'false' WHERE key = 'affiliate.enabled'`).run();
  await automations.runAutomations(e, o.id, 'tracking_link.unhealthy', { siteId, trackingLinkId: 1 }, 'e1');
  assert.equal(sent.length, 0);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT status FROM automation_runs`).first()).status, 'failed');
});

const health = (links) => async () => ({ ok: true, data: { counts: {}, unhealthy_links: links } });
const LINKS = [{ id: 1, name: 'a', status: 'broken' }, { id: 2, name: 'b', status: 'unknown' }, { id: 3, name: 'c', status: 'disabled' }, { id: 4, name: 'd', status: 'warning' }, { id: 5, name: 'e', status: 'timeout' }, { id: 'x', name: 'f', status: 'broken' }];

test('sweep: raises the event only for actionable links, runs the rule, and is quiet until the next day', async () => {
  const e = await env(); const o = await org(e, 'sw@example.com'); const siteId = await liveSite(e, o);
  await automations.createRule(e, o.id, { name: 'Disable broken', triggerEvent: 'tracking_link.unhealthy', conditions: [{ field: 'healthStatus', op: 'eq', value: 'broken' }], actions: [{ type: 'disable_tracking_link' }] }, o.userId);
  const day1 = new Date('2026-10-10T10:00:00Z');
  const s1 = await sweepTrackingLinkEvents(e, { now: day1, getHealth: health(LINKS) });
  assert.deepEqual({ sites: s1.sites, events: s1.events, skipped: s1.skipped }, { sites: 1, events: 3, skipped: 3 });
  assert.deepEqual(puts().map((p) => p.path), ['/en/api/super/tracking-links/1'], 'only the broken one matched the rule');
  await sweepTrackingLinkEvents(e, { now: new Date('2026-10-10T16:00:00Z'), getHealth: health(LINKS) });
  assert.equal(puts().length, 1, 'same day: events already handled');
  await sweepTrackingLinkEvents(e, { now: new Date('2026-10-11T10:00:00Z'), getHealth: health(LINKS) });
  assert.equal(puts().length, 2, 'next day a still-unhealthy link runs the rule again');
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM automation_runs WHERE event_id LIKE 'tl:%'`).first()).n, 2, 'a run is recorded only when the conditions match: one per day for the broken link');
});

test('sweep: only sites whose organization has an active rule for the trigger are asked, least recently asked first', async () => {
  const e = await env(); const a = await org(e, 'sa@example.com'); const b = await org(e, 'sb@example.com'); const c = await org(e, 'sc@example.com');
  const sa = await liveSite(e, a), sb = await liveSite(e, b); await liveSite(e, c);                    // c has no rule
  for (const [o] of [[a], [b]]) await automations.createRule(e, o.id, { name: 'n', triggerEvent: 'tracking_link.unhealthy', conditions: [], actions: [{ type: 'create_alert' }] }, o.userId);
  const asked = []; const getHealth = async (_e, site) => { asked.push(site.id); return { ok: true, data: { unhealthy_links: [] } }; };
  await sweepTrackingLinkEvents(e, { maxSites: 1, getHealth }); await sweepTrackingLinkEvents(e, { maxSites: 1, getHealth }); await sweepTrackingLinkEvents(e, { maxSites: 1, getHealth });
  assert.equal(new Set(asked.slice(0, 2)).size, 2, 'the first two ticks cover both sites');
  assert.deepEqual([...new Set(asked)].sort(), [sa, sb].sort());
  await e.LUMMET_DB.prepare(`UPDATE automation_rules SET status = 'paused'`).run();
  asked.length = 0; await sweepTrackingLinkEvents(e, { getHealth });
  assert.deepEqual(asked, [], 'paused rules cost nothing');
});

test('sweep: a site that errors or is unreachable never stops the others, and is still marked as swept', async () => {
  const e = await env(); const a = await org(e, 'ea@example.com'); const b = await org(e, 'eb@example.com');
  const sa = await liveSite(e, a), sb = await liveSite(e, b);
  for (const o of [a, b]) await automations.createRule(e, o.id, { name: 'n', triggerEvent: 'tracking_link.unhealthy', conditions: [], actions: [{ type: 'create_alert' }] }, o.userId);
  const getHealth = async (_e, site) => { if (site.id === sa) throw new Error('boom'); return { ok: true, data: { unhealthy_links: [{ id: 1, name: 'x', status: 'broken' }] } }; };
  const r = await sweepTrackingLinkEvents(e, { getHealth });
  assert.equal(r.sites, 2); assert.equal(r.events, 1);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM automation_sweep_state`).first()).n, 2);
  const down = await sweepTrackingLinkEvents(e, { getHealth: async () => ({ ok: false, status: 502 }) });
  assert.equal(down.events, 0);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM automation_alerts WHERE organization_id = ?`).bind(b.id).first()).n, 1, 'the create_alert action ran for the healthy site only');
});

test('the maintenance tick endpoint runs the sweep', async () => {
  const e = await env(); e.ALERT_CHECK_TOKEN = 'tick-token-0123456789';
  const o = await org(e, 'tick@example.com'); await liveSite(e, o);
  await automations.createRule(e, o.id, { name: 'n', triggerEvent: 'tracking_link.unhealthy', conditions: [], actions: [{ type: 'disable_tracking_link' }] }, o.userId);
  const pending = []; const c = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
  const res = await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method: 'POST', headers: { Authorization: 'Bearer ' + e.ALERT_CHECK_TOKEN } }), e, c);
  assert.equal(res.status, 200);
  await Promise.all(pending);
  assert.ok(sent.some((s) => s.path === '/en/api/super/tracking-health'), 'the site was asked for its tracking-link health: ' + JSON.stringify(sent.map((s) => s.method + ' ' + s.path)) + ' status=' + res.status);
});

// ---- UI ----
function browser(html, responses, ids = {}) {
  const calls = []; const boxes = {}; const alerts = [];
  const box = (id) => (boxes[id] ||= { innerHTML: '', value: ids[id] ?? '' });
  const script = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
  const sandbox = {
    document: { getElementById: (id) => (id === 'org-switcher' ? { value: 'org-1' } : box(id)), createElement: () => ({}) },
    fetch: async (url, opts = {}) => { calls.push({ url, method: opts.method || 'GET', body: opts.body }); const hit = responses.find((r) => url.includes(r.match)); return { status: hit?.status || 200, json: async () => (hit ? hit.body : {}) }; },
    encodeURIComponent, JSON, Promise, Number, String, Array, Object, Math, alert: (m) => alerts.push(m), location: { reload() {} }, console
  };
  vm.createContext(sandbox); vm.runInContext(script, sandbox);
  return { sandbox, calls, box, alerts, settle: () => new Promise((r) => setTimeout(r, 15)) };
}
const SITE = [{ id: 's1', name: 'S', tenant_id: 't1' }];
const RESP = [
  { match: '/analytics/overview', body: { success: true, rows: [] } },
  { match: '/tracking-health', body: { success: true, counts: { broken: 2, disabled: 1 }, unhealthy_links: [{ id: 1, name: 'A<b>', status: 'broken' }, { id: 2, name: 'B', status: 'timeout' }, { id: 3, name: 'C', status: 'disabled' }, { id: 4, name: 'D', status: 'unknown' }] } },
  { match: '/tracking-links/disable', body: { success: true, disabled: 2, failed: 0 } }
];

test('analytics page: editors get Disable buttons for actionable links and a bulk button; others get none', async () => {
  const b = browser(renderInsightAnalytics({ sites: SITE, entitled: true, canDisable: true }), RESP, { site: 's1', start: 'a', end: 'b', dim: 'casino', currency: '' });
  b.sandbox.lummetLoadAnalytics(); await b.settle();
  const out = b.box('out').innerHTML;
  assert.equal((out.match(/data-onclick="lummetDisableLinks"/g) || []).length, 3, 'two rows plus the bulk button');
  assert.match(out, /data-args="\[\[1\]\]"/); assert.match(out, /data-args="\[\[2\]\]"/); assert.doesNotMatch(out, /data-args="\[\[3\]\]"|data-args="\[\[4\]\]"/);
  assert.match(out, /data-args="\[\[1,2\]\]"/); assert.match(out, /Disable all listed \(2\)/);
  assert.match(out, /A&lt;b&gt;/);
  b.sandbox.lummetDisableLinks([1, 2]); await b.settle();
  const post = b.calls.find((c) => c.method === 'POST');
  assert.equal(post.url, '/api/organizations/org-1/sites/s1/tracking-links/disable'); assert.deepEqual(JSON.parse(post.body), { ids: [1, 2] });
  const viewer = browser(renderInsightAnalytics({ sites: SITE, entitled: true, canDisable: false }), RESP, { site: 's1', start: 'a', end: 'b', dim: 'casino', currency: '' });
  viewer.sandbox.lummetLoadAnalytics(); await viewer.settle();
  assert.doesNotMatch(viewer.box('out').innerHTML, /lummetDisableLinks/);
});

test('analytics page: a partial failure is reported to the person', async () => {
  const b = browser(renderInsightAnalytics({ sites: SITE, entitled: true, canDisable: true }), [...RESP.slice(0, 2), { match: '/tracking-links/disable', body: { success: true, disabled: 1, failed: 1 } }], { site: 's1', start: 'a', end: 'b', dim: 'casino', currency: '' });
  b.sandbox.lummetDisableLinks([1, 9]); await b.settle();
  assert.match(b.alerts[0], /1 disabled, 1 could not be changed/);
});

test('automations page offers the new trigger, action and health condition', () => {
  const html = renderAutomationsPage({ rules: [], runs: [], enabled: true, canManage: true, triggers: automations.TRIGGER_EVENTS, actions: Object.keys(automations.ACTIONS) });
  assert.match(html, /A tracking link becomes unhealthy/); assert.match(html, /Disable that tracking link \(reversible\)/);
  assert.match(html, /id="rule-health"/); assert.match(html, /field: 'healthStatus', op: 'eq'/);
  assert.doesNotMatch(html, /\sonclick=|\sonsubmit=/);
});
