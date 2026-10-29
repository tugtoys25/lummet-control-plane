// test/public-site.test.js
// End-to-end tests for the database-driven public site: real migrations +
// seed, real templates, real router. Nothing is mocked except the runtime
// (D1 -> node:sqlite, ASSETS -> filesystem).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { renderSource } from '../worker/public-site/template.js';
import { sanitizeHtml } from '../worker/public-site/sanitize.js';
import { splitSqlStatements, createTestDb, applyMigrations } from './support/d1-shim.js';
import { createPublicEnv, get, post } from './support/public-env.js';
import { isPublicPath } from '../worker/public-site/router.js';

const text = (r) => r.text();

// ------------------------------------------------------------------ engine

test('template engine: escapes by default, raw only with triple braces', () => {
  const out = renderSource('{{a}}|{{{a}}}', { a: '<script>x</script>' });
  assert.equal(out, '&lt;script&gt;x&lt;/script&gt;|<script>x</script>');
});

test('template engine: nested if/else, each with @index, unless, empty arrays are falsy', () => {
  const t = '{{#if list}}{{#each list}}{{@index}}={{n}}{{#unless @last}},{{/unless}}{{/each}}{{else}}none{{/if}}';
  assert.equal(renderSource(t, { list: [{ n: 'a' }, { n: 'b' }] }), '0=a,1=b');
  assert.equal(renderSource(t, { list: [] }), 'none');
});

test('template engine: an unclosed block is a loud error, not silent output', () => {
  assert.throws(() => renderSource('{{#if a}}oops', {}), /unclosed/);
});

// ------------------------------------------------------------- migrations

test('migrations: applying everything twice never duplicates seeded rows', async () => {
  const db = createTestDb();
  applyMigrations(db);
  applyMigrations(db);
  for (const [table, expected] of [['lummet_brands', 6], ['lummet_faqs', 7], ['lummet_updates', 5], ['lummet_publications', 3], ['lummet_pages', 4]]) {
    const row = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first();
    assert.equal(row.n, expected, table);
  }
});

test('migration splitter: semicolons and -- inside string literals are not statement breaks', () => {
  const stmts = splitSqlStatements("INSERT INTO t VALUES ('a; b -- c'); -- trailing\nSELECT 'it''s';");
  assert.equal(stmts.length, 2);
  assert.match(stmts[0], /a; b -- c/);
});

test('seed: re-running never overwrites an admin edit', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_brands SET tagline = 'Edited by an admin' WHERE slug = 'level-casino'`).run();
  applyMigrations(env.db);
  const row = await env.db.prepare(`SELECT tagline FROM lummet_brands WHERE slug = 'level-casino'`).first();
  assert.equal(row.tagline, 'Edited by an admin');
});

// ---------------------------------------------------------------- routing

test('every public route renders 200 HTML through the shared layout', async () => {
  const env = createPublicEnv();
  const paths = ['/', '/brands', '/brands/level-casino', '/updates', '/updates/ai-management-chat', '/insights',
    '/insights/how-signed-requests-work', '/authors/lummet-team', '/about', '/security', '/privacy'];
  for (const path of paths) {
    const res = await get(handlePublicRoute, env, path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await text(res);
    assert.match(html, /<link rel="stylesheet" href="\/static\/css\/tokens\.css\?v=[\w-]+">/, path);
    assert.match(html, /<header class="site-header"/, path);
    assert.match(html, /<footer class="site-footer"/, path);
    assert.match(html, /<link rel="canonical" href="https:\/\/lummet\.com/, path);
    assert.equal((html.match(/\{\{/g) || []).length, 0, `${path}: unresolved template tag`);
  }
});

test('/p/:slug for an alias page redirects to the clean URL', async () => {
  const env = createPublicEnv();
  const res = await get(handlePublicRoute, env, '/p/about');
  assert.equal(res.status, 301);
  assert.equal(res.headers.get('location'), '/about');
});

test('drafts are unreachable: the seeded draft Terms page 404s and is absent from the footer and sitemap', async () => {
  const env = createPublicEnv();
  const res = await get(handlePublicRoute, env, '/terms');
  assert.equal(res.status, 404);
  const home = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(home, /href="\/terms"/);
  const sitemap = await text(await get(handlePublicRoute, env, '/sitemap.xml'));
  assert.doesNotMatch(sitemap, /\/terms/);
  await env.db.prepare(`UPDATE lummet_pages SET status = 'published' WHERE slug = 'terms'`).run();
  assert.equal((await get(handlePublicRoute, env, '/terms')).status, 200);
});

test('unknown slugs and unknown paths', async () => {
  const env = createPublicEnv();
  assert.equal((await get(handlePublicRoute, env, '/brands/nope')).status, 404);
  assert.equal((await get(handlePublicRoute, env, '/updates/nope')).status, 404);
  assert.equal((await get(handlePublicRoute, env, '/updates?page=99')).status, 404);
  // Admin routes are not owned by the public router.
  assert.equal(await get(handlePublicRoute, env, '/tenants'), null);
  assert.equal(await get(handlePublicRoute, env, '/cms/pages'), null);
  assert.equal(await get(handlePublicRoute, env, '/login'), null);
});

test('non-GET requests are never handled by the public router', async () => {
  const env = createPublicEnv();
  const request = new Request('https://lummet.test/', { method: 'POST' });
  assert.equal(await handlePublicRoute({ request, env, ctx: {} }), null);
});

test('"/" is the public homepage for a signed-in admin too', async () => {
  const env = createPublicEnv();
  const request = new Request('https://lummet.test/');
  const res = await handlePublicRoute({ request, env, ctx: {} });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<html/);
});

test('templates are never served as static URLs', async () => {
  const env = createPublicEnv();
  const res = await get(handlePublicRoute, env, '/templates/layout/base.html');
  assert.equal(res, null);
  const css = await get(handlePublicRoute, env, '/static/css/tokens.css');
  assert.equal(css.status, 200);
});

// ------------------------------------------------------------ data-driven

test('homepage brands, hero graph and stats come from the database, not code', async () => {
  const env = createPublicEnv();
  let html = await text(await get(handlePublicRoute, env, '/'));
  for (const name of ['Level.casino', 'NeuroOdds.com', 'Cluster.casino', 'LegendOdds.com', 'BrilliantOdds.com', 'Freewin.xyz']) {
    assert.ok(html.includes(name), name);
  }
  assert.match(html, /connected to 6 brands/);

  await env.db.prepare(`UPDATE lummet_brands SET status = 'draft' WHERE slug = 'freewin'`).run();
  html = await text(await get(handlePublicRoute, env, '/'));
  assert.ok(!html.includes('Freewin.xyz'));
  assert.match(html, /connected to 5 brands/);
});

test('a section with no published rows does not render (no placeholder copy)', async () => {
  const env = createPublicEnv();
  let html = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(html, /id="partners"/); // no partners seeded
  assert.doesNotMatch(html, /href="\/partners"/); // nav hides until partners exist

  await env.db.prepare(
    `INSERT INTO lummet_partners (name, slug, partner_type, status, description) VALUES ('Example Partner', 'example-partner', 'technology', 'published', 'Real description')`
  ).run();
  html = await text(await get(handlePublicRoute, env, '/'));
  assert.match(html, /id="partners"/);
  assert.match(html, /href="\/partners"/);
  const page = await text(await get(handlePublicRoute, env, '/partners'));
  assert.match(page, /Example Partner/);

  await env.db.prepare(`UPDATE lummet_brands SET status = 'draft'`).run();
  html = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(html, /id="brands"/);
  assert.doesNotMatch(html, /hero-graph/);
});

test('with no contact email, no mailto link appears anywhere; the contact form still works', async () => {
  const env = createPublicEnv({ contactEmail: '' });
  let html = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(html, /mailto:/);
  assert.match(html, /id="contact"/); // the section links to the /contact form instead
  assert.match(html, /href="\/contact"/);
});

test('with no contact email AND no published contact form, the contact section and its links disappear', async () => {
  const env = createPublicEnv({ contactEmail: '' });
  await env.db.prepare(`UPDATE lummet_forms SET status = 'draft' WHERE form_key = 'contact'`).run();
  const html = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(html, /id="contact"/);
  assert.doesNotMatch(html, /mailto:/);
  assert.doesNotMatch(html, /href="\/contact"/);
});

test('hero CTAs never point at a section that is not on the page', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_homepage_sections SET status = 'draft' WHERE section_key = 'demo'`).run();
  const html = await text(await get(handlePublicRoute, env, '/'));
  const hero = html.slice(html.indexOf('class="hero"'), html.indexOf('</section>', html.indexOf('class="hero"')));
  assert.doesNotMatch(hero, /href="#demo"/);
});

// -------------------------------------------------------------------- SEO

test('canonical, OG and JSON-LD come from the record\'s own seo fields', async () => {
  const env = createPublicEnv();
  await env.db.prepare(
    `UPDATE lummet_brands SET seo_title = 'Custom SEO Title', seo_description = 'Custom SEO description.', og_image = '/static/images/brands/level-casino.png' WHERE slug = 'level-casino'`
  ).run();
  const html = await text(await get(handlePublicRoute, env, '/brands/level-casino'));
  assert.match(html, /<title>Custom SEO Title · Lummet<\/title>/);
  assert.match(html, /<meta name="description" content="Custom SEO description\.">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/lummet\.com\/brands\/level-casino">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/lummet\.com\/static\/images\/brands\/level-casino\.png">/);
  assert.match(html, /"@type":"BreadcrumbList"/);
});

test('article pages emit Article JSON-LD with real dates and author', async () => {
  const env = createPublicEnv();
  const html = await text(await get(handlePublicRoute, env, '/insights/default-deny-access-for-staff'));
  assert.match(html, /"@type":"Article"/);
  assert.match(html, /"datePublished":"2026-09-30"/);
  assert.match(html, /"name":"Lummet Team"/);
  assert.match(html, /<meta property="og:type" content="article">/);
});

test('FAQ section emits FAQPage JSON-LD from the faq table', async () => {
  const env = createPublicEnv();
  const html = await text(await get(handlePublicRoute, env, '/'));
  assert.match(html, /"@type":"FAQPage"/);
  assert.match(html, /What is Lummet\?/);
});

test('sitemap lists only published, resolvable URLs; robots points at it', async () => {
  const env = createPublicEnv();
  const xml = await text(await get(handlePublicRoute, env, '/sitemap.xml'));
  assert.match(xml, /<loc>https:\/\/lummet\.com\/<\/loc>/);
  assert.match(xml, /<loc>https:\/\/lummet\.com\/brands\/level-casino<\/loc>/);
  assert.match(xml, /<loc>https:\/\/lummet\.com\/about<\/loc>/);
  assert.doesNotMatch(xml, /\/partners/); // none published
  const robots = await text(await get(handlePublicRoute, env, '/robots.txt'));
  assert.match(robots, /Sitemap: https:\/\/lummet\.com\/sitemap\.xml/);
  assert.match(robots, /Disallow: \/cms\//);
});

test('canonical base falls back to the request origin when the setting is blank', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`DELETE FROM lummet_site_settings WHERE key = 'canonical_url'`).run();
  const html = await text(await get(handlePublicRoute, env, '/brands'));
  assert.match(html, /<link rel="canonical" href="https:\/\/lummet\.test\/brands">/);
});

// --------------------------------------------------------------- security

test('XSS: CMS rich text is sanitized and CMS URLs cannot carry javascript:', async () => {
  const env = createPublicEnv();
  await env.db.prepare(
    `UPDATE lummet_brands SET description = '<p>ok</p><script>alert(1)</script><img src=x onerror=alert(2)>', website_url = 'javascript:alert(3)', logo_url = 'javascript:alert(4)' WHERE slug = 'freewin'`
  ).run();
  const html = await text(await get(handlePublicRoute, env, '/brands/freewin'));
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /onerror/);
  assert.doesNotMatch(html, /javascript:/);
  assert.match(html, /<p>ok<\/p>/);
});

test('XSS: plain-text fields are escaped in HTML and JSON-LD', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_brands SET name = 'A<b>"&' WHERE slug = 'freewin'`).run();
  const html = await text(await get(handlePublicRoute, env, '/brands/freewin'));
  assert.ok(html.includes('A&lt;b&gt;&quot;&amp;'));
  assert.doesNotMatch(html, /A<b>/);
  const ld = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s)[1];
  assert.doesNotMatch(ld, /</);
  JSON.parse(ld);
});

test('XSS: an accent colour that is not a plain colour is dropped, not injected into <style>', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`INSERT INTO lummet_site_settings (key, value) VALUES ('accent_color', 'red;} body{display:none')`).run();
  const html = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(html, /display:none/);
});

test('security headers and CSP are set on public pages', async () => {
  const env = createPublicEnv();
  const res = await get(handlePublicRoute, env, '/');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(res.headers.get('cache-control'), /s-maxage=60/);
  const html = await text(res);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*ld\+json)[^>]*>/); // no inline scripts (CSP)
});

test('sanitizer keeps normal formatting', () => {
  assert.equal(sanitizeHtml('<h2>T</h2><ul><li><strong>x</strong></li></ul>'), '<h2>T</h2><ul><li><strong>x</strong></li></ul>');
});

// ------------------------------------------------------ pagination + filter

test('updates paginate and are newest-first', async () => {
  const env = createPublicEnv();
  for (let i = 0; i < 12; i++) {
    await env.db.prepare(
      `INSERT INTO lummet_updates (slug, title, status, published_at) VALUES (?, ?, 'published', ?)`
    ).bind(`extra-${i}`, `Extra ${i}`, `2026-10-${String(i + 1).padStart(2, '0')}`).run();
  }
  const p1 = await text(await get(handlePublicRoute, env, '/updates'));
  assert.ok(p1.indexOf('Extra 11') < p1.indexOf('Extra 10'));
  assert.match(p1, /rel="next"/);
  const p2 = await text(await get(handlePublicRoute, env, '/updates?page=2'));
  assert.match(p2, /rel="prev"/);
  assert.match(p2, /<link rel="canonical" href="https:\/\/lummet\.com\/updates\?page=2">/);
});

test('insights filter by type; filtered views are noindex', async () => {
  const env = createPublicEnv();
  await env.db.prepare(
    `INSERT INTO lummet_publications (slug, title, publication_type, status, published_at, source_name, source_url) VALUES ('press-1', 'Press piece', 'press', 'published', '2026-10-01', 'Some Outlet', 'https://outlet.example/story')`
  ).run();
  const all = await text(await get(handlePublicRoute, env, '/insights'));
  assert.match(all, /Press piece/);
  assert.match(all, /class="chip is-active"/);
  const press = await text(await get(handlePublicRoute, env, '/insights?type=press'));
  assert.match(press, /Press piece/);
  assert.doesNotMatch(press, /How signed requests work/);
  assert.match(press, /noindex/);
  const detail = await text(await get(handlePublicRoute, env, '/insights/press-1'));
  assert.match(detail, /outlet\.example/);
});

test('brand filter appears only when a category is shared, ships hidden (progressive enhancement), cards carry data-category', async () => {
  const env = createPublicEnv();
  let html = await text(await get(handlePublicRoute, env, '/brands'));
  assert.doesNotMatch(html, /data-filter-bar/); // seeded categories are all distinct: a filter would be noise
  await env.db.prepare(`UPDATE lummet_brands SET category = 'Sports' WHERE slug IN ('neuroodds', 'legendodds')`).run();
  html = await text(await get(handlePublicRoute, env, '/brands'));
  assert.match(html, /data-filter-bar hidden/);
  assert.match(html, /data-category="Sports"/);
});

test('logo: a brand with a logo shows it; a brand without one shows initials, not a fake logo', async () => {
  const env = createPublicEnv();
  const html = await text(await get(handlePublicRoute, env, '/brands'));
  assert.match(html, /src="\/static\/images\/brands\/level-casino\.png"/);
  assert.match(html, /brand-initials/);
  assert.equal((html.match(/class="brand-thumb"/g) || []).length, 1);
});

test('the AI panel, steps and capability cards are read from lummet_features', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_features SET title = 'Renamed capability' WHERE feature_key = 'cap-ai'`).run();
  const html = await text(await get(handlePublicRoute, env, '/'));
  assert.match(html, /Renamed capability/);
  assert.match(html, /Preview before anything is written/);
  assert.match(html, /class="step-no">01</);
});


// ---------------------------------------------------------------- Round 6.2A public trust pages acceptance tests

test('Round 6.2A trust pages render with CSP and only safe configured links', async () => {
  const env = createPublicEnv();
  Object.assign(env, {
    PUBLIC_TRUST_PAGES: 'on', STATUS_PROVIDER_URL: 'https://status.example.test/',
    SECURITY_CONTACT: 'mailto:security@example.test',
    SECURITY_TXT_EXPIRES: '2027-01-01T00:00:00Z',
    PUBLIC_FORMS_TURNSTILE_REQUIRED: 'on', TURNSTILE_SITE_KEY: 'public-test-site-key', TURNSTILE_SECRET_KEY: 'test-secret'
  });
  for (const path of ['/status', '/security', '/changelog', '/contact-sales']) {
    const res = await get(handlePublicRoute, env, path);
    assert.equal(res.status, 200, path);
    assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/, path);
    assert.match(res.headers.get('content-type') || '', /text\/html/, path);
    const html = await res.text();
    assert.match(html, /<html/i, path);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/i, `${path} contains inline executable script content`);
    assert.doesNotMatch(html, /\{\{[^}]+\}\}/, `${path} has unresolved template tags`);
  }
  const status = await (await get(handlePublicRoute, env, '/status')).text();
  assert.match(status, /https:\/\/status\.example\.test\//);
  const security = await (await get(handlePublicRoute, env, '/security')).text();
  assert.match(security, /security@example\.test/);
  const sales = await (await get(handlePublicRoute, env, '/contact-sales')).text();
  assert.match(sales, /<form[^>]+action="\/contact-sales"/i);
  assert.match(sales, /cf-turnstile/i);
  const salesResponse = await get(handlePublicRoute, env, '/contact-sales');
  assert.match(salesResponse.headers.get('content-security-policy') || '', /challenges\.cloudflare\.com/);
  // live pages carry no [OPEN] markers and are indexable
  for (const path of ['/status', '/security', '/changelog']) {
    const live = await (await get(handlePublicRoute, env, path)).text();
    assert.doesNotMatch(live, /\[OPEN\]/, `${path} must not show [OPEN] when on`);
    assert.doesNotMatch(live, /noindex/, `${path} is indexable when on`);
  }
  // shadow: renders for review, noindex, preview notice, no outbound status link
  const shadowEnv = createPublicEnv();
  Object.assign(shadowEnv, { STATUS_PROVIDER_URL: 'https://status.example.test/', PUBLIC_TRUST_PAGES: 'shadow' });
  const preview = await (await get(handlePublicRoute, shadowEnv, '/status')).text();
  assert.match(preview, /rollout is not enabled/);
  assert.match(preview, /\[OPEN\]/);
  assert.match(preview, /noindex/);
  assert.doesNotMatch(preview, /href="https:\/\/status\.example\.test\//);
  const shadowSales = await (await get(handlePublicRoute, shadowEnv, '/contact-sales')).text();
  assert.match(shadowSales, /noindex/);
  const salesPostEnv = createPublicEnv();
  salesPostEnv.PUBLIC_TRUST_PAGES = 'on';
  const submitted = await post(handlePublicRoute, salesPostEnv, '/contact-sales', {
    f_name: 'Sales Visitor', f_email: 'sales@example.test', f_message: 'Please contact me about sales.'
  });
  assert.equal(submitted.status, 303);
  assert.equal(submitted.headers.get('location'), '/contact-sales?sent=1');
});

test('Round 6.2A security.txt uses valid contact and expiry fields with security headers', async () => {
  const env = createPublicEnv();
  Object.assign(env, {
    PUBLIC_TRUST_PAGES: 'on',
    SECURITY_CONTACT: 'mailto:security@example.test',
    SECURITY_TXT_EXPIRES: '2027-01-01T00:00:00Z'
  });
  const res = await get(handlePublicRoute, env, '/.well-known/security.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/plain/);
  assert.match(res.headers.get('content-security-policy') || '', /default-src 'self'/);
  const body = await res.text();
  assert.match(body, /^Contact: mailto:security@example\.test$/m);
  assert.match(body, /^Expires: 2027-01-01T00:00:00Z$/m);
  assert.match(body, /^Preferred-Languages: en$/m);
});

test('Round 6.2A trust settings are required in production config-check', async () => {
  const { configIssues } = await import('../worker/config-check.js');
  const env = { ENVIRONMENT: 'production' };
  const issues = configIssues(env);
  for (const key of ['STATUS_PROVIDER_URL', 'SECURITY_CONTACT', 'SECURITY_TXT_EXPIRES']) {
    assert.ok(issues.some((issue) => issue.key === key), `${key} should be required`);
  }
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging' }), []);
});

test('Round 6.2A flag off keeps every trust route inert and legacy behaviour intact', async () => {
  const env = createPublicEnv();
  Object.assign(env, { PUBLIC_TRUST_PAGES: 'off', STATUS_PROVIDER_URL: 'https://status.example.test/', SECURITY_CONTACT: 'mailto:security@example.test', SECURITY_TXT_EXPIRES: '2030-01-01T00:00:00Z' });
  for (const path of ['/status', '/changelog', '/contact-sales', '/.well-known/security.txt']) {
    const res = await get(handlePublicRoute, env, path);
    assert.equal(res.status, 404, `${path} must be 404 when off`);
  }
  const post404 = await post(handlePublicRoute, env, '/contact-sales', { f_name: 'A', f_email: 'a@example.test', f_message: 'hello there' });
  assert.equal(post404.status, 404);
  const unset = createPublicEnv();
  assert.equal((await get(handlePublicRoute, unset, '/status')).status, 404, 'unset flag behaves as off');
});

test('Round 6.2A security.txt is served only when on, and fails closed on bad or expired config', async () => {
  const base = { SECURITY_CONTACT: 'mailto:security@example.test', SECURITY_TXT_EXPIRES: '2030-01-01T00:00:00Z' };
  const shadow = createPublicEnv(); Object.assign(shadow, base, { PUBLIC_TRUST_PAGES: 'shadow' });
  assert.equal((await get(handlePublicRoute, shadow, '/.well-known/security.txt')).status, 404);
  const expired = createPublicEnv(); Object.assign(expired, base, { PUBLIC_TRUST_PAGES: 'on', SECURITY_TXT_EXPIRES: '2020-01-01T00:00:00Z' });
  assert.equal((await get(handlePublicRoute, expired, '/.well-known/security.txt')).status, 503);
  const badContact = createPublicEnv(); Object.assign(badContact, base, { PUBLIC_TRUST_PAGES: 'on', SECURITY_CONTACT: 'javascript:alert(1)' });
  assert.equal((await get(handlePublicRoute, badContact, '/.well-known/security.txt')).status, 503);
  const ok = createPublicEnv(); Object.assign(ok, base, { PUBLIC_TRUST_PAGES: 'on' });
  const res = await get(handlePublicRoute, ok, '/.well-known/security.txt');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('Round 6.2A /status and /security never emit unsafe configured links', async () => {
  const env = createPublicEnv();
  Object.assign(env, { PUBLIC_TRUST_PAGES: 'on', STATUS_PROVIDER_URL: 'http://insecure.example.test/', SECURITY_CONTACT: 'javascript:alert(1)' });
  const status = await (await get(handlePublicRoute, env, '/status')).text();
  assert.doesNotMatch(status, /insecure\.example\.test/);
  const sec = await (await get(handlePublicRoute, env, '/security')).text();
  assert.doesNotMatch(sec, /javascript:/i);
  const xss = createPublicEnv();
  Object.assign(xss, { PUBLIC_TRUST_PAGES: 'on', SECURITY_CONTACT: 'https://x.example.test/a?b=1&c=\"><script>1</script>' });
  const html = await (await get(handlePublicRoute, xss, '/security')).text();
  assert.doesNotMatch(html, /<script>1<\/script>/);
});

test('Round 6.2A links on trust pages resolve to routes the site serves', async () => {
  const env = createPublicEnv();
  Object.assign(env, { PUBLIC_TRUST_PAGES: 'on', STATUS_PROVIDER_URL: 'https://status.example.test/', SECURITY_CONTACT: 'mailto:security@example.test', SECURITY_TXT_EXPIRES: '2030-01-01T00:00:00Z' });
  const html = await (await get(handlePublicRoute, env, '/security')).text();
  const internal = [...html.matchAll(/href="(\/[^"#?]*)"/g)].map((m) => m[1]).filter((h) => !h.startsWith('/static/') && isPublicPath(h));
  assert.ok(internal.includes('/.well-known/security.txt'));
  for (const href of new Set(internal)) {
    const r = await get(handlePublicRoute, env, href);
    assert.ok(r && r.status < 400, `${href} must resolve (got ${r && r.status})`);
  }
});
