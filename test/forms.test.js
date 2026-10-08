// test/forms.test.js
// Contact / demo forms, interface text, sticky footer and link liveness.
// Real migrations + seed, real templates, real router.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { isLiveHref } from '../worker/public-site/links.js';
import { validateSubmission, buildInquiryRecord } from '../worker/public-site/forms.js';
import { createCmsRecord, updateCmsRecord } from '../worker/cms.js';
import { applyMigrations } from './support/d1-shim.js';
import { createPublicEnv, get, post } from './support/public-env.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const text = (r) => r.text();
const valid = { f_name: 'Ada Lovelace', f_email: 'ada@example.test', f_message: 'Hello, I would like to talk about licensing.' };
const inquiries = async (env) => (await env.db.prepare('SELECT * FROM lummet_inquiries ORDER BY id').all()).results;

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// -------------------------------------------------------------- migration

test('0008 is re-runnable and seeds two forms, their fields and the interface text', async () => {
  const env = createPublicEnv();
  applyMigrations(env.db);
  const n = async (t) => (await env.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first()).n;
  assert.equal(await n('lummet_forms'), 2);
  assert.equal(await n('lummet_form_fields'), 11);
  assert.ok((await n('lummet_ui_strings')) >= 75);
});

test('0008 repoints old demo/contact links, but never overwrites an admin edit', async () => {
  const env = createPublicEnv();
  const cta = await env.db.prepare(`SELECT href, visible_when FROM lummet_nav_links WHERE placement='header_cta' AND label='Get a Demo'`).first();
  assert.deepEqual({ ...cta }, { href: '/demo', visible_when: 'form:demo' });
  await env.db.prepare(`UPDATE lummet_nav_links SET href = '/custom' WHERE placement='header_cta' AND label='Get a Demo'`).run();
  applyMigrations(env.db);
  const after = await env.db.prepare(`SELECT href FROM lummet_nav_links WHERE placement='header_cta' AND label='Get a Demo'`).first();
  assert.equal(after.href, '/custom');
});

// ------------------------------------------------- nothing hardcoded (guards)

test('every ui.<key> used by a template exists in the seeded interface text', async () => {
  const env = createPublicEnv();
  const seeded = new Set((await env.db.prepare('SELECT ui_key FROM lummet_ui_strings').all()).results.map((r) => r.ui_key));
  const used = new Set();
  for (const f of walk(join(ROOT, 'public/templates'))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bui\.(\w+)/g)) used.add(m[1]);
  }
  assert.ok(used.size > 40);
  const missing = [...used].filter((k) => !seeded.has(k));
  assert.deepEqual(missing, []);
});

test('templates contain no literal user-facing text (only {{ }} values)', () => {
  const offenders = [];
  for (const f of walk(join(ROOT, 'public/templates'))) {
    const src = readFileSync(f, 'utf8').replace(/\{\{[^}]*\}\}+/g, '').replace(/&[a-z]+;/g, '').replace(/<script[\s\S]*?<\/script>/g, '');
    for (const m of src.matchAll(/>([^<>]+)</g)) {
      if (/[A-Za-z]{2,}/.test(m[1].trim()) && m[1].trim() !== '404') offenders.push(`${f}: ${m[1].trim()}`);
    }
    for (const m of src.matchAll(/\b(aria-label|alt|title|placeholder)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) offenders.push(`${f}: ${m[1]}="${m[2]}"`);
  }
  assert.deepEqual(offenders, []);
});

test('client scripts carry no UI strings of their own', () => {
  for (const f of walk(join(ROOT, 'public/static/js'))) {
    const src = readFileSync(f, 'utf8');
    for (const phrase of ['Open menu', 'Close menu', 'Link copied', 'Sending', 'Copy link']) assert.ok(!src.includes(phrase), `${f}: ${phrase}`);
  }
});

test('editing interface text in the database changes the rendered page', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_ui_strings SET value = 'Open profile' WHERE ui_key = 'view_profile'`).run();
  await env.db.prepare(`UPDATE lummet_ui_strings SET value = 'Rechte vorbehalten.' WHERE ui_key = 'rights'`).run();
  const html = await text(await get(handlePublicRoute, env, '/brands'));
  assert.match(html, /Open profile/);
  assert.match(html, /Rechte vorbehalten\./);
  assert.doesNotMatch(html, /View profile/);
});

// ------------------------------------------------------------------ pages

test('/contact and /demo render from the database through the shared layout', async () => {
  const env = createPublicEnv();
  for (const [path, title, label] of [['/contact', 'Get in touch', 'Your name'], ['/demo', 'Request a demo', 'Work email']]) {
    const res = await get(handlePublicRoute, env, path);
    assert.equal(res.status, 200, path);
    const html = await text(res);
    assert.ok(html.includes(`<h1>${title}</h1>`), path);
    assert.ok(html.includes(label), path);
    assert.match(html, /<footer class="site-footer"/);
    assert.match(html, new RegExp(`<form method="post" action="${path}"`));
    assert.match(html, /name="hp_website"/);
    assert.match(html, /"@type":"ContactPage"/);
    assert.equal((html.match(/\{\{/g) || []).length, 0, path);
  }
});

test('changing a form field in the database changes the page (label, required, select options)', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_form_fields SET label = 'Full name', required = 0 WHERE form_key='contact' AND field_key='name'`).run();
  await env.db.prepare(`UPDATE lummet_form_fields SET options = 'Alpha\nBeta' WHERE form_key='contact' AND field_key='topic'`).run();
  await env.db.prepare(`UPDATE lummet_form_fields SET status = 'draft' WHERE form_key='contact' AND field_key='company'`).run();
  const html = await text(await get(handlePublicRoute, env, '/contact'));
  assert.match(html, /Full name/);
  assert.match(html, /<option value="Alpha">Alpha<\/option>/);
  assert.doesNotMatch(html, /Company or brand/);
  assert.doesNotMatch(html, /id="contact-name"[^>]*required/);
});

test('a form can be added from the dashboard data alone (/forms/:key) and appears in the sitemap', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`INSERT INTO lummet_forms (form_key, title, submit_label, success_title, success_message, status) VALUES ('press','Press enquiries','Send','Sent','<p>Done.</p>','published')`).run();
  await env.db.prepare(`INSERT INTO lummet_form_fields (form_key, field_key, label, type, required, sort_order) VALUES ('press','email','Email','email',1,1)`).run();
  assert.equal((await get(handlePublicRoute, env, '/forms/press')).status, 200);
  const xml = await text(await get(handlePublicRoute, env, '/sitemap.xml'));
  assert.match(xml, /\/forms\/press</);
  assert.match(xml, /\/contact</);
  assert.match(xml, /\/demo</);
});

test('draft forms and unknown forms are 404 for GET and POST', async () => {
  const env = createPublicEnv();
  await env.db.prepare(`UPDATE lummet_forms SET status='draft' WHERE form_key='demo'`).run();
  assert.equal((await get(handlePublicRoute, env, '/demo')).status, 404);
  assert.equal((await post(handlePublicRoute, env, '/demo', valid)).status, 404);
  assert.equal((await get(handlePublicRoute, env, '/forms/nope')).status, 404);
  assert.equal((await post(handlePublicRoute, env, '/forms/nope', valid)).status, 404);
  assert.equal((await inquiries(env)).length, 0);
});

// ------------------------------------------------------------- submission

test('a valid submission is stored, redirected (PRG) and the success text comes from the database', async () => {
  const env = createPublicEnv();
  const res = await post(handlePublicRoute, env, '/contact', { ...valid, f_company: 'Analytical Engines', f_topic: 'Technology licensing' }, { headers: { 'cf-connecting-ip': '203.0.113.9' } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/contact?sent=1');
  const rows = await inquiries(env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].form_key, 'contact');
  assert.equal(rows[0].name, 'Ada Lovelace');
  assert.equal(rows[0].email, 'ada@example.test');
  assert.equal(rows[0].status, 'new');
  assert.match(rows[0].summary, /^Hello, I would like/);
  assert.match(rows[0].details, /Company or brand: Analytical Engines/);
  assert.equal(JSON.parse(rows[0].payload).fields.length, 5);
  assert.equal(rows[0].ip_hash.length, 64);
  assert.doesNotMatch(rows[0].ip_hash, /203\.0\.113/);

  await env.db.prepare(`UPDATE lummet_forms SET success_title = 'Danke!' WHERE form_key='contact'`).run();
  const sent = await get(handlePublicRoute, env, '/contact?sent=1');
  const html = await text(sent);
  assert.match(html, /Danke!/);
  assert.doesNotMatch(html, /<form /);
  assert.equal(sent.headers.get('cache-control'), 'no-store');
  assert.match(html, /noindex/);
});

test('invalid submissions re-render the form with field errors and keep what was typed; nothing is stored', async () => {
  const env = createPublicEnv();
  const res = await post(handlePublicRoute, env, '/contact', { f_name: '', f_email: 'not-an-email', f_message: 'Keep this text' });
  assert.equal(res.status, 422);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const html = await text(res);
  assert.match(html, /This field is required\./);
  assert.match(html, /Enter a valid email address\./);
  assert.match(html, /Please correct the highlighted fields\./);
  assert.match(html, /Keep this text/);
  assert.match(html, /value="not-an-email"/);
  assert.equal((await inquiries(env)).length, 0);
});

test('a select value that is not one of the stored options is rejected (cannot be forged)', async () => {
  const env = createPublicEnv();
  const res = await post(handlePublicRoute, env, '/contact', { ...valid, f_topic: 'Free money' });
  assert.equal(res.status, 422);
  assert.match(await text(res), /Choose one of the listed options\./);
});

test('over-long and oversized submissions are refused', async () => {
  const env = createPublicEnv();
  const long = await post(handlePublicRoute, env, '/contact', { ...valid, f_name: 'x'.repeat(500) });
  assert.equal(long.status, 422);
  const big = await post(handlePublicRoute, env, '/contact', valid, { headers: { 'content-length': String(200 * 1024) } });
  assert.equal(big.status, 413);
  assert.equal((await inquiries(env)).length, 0);
});

test('honeypot: a bot that fills the hidden field is told it worked and nothing is stored', async () => {
  const env = createPublicEnv();
  const res = await post(handlePublicRoute, env, '/contact', { ...valid, hp_website: 'http://spam.test' });
  assert.equal(res.status, 303);
  assert.equal((await inquiries(env)).length, 0);
});

test('cross-site POSTs are refused (same-origin check) and nothing is stored', async () => {
  const env = createPublicEnv();
  const evil = await post(handlePublicRoute, env, '/contact', valid, { headers: { origin: 'https://evil.test' } });
  assert.equal(evil.status, 403);
  const nullOrigin = await post(handlePublicRoute, env, '/contact', valid, { headers: { origin: 'null' } });
  assert.equal(nullOrigin.status, 403);
  const fetchSite = await post(handlePublicRoute, env, '/contact', valid, { headers: { origin: '', 'sec-fetch-site': 'cross-site' } });
  assert.equal(fetchSite.status, 403);
  assert.equal((await inquiries(env)).length, 0);
});

test('per-IP hourly limit (default 5, adjustable in settings) returns 429 with database text', async () => {
  const env = createPublicEnv();
  const ip = { 'cf-connecting-ip': '198.51.100.7' };
  for (let i = 0; i < 5; i++) assert.equal((await post(handlePublicRoute, env, '/contact', valid, { headers: ip })).status, 303);
  const blocked = await post(handlePublicRoute, env, '/contact', valid, { headers: ip });
  assert.equal(blocked.status, 429);
  assert.match(await text(blocked), /Too many submissions/);
  const other = await post(handlePublicRoute, env, '/contact', valid, { headers: { 'cf-connecting-ip': '198.51.100.8' } });
  assert.equal(other.status, 303);

  await env.db.prepare(`INSERT INTO lummet_site_settings (key, value) VALUES ('inquiry_rate_limit_per_hour', '7')`).run();
  assert.equal((await post(handlePublicRoute, env, '/contact', valid, { headers: ip })).status, 303);
});

test('XSS: visitor input is escaped when echoed back and stored as plain text', async () => {
  const env = createPublicEnv();
  const payload = '"><script>alert(1)</script>';
  const res = await post(handlePublicRoute, env, '/contact', { f_name: payload, f_email: 'bad', f_message: payload });
  const html = await text(res);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('optional webhook: one JSON POST per submission, https only, never blocks the visitor', async () => {
  const env = createPublicEnv();
  env.INQUIRY_WEBHOOK_URL = 'https://hooks.example.test/abc';
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); };
  try {
    const pending = [];
    const res = await post(handlePublicRoute, env, '/demo', { f_name: 'Grace', f_email: 'grace@example.test', f_company: 'Navy' }, { ctx: { waitUntil: (p) => pending.push(p) } });
    await Promise.all(pending);
    assert.equal(res.status, 303);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://hooks.example.test/abc');
    assert.match(calls[0].body.text, /New demo inquiry #1 from Grace grace@example\.test/);

    env.INQUIRY_WEBHOOK_URL = 'http://insecure.test/x';
    await post(handlePublicRoute, env, '/demo', { f_name: 'Grace', f_email: 'grace@example.test', f_company: 'Navy' });
    assert.equal(calls.length, 1);

    env.INQUIRY_WEBHOOK_URL = 'https://hooks.example.test/abc';
    globalThis.fetch = async () => { throw new Error('down'); };
    const ok = await post(handlePublicRoute, env, '/demo', { f_name: 'Grace', f_email: 'grace@example.test', f_company: 'Navy' });
    assert.equal(ok.status, 303); // a dead webhook never loses the inquiry
    assert.equal((await inquiries(env)).length, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('buildInquiryRecord / validateSubmission: unit behaviour', () => {
  const fields = [
    { field_key: 'name', label: 'Name', type: 'text', required: 1, max_length: 20 },
    { field_key: 'email', label: 'Email', type: 'email', required: 1, max_length: 254 },
    { field_key: 'message', label: 'Message', type: 'textarea', required: 0, max_length: 100 }
  ];
  const fd = new URLSearchParams({ f_name: 'A\u0007B', f_email: 'a@b.co', f_message: 'line1\r\nline2' });
  const { values, ok } = validateSubmission(fields, fd, {});
  assert.ok(ok);
  assert.equal(values.name, 'AB'); // control characters removed
  assert.equal(values.message, 'line1\nline2');
  const rec = buildInquiryRecord('contact', fields, values);
  assert.equal(rec.name, 'AB');
  assert.equal(rec.email, 'a@b.co');
  assert.match(rec.details, /Message:\nline1\nline2/);
});

// ------------------------------------------------------ links + navigation

test('header button, hero button and footer link point at the new pages; they vanish with their form', async () => {
  const env = createPublicEnv();
  let html = await text(await get(handlePublicRoute, env, '/'));
  assert.match(html, /href="\/demo"/);
  assert.match(html, /href="\/contact"/);
  assert.doesNotMatch(html, /href="#demo"/);
  assert.doesNotMatch(html, /href="\/#demo"/);

  await env.db.prepare(`UPDATE lummet_forms SET status='draft' WHERE form_key='demo'`).run();
  html = await text(await get(handlePublicRoute, env, '/'));
  assert.doesNotMatch(html, /href="\/demo"/);
  assert.doesNotMatch(html, /id="demo"/);
  assert.match(html, /href="\/contact"/);
});

test('the homepage contact section links to /contact and shows the email as plain contact data', async () => {
  const env = createPublicEnv();
  const html = await text(await get(handlePublicRoute, env, '/'));
  const section = html.slice(html.indexOf('id="contact"'));
  assert.match(section, /href="\/contact"/);
  assert.match(section, /mailto:hello@example\.test/);
});

test('isLiveHref', () => {
  const counts = { brands: 1, updates: 0, publications: 2, partners: 0, formKeys: new Set(['contact']), pageSlugs: new Set(['about']) };
  const live = (h, anchors) => isLiveHref(h, { counts, anchors });
  assert.equal(live('/brands'), true);
  assert.equal(live('/updates'), false);
  assert.equal(live('/partners'), false);
  assert.equal(live('/contact'), true);
  assert.equal(live('/demo'), false);
  assert.equal(live('/about'), true);
  assert.equal(live('/terms'), false);
  assert.equal(live('/p/about'), true);
  assert.equal(live('#faq', new Set(['faq'])), true);
  assert.equal(live('#faq', new Set()), false);
  assert.equal(live('https://example.test'), true);
  assert.equal(live('javascript:alert(1)'), false);
  assert.equal(live(''), false);
  assert.equal(live('/login'), true);
});

// ------------------------------------------------------------- sticky footer

test('sticky footer: body is a full-height flex column and <main> grows', () => {
  const css = readFileSync(join(ROOT, 'public/static/css/base.css'), 'utf8');
  assert.match(css, /body\s*\{[^}]*min-height:\s*100dvh;[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s);
  assert.match(css, /main\s*\{[^}]*flex:\s*1 0 auto/);
  const base = readFileSync(join(ROOT, 'public/templates/layout/base.html'), 'utf8');
  assert.match(base, /<main id="main">[\s\S]*<\/main>\s*\{\{> layout\/footer\}\}/); // footer is a direct child of <body>, after <main>
});

// ----------------------------------------------------- dashboard (CMS) side

test('inquiries are read-only for admins except status and notes; they cannot be created by hand', async () => {
  const env = createPublicEnv();
  await post(handlePublicRoute, env, '/contact', valid);
  const before = (await inquiries(env))[0];
  const res = await updateCmsRecord(env, 'inquiries', before.id, { status: 'replied', admin_notes: 'Called back', name: 'FORGED', email: 'forged@x.test', details: 'FORGED' });
  assert.equal(res.ok, true);
  const after = (await inquiries(env))[0];
  assert.equal(after.status, 'replied');
  assert.equal(after.admin_notes, 'Called back');
  assert.equal(after.name, before.name);
  assert.equal(after.email, before.email);
  assert.equal(after.details, before.details);
  const created = await createCmsRecord(env, 'inquiries', { status: 'new' });
  assert.equal(created.ok, false);
  assert.equal(created.status, 405);
});

test('blank number fields fall back to their default instead of failing NOT NULL', async () => {
  const env = createPublicEnv();
  const res = await createCmsRecord(env, 'form_fields', { form_key: 'contact', field_key: 'phone', label: 'Phone', type: 'tel', required: '', max_length: '', status: 'published', sort_order: '' });
  assert.equal(res.ok, true, JSON.stringify(res));
  const row = await env.db.prepare(`SELECT required, max_length, sort_order FROM lummet_form_fields WHERE field_key='phone'`).first();
  assert.deepEqual({ ...row }, { required: 0, max_length: 2000, sort_order: 0 });
  const html = await text(await get(handlePublicRoute, env, '/contact'));
  assert.match(html, /type="tel"/);
});
