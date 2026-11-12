// test/aftermarket-images.test.js — website link, image upload/gallery, delete and CRUD for domains and business listings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, get } from './support/public-env.js';
import { handleApi } from '../worker/aftermarket-portal.js';
import { hostedGate } from '../worker/aftermarket-host.js';
import { __setAftermarketProvidersForTests } from '../worker/aftermarket-zones.js';

const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const png = (w, h, { truncated = false } = {}) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...(truncated ? [] : [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82])]);
const gif = () => new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0)).concat([200, 0, 200, 0, 0, 0, 0, 0x3b]));
function fakeR2() {
  const m = new Map();
  return { m, async put(k, v, o) { m.set(k, { body: v, o }); }, async get(k) { const e = m.get(k); return e ? { body: e.body, httpMetadata: e.o?.httpMetadata } : null; }, async head(k) { const e = m.get(k); return e ? { size: e.body.length } : null; }, async delete(k) { m.delete(k); } };
}
const mkEnv = (extra = {}) => { const env = createPublicEnv(); env.PLATFORM_MEDIA = fakeR2(); Object.assign(env, extra); return env; };
const guardAll = async () => null;
const customer = { id: 'u1', email: 'seller@example.test' };
async function api(env, org, method, subPath, body) {
  const init = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  const res = await handleApi({ env, request: new Request('https://cp.test/x', init), method, path: `/api/organizations/${org}${subPath}`, organizationId: org, customer, requireOrgRole: guardAll, audit: async () => {} });
  return { status: res.status, json: await res.json() };
}
const upload = (bytes, name = 'shot.png', caption = '') => { const f = new FormData(); f.append('file', new File([bytes], name, { type: 'image/png' })); f.append('caption', caption); return f; };
const listing = async (env, org = 'orgA', extra = {}) => { const r = await api(env, org, 'POST', '/aftermarket/listings', { title: 'Image Shop', category_slug: 'websites', summary: 'S', ...extra }); return r.json; };
const publish = (env, id) => env.db.prepare(`UPDATE lummet_listings SET status='listed', notified_status='listed' WHERE id=?`).bind(id).run();
const html = async (env, path) => (await get(handlePublicRoute, env, path)).text();

test('business website: shown under the location as a safe, clickable link; bad addresses are refused', async () => {
  const env = mkEnv();
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/listings', { title: 'Bad Site', category_slug: 'websites', website_url: 'javascript:alert(1)' })).json.error, 'invalid_website');
  assert.equal((await api(env, 'orgA', 'POST', '/aftermarket/listings', { title: 'Bad Site', category_slug: 'websites', website_url: 'http://plain.test' })).json.error, 'invalid_website');
  const { id, slug } = await listing(env, 'orgA', { location: 'Kigali', website_url: 'www.example-shop.com/store' });
  await publish(env, id);
  const page = await html(env, `/aftermarket/listings/${slug}`);
  assert.match(page, /<a href="https:\/\/www\.example-shop\.com\/store" target="_blank" rel="noopener nofollow ugc">example-shop\.com\/store<\/a>/);
  assert.ok(page.indexOf('Kigali') < page.indexOf('example-shop.com/store'), 'the website comes after the location');
  // an admin-typed unsafe value is never rendered as a link
  await env.db.prepare(`UPDATE lummet_listings SET website_url='javascript:alert(1)' WHERE id=?`).bind(id).run();
  assert.doesNotMatch(await html(env, `/aftermarket/listings/${slug}`), /javascript:alert/);
});

test('business images: validated by content, capped at ten, cover first, shown as a gallery, thumbnail in the list', async () => {
  const env = mkEnv();
  const { id, slug } = await listing(env);
  await publish(env, id);
  const base = `/aftermarket/listings/${id}/images`;
  assert.equal((await api(env, 'orgA', 'POST', base, upload(gif(), 'a.gif'))).json.error, 'unsupported_file_type');
  assert.equal((await api(env, 'orgA', 'POST', base, upload(new TextEncoder().encode('<svg onload=alert(1)/>'), 'a.png'))).json.error, 'not_an_image');
  assert.equal((await api(env, 'orgA', 'POST', base, upload(png(50, 50), 'tiny.png'))).json.error, 'image_dimensions');
  assert.equal((await api(env, 'orgA', 'POST', base, upload(png(400, 300, { truncated: true }), 'cut.png'))).json.error, 'not_an_image');
  assert.equal(env.PLATFORM_MEDIA.m.size, 0, 'nothing refused was stored');

  const first = await api(env, 'orgA', 'POST', base, upload(png(400, 300), 'one.png', 'Dashboard'));
  assert.equal(first.status, 200);
  assert.equal(first.json.image.alt, 'Dashboard');
  const second = await api(env, 'orgA', 'POST', base, upload(png(640, 480), 'two.png', 'Checkout'));
  // adding an image to a listed listing sends it back for approval
  assert.equal((await env.db.prepare('SELECT status FROM lummet_listings WHERE id=?').bind(id).first()).status, 'pending');
  await publish(env, id);

  let page = await html(env, `/aftermarket/listings/${slug}`);
  assert.match(page, /class="listing-cover"[\s\S]*alt="Dashboard"/);
  assert.match(page, /class="listing-gallery"[\s\S]*alt="Checkout"/);
  assert.match(await html(env, '/aftermarket/businesses'), /class="listing-thumb" src="\/brand-media\/market\//);

  assert.equal((await api(env, 'orgA', 'POST', `${base}/${second.json.id}/cover`)).status, 200);
  await publish(env, id);
  page = await html(env, `/aftermarket/listings/${slug}`);
  assert.match(page, /class="listing-cover"[\s\S]*alt="Checkout"/);

  for (let i = 3; i <= 10; i += 1) assert.equal((await api(env, 'orgA', 'POST', base, upload(png(300 + i, 300), `n${i}.png`))).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', base, upload(png(999, 300), 'eleven.png'))).json.error, 'too_many_images');
  assert.equal((await api(env, 'orgA', 'GET', `/aftermarket/listings/${id}`)).json.images.length, 10);
});

test('image files are served and removed with their last use; other organizations cannot touch them', async () => {
  const env = mkEnv();
  const a = await listing(env, 'orgA');
  const b = await listing(env, 'orgB', { title: 'Other Shop' });
  const bytes = png(500, 400);
  const ia = (await api(env, 'orgA', 'POST', `/aftermarket/listings/${a.id}/images`, upload(bytes))).json;
  const ib = (await api(env, 'orgB', 'POST', `/aftermarket/listings/${b.id}/images`, upload(bytes))).json;   // identical file: stored once
  assert.equal(env.PLATFORM_MEDIA.m.size, 1);
  assert.equal((await api(env, 'orgB', 'DELETE', `/aftermarket/listings/${a.id}/images/${ia.id}`)).status, 404);
  assert.equal((await api(env, 'orgB', 'POST', `/aftermarket/listings/${a.id}/images`, upload(png(321, 321)))).status, 404);
  assert.equal((await api(env, 'orgA', 'DELETE', `/aftermarket/listings/${a.id}/images/${ia.id}`)).status, 200);
  assert.equal(env.PLATFORM_MEDIA.m.size, 1, 'still used by the other listing');
  assert.equal((await api(env, 'orgB', 'DELETE', `/aftermarket/listings/${b.id}/images/${ib.id}`)).status, 200);
  assert.equal(env.PLATFORM_MEDIA.m.size, 0);
});

test('a domain can have a cover image and a gallery, like a business; shown on its page and in the list', async () => {
  const env = mkEnv();
  await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'cover.app' });
  await env.db.prepare(`UPDATE lummet_aftermarket_domains SET status='listed', notified_status='listed' WHERE domain='cover.app'`).run();
  const base = '/aftermarket/domains/cover.app/images';
  const a = await api(env, 'orgA', 'POST', base, upload(png(400, 300), 'a.png', 'Brand mock-up'));
  const b = await api(env, 'orgA', 'POST', base, upload(png(420, 300), 'b.png', 'Business card'));
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal(env.PLATFORM_MEDIA.m.size, 2);
  assert.equal((await api(env, 'orgA', 'GET', '/aftermarket/domains/cover.app')).json.images.length, 2);
  let page = await html(env, '/aftermarket/domains/cover.app');
  assert.match(page, /class="listing-cover"[\s\S]*alt="Brand mock-up"/);
  assert.match(page, /class="listing-gallery"[\s\S]*alt="Business card"/);
  assert.match(await html(env, '/aftermarket/list-of-domains'), /class="listing-thumb"/);
  assert.equal((await api(env, 'orgA', 'POST', `${base}/${b.json.id}/cover`)).status, 200);
  assert.match(await html(env, '/aftermarket/domains/cover.app'), /class="listing-cover"[\s\S]*alt="Business card"/);
  for (let i = 3; i <= 10; i += 1) assert.equal((await api(env, 'orgA', 'POST', base, upload(png(300 + i, 300), `n${i}.png`))).status, 200);
  assert.equal((await api(env, 'orgA', 'POST', base, upload(png(999, 300), 'eleven.png'))).json.error, 'too_many_images');
  assert.equal((await api(env, 'orgB', 'POST', base, upload(png(333, 333), 'x.png'))).status, 404);
  // staff can hide an image without deleting it
  await env.db.prepare(`UPDATE lummet_listing_images SET status='hidden'`).run();
  assert.doesNotMatch(await html(env, '/aftermarket/domains/cover.app'), /listing-cover|listing-gallery/);
});

test('uploads fail closed without media storage', async () => {
  const env = mkEnv();
  delete env.PLATFORM_MEDIA;
  const { id } = await listing(env);
  const r = await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}/images`, upload(png(400, 300)));
  assert.deepEqual([r.status, r.json.error], [503, 'media_storage_not_configured']);
});

test('delete: a domain (zone released, images removed) and a listing; a provider failure keeps the domain', async () => {
  const env = mkEnv();
  await api(env, 'orgA', 'POST', '/aftermarket/domains', { domain: 'gone.app' });
  await env.db.prepare(`UPDATE lummet_aftermarket_domains SET status='listed', verified_method='ns', cf_zone_id='z9' WHERE domain='gone.app'`).run();
  await api(env, 'orgA', 'POST', '/aftermarket/domains/gone.app/images', upload(png(400, 300)));
  assert.equal((await api(env, 'orgB', 'DELETE', '/aftermarket/domains/gone.app')).status, 404);

  __setAftermarketProvidersForTests({ infra: { deleteZone: async () => { throw new Error('boom'); } } });
  try {
    assert.deepEqual((await api(env, 'orgA', 'DELETE', '/aftermarket/domains/gone.app')).json.error, 'provider_error');
    assert.ok(await env.db.prepare(`SELECT id FROM lummet_aftermarket_domains WHERE domain='gone.app'`).first());
  } finally { __setAftermarketProvidersForTests(); }
  const deleted = [];
  __setAftermarketProvidersForTests({ infra: { deleteZone: async (_e, z) => { deleted.push(z); } } });
  try {
    assert.equal((await api(env, 'orgA', 'DELETE', '/aftermarket/domains/gone.app')).status, 200);
  } finally { __setAftermarketProvidersForTests(); }
  assert.deepEqual(deleted, ['z9']);
  assert.equal(await env.db.prepare(`SELECT id FROM lummet_aftermarket_domains WHERE domain='gone.app'`).first(), null);
  assert.equal((await env.db.prepare('SELECT COUNT(*) AS n FROM lummet_listing_images').first()).n, 0);
  assert.equal(env.PLATFORM_MEDIA.m.size, 0);

  const { id, slug } = await listing(env);
  await api(env, 'orgA', 'POST', `/aftermarket/listings/${id}/images`, upload(png(410, 300)));
  assert.equal((await api(env, 'orgB', 'DELETE', `/aftermarket/listings/${id}`)).status, 404);
  assert.equal((await api(env, 'orgA', 'DELETE', `/aftermarket/listings/${id}`)).status, 200);
  assert.equal((await get(handlePublicRoute, env, `/aftermarket/listings/${slug}`)).status, 404);
  assert.equal(env.PLATFORM_MEDIA.m.size, 0);
});

test('a hosted domain still serves the image files of its for-sale page', async () => {
  const env = mkEnv({ PORTAL_BASE_URL: 'https://portal.lummet.test' });
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source, hosted) VALUES ('shown.app','listed','seller',1)`).run();
  const res = await hostedGate(new Request('https://shown.app/brand-media/market/1-0123456789abcdef.png'), env);
  assert.ok(res && !res.response, 'passes through to the media route instead of being redirected');
  assert.equal((await hostedGate(new Request('https://shown.app/app/overview'), env)).response.status, 301);
});
