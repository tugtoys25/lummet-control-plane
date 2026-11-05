// Integrated extras: editable accent colour + show-in-strip, collision-proof slugs, one auto listing per tenant,
// and the new-tenant announcement seed applied to the real tenant schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { renderBrandBand, loadBrandBand, accentOf, hueOfHex } from '../worker/brand-band.js';
import { syncSiteBrand, brandSlugFor } from '../worker/site-brands.js';
import { CMS_RESOURCES } from '../worker/cms-resources.js';
import { defaultAnnouncementSql, DEFAULT_SITE_ANNOUNCEMENT, setupPendingSql } from '../worker/tenant-defaults.js';

const env = () => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db }; };

test('accent colour: valid #RRGGBB is used (and its hue), anything else is ignored', () => {
  assert.equal(accentOf({ accent_color: ' #FF0066 ' }), '#ff0066');
  assert.equal(accentOf({ accent_color: 'red; background:url(x)' }), '');
  assert.equal(accentOf({}), '');
  assert.equal(hueOfHex('#ff0000'), 0);
  assert.equal(hueOfHex('#00ff00'), 120);
  assert.equal(hueOfHex('#0000ff'), 240);
  const html = renderBrandBand([{ id: 1, name: 'A', slug: 'a', status: 'published', accent_color: '#ff0066' }, { id: 2, name: 'B', slug: 'b', status: 'published', accent_color: 'x"onmouseover=' }], { manage: true });
  assert.match(html, /--c:#ff0066/);
  assert.equal((html.match(/--c:/g) || []).length, 1);
});

test('show_in_strip: customers never see switched-off brands, staff see them marked Hidden', async () => {
  const e = env();
  await e.LUMMET_DB.prepare(`INSERT INTO lummet_brands (name, slug, status, show_in_strip, accent_color) VALUES ('Quiet', 'quiet', 'published', 0, '#0e7490'), ('Loud', 'loud', 'published', 1, NULL)`).run();
  const customer = await loadBrandBand(e, { includeDrafts: false });
  assert.ok(!customer.some((b) => b.slug === 'quiet') && customer.some((b) => b.slug === 'loud'));
  const staff = await loadBrandBand(e, { includeDrafts: true });
  const q = staff.find((b) => b.slug === 'quiet');
  assert.ok(q);
  assert.match(renderBrandBand([q], { manage: true }), /Hidden/);
  assert.doesNotMatch(renderBrandBand([{ ...q, show_in_strip: 1 }], { manage: true }), />Hidden</);
  assert.ok(CMS_RESOURCES.brands.fields.some((f) => f.name === 'show_in_strip'));
  assert.ok(CMS_RESOURCES.brands.fields.some((f) => f.name === 'accent_color'));
});

test('band tolerates a database without the accent/strip columns', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE lummet_brands (id INTEGER PRIMARY KEY, name TEXT, slug TEXT, status TEXT, sort_order INTEGER, category TEXT, tagline TEXT, logo_url TEXT, website_url TEXT, source TEXT);
           INSERT INTO lummet_brands (name, slug, status, sort_order) VALUES ('Old', 'old', 'published', 1);`);
  const shim = { prepare: (sql) => ({ all: async () => ({ results: db.prepare(sql).all() }) }) };
  assert.equal((await loadBrandBand({ LUMMET_DB: shim }, {})).length, 1);
});

test('slugs: accents folded, capped, and a taken suffixed slug never silently skips the listing', async () => {
  assert.equal(brandSlugFor({ slug: 'Ácme  News!!' }), 'acme-news');
  assert.equal(brandSlugFor({ slug: 'x'.repeat(90) }).length, 60);
  assert.equal(brandSlugFor({ slug: '###' }), 'site');
  const e = env();
  const db = e.LUMMET_DB;
  await db.prepare(`INSERT INTO lummet_brands (name, slug, status) VALUES ('M1', 'clash', 'published'), ('M2', 'clash-abcdef', 'published')`).run();
  const site = { id: 'abcdef1', slug: 'clash', name: 'Clash', tenant_id: null, organization_id: 'o1', primary_domain: 'c1.example.com', status: 'active' };
  // Exercise the slug picker through the public API with a synthetic site row.
  const fake = { LUMMET_DB: { prepare: (sql) => {
    if (/FROM sites WHERE id/.test(sql)) return { bind: () => ({ first: async () => site }) };
    if (/organization_branding/.test(sql)) return { bind: () => ({ first: async () => null }) };
    return db.prepare(sql);
  } } };
  const r = await syncSiteBrand(fake, 'abcdef1');
  assert.equal(r.action, 'created');
  assert.match(r.slug, /^clash-abcdef-2$/);
});

test('unique tenant index (migration 0082): a second automatic listing for the same tenant is refused', async () => {
  const db = createTestDb(); applyMigrations(db);
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t1', 't', 't.example', 'https://t.example')`).run();
  await db.prepare(`INSERT INTO lummet_brands (tenant_id, name, slug, status, source) VALUES ('t1', 'A', 'a', 'published', 'site')`).run();
  await assert.rejects(db.prepare(`INSERT INTO lummet_brands (tenant_id, name, slug, status, source) VALUES ('t1', 'B', 'b', 'published', 'site')`).run(), /UNIQUE/);
  await db.prepare(`INSERT INTO lummet_brands (tenant_id, name, slug, status, source) VALUES ('t1', 'Manual', 'm', 'published', 'manual')`).run();
});

// The seed the platform applies on a tenant's first deploy must run on the real tenant schema and use keys the tenant manages.
const TENANT = new URL('../../lummet-tenant/en/', import.meta.url);
test('new-tenant announcement seed applies to the tenant schema with the keys its Header & Hero page manages', { skip: !existsSync(new URL('migrations/', TENANT)) }, () => {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('migrations/', TENANT)).sort()) db.exec(readFileSync(new URL(`migrations/${f}`, TENANT), 'utf8'));
  db.exec(defaultAnnouncementSql());
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  assert.equal(get('site_announce_enabled'), 'true');
  assert.equal(get('site_announce_url'), 'https://lummet.com');
  assert.equal(get('site_announce_tone'), 'promo');
  assert.ok(get('site_announce_text').length <= 160);
  const schema = readFileSync(new URL('worker/header-hero/schema.js', TENANT), 'utf8');
  for (const [key] of DEFAULT_SITE_ANNOUNCEMENT) assert.ok(schema.includes(`"${key}"`), `${key} is a managed header-hero key`);
});

// Phase 9: on the real tenant schema the tenant's own migration 0013 marks a database's setup as complete (right for sites already in use);
// the second first-deploy seed must run AFTER it and put a NEW tenant back in the wizard.
test('setup-pending seed turns a freshly migrated tenant into a site that starts the setup wizard', { skip: !existsSync(new URL('migrations/', TENANT)) }, () => {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(new URL('migrations/', TENANT)).sort()) db.exec(readFileSync(new URL(`migrations/${f}`, TENANT), 'utf8'));
  const get = (k) => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value;
  if (get('site_setup_state') === undefined) return; // tenant without Phase 9 migration 0013: nothing to put back
  assert.equal(get('site_setup_state'), 'complete', 'a database that is only migrated counts as set up');
  db.exec(setupPendingSql());
  assert.equal(get('site_setup_state'), 'pending');
  assert.equal(get('site_setup_source'), 'new');
});
