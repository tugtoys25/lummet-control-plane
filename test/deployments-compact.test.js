// Customer Deployments: the list shows each site with its two newest deployments and a link to the full history; nothing is removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import { renderDeploymentsPage, renderDeploymentCards, RECENT_DEPLOYMENTS } from '../worker/views/customer-pages/deployments.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
let ipn = 20;
const makeEnv = () => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'z', CREDENTIAL_KEK: btoa('k'.repeat(32)) }; };
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload; if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, headers: res.headers, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
const site = (id, name) => ({ id, name, status: 'active', template_line: 'casino' });
const dep = (n, site_id = 's1', o = {}) => ({ id: `d${n}`, site_id, version: `v${n}`, status: 'active', is_rollback: 0, is_current: n === 5 ? 1 : 0, error_message: null, created_at: `2026-10-0${n}`, ...o });
const five = [5, 4, 3, 2, 1].map((n) => dep(n));
const count = (html, re) => (html.match(re) || []).length;

test('constant: two recent deployments', () => assert.equal(RECENT_DEPLOYMENTS, 2));

test('limited list: two newest rows, a count, and a link to the site history', () => {
  const html = renderDeploymentCards({ sites: [site('s1', 'Alpha')], deploymentsBySite: { s1: five }, latestVersion: 'v5', canManage: true, recentLimit: 2 });
  assert.equal(count(html, /<td class="mono">v\d/g), 2);
  assert.ok(html.includes('>v5<') || html.includes('v5'));
  assert.ok(!html.includes('>v3<') && !html.includes('>v1<'));
  assert.ok(html.includes('Showing the 2 most recent of 5 deployments') && html.includes('View more deployments for this site') && html.includes('/app/deployments?site=s1'));
  assert.ok(html.includes('up to date'), 'the banner still uses the whole history');
});

test('no link when a site has two or fewer deployments; no limit keeps every row exactly as before', () => {
  const two = renderDeploymentCards({ sites: [site('s1', 'Alpha')], deploymentsBySite: { s1: five.slice(0, 2) }, latestVersion: 'v5', canManage: true, recentLimit: 2 });
  assert.ok(!two.includes('View more deployments'));
  const all = renderDeploymentCards({ sites: [site('s1', 'Alpha')], deploymentsBySite: { s1: five }, latestVersion: 'v5', canManage: true });
  assert.equal(count(all, /<td class="mono">v\d/g), 5); assert.ok(!all.includes('View more deployments'));
});

test('a busy deployment is still announced even when it is not among the shown rows', () => {
  const list = [dep(9, 's1', { status: 'active' }), dep(8), dep(7, 's1', { status: 'building' })];
  const html = renderDeploymentCards({ sites: [site('s1', 'Alpha')], deploymentsBySite: { s1: list }, latestVersion: 'v9', canManage: true, recentLimit: 2 });
  assert.ok(html.includes('A deployment is in progress'));
});

test('site page: whole history, back link, live source carries the site', () => {
  const html = renderDeploymentsPage({ sites: [site('s1', 'Alpha')], deploymentsBySite: { s1: five }, latestVersion: 'v5', canManage: true, organizationId: 'o1', recentLimit: 2, siteId: 's1' });
  assert.equal(count(html, /<td class="mono">v\d/g), 5);
  assert.ok(html.includes('Deployments: Alpha') && html.includes('All sites') && html.includes('live-cards?site=s1'));
});

test('route: list is compact, the site page shows everything, live-cards follows each, unknown site goes back', async () => {
  const env = makeEnv();
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email: 'dc@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org dc', displayName: 'T' } });
  assert.equal(r.status, 200, r.text); const cookie = r.cookie, orgId = r.json.organizationId;
  await plans.startTrialSubscription(env, orgId, 'plan_casino_news_starter').catch(() => {});
  const ids = [];
  const m = await call(env, 'POST', `/api/organizations/${orgId}/sites`, { cookie, body: { name: 'Alpha', productId: 'prod_casino_news' } }); ids.push(m.json.siteId);
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) SELECT 'beta-id', organization_id, product_id, 'Beta', 'beta-slug', 'active' FROM sites WHERE id = ?`).bind(ids[0]).run(); ids.push('beta-id');
  for (const id of ids) await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(id).run();
  for (let i = 1; i <= 5; i++) await env.LUMMET_DB.prepare(`INSERT INTO deployments (id, site_id, version, status, created_at) VALUES (?, ?, ?, 'active', ?)`).bind('x' + i, ids[0], 'v' + i, '2026-10-0' + i).run();
  const list = await call(env, 'GET', `/app/deployments?org=${orgId}`, { cookie });
  assert.equal(list.status, 200); assert.ok(list.text.includes('Alpha') && list.text.includes('Beta'));
  assert.equal(count(list.text, /<td class="mono">v\d/g), 2); assert.ok(list.text.includes('View more deployments for this site'));
  const one = await call(env, 'GET', `/app/deployments?org=${orgId}&site=${ids[0]}`, { cookie });
  assert.equal(one.status, 200); assert.equal(count(one.text, /<td class="mono">v\d/g), 5); assert.ok(!one.text.includes('Beta'));
  const lc = await call(env, 'GET', `/api/organizations/${orgId}/deployments/live-cards`, { cookie });
  assert.equal(count(lc.json.data.html, /<td class="mono">v\d/g), 2);
  const lcOne = await call(env, 'GET', `/api/organizations/${orgId}/deployments/live-cards?site=${ids[0]}`, { cookie });
  assert.equal(count(lcOne.json.data.html, /<td class="mono">v\d/g), 5);
  assert.equal((one.text.match(/data-live-hash="([0-9a-f]{8})"/) || [])[1], lcOne.json.data.hash);
  const bad = await call(env, 'GET', `/app/deployments?org=${orgId}&site=nope`, { cookie });
  assert.equal(bad.status, 302); assert.equal(bad.headers.get('Location'), '/app/deployments');
});
