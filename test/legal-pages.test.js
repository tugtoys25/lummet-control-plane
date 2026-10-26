// Round 6.2B: /legal pages are unpublished by default, watermarked drafts in draft mode, and published only with a
// recorded counsel approval for the exact market and page plus counsel-supplied text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicEnv, get } from './support/public-env.js';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { LEGAL_SLUGS, legalApprovalRecorded, legalMarketForHost } from '../worker/public-site/pages.js';
import { configIssues } from '../worker/config-check.js';

const SLUGS = ['terms', 'privacy', 'dpa', 'subprocessors', 'sla', 'refunds', 'acceptable-use', 'cookies'];
const PATHS = ['/legal', ...SLUGS.map((s) => `/legal/${s}`)];
const approval = (extra = {}) => ({ approvedBy: 'Example Counsel LLP', approvedAt: '2026-01-15T09:00:00Z', ...extra });
async function publishCms(env, slug, content, status = 'published') {
  await env.db.prepare(`INSERT INTO lummet_pages (slug, title, content, status) VALUES (?, ?, ?, ?)`).bind(slug, slug, content, status).run();
}
function liveEnv({ approvals, hosts = { 'lummet.test': 'uk' } } = {}) {
  const env = createPublicEnv();
  Object.assign(env, { PUBLIC_LEGAL_PAGES: 'on', LEGAL_MARKET_BY_HOST: JSON.stringify(hosts), LEGAL_COUNSEL_APPROVALS: JSON.stringify(approvals ?? { uk: { terms: approval() } }) });
  return env;
}

test('the eight pages the round names are exactly the ones served', () => {
  assert.deepEqual([...LEGAL_SLUGS].sort(), [...SLUGS].sort());
});

test('legal pages are unpublished by default: unset and off are 404 for every page, even with approvals configured', async () => {
  for (const env of [createPublicEnv(), Object.assign(createPublicEnv(), { PUBLIC_LEGAL_PAGES: 'off' }),
    Object.assign(createPublicEnv(), { PUBLIC_LEGAL_PAGES: 'bogus' }),
    Object.assign(createPublicEnv(), { PUBLIC_LEGAL_PAGES: 'off', LEGAL_MARKET_BY_HOST: '{"lummet.test":"uk"}', LEGAL_COUNSEL_APPROVALS: JSON.stringify({ uk: { terms: approval() } }) })]) {
    for (const path of PATHS) assert.equal((await get(handlePublicRoute, env, path)).status, 404, `${path} (${env.PUBLIC_LEGAL_PAGES})`);
  }
  assert.equal((await get(handlePublicRoute, liveEnv(), '/legal/not-a-page')).status, 404);
});

test('draft mode: every page is a watermarked, noindex, never-cached outline of [OPEN] placeholders with no invented terms', async () => {
  const env = createPublicEnv(); env.PUBLIC_LEGAL_PAGES = 'draft';
  for (const path of PATHS) {
    const res = await get(handlePublicRoute, env, path); const html = await res.text();
    assert.equal(res.status, 200, path);
    assert.match(html, /DRAFT FOR COUNSEL/, `${path} watermark`);
    assert.match(html, /noindex/, `${path} noindex`);
    assert.equal(res.headers.get('cache-control'), 'no-store', `${path} not cacheable`);
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
    assert.doesNotMatch(html, /\{\{[^}]+\}\}/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/i);
    const body = html.slice(html.indexOf('<article'), html.indexOf('</article>'));
    if (path !== '/legal') assert.match(body, /\[OPEN\]/, `${path} placeholders`);
    // Nothing in a draft may look like a commitment: no percentages, durations, currency amounts or uptime figures.
    assert.doesNotMatch(body.replace(/DRAFT FOR COUNSEL[^<]*/g, ''), /\d+\s*%|\b\d+\s*(days?|hours?|minutes?|months?|years?)\b|[$£€]\s*\d|99\.\d/i, `${path} must not invent numbers`);
  }
  const au = await (await get(handlePublicRoute, env, '/legal/acceptable-use')).text();
  for (const topic of [/age gating/i, /responsible-gambling/i, /local advertising/i]) assert.match(au, topic);
  const index = await (await get(handlePublicRoute, env, '/legal')).text();
  for (const slug of SLUGS) assert.match(index, new RegExp(`href="/legal/${slug}"`));
});

test('draft pages stay out of the sitemap and the robots-visible page cache path', async () => {
  const env = createPublicEnv(); env.PUBLIC_LEGAL_PAGES = 'draft';
  const sitemap = await (await get(handlePublicRoute, env, '/sitemap.xml')).text();
  assert.doesNotMatch(sitemap, /\/legal/);
});

test('on: nothing is published without a recorded approval for that page, market AND counsel text', async () => {
  const env = liveEnv();
  assert.equal((await get(handlePublicRoute, env, '/legal/terms')).status, 404, 'approved but no counsel text yet');
  assert.equal((await get(handlePublicRoute, env, '/legal')).status, 404, 'index hidden when nothing is publishable');
  await publishCms(env, 'legal-uk-terms', '<h2>Terms</h2><p>Counsel supplied wording for the UK market.</p>', 'draft');
  assert.equal((await get(handlePublicRoute, env, '/legal/terms')).status, 404, 'unpublished CMS text is not published');
  await env.db.prepare(`UPDATE lummet_pages SET status = 'published' WHERE slug = 'legal-uk-terms'`).run();
  const res = await get(handlePublicRoute, env, '/legal/terms'); const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Counsel supplied wording for the UK market/);
  assert.doesNotMatch(html, /DRAFT FOR COUNSEL|noindex|\[OPEN\]/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const index = await (await get(handlePublicRoute, env, '/legal')).text();
  assert.match(index, /href="\/legal\/terms"/); assert.doesNotMatch(index, /href="\/legal\/privacy"/, 'only approved pages are listed');
});

test('an approval never unlocks a different page, market or host', async () => {
  const env = liveEnv({ approvals: { uk: { terms: approval() }, de: { privacy: approval() } } });
  await publishCms(env, 'legal-uk-terms', '<p>UK terms text.</p>');
  await publishCms(env, 'legal-uk-privacy', '<p>UK privacy text, no approval recorded.</p>');
  await publishCms(env, 'legal-de-privacy', '<p>DE privacy text, host not mapped.</p>');
  assert.equal((await get(handlePublicRoute, env, '/legal/terms')).status, 200);
  assert.equal((await get(handlePublicRoute, env, '/legal/privacy')).status, 404, 'approval exists only for another market');
  const other = liveEnv({ hosts: { 'other.test': 'uk' } }); await publishCms(other, 'legal-uk-terms', '<p>x</p>');
  assert.equal((await get(handlePublicRoute, other, '/legal/terms')).status, 404, 'unmapped host');
});

test('malformed or incomplete approvals fail closed', async () => {
  const cases = {
    'blank approver': { uk: { terms: approval({ approvedBy: '  ' }) } },
    'missing approver': { uk: { terms: { approvedAt: '2026-01-15T09:00:00Z' } } },
    'future date': { uk: { terms: approval({ approvedAt: '2999-01-01T00:00:00Z' }) } },
    'not a timestamp': { uk: { terms: approval({ approvedAt: 'yesterday' }) } },
    'date only': { uk: { terms: approval({ approvedAt: '2026-01-15' }) } },
    'wrong shape': { uk: { terms: true } }
  };
  for (const [name, approvals] of Object.entries(cases)) {
    const env = liveEnv({ approvals }); await publishCms(env, 'legal-uk-terms', '<p>Counsel text.</p>');
    assert.equal((await get(handlePublicRoute, env, '/legal/terms')).status, 404, name);
  }
  const broken = Object.assign(liveEnv(), { LEGAL_COUNSEL_APPROVALS: '{not json' }); await publishCms(broken, 'legal-uk-terms', '<p>Counsel text.</p>');
  assert.equal((await get(handlePublicRoute, broken, '/legal/terms')).status, 404, 'invalid JSON');
  assert.equal(legalApprovalRecorded({ LEGAL_COUNSEL_APPROVALS: '[]' }, 'uk', 'terms'), false);
  assert.equal(legalMarketForHost({ LEGAL_MARKET_BY_HOST: '{"a.test":"../etc"}' }, 'a.test'), null, 'market ids are validated');
});

test('text that still carries a placeholder or the draft watermark is never published as approved', async () => {
  for (const text of ['<p>Terms [OPEN] fill in</p>', '<p>DRAFT FOR COUNSEL terms</p>', '   ']) {
    const env = liveEnv(); await publishCms(env, 'legal-uk-terms', text);
    assert.equal((await get(handlePublicRoute, env, '/legal/terms')).status, 404, text);
  }
});

test('published counsel text is sanitized before it is served', async () => {
  const env = liveEnv(); await publishCms(env, 'legal-uk-terms', '<p>Safe text</p><script>alert(1)</script><img src=x onerror=alert(2)>');
  const html = await (await get(handlePublicRoute, env, '/legal/terms')).text();
  assert.match(html, /Safe text/); assert.doesNotMatch(html, /alert\(1\)|onerror/i);
});

test('production config-check: PUBLIC_LEGAL_PAGES is required, and on additionally needs the market map and approvals', () => {
  const keys = (env) => configIssues({ ENVIRONMENT: 'production', ...env }).map((i) => i.key);
  assert.ok(keys({}).includes('PUBLIC_LEGAL_PAGES'));
  assert.ok(keys({ PUBLIC_LEGAL_PAGES: 'bogus' }).includes('PUBLIC_LEGAL_PAGES'));
  for (const mode of ['off', 'draft']) assert.ok(!keys({ PUBLIC_LEGAL_PAGES: mode }).includes('PUBLIC_LEGAL_PAGES'));
  assert.ok(!keys({ PUBLIC_LEGAL_PAGES: 'off' }).includes('LEGAL_MARKET_BY_HOST/LEGAL_COUNSEL_APPROVALS'));
  assert.ok(keys({ PUBLIC_LEGAL_PAGES: 'on' }).includes('LEGAL_MARKET_BY_HOST/LEGAL_COUNSEL_APPROVALS'));
  assert.ok(!keys({ PUBLIC_LEGAL_PAGES: 'on', LEGAL_MARKET_BY_HOST: '{"a.test":"uk"}', LEGAL_COUNSEL_APPROVALS: '{"uk":{}}' }).includes('LEGAL_MARKET_BY_HOST/LEGAL_COUNSEL_APPROVALS'));
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging' }), []);
});
