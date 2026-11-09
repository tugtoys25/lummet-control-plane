// test/section-backgrounds.test.js
// 2.8.2: background colour for homepage sections, page header bands and the site settings behind them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, get } from './support/public-env.js';
import { normalizeBg, sectionBg, headerBg } from '../worker/public-site/backgrounds.js';
import { CMS_RESOURCES } from '../worker/cms-resources.js';
import { SITE_SETTING_KEYS } from '../worker/cms.js';
import { renderSiteSettingsPage } from '../worker/views/pages/cms.js';
import { pageCanonicalPath } from '../worker/public-site/pages.js';

const text = (r) => r.text();
const setting = (env, key, value) => env.db.prepare(`INSERT OR REPLACE INTO lummet_site_settings (key, value) VALUES (?, ?)`).bind(key, value).run();

test('background helpers: unknown values never reach a class name; sections and headers resolve their fallbacks', () => {
  assert.equal(normalizeBg('blue'), 'blue');
  assert.equal(normalizeBg('red;"><script>'), 'default');
  assert.equal(sectionBg('default', undefined), 'default');
  assert.equal(sectionBg('default', 'blue'), 'blue');       // follows the site default
  assert.equal(sectionBg('soft', 'blue'), 'soft');          // own choice wins
  assert.equal(headerBg('default', undefined), 'soft');     // original look
  assert.equal(headerBg('default', 'dark'), 'dark');
  assert.equal(headerBg('blue', 'dark'), 'blue');
});

test('forms: homepage sections and pages offer the blue band, pre-selected for new records; settings list both defaults', () => {
  const bg = CMS_RESOURCES.homepage_sections.fields.find((f) => f.name === 'background');
  assert.deepEqual(bg.options, ['default', 'soft', 'blue', 'dark']);
  assert.equal(bg.default, 'blue');
  const hb = CMS_RESOURCES.pages.fields.find((f) => f.name === 'header_background');
  assert.deepEqual(hb.options, ['default', 'soft', 'blue', 'dark']);
  assert.equal(hb.default, 'blue');
  assert.ok(SITE_SETTING_KEYS.includes('section_background') && SITE_SETTING_KEYS.includes('page_header_background'));
});

test('settings form renders both colour settings as selects, soft grey header selected when unset', async () => {
  const env = createPublicEnv();
  env.LUMMET_DB = env.db;
  const html = await renderSiteSettingsPage(env, { id: 'a', role: 'super_admin', email: 'x@y.z' }, null);
  assert.match(html, /<select name="section_background">/);
  assert.match(html, /<select name="page_header_background">/);
  assert.match(html, /<option value="soft" selected>/);
  assert.match(html, /<option value="default" selected>/);
});

test('homepage: a section on Blue renders bg-blue; the site default applies only to sections left on Default', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`INSERT INTO lummet_homepage_sections (section_key, kind, background, title, body, status, sort_order) VALUES ('zz-blue','text','blue','Blue block','<p>x</p>','published',900),('zz-plain','text','default','Plain block','<p>y</p>','published',901)`).run();
  let html = await text(await get(handlePublicRoute, env, '/'));
  assert.match(html, /<section class="section bg-blue" id="zz-blue"/);
  assert.match(html, /<section class="section bg-default" id="zz-plain"/);

  await setting(env, 'section_background', 'soft');
  html = await text(await get(handlePublicRoute, env, '/'));
  assert.match(html, /<section class="section bg-soft" id="zz-plain"/);
  assert.match(html, /<section class="section bg-blue" id="zz-blue"/);
});

test('page header: site setting colours inner pages, a CMS page can override it, and a bad value falls back', async () => {
  const env = createPublicEnv();
  assert.match(await text(await get(handlePublicRoute, env, '/brands')), /class="page-hero bg-soft"/);

  await setting(env, 'page_header_background', 'blue');
  assert.match(await text(await get(handlePublicRoute, env, '/brands')), /class="page-hero bg-blue"/);

  const row = await env.db.prepare(`SELECT slug FROM lummet_pages WHERE status = 'published' ORDER BY id LIMIT 1`).first();
  const path = pageCanonicalPath(row.slug);
  const follow = await text(await get(handlePublicRoute, env, path));
  assert.match(follow, /<header class="page-hero bg-blue">/, path);
  await env.db.prepare(`UPDATE lummet_pages SET header_background = 'dark' WHERE slug = ?`).bind(row.slug).run();
  assert.match(await text(await get(handlePublicRoute, env, path)), /<header class="page-hero bg-dark">/);
  await env.db.prepare(`UPDATE lummet_pages SET header_background = 'x" onload="1' WHERE slug = ?`).bind(row.slug).run();
  const bad = await text(await get(handlePublicRoute, env, path));
  assert.doesNotMatch(bad, /onload=/);
  assert.match(bad, /<header class="page-hero bg-blue">/);   // bad value is treated as Default, so it follows the site setting
});
