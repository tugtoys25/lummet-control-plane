// Default announcement seed for new tenants, "Powered by Lummet" brand listing for live sites, dashboard brand band and
// dynamic sidebar brand. Touches only: tenant-defaults.js, deployments.js (first-deploy seed), site-brands.js, sites.js hook,
// brand-band.js, site-chrome.js markers, both dashboard layouts, public nav CSS/JS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import * as template from '../worker/tenant-template.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import { defaultAnnouncementSql, newTenantSeedMigrations, DEFAULT_ANNOUNCEMENT_MIGRATION, SETUP_PENDING_MIGRATION, setupPendingSql } from '../worker/tenant-defaults.js';
import { syncSiteBrand } from '../worker/site-brands.js';
import { renderBrandBand, hueFor } from '../worker/brand-band.js';
import { injectSiteChrome, MARKERS } from '../worker/site-chrome.js';
import { renderCustomerShell } from '../worker/views/customer-layout.js';
import { createAssets } from './support/public-env.js';

function fakeR2() { const m = new Map(); return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; } }; }
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ASSETS: createAssets(), CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ...extra };
}
async function newSite(env, email, orgName, siteName = 'Site') {
  const signup = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: orgName }; }, headers: { get: () => '203.0.113.20' } }, env);
  await plans.startTrialSubscription(env, signup.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: signup.organizationId, name: siteName, productId: 'prod_casino_news', actorUserId: signup.userId });
  return { orgId: signup.organizationId, siteId: site.siteId, slug: site.slug };
}
async function goLive(env, siteId, infra = createFakeInfraProvider()) {
  const deploymentService = createDeploymentService(infra);
  const provisioning = createProvisioningService(infra, { deploymentService, templateService: template });
  const run = await provisioning.runJob(env, (await provisioning.startProvisioning(env, siteId)).jobId);
  assert.equal(run.ok, true, JSON.stringify(run));
  return { infra, deploymentService, provisioning };
}

test('default announcement SQL matches the requested seed exactly', () => {
  const sql = defaultAnnouncementSql();
  assert.match(sql, /^INSERT OR REPLACE INTO settings \(key, value\) VALUES/);
  for (const row of [
    "('site_announce_enabled','true')",
    "('site_announce_text','Launch your own affiliate business with Lummet.com, ready in 5 minutes.')",
    "('site_announce_link_text','Start with Lummet')",
    "('site_announce_url','https://lummet.com')",
    "('site_announce_tone','promo')",
    "('site_announce_dismissible','true')"
  ]) assert.ok(sql.includes(row), row);
  assert.equal(newTenantSeedMigrations()[0].name, DEFAULT_ANNOUNCEMENT_MIGRATION);
  // Phase 9: the second first-deploy seed puts a new tenant in the setup wizard.
  assert.deepEqual(newTenantSeedMigrations().map((m) => m.name), [DEFAULT_ANNOUNCEMENT_MIGRATION, 'provision_0002_site_setup_pending']);
  assert.equal(SETUP_PENDING_MIGRATION, 'provision_0002_site_setup_pending');
  const pending = setupPendingSql();
  assert.match(pending, /^INSERT OR REPLACE INTO settings \(key, value\) VALUES/);
  assert.ok(pending.includes("('site_setup_state','pending')") && pending.includes("('site_setup_source','new')"));
});

test('a new tenant gets the seed on its first deploy, after the release migrations, and never again on a redeploy', async () => {
  const env = makeEnv({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'v1', migrations: [{ name: '0001_x.sql', sql: 'CREATE TABLE x (id INTEGER);' }] });
  const { siteId } = await newSite(env, 'seed1@example.com', 'Seed Org');
  const { infra, deploymentService } = await goLive(env, siteId);
  const queries = infra._calls.filter((c) => c.method === 'runD1Query').map((c) => c.sql);
  assert.match(queries[0], /CREATE TABLE x/, 'release migrations first');
  const seedAt = queries.findIndex((q) => /site_announce_enabled/.test(q));
  assert.ok(seedAt > 0, 'seed runs after the release migrations');
  assert.match(queries[seedAt], /INSERT OR REPLACE INTO settings/);
  assert.equal((await sites.getSite(env, siteId)).status, 'active');

  const before = infra._calls.length;
  const again = await deploymentService.startDeployment(env, { siteId, version: '1.0.1', migrations: [], scriptContent: 'v1b', actorType: 'system' });
  assert.equal(again.ok, true, JSON.stringify(again));
  await deploymentService.runJob(env, again.jobId);
  assert.equal(infra._calls.slice(before).filter((c) => c.method === 'runD1Query' && /site_announce/.test(c.sql)).length, 0, 'a redeploy must not re-seed (would overwrite customer edits)');
});

test('site brand: going live creates an UNPUBLISHED brand; only a brand an admin published is taken offline on suspension and restored on reactivation', async () => {
  const env = makeEnv({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(env, { version: '1.0.0', scriptContent: 'v1', migrations: [] });
  const { siteId, slug } = await newSite(env, 'brand1@example.com', 'Brand Org', 'Acme Affiliates');
  const get = () => env.LUMMET_DB.prepare('SELECT * FROM lummet_brands WHERE site_id = ?').bind(siteId).first();
  assert.equal(await get(), null, 'not listed before it is live');
  await goLive(env, siteId);
  let b = await get();
  assert.equal(b.status, 'draft', 'new live sites start unpublished: the admin decides');
  assert.equal(b.auto_hidden, 0);
  assert.equal(b.name, 'Acme Affiliates');
  assert.equal(b.slug, slug);
  assert.equal(b.source, 'site');
  assert.equal(b.category, 'Powered by Lummet');
  assert.ok(b.tenant_id);

  // Suspending and reactivating never publishes a draft.
  await sites.transitionSiteStatus(env, siteId, 'suspended', { reason: 't', actorType: 'system' });
  b = await get(); assert.equal(b.status, 'draft'); assert.equal(b.auto_hidden, 0);
  await sites.transitionSiteStatus(env, siteId, 'active', { reason: 't', actorType: 'system' });
  b = await get(); assert.equal(b.status, 'draft'); assert.equal(b.auto_hidden, 0);

  // The admin publishes it; now suspension takes it offline and reactivation restores it.
  await env.LUMMET_DB.prepare(`UPDATE lummet_brands SET status = 'published' WHERE site_id = ?`).bind(siteId).run();
  await sites.transitionSiteStatus(env, siteId, 'suspended', { reason: 't', actorType: 'system' });
  b = await get(); assert.equal(b.status, 'draft'); assert.equal(b.auto_hidden, 1);
  await sites.transitionSiteStatus(env, siteId, 'active', { reason: 't', actorType: 'system' });
  b = await get(); assert.equal(b.status, 'published'); assert.equal(b.auto_hidden, 0);
});

test('site brand: staff who unpublished a brand on purpose are not overridden; white-label orgs are never listed; slug clashes get a suffix', async () => {
  const env = makeEnv();
  const a = await newSite(env, 'brand2@example.com', 'Org A', 'Alpha');
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(a.siteId).run();
  assert.equal((await syncSiteBrand(env, a.siteId)).action, 'created');
  await env.LUMMET_DB.prepare(`UPDATE lummet_brands SET status = 'draft' WHERE site_id = ?`).bind(a.siteId).run(); // staff, auto_hidden stays 0
  assert.equal((await syncSiteBrand(env, a.siteId)).action, 'none');
  assert.equal((await env.LUMMET_DB.prepare(`SELECT status FROM lummet_brands WHERE site_id = ?`).bind(a.siteId).first()).status, 'draft');

  const w = await newSite(env, 'brand3@example.com', 'Org W', 'Whitelabel');
  await env.LUMMET_DB.prepare(`INSERT INTO organization_branding (organization_id, hide_lummet_branding) VALUES (?, 1)`).bind(w.orgId).run();
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(w.siteId).run();
  assert.equal((await syncSiteBrand(env, w.siteId)).action, 'none');

  const c = await newSite(env, 'brand4@example.com', 'Org C', 'Clash');
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(c.siteId).run();
  await env.LUMMET_DB.prepare(`INSERT INTO lummet_brands (name, slug, status) VALUES ('Manual', ?, 'published')`).bind(c.slug).run();
  const r = await syncSiteBrand(env, c.siteId);
  assert.equal(r.action, 'created');
  assert.notEqual(r.slug, c.slug);
  assert.match(r.slug, new RegExp(`^${c.slug}-`));
});

test('brand band: manage mode links to the editor and shows offline brands; view mode links to the public page; fails soft', () => {
  const rows = [
    { id: 7, name: 'Acme <b>', slug: 'acme', category: 'Powered by Lummet', status: 'published', website_url: 'https://acme.example', logo_url: '' },
    { id: 8, name: 'Gone', slug: 'gone', status: 'draft', website_url: 'javascript:alert(1)' }
  ];
  const staff = renderBrandBand(rows, { manage: true, canAdd: true });
  assert.match(staff, /href="\/cms\/brands\/7\/edit"/);
  assert.match(staff, /href="\/cms\/brands\/new"/);
  assert.match(staff, /href="\/cms\/brands">Manage/);
  assert.match(staff, /is-off/);
  assert.match(staff, /Acme &lt;b&gt;/);
  assert.doesNotMatch(staff, /javascript:/);
  const customer = renderBrandBand(rows.slice(0, 1), { manage: false });
  assert.match(customer, /href="\/brands\/acme"/);
  assert.doesNotMatch(customer, /\/cms\//);
  assert.equal(renderBrandBand([], { manage: false }), '');
  assert.match(renderBrandBand([], { manage: true, canAdd: true }), /No brands yet/);
  assert.equal(hueFor('acme'), hueFor('acme'));
});

test('dashboard sidebar shows the public site logo/name via marker; brand band marker is filled for customers', async () => {
  const env = makeEnv();
  await env.LUMMET_DB.prepare(`INSERT OR REPLACE INTO lummet_settings (key, value) VALUES ('site_name', 'Acme Hub')`).run().catch(() => {});
  await env.LUMMET_DB.prepare(`INSERT INTO lummet_brands (name, slug, status, source) VALUES ('Live Brand', 'live-brand', 'published', 'site')`).run();
  const shell = renderCustomerShell({ title: 'Overview', activeKey: 'overview', customer: { email: 'a@b.co' }, organizations: [], bodyHtml: '<p>x</p>' });
  assert.ok(shell.includes(MARKERS.brand) && shell.includes(MARKERS.brandBand));
  assert.doesNotMatch(shell, /class="dot"/);
  const other = renderCustomerShell({ title: 'Sites', activeKey: 'sites', customer: { email: 'a@b.co' }, organizations: [], bodyHtml: '' });
  assert.ok(!other.includes(MARKERS.brandBand), 'band only on the overview page');
  const out = await injectSiteChrome(shell, env, new URL('https://cp.example.test/app/overview'));
  assert.doesNotMatch(out, /<!--lummet:site-(brand|name)-->|<!--lummet:brand-band-->/);
  assert.match(out, /class="brand-icon/);
  assert.match(out, /class="brand-label"/);
  assert.match(out, /href="\/brands\/live-brand"/);
});

test('public nav: original markup and nav.js untouched; the menu scrolls smoothly and clears the bottom edge with CSS only', () => {
  const css = readFileSync(new URL('../public/static/css/base.css', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../public/static/js/nav.js', import.meta.url), 'utf8');
  assert.match(css, /\.mobile-menu \{[^}]*overscroll-behavior: contain/);
  assert.match(css, /100dvh/);
  assert.match(css, /\.mobile-menu nav \{ padding-bottom: calc\(var\(--space-6\) \+ env\(safe-area-inset-bottom/);
  assert.doesNotMatch(css, /menu-open/);
  assert.doesNotMatch(js, /menu-open/);
});
