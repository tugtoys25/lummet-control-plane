// test/aftermarket-admin-images.test.js — staff create listings (with website) and manage their images from the admin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { authenticateAdmin } from '../worker/auth.js';
import { createAssets, get } from './support/public-env.js';

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w, h) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
function fakeR2() {
  const m = new Map();
  return { m, async put(k, v, o) { m.set(k, { body: v, o }); }, async get(k) { const e = m.get(k); return e ? { body: e.body, httpMetadata: e.o?.httpMetadata } : null; }, async head(k) { const e = m.get(k); return e ? { size: e.body.length } : null; }, async delete(k) { m.delete(k); } };
}

async function setup() {
  const db = createTestDb(); applyMigrations(db);
  await seedFixtures(db);
  const env = { LUMMET_DB: db, db, ASSETS: createAssets(), PLATFORM_MEDIA: fakeR2(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
  const r = await authenticateAdmin(env, 'superAdmin@example.com', FIXTURE_PASSWORDS.superAdmin, 'ip-1');
  const call = (method, path, { form, multipart, sid = r.sessionId } = {}) => worker.fetch(new Request(`https://lummet.test${path}`, {
    method, redirect: 'manual',
    headers: { ...(sid ? { Cookie: `lummet_session=${sid}` } : {}), ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
    body: form ? new URLSearchParams(form).toString() : multipart
  }), env, { waitUntil() {} });
  return { env, call };
}
const upload = (bytes, name, caption) => { const f = new FormData(); f.append('file', new File([bytes], name, { type: 'image/png' })); f.append('caption', caption || ''); return f; };

test('staff create a business listing with a website, add images from the edit page, and the public page shows them', async () => {
  const { env, call } = await setup();
  const created = await call('POST', '/cms/listings/new', { form: { title: 'Staff Listed Cafe', slug: 'staff-cafe', category_slug: 'local-business', status: 'listed', summary: 'Nice cafe', location: 'Kigali', website_url: 'https://cafe.example.test', sort_order: '0' } });
  assert.equal(created.status, 302);
  const row = await env.db.prepare(`SELECT id, source, website_url FROM lummet_listings WHERE slug='staff-cafe'`).first();
  assert.equal(row.website_url, 'https://cafe.example.test');

  const edit = await (await call('GET', `/cms/listings/${row.id}/edit`)).text();
  assert.match(edit, /Images and screenshots/);
  assert.match(edit, new RegExp(`/cms/market-images/listing/${row.id}`));

  const add1 = await call('POST', `/cms/market-images/listing/${row.id}`, { multipart: upload(png(400, 300), 'a.png', 'Front of the cafe') });
  assert.equal(add1.status, 302);
  assert.match(add1.headers.get('location'), /flash=Image%20added|flash=Image\+added/);
  await call('POST', `/cms/market-images/listing/${row.id}`, { multipart: upload(png(500, 300), 'b.png', 'Inside') });
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM lummet_listing_images').first()).n, 2);

  const page = await (await get(handlePublicRoute, env, '/aftermarket/listings/staff-cafe')).text();
  assert.match(page, /class="listing-cover"[\s\S]*alt="Front of the cafe"/);
  assert.match(page, /class="listing-gallery"[\s\S]*alt="Inside"/);
  assert.match(page, /href="https:\/\/cafe\.example\.test\/" target="_blank" rel="noopener nofollow ugc"/);

  const second = await env.db.prepare(`SELECT id FROM lummet_listing_images ORDER BY id DESC LIMIT 1`).first();
  await call('POST', `/cms/market-images/listing/${row.id}/${second.id}/cover`);
  assert.match(await (await get(handlePublicRoute, env, '/aftermarket/listings/staff-cafe')).text(), /class="listing-cover"[\s\S]*alt="Inside"/);
  await call('POST', `/cms/market-images/listing/${row.id}/${second.id}/delete`);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM lummet_listing_images').first()).n, 1);
  assert.equal(env.PLATFORM_MEDIA.m.size, 1);
});

test('staff can give an admin-listed domain a cover image; refused files and signed-out requests change nothing', async () => {
  const { env, call } = await setup();
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source) VALUES ('staff.app','listed','admin')`).run();
  const d = await env.db.prepare(`SELECT id FROM lummet_aftermarket_domains WHERE domain='staff.app'`).first();
  assert.match(await (await call('GET', `/cms/aftermarket_domains/${d.id}/edit`)).text(), /Cover image/);
  const bad = await call('POST', `/cms/market-images/domain/${d.id}`, { multipart: upload(new TextEncoder().encode('<svg/>'), 'x.png') });
  assert.match(bad.headers.get('location'), /flash_type=error/);
  const anon = await call('POST', `/cms/market-images/domain/${d.id}`, { multipart: upload(png(400, 300), 'ok.png'), sid: null });
  assert.ok([302, 401, 403].includes(anon.status) && !/market-images/.test(anon.headers.get('location') || ''), 'signed-out request is turned away');
  const none = await authenticateAdmin(env, 'staffNone@example.com', FIXTURE_PASSWORDS.staffNone, 'ip-2');
  const denied = await call('POST', `/cms/market-images/domain/${d.id}`, { multipart: upload(png(400, 300), 'ok.png'), sid: none.sessionId });
  assert.ok(denied.status === 403 || (denied.status === 302 && !/flash=Image/.test(denied.headers.get('location') || '')), 'a role without CMS permission is refused');
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM lummet_listing_images').first()).n, 0, 'nothing stored by a refused file or a signed-out request');
  await call('POST', `/cms/market-images/domain/${d.id}`, { multipart: upload(png(400, 300), 'ok.png', 'Mock-up') });
  assert.match(await (await get(handlePublicRoute, env, '/aftermarket/domains/staff.app')).text(), /class="listing-cover"[\s\S]*alt="Mock-up"/);
  assert.equal((await call('POST', `/cms/market-images/domain/99999`, { multipart: upload(png(400, 300), 'ok.png') })).status, 404);
});
