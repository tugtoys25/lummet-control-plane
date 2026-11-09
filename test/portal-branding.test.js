// Portal branding and the control plane's media library (release 2.8.0): image inspection, media storage, branding values,
// staff routes, public routes, and where the icons appear. Real code over an in-memory D1 and an in-memory R2.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import worker from '../worker/index.js';
import * as media from '../worker/platform-media.js';
import * as branding from '../worker/portal-branding.js';
import { inspectImage, inspectSvg, extensionMatches } from '../worker/image-inspect.js';

// ---------- fixtures: the smallest real files ----------
const enc = (s) => new TextEncoder().encode(s);
const be32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
function png(w, h, { truncated = false } = {}) {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0];
  const tail = truncated ? [] : [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  return new Uint8Array([...head, ...tail]);
}
function gif(w, h) { return new Uint8Array([...enc('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0, 0x3b]); }
function jpeg(w, h) { return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...enc('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0, 0xff, 0xd9]); }
function ico(w, h) {
  const entry = [w === 256 ? 0 : w, h === 256 ? 0 : h, 0, 0, 1, 0, 32, 0, 4, 0, 0, 0, 22, 0, 0, 0];
  return new Uint8Array([0, 0, 1, 0, 1, 0, ...entry, 1, 2, 3, 4]);
}
function webpX(w, h) {
  const b = new Uint8Array(30); b.set(enc('RIFF'), 0); b.set(enc('WEBP'), 8); b.set(enc('VP8X'), 12);
  b[24] = (w - 1) & 255; b[25] = ((w - 1) >> 8) & 255; b[26] = ((w - 1) >> 16) & 255; b[27] = (h - 1) & 255; b[28] = ((h - 1) >> 8) & 255; b[29] = ((h - 1) >> 16) & 255;
  return b;
}
const SVG_OK = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48"><rect width="64" height="48" fill="#1a56db"/></svg>';
const file = (bytes, name, type = 'application/octet-stream') => new File([bytes], name, { type });

function fakeR2() {
  const m = new Map();
  return {
    m,
    async put(k, v, o) { m.set(k, { body: v, o }); },
    async get(k) { const e = m.get(k); return e ? { body: e.body, httpEtag: `"${k.length}-${e.body.length}"`, httpMetadata: e.o?.httpMetadata } : null; },
    async delete(k) { m.delete(k); }
  };
}
let n = 1;
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ASSETS: createAssets(), PLATFORM_MEDIA: fakeR2(), ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), PORTAL_BASE_URL: 'https://cp.test', ...extra };
}
const ctx = { waitUntil() {} };
async function call(env, method, path, { body, cookie, form, headers = {} } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${n++ % 250 + 1}`, ...headers });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (form) payload = form; else if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
  const buf = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(buf); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, headers: res.headers, json, text, buf, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffCookie(env) {
  await call(env, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  return (await call(env, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
}
async function upload(env, cookie, bytes, name, extra = {}) {
  const form = new FormData(); form.set('file', file(bytes, name)); for (const [k, v] of Object.entries(extra)) form.set(k, v);
  return call(env, 'POST', '/api/platform/saas/media', { cookie, form });
}

// ---------- image inspection ----------
test('inspectImage reads type and size from the bytes', () => {
  assert.deepEqual(['png', 96, 96], ((r) => [r.type, r.width, r.height])(inspectImage(png(96, 96))));
  assert.deepEqual(['gif', 20, 10], ((r) => [r.type, r.width, r.height])(inspectImage(gif(20, 10))));
  assert.deepEqual(['jpeg', 300, 200], ((r) => [r.type, r.width, r.height])(inspectImage(jpeg(300, 200))));
  assert.deepEqual(['webp', 512, 256], ((r) => [r.type, r.width, r.height])(inspectImage(webpX(512, 256))));
  assert.deepEqual(['ico', 256, 32], ((r) => [r.type, r.width, r.height])(inspectImage(ico(256, 32))));
  const svg = inspectImage(enc(SVG_OK));
  assert.deepEqual(['svg', 64, 48, 'image/svg+xml'], [svg.type, svg.width, svg.height, svg.mime]);
});

test('inspectImage refuses things that are not pictures, or are cut off', () => {
  assert.equal(inspectImage(enc('just some text, not an image')).ok, false);
  assert.equal(inspectImage(new Uint8Array(4)).ok, false);
  assert.equal(inspectImage(png(96, 96, { truncated: true })).ok, false, 'a PNG with no IEND was cut off');
  assert.equal(inspectImage(png(0, 10)).ok, false, 'zero size');
  assert.equal(inspectImage(png(20000, 10)).ok, false, 'absurd size');
  const badIco = ico(16, 16).slice(0, 20);
  assert.equal(inspectImage(badIco).ok, false, 'an ICO entry that points outside the file');
});

test('extension has to agree with the bytes', () => {
  assert.equal(extensionMatches('png', 'logo.PNG'), true);
  assert.equal(extensionMatches('jpeg', 'photo.jpeg'), true);
  assert.equal(extensionMatches('png', 'logo.gif'), false);
  assert.equal(extensionMatches('svg', 'noextension'), false);
});

test('SVG: anything that can run code or fetch from elsewhere is refused, a plain drawing is not', () => {
  const wrap = (inner) => enc(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">${inner}</svg>`);
  const refused = {
    script: '<' + 'script>alert(1)</' + 'script>',
    handler: '<rect onload="x()" width="1" height="1"/>',
    foreign: '<foreignObject><div/></foreignObject>',
    external: '<image href="https://evil.example/x.png"/>',
    jsUrl: '<a href="javascript:alert(1)"><rect/></a>',
    cssUrl: '<rect style="fill:url(https://evil.example/a)"/>',
    cssImport: '<style>@import "x.css";</style>',
    animateHref: '<a><animate attributeName="href" values="javascript:alert(1)"/></a>'
  };
  for (const [name, inner] of Object.entries(refused)) assert.equal(inspectSvg(wrap(inner)).ok, false, name);
  assert.equal(inspectSvg(enc('<!DOCTYPE svg [<!ENTITY a "b">]><svg xmlns="http://www.w3.org/2000/svg"/>')).ok, false, 'doctype / entity');
  assert.equal(inspectSvg(enc('<svg viewBox="0 0 1 1"><rect/></svg>')).error, 'svg_missing_xmlns');
  assert.equal(inspectSvg(wrap('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/>')).ok, true, 'internal references are fine');
  assert.equal(inspectSvg(enc('<?xml version="1.0"?>\n<!-- logo -->' + SVG_OK)).ok, true, 'an xml declaration and a comment are fine');
  assert.equal(inspectSvg(enc('x'.repeat(600 * 1024))).ok, false);
});

// ---------- media library ----------
test('upload stores the bytes, the right content type and a public address, and records size and dimensions', async () => {
  const env = makeEnv();
  const r = await media.uploadMedia(env, { file: file(png(96, 96), 'Favicon 96.PNG', 'image/jpeg'), actorId: 'staff:1', altText: ' Logo ' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.media.url, /^\/brand-media\/branding\/\d+-[0-9a-f]{16}\.png$/);
  assert.deepEqual([r.media.mimeType, r.media.width, r.media.height, r.media.altText, r.media.folder], ['image/png', 96, 96, 'Logo', 'branding']);
  const stored = env.PLATFORM_MEDIA.m.get(r.media.key);
  assert.equal(stored.o.httpMetadata.contentType, 'image/png', 'the type comes from the bytes, not from what the browser said');
  assert.equal((await media.getMedia(env, r.media.id)).filename, 'Favicon 96.PNG');
});

test('upload refuses what is not a real, allowed image', async () => {
  const env = makeEnv();
  const up = (bytes, name, extra = {}) => media.uploadMedia(env, { file: file(bytes, name), ...extra });
  assert.equal((await up(enc('not an image'), 'a.png')).error, 'not_an_image');
  assert.equal((await up(gif(5, 5), 'a.png')).error, 'extension_mismatch');
  assert.equal((await up(png(8, 8), 'a.exe')).error, 'unsupported_file_type');
  assert.equal((await up(png(8, 8), 'a')).error, 'unsupported_file_type');
  assert.equal((await up(enc('<svg xmlns="http://www.w3.org/2000/svg"><' + 'script/></svg>'), 'a.svg')).error, 'svg_unsafe');
  assert.equal((await up(png(8, 8), 'a.png', { folder: '../etc' })).error, 'invalid_folder');
  assert.equal((await up(new Uint8Array(0), 'a.png')).error, 'empty_file');
  const big = new Uint8Array(media.MAX_IMAGE_BYTES + 1); big.set(png(8, 8));
  assert.equal((await up(big, 'big.png')).error, 'file_too_large');
  assert.equal(env.PLATFORM_MEDIA.m.size, 0, 'nothing was stored for any refused file');
  assert.equal((await media.listMedia(env)).total, 0);
});

test('the same file in the same folder is stored once', async () => {
  const env = makeEnv();
  const a = await media.uploadMedia(env, { file: file(png(32, 32), 'one.png') });
  const b = await media.uploadMedia(env, { file: file(png(32, 32), 'two.png') });
  assert.deepEqual([a.duplicate, b.duplicate, b.media.id === a.media.id, env.PLATFORM_MEDIA.m.size], [false, true, true, 1]);
});

test('without the R2 binding uploads fail closed, and reading the library still works', async () => {
  const env = makeEnv({ PLATFORM_MEDIA: undefined });
  assert.deepEqual([(await media.uploadMedia(env, { file: file(png(8, 8), 'a.png') })).error, media.storageConfigured(env)], ['media_storage_not_configured', false]);
  assert.equal((await media.listMedia(env)).total, 0);
});

test('a failed database write removes the object it just stored', async () => {
  const env = makeEnv();
  const real = env.LUMMET_DB.prepare.bind(env.LUMMET_DB);
  env.LUMMET_DB = Object.assign(Object.create(env.LUMMET_DB), { prepare: (sql) => { if (/^\s*INSERT INTO platform_media/i.test(sql)) throw new Error('disk full'); return real(sql); } });
  const r = await media.uploadMedia(env, { file: file(png(8, 8), 'a.png') });
  assert.deepEqual([r.ok, r.error, env.PLATFORM_MEDIA.m.size], [false, 'upload_failed', 0]);
});

test('list: search, folder and type filters, paging; update alt text and folder; folder names are validated', async () => {
  const env = makeEnv();
  await media.uploadMedia(env, { file: file(png(96, 96), 'alpha.png'), altText: 'blue square' });
  await media.uploadMedia(env, { file: file(enc(SVG_OK), 'beta.svg'), folder: 'logos' });
  const all = await media.listMedia(env);
  assert.deepEqual([all.total, all.folders.map((f) => f.folder)], [2, ['branding', 'logos']]);
  assert.deepEqual((await media.listMedia(env, { search: 'blue' })).items.map((m) => m.filename), ['alpha.png']);
  assert.deepEqual((await media.listMedia(env, { search: '100%_' })).items, [], 'LIKE wildcards are literal');
  assert.deepEqual((await media.listMedia(env, { accept: ['image/svg+xml'] })).items.map((m) => m.filename), ['beta.svg']);
  assert.deepEqual((await media.listMedia(env, { folder: 'logos' })).items.map((m) => m.filename), ['beta.svg']);
  assert.equal((await media.listMedia(env, { folder: 'Bad Folder!' })).total, 0);
  const id = all.items[0].id;
  const u = await media.updateMedia(env, id, { altText: 'new alt', folder: 'general' });
  assert.deepEqual([u.ok, u.media.altText, u.media.folder, u.media.url === all.items[0].url], [true, 'new alt', 'general', true]);
  assert.equal((await media.updateMedia(env, id, { folder: '../x' })).error, 'invalid_folder');
  assert.equal((await media.updateMedia(env, 'pm_nope', {})).error, 'media_not_found');
});

// ---------- branding values ----------
async function uploaded(env, bytes, name) { const r = await media.uploadMedia(env, { file: file(bytes, name) }); assert.equal(r.ok, true, JSON.stringify(r)); return r.media; }
const save = (env, values, reason = 'testing') => branding.saveBranding(env, { values, actorId: 'staff:1', reason });

test('every icon has to be the right type and the right size', async () => {
  const env = makeEnv();
  const ok96 = await uploaded(env, png(96, 96), 'f96.png');
  const bad = await uploaded(env, png(64, 64), 'f64.png');
  const svg = await uploaded(env, enc(SVG_OK), 'f.svg');
  assert.equal((await save(env, { favicon_96: ok96.url })).ok, true);
  const wrongSize = await save(env, { favicon_96: bad.url });
  assert.deepEqual([wrongSize.ok, wrongSize.errors.favicon_96.error], [false, 'wrong_dimensions']);
  assert.match(wrongSize.errors.favicon_96.detail, /96 by 96.*64 by 64/);
  assert.equal((await save(env, { favicon_96: svg.url })).errors.favicon_96.error, 'wrong_image_type');
  assert.equal((await save(env, { favicon_svg: svg.url })).ok, true);
  assert.equal((await save(env, { favicon_svg: ok96.url })).errors.favicon_svg.error, 'wrong_image_type');
  assert.equal((await save(env, { logo: ok96.url })).ok, true, 'a logo may be any size');
  assert.equal((await save(env, { apple_touch_icon: '/brand-media/branding/1700000000000-0123456789abcdef.png' })).errors.apple_touch_icon.error, 'media_not_found');
});

test('values: addresses, colours, names; unknown keys and a missing reason are refused; nothing is half-saved', async () => {
  const env = makeEnv();
  assert.equal((await branding.saveBranding(env, { values: { brand_name: 'X' }, actorId: 'staff:1', reason: ' ' })).error, 'reason_required');
  assert.equal((await save(env, { nope: 'x' })).error, 'unknown_setting');
  const r = await save(env, { brand_name: 'Acme Control', theme_color: '#ABC', logo: 'http://insecure.example/l.png', background_color: 'blue', manifest_display: 'fullscreen' });
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.errors).sort(), ['background_color', 'logo', 'manifest_display']);
  assert.deepEqual(await branding.loadBranding(env, { fresh: true }), {}, 'the good values were not saved either');
  for (const bad of ['https://user:pw@example.com/a.png', 'https://example.com/a b.png', 'javascript:alert(1)', '//example.com/a.png', '/static/images/favicon.svg', 'https://example.com/a"onload="x']) {
    assert.equal((await save(env, { logo: bad })).ok, false, bad);
  }
  const good = await save(env, { brand_name: ' Acme Control ', theme_color: '#ABC', logo: 'https://cdn.example.com/logo.png', manifest_display: 'Standalone' });
  assert.deepEqual([good.ok, (await branding.loadBranding(env)).theme_color, (await branding.loadBranding(env)).brand_name, (await branding.loadBranding(env)).manifest_display], [true, '#aabbcc', 'Acme Control', 'standalone']);
});

test('an empty value clears a field; saving the same thing again changes nothing', async () => {
  const env = makeEnv();
  await save(env, { brand_name: 'One', theme_color: '#112233' });
  const again = await save(env, { brand_name: 'One' });
  assert.deepEqual([again.ok, again.unchanged, again.changed], [true, true, []]);
  const cleared = await save(env, { brand_name: '' });
  assert.deepEqual([cleared.changed, (await branding.loadBranding(env)).brand_name, (await branding.loadBranding(env)).theme_color], [['brand_name'], undefined, '#112233']);
});

test('a file that a branding value uses cannot be deleted until the value is changed', async () => {
  const env = makeEnv();
  const m = await uploaded(env, png(192, 192), 'a192.png');
  await save(env, { pwa_icon_192: m.url });
  const refused = await media.deleteMedia(env, m.id);
  assert.deepEqual([refused.ok, refused.status, refused.error, refused.usedBy], [false, 409, 'media_in_use', ['pwa_icon_192']]);
  assert.equal(env.PLATFORM_MEDIA.m.size, 1);
  await save(env, { pwa_icon_192: '' });
  assert.equal((await media.deleteMedia(env, m.id)).ok, true);
  assert.deepEqual([env.PLATFORM_MEDIA.m.size, await media.getMedia(env, m.id)], [0, null]);
});

test('head tags and the manifest come only from what is set, and are escaped', async () => {
  assert.equal(branding.iconLinksHtml({}), '');
  const v = { favicon_svg: '/brand-media/branding/1-0123456789abcdef.svg', favicon_96: 'https://cdn.example.com/a.png?x=1&y="2"', apple_touch_icon: '/brand-media/branding/2-0123456789abcdef.png', pwa_icon_192: '/brand-media/branding/3-0123456789abcdef.png', theme_color: '#112233' };
  const html = branding.iconLinksHtml(v);
  assert.match(html, /rel="icon" type="image\/svg\+xml" href="\/brand-media\/branding\/1-/);
  assert.match(html, /sizes="96x96" href="https:\/\/cdn\.example\.com\/a\.png\?x=1&amp;y=&quot;2&quot;"/);
  assert.match(html, /rel="apple-touch-icon" sizes="180x180"/);
  assert.match(html, /rel="manifest" href="\/site\.webmanifest"/);
  assert.match(html, /name="theme-color" content="#112233"/);
  assert.equal(branding.iconLinksHtml({ favicon_svg: v.favicon_svg }).includes('manifest'), false, 'no app icon, no manifest');
  assert.equal(branding.buildManifest({ favicon_svg: v.favicon_svg }), null);
  const m = branding.buildManifest({ ...v, brand_name: 'Acme', pwa_icon_512: '/brand-media/branding/4-0123456789abcdef.png' });
  assert.deepEqual([m.name, m.short_name, m.display, m.icons.map((i) => i.sizes), m.theme_color, m.background_color], ['Acme', 'Acme', 'standalone', ['192x192', '512x512'], '#112233', '#112233']);
});

test('unreadable branding falls back to the built-in look and does not throw', async () => {
  const env = makeEnv();
  const broken = Object.assign(Object.create(env.LUMMET_DB), { prepare: () => { throw new Error('d1 down'); } });
  const e2 = { ...env, LUMMET_DB: broken };
  assert.deepEqual(await branding.loadBranding(e2), {});
  assert.equal(await branding.headIconsHtml(e2), branding.FALLBACK_ICON_LINK);
});

// ---------- through the Worker ----------
test('the staff API is for super admins only', async () => {
  const env = makeEnv();
  for (const [m, p] of [['GET', '/api/platform/saas/branding'], ['PUT', '/api/platform/saas/branding'], ['GET', '/api/platform/saas/media'], ['POST', '/api/platform/saas/media'], ['DELETE', '/api/platform/saas/media/pm_x'], ['GET', '/platform/saas/media']]) {
    const r = await call(env, m, p, { body: m === 'PUT' ? { values: {}, reason: 'x' } : undefined });
    assert.ok([401, 302, 403].includes(r.status), `${m} ${p} -> ${r.status}`);
  }
});

test('end to end: upload, choose, save, and the whole portal wears it', async () => {
  const env = makeEnv();
  const cookie = await staffCookie(env);

  const f96 = await upload(env, cookie, png(96, 96), 'f96.png', { alt_text: 'favicon' });
  assert.equal(f96.status, 201, f96.text);
  const dup = await upload(env, cookie, png(96, 96), 'again.png');
  assert.deepEqual([dup.status, dup.json.duplicate], [200, true]);
  assert.equal((await upload(env, cookie, enc('nope'), 'x.png')).status, 422);
  const svg = (await upload(env, cookie, enc(SVG_OK), 'icon.svg')).json.media;
  const ico = (await upload(env, cookie, ico_(), 'favicon.ico')).json.media;
  const p192 = (await upload(env, cookie, png(192, 192), 'a192.png')).json.media;
  const logo = (await upload(env, cookie, png(128, 128), 'logo.png')).json.media;

  const list = await call(env, 'GET', '/api/platform/saas/media?accept=image/png', { cookie });
  assert.deepEqual([list.status, list.json.total, list.json.storageConfigured], [200, 3, true]);

  const bad = await call(env, 'PUT', '/api/platform/saas/branding', { cookie, body: { values: { favicon_96: logo.url }, reason: 'try' } });
  assert.deepEqual([bad.status, bad.json.errors.favicon_96.error], [422, 'wrong_dimensions']);
  const noReason = await call(env, 'PUT', '/api/platform/saas/branding', { cookie, body: { values: { brand_name: 'X' } } });
  assert.equal(noReason.status, 422);

  const saved = await call(env, 'PUT', '/api/platform/saas/branding', { cookie, body: { reason: 'launch', values: { brand_name: 'Acme Control', logo: logo.url, favicon_svg: svg.url, favicon_ico: ico.url, favicon_96: f96.json.media.url, pwa_icon_192: p192.url, theme_color: '#112233' } } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal((await call(env, 'GET', '/api/platform/saas/branding', { cookie })).json.data.find((f) => f.key === 'logo').value, logo.url);

  // The staff console: icon tags, manifest, theme colour, the portal's own name and logo.
  const dash = await call(env, 'GET', '/dashboard', { cookie });
  assert.equal(dash.status, 200);
  assert.ok(dash.text.includes(`href="${svg.url}"`), 'svg favicon');
  assert.ok(dash.text.includes('rel="manifest" href="/site.webmanifest"'));
  assert.ok(dash.text.includes('name="theme-color" content="#112233"'));
  assert.match(dash.text, /<title>[^<]*· Acme Control<\/title>/);
  assert.ok(dash.text.includes(`<img class="brand-icon" src="${logo.url}"`), 'logo in the sidebar');
  assert.ok(dash.text.includes('<span class="brand-label">Acme Control</span>'));
  assert.equal(dash.text.includes('<!--lummet:'), false, 'every marker was replaced');
  assert.ok(dash.text.includes('/platform/saas/media'), 'the nav links to the library');

  // Sign-in pages, the customer dashboard and the public site carry the icons (not the staff-only name and logo).
  const login = await call(env, 'GET', '/login');
  assert.ok(login.text.includes(`href="${svg.url}"`), 'staff sign-in');
  assert.equal(login.text.includes('/static/images/favicon.svg'), false, 'the built-in favicon is replaced, not added to');
  const home = await call(env, 'GET', '/');
  assert.equal(home.status, 200);
  assert.ok(home.text.includes(`href="${svg.url}"`), 'public site');
  assert.ok(home.text.includes('rel="manifest"'));
  const customer = (await call(env, 'POST', '/api/customer/signup', { body: { email: 'c@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } })).cookie;
  const app = await call(env, 'GET', '/app/overview', { cookie: customer });
  assert.ok(app.text.includes(`href="${svg.url}"`), 'customer dashboard');
  assert.equal(app.text.includes('Acme Control'), false, 'customers keep the site name and logo');

  // The public files.
  const file1 = await call(env, 'GET', svg.url);
  assert.deepEqual([file1.status, file1.headers.get('Content-Type'), file1.headers.get('X-Content-Type-Options')], [200, 'image/svg+xml', 'nosniff']);
  assert.match(file1.headers.get('Content-Security-Policy'), /sandbox/);
  assert.match(file1.headers.get('Cache-Control'), /immutable/);
  assert.equal(file1.text, SVG_OK);
  const pngRes = await call(env, 'GET', f96.json.media.url);
  assert.deepEqual([pngRes.headers.get('Content-Type'), [...pngRes.buf.slice(0, 4)]], ['image/png', [0x89, 0x50, 0x4e, 0x47]]);
  const etag = pngRes.headers.get('ETag');
  assert.equal((await call(env, 'GET', f96.json.media.url, { headers: { 'If-None-Match': etag } })).status, 304);
  assert.equal((await call(env, 'HEAD', f96.json.media.url)).status, 200);
  assert.equal((await call(env, 'GET', '/brand-media/branding%2F..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await call(env, 'GET', '/brand-media/branding/1-0123456789abcdef.png')).status, 404);
  assert.equal((await call(env, 'GET', '/brand-media/%E0%A4%A')).status, 404, 'a malformed escape is just not found');
  const fav = await call(env, 'GET', '/favicon.ico');
  assert.deepEqual([fav.status, fav.headers.get('Location')], [302, ico.url]);
  const man = await call(env, 'GET', '/site.webmanifest');
  assert.equal(man.status, 200);
  assert.match(man.headers.get('Content-Type'), /manifest\+json/);
  assert.deepEqual([man.json.name, man.json.icons.length, man.json.theme_color], ['Acme Control', 1, '#112233']);

  // Pages render and their scripts compile.
  for (const p of ['/platform/saas/settings', '/platform/saas/media']) {
    const r = await call(env, 'GET', p, { cookie });
    assert.equal(r.status, 200, p);
    assert.ok(r.text.includes('Media library') || r.text.includes('Branding'));
    for (const m of r.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) { if (!/src=/.test(m[1])) assert.doesNotThrow(() => new vm.Script(m[2]), p); }
  }
  const settings = await call(env, 'GET', '/platform/saas/settings', { cookie });
  assert.ok(settings.text.includes('data-brand-key="favicon_96"') && settings.text.includes('data-size="96"'));
  assert.ok(settings.text.includes(`value="${logo.url}"`));
  const library = await call(env, 'GET', '/platform/saas/media?q=icon.svg', { cookie });
  assert.ok(library.text.includes('icon.svg') && !library.text.includes('f96.png'));

  // In use -> cannot delete; then it can.
  const del = await call(env, 'DELETE', `/api/platform/saas/media/${svg.id}`, { cookie });
  assert.deepEqual([del.status, del.json.error], [409, 'media_in_use']);
  await call(env, 'PUT', '/api/platform/saas/branding', { cookie, body: { reason: 'swap', values: { favicon_svg: '' } } });
  assert.equal((await call(env, 'DELETE', `/api/platform/saas/media/${svg.id}`, { cookie })).status, 200);
  assert.equal((await call(env, 'GET', svg.url)).status, 404);
  const patch = await call(env, 'PATCH', `/api/platform/saas/media/${logo.id}`, { cookie, body: { altText: 'The logo' } });
  assert.equal(patch.json.media.altText, 'The logo');

  // Every write is in the audit log; the log names the fields, not secrets.
  const rows = (await env.LUMMET_DB.prepare("SELECT resource, action, success FROM lummet_audit_logs WHERE resource IN ('portal_branding','platform_media') ORDER BY id").all()).results;
  const has = (resource, action, success) => rows.some((r) => r.resource === resource && r.action === action && Number(r.success) === success);
  assert.ok(has('platform_media', 'upload', 1) && has('platform_media', 'upload', 0) && has('platform_media', 'upload_duplicate', 1));
  assert.ok(has('portal_branding', 'save', 1) && has('portal_branding', 'save', 0));
  assert.ok(has('platform_media', 'delete', 0) && has('platform_media', 'delete', 1) && has('platform_media', 'update', 1));
});
function ico_() { return ico(32, 32); }

test('nothing set: the portal looks exactly as it did, /favicon.ico falls through and there is no manifest', async () => {
  const env = makeEnv();
  const cookie = await staffCookie(env);
  const dash = await call(env, 'GET', '/dashboard', { cookie });
  assert.ok(dash.text.includes('<link rel="icon" type="image/svg+xml" href="/static/images/favicon.svg" />'));
  assert.equal(dash.text.includes('manifest'), false);
  assert.match(dash.text, /<title>[^<]*· Lummet<\/title>/);
  assert.equal((await call(env, 'GET', '/site.webmanifest')).status, 404);
  const nofav = await call(env, 'GET', '/favicon.ico');
  assert.equal((nofav.headers.get('Location') || '').includes('brand-media'), false, 'no icon set: no redirect to a branding file');
  const home = await call(env, 'GET', '/');
  assert.equal(home.text.includes('rel="manifest"'), false);
  assert.ok(home.text.includes('rel="icon"'));
});

test('uploads without storage answer 503 and the page says so; a cross-site upload is blocked', async () => {
  const env = makeEnv({ PLATFORM_MEDIA: undefined });
  const cookie = await staffCookie(env);
  const r = await upload(env, cookie, png(8, 8), 'a.png');
  assert.deepEqual([r.status, r.json.error], [503, 'media_storage_not_configured']);
  assert.match((await call(env, 'GET', '/platform/saas/settings', { cookie })).text, /PLATFORM_MEDIA/);
  const form = new FormData(); form.set('file', file(png(8, 8), 'a.png'));
  const cross = await call(env, 'POST', '/api/platform/saas/media', { cookie, form, headers: { Origin: 'https://evil.example' } });
  assert.deepEqual([cross.status, cross.json.error], [403, 'cross_site_request_blocked']);
});

test('an oversized upload is refused before it is read', async () => {
  const env = makeEnv();
  const cookie = await staffCookie(env);
  const r = await call(env, 'POST', '/api/platform/saas/media', { cookie, form: new FormData(), headers: { 'Content-Length': String(media.MAX_IMAGE_BYTES + 1024 * 1024) } });
  assert.deepEqual([r.status, r.json.error], [413, 'file_too_large']);
});
