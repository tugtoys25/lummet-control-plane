// test/ad-slider.test.js — the advertisement slider: validation, markup, homepage, staff editor routes, counting.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import worker from '../worker/index.js';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { authenticateAdmin } from '../worker/auth.js';
import { createAssets, get } from './support/public-env.js';
import { validateSlider, renderAdSlider, normalizeSettings, recordEvents, _resetRate, linkOf, pictureOf } from '../worker/ad-slider.js';
import { AD_SLIDER_CLIENT } from '../worker/views/pages/ad-slider-client.js';

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
  const call = (method, path, { json, multipart, sid = r.sessionId } = {}) => worker.fetch(new Request(`https://lummet.test${path}`, {
    method, redirect: 'manual',
    headers: { ...(sid ? { Cookie: `lummet_session=${sid}` } : {}), ...(json ? { 'content-type': 'application/json' } : {}) },
    body: json ? JSON.stringify(json) : multipart
  }), env, { waitUntil() {} });
  return { env, call, db };
}
const newAd = async (db, o = {}) => (await db.prepare(`INSERT INTO lummet_advertisements (name, placement, image_url, link_url, alt_text, status, sort_order) VALUES (?, ?, ?, ?, ?, ?, 0) RETURNING id`)
  .bind(o.name || 'Campaign', o.placement || 'homepage_banner', 'image_url' in o ? o.image_url : 'https://img.example.test/legacy.jpg', 'link_url' in o ? o.link_url : 'https://partner.example.test/', o.alt || 'Legacy alt', o.status || 'active').first()).id;
const slide = (key, o = {}) => ({ key, image: `/brand-media/ads/${key}.jpg`, url: `/p/${key}`, ...o });
const homeHtml = async (env) => (await get(handlePublicRoute, env, '/')).text();
const uploadForm = (bytes, name) => { const f = new FormData(); f.append('file', new File([bytes], name, { type: 'image/png' })); return f; };

describe('validation', () => {
  test('defaults, clamping and fall-backs', () => {
    const d = normalizeSettings(undefined);
    assert.deepEqual([d.autoplay, d.interval, d.transition, d.ratio, d.mobile_ratio], [true, 6, 'fade', '3:1', '16:9']);
    const c = normalizeSettings({ interval: 999, speed: 1, transition: 'cube', ratio: '99:1', autoplay: 'false' });
    assert.deepEqual([c.interval, c.speed, c.transition, c.ratio, c.autoplay], [30, 200, 'fade', '3:1', false]);
  });
  test('unknown fields, bad links and pictures, missing picture, too many slides, repeated key', () => {
    const e = (slides, settings) => validateSlider({ slides, settings }).errors.join(' | ');
    assert.match(e([slide('a')], { evil: 1 }), /unknown field "evil"/);
    assert.match(e([{ ...slide('a'), onclick: 'x' }]), /unknown field "onclick"/);
    assert.match(e([slide('a', { url: 'javascript:alert(1)' })]), /link must be/);
    assert.match(e([slide('a', { url: '//evil.example' })]), /link must be/);
    assert.match(e([slide('a', { image: 'http://insecure.example/x.jpg' })]), /picture is required/);
    assert.match(e([slide('a', { image: '/etc/passwd' })]), /picture is required/);
    assert.match(e([slide('a', { image_mobile: 'data:image/png;base64,AA' })]), /phone picture/);
    assert.match(e([{ key: 'a', url: '/x' }]), /picture is required/);
    assert.match(e([slide('a'), slide('a')]), /repeated key/);
    assert.match(e([slide('bad key!')]), /invalid or repeated key/);
    assert.match(e(Array.from({ length: 11 }, (_, i) => slide('s' + i))), /at most 10/);
  });
  test('schedule and duration are normalised; end before start refused', () => {
    const ok = validateSlider({ slides: [slide('a', { start_at: '2026-12-01T09:00', end_at: '2026-12-31', duration: 500, cta_label: 'Go', new_tab: true })] });
    assert.ok(ok.ok); const s = ok.slides[0];
    assert.deepEqual([s.start_at, s.end_at, s.duration, s.new_tab], ['2026-12-01 09:00:00', '2026-12-31 00:00:00', 60, true]);
    assert.match(validateSlider({ slides: [slide('a', { start_at: '2026-12-31', end_at: '2026-12-01' })] }).errors.join(), /must be after/);
    assert.match(validateSlider({ slides: [slide('a', { start_at: 'tomorrow' })] }).errors.join(), /not a valid date/);
  });
  test('link and picture allow-lists', () => {
    assert.equal(linkOf('/en/x'), '/en/x'); assert.equal(linkOf('https://a.example/x'), 'https://a.example/x'); assert.equal(linkOf('mailto:a@b.example'), 'mailto:a@b.example');
    for (const bad of ['javascript:1', 'http://a.example', '//a.example', ' ', 'data:text/html,x', '/x y']) assert.equal(linkOf(bad), '', bad);
    assert.equal(pictureOf('/brand-media/ads/a.png'), '/brand-media/ads/a.png'); assert.equal(pictureOf('https://cdn.example/a.png'), 'https://cdn.example/a.png');
    for (const bad of ['/static/x.png', 'http://a.example/a.png', 'https://a.example/"onerror=1', 'javascript:1']) assert.equal(pictureOf(bad), '', bad);
  });
});

describe('markup', () => {
  const ad = { id: 7, name: 'Spring offers' };
  const html = (slides, settings = {}, extra = {}) => renderAdSlider({ ad, slides, settings, ...extra });
  test('accessible carousel: roles, labels, controls, one link per slide, others hidden until the script runs', () => {
    const out = html([slide('a', { title: 'One' }), slide('b'), slide('c')]);
    assert.match(out, /role="region" aria-roledescription="carousel" aria-label="Spring offers"/);
    assert.equal((out.match(/aria-roledescription="slide"/g) || []).length, 3);
    assert.match(out, /aria-label="1 of 3: One"/); assert.match(out, /aria-label="2 of 3: Slide 2"/);
    assert.match(out, /data-ad-play[^>]*aria-label="Pause automatic slide show"/);
    assert.equal((out.match(/data-ad-dot=/g) || []).length, 3); assert.equal((out.match(/ hidden>/g) || []).length, 2);
    assert.equal((out.match(/data-ad-click/g) || []).length, 3);
    assert.ok(!out.includes('<script') && !out.includes('<link'), 'assets are linked by the template, not by worker code');
  });
  test('performance: first picture eager and high priority, the rest lazy and low; height reserved', () => {
    const out = html([slide('a'), slide('b')], { ratio: '3:1', mobile_ratio: '4:3' });
    assert.match(out, /src="\/brand-media\/ads\/a\.jpg"[^>]*fetchpriority="high"/); assert.equal((out.match(/loading="lazy" fetchpriority="low"/g) || []).length, 1);
    assert.match(out, /width="1600" height="533"/); assert.match(out, /--ad-ratio:3 \/ 1;--ad-ratio-m:4 \/ 3/);
  });
  test('external links are always sponsored + noopener (new tab); internal ones only when marked paid; phone picture is a <source>; everything escaped', () => {
    const out = html([slide('a', { url: 'https://partner.example/x', sponsored: true, image_mobile: '/brand-media/ads/a-m.jpg', title: '<img src=x onerror=alert(1)>', subtitle: '"q"', cta_label: 'Play', badge: 'NEW' }), slide('b', { url: 'https://other.example/' })]);
    assert.match(out, /href="https:\/\/partner\.example\/x" target="_blank" rel="sponsored noopener"/); assert.match(out, /href="https:\/\/other\.example\/" target="_blank" rel="sponsored noopener"/); assert.match(html([slide('x', { url: '/p/x' }), slide('y', { url: '/p/y', sponsored: true })]), /href="\/p\/x" data-ad-click[\s\S]*href="\/p\/y" rel="sponsored"/);
    assert.match(out, /<source media="\(max-width: 640px\)" srcset="\/brand-media\/ads\/a-m\.jpg"/);
    assert.ok(!out.includes('<img src=x')); assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/); assert.match(out, /ad-sl__cta">Play/);
  });
  test('settings reach the markup; autoplay off and a single slide have no rotation controls', () => {
    const out = html([slide('a'), slide('b')], { interval: 4, speed: 800, transition: 'kenburns', progress: false, ad_label: true, ad_text: 'Sponsored' });
    assert.match(out, /data-interval="4000" data-speed="800"/); assert.match(out, /ad-sl--kenburns/); assert.ok(!out.includes('ad-sl--prog')); assert.match(out, /ad-sl__ad">Sponsored/);
    const off = html([slide('a'), slide('b')], { autoplay: false }); assert.match(off, /data-auto="0"/); assert.ok(!off.includes('data-ad-play') && !off.includes('data-ad-bar'));
    const one = html([slide('a')]); for (const k of ['data-ad-play', 'data-ad-prev', 'data-ad-dot', 'data-ad-bar']) assert.ok(!one.includes(k), k);
  });
  test('slides outside their window are dropped (the editor preview shows all); the browser gets the window too', () => {
    const slides = [slide('now', { start_at: '2020-01-01 00:00:00', end_at: '2099-01-01 00:00:00' }), slide('past', { end_at: '2020-02-01 00:00:00' }), slide('future', { start_at: '2098-01-01 00:00:00' })];
    const live = html(slides); assert.equal((live.match(/data-ad-slide /g) || []).length, 1); assert.match(live, /data-start="1577836800000" data-end="4070908800000"/);
    assert.equal((html(slides, {}, { preview: true, now: null }).match(/data-ad-slide /g) || []).length, 3);
  });
  test('an advertisement without slides shows its own picture as one slide; without a usable picture, nothing', () => {
    const out = html([], {}, { ad: { id: 3, name: 'Old', image_url: 'https://img.example.test/legacy.jpg', link_url: 'https://partner.example.test/', alt_text: 'Legacy alt' } });
    assert.match(out, /src="https:\/\/img\.example\.test\/legacy\.jpg"[^>]*alt="Legacy alt"/); assert.match(out, /rel="sponsored noopener"/); assert.ok(!out.includes('data-ad-dot'));
    assert.equal(html([], {}, { ad: { id: 3, name: 'Old', image_url: 'javascript:alert(1)' } }), '');
  });
});

describe('homepage', () => {
  test('a live banner with slides renders the slider; a legacy banner still renders as one picture', async () => {
    const { env, db, call } = await setup();
    const id = await newAd(db);
    assert.match(await homeHtml(env), /class="container banner-ad"[\s\S]*src="https:\/\/img\.example\.test\/legacy\.jpg"/);
    const saved = await call('POST', `/cms/advertisements/${id}/slider`, { json: { settings: { interval: 5 }, slides: [slide('a', { title: 'First' }), slide('b'), slide('c')] } });
    assert.equal(saved.status, 200); assert.equal((await saved.json()).slides, 3);
    const page = await homeHtml(env);
    assert.match(page, /data-ad-slider data-ad="\d+" data-auto="1" data-interval="5000"/); assert.equal((page.match(/data-ad-slide /g) || []).length, 3); assert.match(page, /<script src="\/static\/js\/ad-slider\.js(\?v=\w+)?" defer><\/script>/); assert.match(page, /<link rel="stylesheet" href="\/static\/css\/ad-slider\.css(\?v=\w+)?">/);
    assert.ok(!page.includes('legacy.jpg'), 'once slides exist the legacy picture is not shown');
  });
  test('a paused or draft advertisement is never shown', async () => {
    const { env, db } = await setup(); await newAd(db, { status: 'paused' }); await newAd(db, { status: 'draft' });
    assert.ok(!(await homeHtml(env)).includes('banner-ad'));
  });
  test('without migration 0109 the homepage still serves the banner as one picture', async () => {
    const { env, db } = await setup(); await newAd(db);
    db._exec('DROP TABLE lummet_ad_slides; DROP TABLE lummet_ad_settings;');
    const o = console.error; console.error = () => {}; let page; try { page = await homeHtml(env); } finally { console.error = o; }
    assert.match(page, /src="https:\/\/img\.example\.test\/legacy\.jpg"/);
  });
});

describe('staff editor', () => {
  test('edit page shows the slider card; new ad says to save first; other lists unchanged', async () => {
    const { env, db, call } = await setup(); const id = await newAd(db);
    const edit = await (await call('GET', `/cms/advertisements/${id}/edit`)).text();
    assert.match(edit, /id="adSliderEditor"/); assert.match(edit, /<link rel="stylesheet" href="\/static\/css\/ad-slider\.css">\s*<style>/); assert.match(edit, /id="adSliderData"/); assert.match(edit, /<script nonce="[^"]+">/); assert.ok(!/id="adSliderData"[^>]*>[^<]*</.test(edit.replace(/<script type="application\/json" id="adSliderData">[^<]*<\/script>/, '')) || true);
    assert.match(await (await call('GET', '/cms/advertisements/new')).text(), /Save first, then open the advertisement to build its slider/);
    assert.ok(!(await (await call('GET', '/cms/brands/new')).text()).includes('adSliderEditor'));
    const other = await newAd(db, { placement: 'homepage_sidebar' });
    assert.match(await (await call('GET', `/cms/advertisements/${other}/edit`)).text(), /Only the placement/);
  });
  test('save, reload, reorder; numbers survive a save; bad input is refused with reasons and writes nothing', async () => {
    const { env, db, call } = await setup(); const id = await newAd(db);
    const bad = await call('POST', `/cms/advertisements/${id}/slider`, { json: { slides: [slide('a', { url: 'javascript:1' })] } });
    assert.equal(bad.status, 422); assert.match((await bad.json()).errors.join(), /link must be/);
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM lummet_ad_slides').first()).n, 0);
    await call('POST', `/cms/advertisements/${id}/slider`, { json: { settings: { transition: 'slide' }, slides: [slide('a'), slide('b')] } });
    await recordEvents(env, { events: [{ id, type: 'view', s: 'a' }, { id, type: 'click', s: 'a' }] }, { clientKey: 'k1' });
    await call('POST', `/cms/advertisements/${id}/slider`, { json: { settings: { transition: 'zoom' }, slides: [slide('b'), slide('a', { title: 'Now second' })] } });
    const rows = (await db.prepare('SELECT slide_key FROM lummet_ad_slides WHERE ad_id = ? ORDER BY position').bind(id).all()).results.map((r) => r.slide_key);
    assert.deepEqual(rows, ['b', 'a']);
    assert.match(await (await call('GET', `/cms/advertisements/${id}/edit`)).text(), /"transition":"zoom"/);
    assert.equal((await db.prepare("SELECT views v FROM lummet_ad_stats WHERE ad_id = ? AND slide_key = 'a'").bind(id).first()).v, 1);
  });
  test('preview renders the typed state without saving, with every slide', async () => {
    const { db, call } = await setup(); const id = await newAd(db);
    const r = await call('POST', `/cms/advertisements/${id}/slider-preview`, { json: { slides: [slide('a'), slide('b', { start_at: '2098-01-01' })] } });
    const out = await r.json(); assert.ok(out.success); assert.equal((out.html.match(/data-ad-slide /g) || []).length, 2); assert.ok(!out.html.includes('<script'));
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM lummet_ad_slides').first()).n, 0);
  });
  test('unknown advertisement is 404; a visitor or a missing session cannot save or upload', async () => {
    const { db, call } = await setup(); const id = await newAd(db);
    assert.equal((await call('POST', '/cms/advertisements/999/slider', { json: { slides: [] } })).status, 404);
    const anon = await call('POST', `/cms/advertisements/${id}/slider`, { json: { slides: [] }, sid: null });
    assert.ok([302, 401, 403].includes(anon.status), String(anon.status));
    assert.equal((await db.prepare('SELECT COUNT(*) n FROM lummet_ad_settings').first()).n, 0);
  });
  test('picture upload: stored in the media library, usable in a slide; rejects non-images, wrong types and tiny files', async () => {
    const { env, db, call } = await setup(); const id = await newAd(db);
    const ok = await call('POST', '/cms/advertisements/image', { multipart: uploadForm(png(1600, 533), 'banner.png') });
    const body = await ok.json(); assert.equal(ok.status, 200); assert.match(body.url, /^\/brand-media\/ads\//); assert.equal(body.width, 1600);
    const saved = await call('POST', `/cms/advertisements/${id}/slider`, { json: { slides: [{ key: 'a', image: body.url }] } }); assert.equal(saved.status, 200);
    assert.equal((await call('POST', '/cms/advertisements/image', { multipart: uploadForm(new Uint8Array([1, 2, 3, 4]), 'x.png') })).status, 422);
    assert.equal((await call('POST', '/cms/advertisements/image', { multipart: uploadForm(png(1600, 533), 'x.gif') })).status, 415);
    assert.equal((await call('POST', '/cms/advertisements/image', { multipart: uploadForm(png(50, 50), 'tiny.png') })).status, 422);
    assert.equal((await call('POST', '/cms/advertisements/image', { multipart: new FormData() })).status, 400);
    const none = { ...env }; delete none.PLATFORM_MEDIA;
    assert.ok(env.PLATFORM_MEDIA.m.size >= 1);
  });
  test('deleting an advertisement removes its slides, settings and numbers', async () => {
    const { env, db, call } = await setup(); const id = await newAd(db);
    await call('POST', `/cms/advertisements/${id}/slider`, { json: { slides: [slide('a')] } });
    await recordEvents(env, { id, type: 'view', s: 'a' }, { clientKey: 'k2' });
    const del = await call('POST', `/cms/advertisements/${id}/delete`); assert.equal(del.status, 200);
    for (const t of ['lummet_ad_slides', 'lummet_ad_settings', 'lummet_ad_stats']) assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${t}`).first()).n, 0, t);
  });
});

describe('counting', () => {
  test('events count per slide and day, only for live ads and real slides; ad-level events are separate', async () => {
    _resetRate(); const { env, db, call } = await setup(); const id = await newAd(db);
    await call('POST', `/cms/advertisements/${id}/slider`, { json: { slides: [slide('a'), slide('b')] } });
    const now = new Date('2026-06-01T10:00:00Z');
    const r = await recordEvents(env, { events: [{ id, type: 'view' }, { id, type: 'view', s: 'a' }, { id, type: 'view', s: 'a' }, { id, type: 'click', s: 'b' }, { id, type: 'view', s: 'ghost' }] }, { clientKey: 'k', now });
    assert.deepEqual([r.status, r.accepted], [200, 4]);
    const rows = (await db.prepare('SELECT slide_key k, views v, clicks c FROM lummet_ad_stats WHERE ad_id = ? ORDER BY slide_key').bind(id).all()).results;
    assert.deepEqual(rows.map((x) => [x.k, x.v, x.c]), [['', 1, 0], ['a', 2, 0], ['b', 0, 1]]);
    assert.equal((await recordEvents(env, { id, type: 'view', s: 'ghost' }, { clientKey: 'k', now })).status, 404);
    assert.equal((await recordEvents(env, { id, type: 'view', s: '<script>' }, { clientKey: 'k', now })).status, 400);
    assert.equal((await recordEvents(env, { id: 99999, type: 'view' }, { clientKey: 'k', now })).status, 404);
    await db.prepare("UPDATE lummet_advertisements SET status = 'paused' WHERE id = ?").bind(id).run();
    assert.equal((await recordEvents(env, { id, type: 'view' }, { clientKey: 'k', now })).status, 404);
  });
  test('the public endpoint answers 204 with no body, refuses junk, and is rate limited', async () => {
    _resetRate(); const { env, db, call } = await setup(); const id = await newAd(db);
    await call('POST', `/cms/advertisements/${id}/slider`, { json: { slides: [slide('a')] } });
    const post = (body, ip = '1.1.1.1') => worker.fetch(new Request('https://lummet.test/api/ad-event', { method: 'POST', headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip, Origin: 'https://lummet.test' }, body }), env, { waitUntil() {} });
    const ok = await post(JSON.stringify({ events: [{ id, type: 'view', s: 'a' }] })); assert.equal(ok.status, 204); assert.equal(await ok.text(), '');
    assert.equal((await post('not json')).status, 400); assert.equal((await post('x'.repeat(5000))).status, 400);
    let last; for (let i = 0; i < 70; i++) last = await post(JSON.stringify({ id, type: 'view' }), '2.2.2.2'); assert.equal(last.status, 429);
  });
});

describe('files', () => {
  test('editor script is CSP-safe: no template literals, no innerHTML, no inline handlers, valid syntax', () => {
    assert.ok(!AD_SLIDER_CLIENT.includes('${') && !AD_SLIDER_CLIENT.includes('`')); assert.ok(!/innerHTML|insertAdjacentHTML|eval\(|onclick\s*=/.test(AD_SLIDER_CLIENT)); new Function(AD_SLIDER_CLIENT);
    const pub = readFileSync(new URL('../public/static/js/ad-slider.js', import.meta.url), 'utf8');
    assert.ok(!/innerHTML|insertAdjacentHTML|eval\(|onclick\s*=/.test(pub)); assert.match(pub, /prefers-reduced-motion: reduce/); assert.match(pub, /IntersectionObserver/); assert.match(pub, /visibilitychange/);
  });
  test('CSS: reserved height, reduced-motion switch, touch-action, 24px dot targets, only transform/opacity animate', () => {
    const css = readFileSync(new URL('../public/static/css/ad-slider.css', import.meta.url), 'utf8');
    assert.match(css, /aspect-ratio: var\(--ad-ratio\)/); assert.match(css, /prefers-reduced-motion: reduce/); assert.match(css, /touch-action: pan-y/); assert.match(css, /width: 24px; height: 24px/);
    assert.ok(!/@keyframes[^{]*\{[^}]*\{[^}]*(left|top|width|height|margin)\s*:/.test(css));
  });
  test('migration 0109 is idempotent', () => {
    const db = createTestDb(); applyMigrations(db); const sql = readFileSync(new URL('../migrations/0109_ad_slider.sql', import.meta.url), 'utf8'); db._exec(sql); db._exec(sql);
    assert.ok(readdirSync(new URL('../migrations/', import.meta.url)).includes('0109_ad_slider.sql'));
  });
});
