// Homepage brand marquee: only published, strip-enabled brands; validated accent; loop is gap-free and each brand is announced once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { brandStripModels, brandAccent } from '../worker/public-site/models.js';

const row = (o) => ({ name: 'Acme', slug: 'acme', status: 'published', ...o });

test('strip: drafts, hidden-from-strip and slugless rows are excluded; show_in_strip absent counts as shown', () => {
  const m = brandStripModels([row({}), row({ slug: 'd', status: 'draft' }), row({ slug: 'q', show_in_strip: 0 }), row({ slug: 'z', show_in_strip: '0' }), { name: 'x', status: 'published' }]);
  assert.deepEqual(m.items.map((i) => i.url), ['/brands/acme']);
});

test('strip: accent must be #RRGGBB, otherwise a stable palette colour (nothing user-typed reaches CSS)', () => {
  assert.equal(brandAccent({ slug: 'a', accent_color: '#FF0066' }), '#ff0066');
  const bad = brandAccent({ slug: 'a', accent_color: 'red;background:url(x)' });
  assert.match(bad, /^#[0-9a-f]{6}$/);
  assert.equal(bad, brandAccent({ slug: 'a' }));
});

test('strip: track is repeated to at least 12 chips, repeats and the duplicate copy are aria-hidden, real ones are not', () => {
  const m = brandStripModels([row({ slug: 'a' }), row({ slug: 'b', name: 'Beta' })]);
  assert.ok(m.track.length >= 12);
  assert.equal(m.track.filter((t) => !t.aria_hidden).length, 2);
  assert.equal(m.dup.length, m.track.length);
  assert.ok(m.dup.every((t) => t.aria_hidden));
  assert.ok(m.seconds >= 30);
});

test('strip: no brands -> nothing to render', () => {
  const m = brandStripModels([]);
  assert.deepEqual([m.items.length, m.track.length, m.dup.length], [0, 0, 0]);
});

// ---- rendered through the real router and templates ----
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, get } from './support/public-env.js';

const page = async (env, path) => (await get(handlePublicRoute, env, path)).text();

test('homepage renders the moving strip below the header for published brands only; other pages do not', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`DELETE FROM lummet_brands`).run();
  await env.db.prepare(`INSERT INTO lummet_brands (name, slug, status, sort_order) VALUES ('Live One', 'live-one', 'published', 1), ('Hidden Draft', 'hidden-draft', 'draft', 2)`).run();
  const home = await page(env, '/');
  assert.match(home, /class="brand-marquee"/);
  assert.match(home, /href="\/brands\/live-one"/);
  assert.doesNotMatch(home, /hidden-draft|Hidden Draft/);
  assert.ok(home.indexOf('class="brand-strip"') > home.indexOf('</header>') && home.indexOf('class="brand-strip"') < home.indexOf('id="main"'), 'strip sits between the header and main');
  assert.match(home, /\/static\/js\/brand-strip\.js\?v=ui5/);
  assert.doesNotMatch(await page(env, '/brands'), /class="brand-marquee"/);
});

test('homepage has no strip when nothing is published', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_brands SET status = 'draft'`).run();
  assert.doesNotMatch(await page(env, '/'), /brand-marquee/);
});
