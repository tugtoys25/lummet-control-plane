// test/blue-bands.test.js
// 2.7.4: the solid blue bands (announcement bar, closing call to action, Overview banner).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, get } from './support/public-env.js';
import { renderOverviewPage } from '../worker/views/customer-pages/overview.js';

const text = (r) => r.text();
const setting = (env, key, value) => env.db.prepare(`INSERT OR REPLACE INTO lummet_site_settings (key, value) VALUES (?, ?)`).bind(key, value).run();

test('announcement bar: absent by default, shown above the header when text is set, link only when safe and labelled', async () => {
  const env = createPublicEnv();
  assert.doesNotMatch(await text(await get(handlePublicRoute, env, '/pricing')), /class="announce"/);

  await setting(env, 'announce_text', 'New: annual plans <b>save 20%</b>');
  await setting(env, 'announce_link_text', 'See plans');
  await setting(env, 'announce_url', '/pricing');
  const html = await text(await get(handlePublicRoute, env, '/pricing'));
  assert.match(html, /class="announce"/);
  assert.match(html, /New: annual plans &lt;b&gt;save 20%&lt;\/b&gt;/);          // escaped
  assert.match(html, /<a href="\/pricing">See plans/);
  assert.ok(html.indexOf('class="announce"') < html.indexOf('class="site-header'), 'bar sits above the header');

  await setting(env, 'announce_url', 'javascript:alert(1)');
  assert.doesNotMatch(await text(await get(handlePublicRoute, env, '/pricing')), /javascript:/);
});

test('footer call to action is a band above the dark footer (pages that already end in a CTA band hide it with CSS)', async () => {
  const html = await text(await get(handlePublicRoute, createPublicEnv(), '/brands'));
  assert.ok(html.includes('footer-cta-strip'));
  assert.ok(html.indexOf('footer-cta-strip') < html.indexOf('<footer class="site-footer">'));
});

test('Overview shows at most one blue banner: no plan, no site yet, or trial running', () => {
  const base = { organization: { name: 'Acme' }, plan: { name: 'Pro' }, usage: { sites: { used: 0, limit: 1 }, users: { used: 1, limit: 3 }, customDomains: { used: 0, limit: 1 } } };
  const noPlan = renderOverviewPage({ ...base, subscription: null, plan: null, sites: [] });
  assert.equal((noPlan.match(/class="cta-banner"/g) || []).length, 1);
  assert.match(noPlan, /Choose a plan/);

  const noSite = renderOverviewPage({ ...base, subscription: { status: 'active' }, sites: [] });
  assert.equal((noSite.match(/class="cta-banner"/g) || []).length, 1);
  assert.match(noSite, /Create a site/);

  const trial = renderOverviewPage({ ...base, subscription: { status: 'trialing', trial_ends_at: new Date(Date.now() + 2 * 86400000).toISOString() }, sites: [{ id: 's1', name: 'My Site', status: 'active' }] });
  assert.equal((trial.match(/class="cta-banner"/g) || []).length, 1);
  assert.match(trial, /Your trial is running/);

  const settled = renderOverviewPage({ ...base, subscription: { status: 'active' }, sites: [{ id: 's1', name: 'My Site', status: 'active' }] });
  assert.doesNotMatch(settled, /class="cta-banner"/);
});
