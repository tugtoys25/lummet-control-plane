// Release 2.6.0.20, round H.5: the organization sessions page, the "your session was ended" email, trust and legal routes in the sitemap,
// and a separate inquiry record for /contact-sales. Real Worker entry point, migrated in-memory database, fake email transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as totp from '../worker/totp.js';
import { decryptSecret, aadFor } from '../worker/crypto.js';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createPublicEnv, get, post } from './support/public-env.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
function env(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), CUSTOMER_SESSION_ADMIN: 'on', PORTAL_BASE_URL: 'https://app.example.test',
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }), ...extra };
}
let ip = 0;
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': `203.0.113.${(++ip % 250) + 1}` });
  if (cookie) h.set('Cookie', cookie);
  if (body != null) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body == null ? undefined : JSON.stringify(body), redirect: 'manual' }), e, ctx);
  const text = await response.text(); let json = null; try { json = JSON.parse(text); } catch (_) { json = null; }
  return { status: response.status, json, text, location: response.headers.get('Location'), cache: response.headers.get('Cache-Control'), cookie: (response.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function signup(e, email) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: 'Org ' + email });
  assert.equal(r.status, 200, r.text);
  return { cookie: r.cookie, organizationId: r.json.organizationId, userId: (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id };
}
async function member(e, org, email, role) {
  const u = await signup(e, email);
  await e.LUMMET_DB.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(org.organizationId, u.userId, role).run();
  const s = await customerAuth.createSession(e, u.userId, org.organizationId);
  return { ...u, cookie: s.cookie.split(';')[0], sessionId: s.sessionId, role };
}
async function world(e) {
  const owner = await signup(e, 'owner@example.test');
  const admin = await member(e, owner, 'admin@example.test', 'admin');
  const editor = await member(e, owner, 'editor@example.test', 'editor');
  return { owner, admin, editor, base: `/api/organizations/${owner.organizationId}` };
}
// Sign-up queues verification emails too, so look only at the session-ended notices.
const outbox = async (e) => (await e.LUMMET_DB.prepare("SELECT * FROM email_outbox WHERE dedupe_key LIKE 'session_revoked:%' ORDER BY rowid").all()).results;
const bodyOf = async (e, row) => JSON.parse(await decryptSecret(e, row.body_encrypted, row.body_iv, aadFor('email_outbox', row.id, 'body_encrypted')));

// ------------------------------------------------------------ the page

test('H.5 flag off: /app/sessions is not served and the nav has no Sessions link, for an owner too', async () => {
  for (const flag of ['off', undefined, 'maybe']) {
    const e = env({ CUSTOMER_SESSION_ADMIN: flag }); const w = await world(e);
    const page = await call(e, 'GET', '/app/sessions', null, w.owner.cookie);
    assert.equal(page.status, 302, `flag ${flag}`); assert.equal(page.location, '/app/overview');
    const overview = await call(e, 'GET', '/app/overview', null, w.owner.cookie);
    assert.equal(overview.status, 200); assert.ok(!overview.text.includes('/app/sessions'), `flag ${flag}: no link`);
  }
});

test('H.5 shadow and on: owners and admins get the page and the nav link; editors are sent to the overview and see no link', async () => {
  for (const mode of ['shadow', 'on']) {
    const e = env({ CUSTOMER_SESSION_ADMIN: mode }); const w = await world(e);
    for (const who of [w.owner, w.admin]) {
      const page = await call(e, 'GET', '/app/sessions', null, who.cookie);
      assert.equal(page.status, 200, `${mode} ${who.cookie ? 'ok' : ''}`);
      assert.equal(page.cache, 'no-store');
      assert.match(page.text, /<h1>Sessions<\/h1>/);
      assert.match(page.text, /href="\/app\/sessions"/, 'nav link');
      assert.equal(/Preview: ending a session here is a dry run/.test(page.text), mode === 'shadow');
    }
    const editor = await call(e, 'GET', '/app/sessions', null, w.editor.cookie);
    assert.equal(editor.status, 302); assert.equal(editor.location, '/app/overview');
    assert.ok(!(await call(e, 'GET', '/app/overview', null, w.editor.cookie)).text.includes('href="/app/sessions"'));
    assert.equal((await call(e, 'GET', '/app/sessions')).location, '/app/login', 'signed out goes to login');
  }
});

test('H.5 the page carries no session id or cookie value, uses a nonced script that parses, and writes dynamic text with textContent only', async () => {
  const e = env(); const w = await world(e);
  const page = await call(e, 'GET', '/app/sessions', null, w.owner.cookie);
  for (const s of [w.owner, w.admin, w.editor]) {
    assert.ok(!page.text.includes(s.cookie.split('=')[1] || 'x'.repeat(40)), 'cookie value must not appear');
    if (s.sessionId) assert.ok(!page.text.includes(s.sessionId));
  }
  const scripts = [...page.text.matchAll(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/g)];
  const mine = scripts.find((m) => m[2].includes('sessions-root'));
  assert.ok(mine, 'the page script is nonce-tokened');
  assert.doesNotThrow(() => new Function(mine[2]), 'the inline script parses');
  assert.ok(!/innerHTML/.test(mine[2]), 'no innerHTML');
  assert.match(mine[2], /\/sessions\/revoke/);
});

test('H.5 a session an organization 2FA policy restricts cannot reach the page (the restricted-session rule)', async () => {
  const e = env({ ORG_SECURITY_POLICY: 'enforce' });
  const owner = await signup(e, 'owner@example.test');
  const s = await call(e, 'POST', '/api/customer/2fa/setup', {}, owner.cookie);
  await call(e, 'POST', '/api/customer/2fa/confirm', { code: await totp.generateTotpCode(s.json.secret) }, owner.cookie);
  const admin = await member(e, owner, 'admin@example.test', 'admin');
  const on = await call(e, 'PUT', `/api/organizations/${owner.organizationId}/security-policy`, { require2fa: true, reason: 'Org rule from the security review' }, owner.cookie);
  assert.equal(on.status, 200, on.text);
  const page = await call(e, 'GET', '/app/sessions', null, admin.cookie);
  assert.equal(page.status, 403, 'the 2FA-required notice, not the page');
  assert.ok(!/<h1>Sessions<\/h1>/.test(page.text));
});

// ------------------------------------------------------------ the email

test('H.5 ending a member\'s session queues one fixed-text email to that member, naming the organization but never the reason', async () => {
  const e = env(); const w = await world(e);
  const reason = 'laptop reported stolen at the airport';
  const r = await call(e, 'POST', `${w.base}/sessions/revoke`, { userId: w.editor.userId, reason }, w.admin.cookie);
  assert.equal(r.status, 200, r.text); assert.equal(r.json.revoked >= 1, true);
  const rows = await outbox(e);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].to_email, 'editor@example.test');
  assert.equal(rows[0].organization_id, w.owner.organizationId);
  const body = await bodyOf(e, rows[0]);
  assert.match(rows[0].subject, /signed out/i);
  assert.match(body.text, /Org owner@example\.test/);
  for (const forbidden of [reason, 'stolen', 'admin@example.test', w.editor.sessionId, 'airport']) {
    assert.ok(!body.text.includes(forbidden) && !body.html.includes(forbidden) && !rows[0].subject.includes(forbidden), `email must not contain: ${forbidden}`);
  }
  assert.equal((await call(e, 'GET', '/api/organizations', null, w.editor.cookie)).status, 401, 'and the session really ended');
});

test('H.5 a dry run (shadow), a refused revoke and a missing reason queue no email', async () => {
  const shadow = env({ CUSTOMER_SESSION_ADMIN: 'shadow' }); let w = await world(shadow);
  const dry = await call(shadow, 'POST', `${w.base}/sessions/revoke`, { userId: w.editor.userId, reason: 'shadow dry run reason' }, w.admin.cookie);
  assert.equal(dry.json.shadow, true);
  assert.equal((await outbox(shadow)).length, 0);
  const e = env(); w = await world(e);
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { userId: w.editor.userId, reason: 'x' }, w.admin.cookie)).status, 422);
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { userId: w.admin.userId, reason: 'ending my own' }, w.editor.cookie)).status, 403);
  assert.equal((await call(e, 'POST', `${w.base}/sessions/revoke`, { userId: w.owner.userId, reason: 'admin cannot end owner' }, w.admin.cookie)).status, 403);
  assert.equal((await outbox(e)).length, 0);
});

test('H.5 an email that cannot be queued never undoes or hides the revoke, and is logged without the address', async () => {
  const e = env(); const w = await world(e);
  const broken = { ...e, CREDENTIAL_KEK: undefined };                      // queueing encrypts the body, so this makes it throw
  const logged = []; const orig = console.error; console.error = (...a) => logged.push(a.join(' '));
  let r;
  try { r = await call(broken, 'POST', `${w.base}/sessions/revoke`, { userId: w.editor.userId, reason: 'revoke with broken email' }, w.admin.cookie); }
  finally { console.error = orig; }
  assert.equal(r.status, 200, r.text); assert.equal(r.json.revoked >= 1, true);
  assert.equal((await outbox(e)).length, 0);
  assert.ok(logged.some((l) => l.includes('session_revoked_email_failed')));
  assert.ok(!logged.join('\n').includes('editor@example.test'), 'no address in the log');
});

// ------------------------------------------------------------ sitemap and contact-sales

const TRUST = ['/status', '/security', '/changelog', '/docs', '/contact-sales'];
const sitemap = async (e) => (await get(handlePublicRoute, e, '/sitemap.xml')).text();

test('H.5 sitemap lists the trust routes only when PUBLIC_TRUST_PAGES=on, each once', async () => {
  for (const mode of [undefined, 'off', 'shadow']) {
    const e = createPublicEnv(); if (mode) e.PUBLIC_TRUST_PAGES = mode;
    const xml = await sitemap(e);
    // /security is also a published CMS page that serves with trust pages off, so it may already be listed once from the CMS list.
    for (const p of TRUST.filter((x) => x !== '/security')) assert.ok(!xml.includes(`<loc>https://lummet.com${p}</loc>`), `${mode}: ${p} must not be listed`);
    assert.ok((xml.match(/<loc>https:\/\/lummet\.com\/security<\/loc>/g) || []).length <= 1, `${mode}: /security at most once`);
  }
  const e = createPublicEnv(); e.PUBLIC_TRUST_PAGES = 'on';
  const xml = await sitemap(e);
  for (const p of TRUST) assert.equal((xml.match(new RegExp(`<loc>https://lummet\\.com${p}</loc>`, 'g')) || []).length, 1, `${p} listed exactly once`);
  assert.ok(!xml.includes('/openapi.json'));
});

test('H.5 sitemap lists legal pages only with PUBLIC_LEGAL_PAGES=on AND a recorded approval and approved text; draft lists none', async () => {
  const e = createPublicEnv(); e.PUBLIC_LEGAL_PAGES = 'draft';
  assert.ok(!(await sitemap(e)).includes('/legal'), 'draft is noindex and stays out');
  e.PUBLIC_LEGAL_PAGES = 'on';
  assert.ok(!(await sitemap(e)).includes('/legal'), 'on with no approvals lists nothing');
  Object.assign(e, { LEGAL_MARKET_BY_HOST: JSON.stringify({ 'lummet.test': 'uk' }), LEGAL_COUNSEL_APPROVALS: JSON.stringify({ uk: { terms: { approvedBy: 'Counsel LLP', approvedAt: '2026-01-01T00:00:00Z' } } }) });
  assert.ok(!(await sitemap(e)).includes('/legal'), 'approval without approved page text lists nothing');
  await e.db.prepare(`INSERT INTO lummet_pages (slug, title, content, status) VALUES ('legal-uk-terms', 'Terms', '<p>Approved terms text.</p>', 'published')`).run();
  const xml = await sitemap(e);
  assert.match(xml, /<loc>https:\/\/lummet\.com\/legal<\/loc>/);
  assert.match(xml, /<loc>https:\/\/lummet\.com\/legal\/terms<\/loc>/);
  assert.ok(!xml.includes('/legal/privacy'), 'only the approved page');
});

test('H.5 /contact-sales stores its inquiries under its own key; /contact is unchanged; the fields still come from the contact form until a contact-sales form exists', async () => {
  const e = createPublicEnv(); e.PUBLIC_TRUST_PAGES = 'on';
  const page = await (await get(handlePublicRoute, e, '/contact-sales')).text();
  assert.match(page, /<form[^>]+action="\/contact-sales"/i);
  assert.match(page, /name="f_email"/);
  const sales = await post(handlePublicRoute, e, '/contact-sales', { f_name: 'Sales Visitor', f_email: 'sales@example.test', f_message: 'Please contact me about sales.' });
  assert.equal(sales.status, 303); assert.equal(sales.headers.get('location'), '/contact-sales?sent=1');
  const general = await post(handlePublicRoute, e, '/contact', { f_name: 'General Visitor', f_email: 'general@example.test', f_message: 'A general question.' });
  assert.equal(general.status, 303);
  const rows = (await e.db.prepare('SELECT form_key, email FROM lummet_inquiries ORDER BY id').all()).results;
  assert.deepEqual(rows.map((r) => ({ ...r })), [{ form_key: 'contact-sales', email: 'sales@example.test' }, { form_key: 'contact', email: 'general@example.test' }]);
});

test('H.5 an owner-created contact-sales form takes precedence over the contact fallback', async () => {
  const e = createPublicEnv(); e.PUBLIC_TRUST_PAGES = 'on';
  await e.db.prepare(`INSERT INTO lummet_forms (form_key, title, intro, submit_label, success_title, success_message, status) VALUES ('contact-sales', 'Talk to sales', '<p>Sales intro.</p>', 'Send', 'Thanks', '<p>We will call.</p>', 'published')`).run();
  await e.db.prepare(`INSERT INTO lummet_form_fields (form_key, field_key, label, type, required, sort_order, status) VALUES ('contact-sales', 'email', 'Work email', 'email', 1, 1, 'published')`).run();
  const page = await (await get(handlePublicRoute, e, '/contact-sales')).text();
  assert.match(page, /Talk to sales/); assert.match(page, /Work email/); assert.ok(!/name="f_message"/.test(page));
  const sent = await post(handlePublicRoute, e, '/contact-sales', { f_email: 'buyer@example.test' });
  assert.equal(sent.status, 303);
  assert.equal((await e.db.prepare(`SELECT COUNT(*) n FROM lummet_inquiries WHERE form_key = 'contact-sales'`).first()).n, 1);
});

test('H.5 contact-sales keeps the Turnstile requirement it had under the contact key', async () => {
  const e = createPublicEnv();
  Object.assign(e, { PUBLIC_TRUST_PAGES: 'on', PUBLIC_FORMS_TURNSTILE_REQUIRED: 'on', TURNSTILE_SITE_KEY: 'site', TURNSTILE_SECRET_KEY: 'secret' });
  const res = await post(handlePublicRoute, e, '/contact-sales', { f_name: 'A', f_email: 'a@example.test', f_message: 'No token supplied here.' });
  assert.notEqual(res.status, 303, 'refused without a token');
  assert.equal((await e.db.prepare('SELECT COUNT(*) n FROM lummet_inquiries').first()).n, 0);
});
