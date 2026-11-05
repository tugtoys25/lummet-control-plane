// Phase 10 A1-A3 (control plane): the picker options route, the /app/sites page and describeSetup.
// Driven through worker.fetch like site-setup-routes.test.js; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import { describeSetup, renderSitesPage } from '../worker/views/customer-pages/sites.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); }, passThroughOnException() {} };
const PLAN = 'plan_agency_30';
let ipn = 40;

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra };
}
async function call(env, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${(ipn++ % 240) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function customer(env, email) {
  const r = await call(env, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org ' + email, displayName: 'T' } });
  assert.equal(r.status, 200, r.text);
  await plans.startTrialSubscription(env, r.json.organizationId, PLAN).catch(() => {});
  return { cookie: r.cookie, orgId: r.json.organizationId };
}
const run = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).run();
async function liveSite(env, orgId, n, name = `S${n}`) {
  await run(env, `INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, ?, ?, ?)`, `t-${n}`, `T${n}`, `t${n}.example.test`, `https://t${n}.example.test`);
  await run(env, `INSERT INTO sites (id, organization_id, name, slug, product_id, status, tenant_id) VALUES (?, ?, ?, ?, 'prod_casino_news', 'active', ?)`, `s-${n}`, orgId, name, `s${n}`, `t-${n}`);
  return `s-${n}`;
}
const setReq = (env, siteId, status, lastError = null, attempts = 0, preset = 'news') =>
  run(env, `INSERT INTO site_setup_requests (id, site_id, kind, preset_id, status, attempts, last_error) VALUES (?, ?, 'preset', ?, ?, ?, ?)`, `r-${siteId}-${status}`, siteId, preset, status, attempts, lastError);

// ---------- A1: options route ----------

test('A1 options route: needs a session, lists presets, the resolved default and only this organization\'s sites', async () => {
  const env = makeEnv();
  const a = await customer(env, 'o-a@example.com'); const b = await customer(env, 'o-b@example.com');
  await liveSite(env, a.orgId, 1, 'Alpha site'); await liveSite(env, b.orgId, 2, 'Bravo secret site');

  assert.equal((await call(env, 'GET', `/api/organizations/${a.orgId}/site-setup/options`)).status, 401);

  const r = await call(env, 'GET', `/api/organizations/${a.orgId}/site-setup/options`, { cookie: a.cookie });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.data.presets.length >= 2);
  for (const p of r.json.data.presets) assert.deepEqual(Object.keys(p).sort(), ['id', 'label']);
  assert.equal(r.json.data.default.presetId, 'full');
  assert.deepEqual(r.json.data.cloneSources.map((c) => c.name), ['Alpha site']);
  assert.ok(!r.text.includes('Bravo secret site'), 'another organization\'s site never appears');
  assert.ok(!/tenant|api_base_url|t-1|t1\.example/.test(JSON.stringify(r.json.data.cloneSources)), 'no tenant details in the picker');
});

test('A1 options route: another organization\'s id is refused for a non-member; a bad productId is 422', async () => {
  const env = makeEnv();
  const a = await customer(env, 'o-a2@example.com'); const b = await customer(env, 'o-b2@example.com');
  await liveSite(env, a.orgId, 3, 'Only mine');
  const cross = await call(env, 'GET', `/api/organizations/${a.orgId}/site-setup/options`, { cookie: b.cookie });
  assert.ok([401, 403, 404].includes(cross.status), `got ${cross.status}`);
  assert.ok(!cross.text.includes('Only mine'));
  const bad = await call(env, 'GET', `/api/organizations/${a.orgId}/site-setup/options?productId=${encodeURIComponent("x'; DROP TABLE sites;--")}`, { cookie: a.cookie });
  assert.equal(bad.status, 422); assert.equal(bad.json.error, 'invalid_product');
  const ok = await call(env, 'GET', `/api/organizations/${a.orgId}/site-setup/options?productId=prod_casino_news`, { cookie: a.cookie });
  assert.equal(ok.status, 200);
});

test('A1 options route: a plan or product default changes the resolved default (read only; the route never writes)', async () => {
  const env = makeEnv();
  const a = await customer(env, 'o-a3@example.com');
  await run(env, `INSERT INTO site_preset_defaults (scope_kind, scope_id, preset_id) VALUES ('product', 'prod_casino_news', 'news')`);
  const before = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM site_setup_requests`).first()).n;
  const r = await call(env, 'GET', `/api/organizations/${a.orgId}/site-setup/options?productId=prod_casino_news`, { cookie: a.cookie });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.data.default.presetId, 'news');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM site_setup_requests`).first()).n, before);
});

// ---------- A2/A3: /app/sites ----------

test('/app/sites: shows the preset select with the default label, the copy select, and the Setup column per site', async () => {
  const env = makeEnv();
  const a = await customer(env, 'p-a@example.com');
  const id = await liveSite(env, a.orgId, 4, 'Mine one'); await setReq(env, id, 'pending');
  const page = await call(env, 'GET', '/app/sites', { cookie: a.cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /<th>Setup<\/th>/);
  assert.match(page.text, /id="site-preset"/);
  assert.match(page.text, /Recommended for you: /);
  assert.match(page.text, /id="site-clone"/);
  assert.match(page.text, /Or copy from my site/);
  assert.match(page.text, /Waiting to apply:/);
});

test('/app/sites: names are escaped (site name, copy source name); no raw tag survives', async () => {
  const env = makeEnv();
  const a = await customer(env, 'p-a2@example.com');
  await liveSite(env, a.orgId, 5, '<img src=x onerror=alert(1)>"quoted"');
  const page = await call(env, 'GET', '/app/sites', { cookie: a.cookie });
  assert.equal(page.status, 200);
  assert.ok(!page.text.includes('<img src=x onerror=alert(1)>'));
  assert.match(page.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page.text, /&quot;quoted&quot;/);
});

test('/app/sites: another organization\'s site and setup are never shown', async () => {
  const env = makeEnv();
  const a = await customer(env, 'p-a3@example.com'); const b = await customer(env, 'p-b3@example.com');
  await liveSite(env, a.orgId, 6, 'Visible A');
  const other = await liveSite(env, b.orgId, 7, 'Hidden B'); await setReq(env, other, 'failed', 'source_unavailable', 2);
  const page = await call(env, 'GET', '/app/sites', { cookie: a.cookie });
  assert.match(page.text, /Visible A/);
  assert.ok(!page.text.includes('Hidden B'));
  assert.ok(!page.text.includes('source_unavailable'));
  assert.ok(!page.text.includes(other), 'no row id of the other site');
});

test('/app/sites: a switched-off request reads "Skipped: switched off" with no Retry; a failed one on an active site gets Retry for the owner', async () => {
  const env = makeEnv();
  const a = await customer(env, 'p-a4@example.com');
  const off = await liveSite(env, a.orgId, 8, 'Off site'); await setReq(env, off, 'skipped', 'config_system_off');
  const failed = await liveSite(env, a.orgId, 9, 'Failed site'); await setReq(env, failed, 'failed', 'unavailable', 1);
  const page = await call(env, 'GET', '/app/sites', { cookie: a.cookie });
  assert.match(page.text, /Skipped: switched off/);
  assert.ok(!page.text.includes('config_system_off'), 'the code is never shown');
  const offRow = page.text.slice(page.text.indexOf('id="' + off + '"'), page.text.indexOf('</tr>', page.text.indexOf('id="' + off + '"')));
  assert.ok(!offRow.includes('Retry'));
  const failedRow = page.text.slice(page.text.indexOf('id="' + failed + '"'), page.text.indexOf('</tr>', page.text.indexOf('id="' + failed + '"')));
  assert.match(failedRow, /Could not apply yet, will retry/);
  assert.match(failedRow, /data-on[a-z]*=/);
  assert.match(failedRow, /lummetRetrySetup/);
});

// ---------- view-level: describeSetup and Retry only for managers ----------

test('describeSetup: every status in plain words; Retry only when the site is live and the request can still run', () => {
  assert.deepEqual(describeSetup(null, 'active'), { text: '—', retry: false });
  assert.deepEqual(describeSetup({ status: 'none' }, 'active'), { text: '—', retry: false });
  assert.deepEqual(describeSetup({ status: 'applied', kind: 'preset', presetLabel: 'News site' }, 'active'), { text: 'Applied: News site', retry: false });
  assert.deepEqual(describeSetup({ status: 'applied', kind: 'clone' }, 'active'), { text: 'Applied: copy of your site', retry: false });
  assert.equal(describeSetup({ status: 'pending', presetLabel: 'X' }, 'active').retry, true);
  assert.equal(describeSetup({ status: 'pending', presetLabel: 'X' }, 'pending').retry, false, 'not live yet: nothing to retry');
  assert.match(describeSetup({ status: 'pending', presetLabel: 'X' }, 'pending').text, /^Starts after the first deploy/);
  assert.match(describeSetup({ status: 'failed', attempts: 2, presetLabel: 'X' }, 'active').text, /^Could not apply yet, will retry/);
  assert.match(describeSetup({ status: 'failed', attempts: 6, presetLabel: 'X' }, 'active').text, /^Needs a retry/);
  assert.equal(describeSetup({ status: 'failed', attempts: 6, presetLabel: 'X' }, 'failed').retry, false);
  assert.deepEqual(describeSetup({ status: 'skipped', lastError: 'config_system_off' }, 'active'), { text: 'Skipped: switched off', retry: false });
  assert.deepEqual(describeSetup({ status: 'skipped', lastError: 'superseded' }, 'active'), { text: 'Replaced by a newer choice', retry: false });
  assert.equal(describeSetup({ status: 'skipped', lastError: 'already_configured' }, 'active').text, 'Skipped: this site was already set up');
  assert.deepEqual(describeSetup({ status: 'weird' }, 'active'), { text: '—', retry: false });
  for (const s of ['applied', 'pending', 'failed', 'skipped']) assert.ok(!/config_system_off|setup_not_pending|_/.test(describeSetup({ status: s, lastError: 'x', presetLabel: 'P' }, 'active').text.replace('Skipped: this site was already set up', '')));
});

test('renderSitesPage: Retry button only when canManage; still works with no setup arguments; a prototype-named site id is not a view', () => {
  const sites = [{ id: 's1', name: 'One', product_name: 'P', status: 'active', primary_domain: null, app_version: '1' }];
  const views = { s1: { status: 'failed', attempts: 1, presetLabel: 'News' } };
  assert.match(renderSitesPage({ sites, products: [], canManage: true, setupViews: views }), />Retry<\/button>/);
  assert.ok(!renderSitesPage({ sites, products: [], canManage: false, setupViews: views }).includes('>Retry</button>'));
  const bare = renderSitesPage({ sites, products: [], canManage: true });
  assert.match(bare, /<th>Setup<\/th>/); assert.ok(!bare.includes('id="site-preset"'), 'no options, plain create form');
  const proto = renderSitesPage({ sites: [{ ...sites[0], id: 'constructor' }], products: [], canManage: true, setupViews: {} });
  assert.ok(!proto.includes('>Retry</button>'));
});
