// Support file sharing and staff announcements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import * as support from '../worker/support.js';
import * as files from '../worker/private-files.js';
import * as announcements from '../worker/announcements.js';
import { sanitizeHtml, textToHtml, htmlToText } from '../worker/html-sanitize.js';
import { renderCustomerAnnouncementsPage } from '../worker/views/customer-pages/announcements.js';

class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(k, v) { this.m.set(k, v); }
  async get(k) { return this.m.has(k) ? { body: this.m.get(k) } : null; }
  async delete(k) { this.m.delete(k); }
}
function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce', PLATFORM_MEDIA: new FakeR2(), PORTAL_BASE_URL: 'https://app.test' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function signup(e, email, name = 'Acme') {
  const h = new Headers({ 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' });
  const r = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: h, body: JSON.stringify({ email, password: 'Correct-Horse-9!', organizationName: name }) }), e, ctx);
  const json = await r.json(); const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
  await plans.startTrialSubscription(e, json.organizationId, 'plan_casino_news_starter');
  const u = await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first();
  return { id: json.organizationId, userId: u.id, cookie, email };
}
async function req(e, method, path, { cookie, json, form } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (json) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: json ? JSON.stringify(json) : form, redirect: 'manual' }), e, ctx);
  return res;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const mk = (name, bytes) => new File([bytes], name);
const customerWho = (o) => ({ kind: 'customer', id: String(o.userId), organizationId: o.id });

// ---------- sanitizer ----------
test('the HTML cleaner removes script, handlers and unsafe addresses but keeps normal formatting', () => {
  const dirty = '<p onclick="x()">Hi <b>there</b><script>alert(1)</script><a href="javascript:alert(1)">bad</a><a href="https://ok.example/p">good</a><img src=x onerror=alert(1)><img src="https://ok.example/a.png"><iframe src="https://e"></iframe><style>*{display:none}</style></p>';
  const out = sanitizeHtml(dirty);
  assert.ok(!/script|onclick|onerror|javascript:|iframe|<style|display:none/i.test(out), out);
  assert.match(out, /<b>there<\/b>/); assert.match(out, /href="https:\/\/ok\.example\/p"/); assert.match(out, /<img[^>]+src="https:\/\/ok\.example\/a\.png"/);
  assert.ok(!sanitizeHtml('<a href="//evil.com">x</a>').includes('evil.com'));
  assert.match(textToHtml('a <b>\nline2'), /&lt;b&gt;/); assert.match(htmlToText('<p>Hello</p><p>World</p>'), /Hello[\s\S]*World/);
});

// ---------- file validation ----------
test('photos, documents and odd extensions are accepted; programs, fake images and empty files are refused', async () => {
  const e = env(); const o = await signup(e, 'a@example.com');
  for (const n of ['shot.PNG', 'notes.txt', 'plan.docx', 'old.doc', 'pic.webp', 'x.webapp', 'sheet.xlsx', 'data.csv', 'mystery.abc']) {
    const bytes = /png|webp/i.test(n) ? (n.toLowerCase().endsWith('png') ? PNG : new Uint8Array([0x52,0x49,0x46,0x46,0,0,0,0,0x57,0x45,0x42,0x50])) : new Uint8Array([65, 66, 67]);
    const r = await files.uploadFile(e, { file: mk(n, bytes), purpose: 'support', who: customerWho(o) });
    assert.equal(r.ok, true, `${n}: ${r.error}`);
  }
  for (const n of ['run.exe', 'a.js', 'page.html', 'x.svg', 'x.SH', 'x.ps1']) assert.equal((await files.uploadFile(e, { file: mk(n, new Uint8Array([1])), purpose: 'support', who: customerWho(o) })).error, 'file_type_not_allowed', n);
  assert.equal((await files.uploadFile(e, { file: mk('fake.png', new Uint8Array([1, 2, 3])), purpose: 'support', who: customerWho(o) })).error, 'image_not_valid');
  assert.equal((await files.uploadFile(e, { file: mk('e.txt', new Uint8Array([])), purpose: 'support', who: customerWho(o) })).error, 'empty_file');
  assert.equal((await files.uploadFile(e, { file: mk('big.zip', new Uint8Array(files.MAX_BYTES + 1)), purpose: 'support', who: customerWho(o) })).error, 'file_too_large');
  assert.equal((await files.uploadFile({ ...e, PLATFORM_MEDIA: undefined }, { file: mk('a.txt', new Uint8Array([1])), purpose: 'support', who: customerWho(o) })).error, 'file_storage_not_configured');
});

// ---------- support attachments over HTTP ----------
test('a customer sends a screenshot with a request; members can open it, other organizations cannot; staff can reply with a file', async () => {
  const e = env(); const a = await signup(e, 'a@example.com', 'Acme'); const b = await signup(e, 'b@example.com', 'Beta');
  const form = new FormData(); form.append('file', new File([PNG], 'screen.png'));
  const up = await req(e, 'POST', `/api/organizations/${a.id}/support/files`, { cookie: a.cookie, form });
  assert.equal(up.status, 201); const fid = (await up.json()).file.id;
  // someone else's file cannot be attached
  const stolen = await support.createTicket(e, { organizationId: b.id, customerUserId: b.userId, authorLabel: 'B', subject: 'Hello there', body: 'hello hello', fileIds: [fid] });
  assert.equal(stolen.ok, true);
  assert.equal((await support.getTicket(e, b.id, stolen.id)).messages[0].attachments.length, 0);
  const made = await req(e, 'POST', `/api/organizations/${a.id}/support/tickets`, { cookie: a.cookie, json: { subject: 'Broken page', body: 'See the screenshot', fileIds: [fid] } });
  const tid = (await made.json()).id;
  const t = await support.getTicket(e, a.id, tid); assert.equal(t.messages[0].attachments[0].filename, 'screen.png'); assert.equal(t.messages[0].attachments[0].isImage, true);
  const dl = await req(e, 'GET', `/api/organizations/${a.id}/support/files/${fid}`, { cookie: a.cookie });
  assert.equal(dl.status, 200); assert.equal(dl.headers.get('content-type'), 'image/png'); assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await req(e, 'GET', `/api/organizations/${a.id}/support/files/${fid}`, { cookie: b.cookie })).status >= 400, true);
  assert.equal((await req(e, 'GET', `/api/organizations/${b.id}/support/files/${fid}`, { cookie: b.cookie })).status, 404);
  assert.equal((await req(e, 'GET', `/api/organizations/${a.id}/support/files/${fid}`)).status >= 400, true);
  // a document downloads, never renders
  const doc = await files.uploadFile(e, { file: mk('terms.docx', new Uint8Array([1, 2])), purpose: 'support', who: customerWho(a) });
  await support.customerReply(e, a.id, tid, { authorLabel: 'A', body: 'doc', fileIds: [doc.file.id], customerUserId: a.userId });
  const dd = await req(e, 'GET', `/api/organizations/${a.id}/support/files/${doc.file.id}`, { cookie: a.cookie });
  assert.equal(dd.headers.get('content-type'), 'application/octet-stream'); assert.match(dd.headers.get('content-disposition'), /^attachment/);
  // staff reply with a file for that ticket's organization
  const sf = await files.uploadFile(e, { file: mk('fix.pdf', new Uint8Array([1, 2])), purpose: 'support', who: { kind: 'staff', id: '7', organizationId: a.id } });
  assert.equal((await support.staffReply(e, tid, { staffLabel: 'Team', staffId: '7', body: 'See attached', fileIds: [sf.file.id] })).ok, true);
  const t2 = await support.getTicket(e, a.id, tid); assert.equal(t2.messages.at(-1).attachments[0].filename, 'fix.pdf');
  // a file alone is enough for a reply
  const only = await files.uploadFile(e, { file: mk('only.txt', new Uint8Array([1])), purpose: 'support', who: customerWho(a) });
  assert.equal((await support.customerReply(e, a.id, tid, { authorLabel: 'A', body: '', fileIds: [only.file.id], customerUserId: a.userId })).ok, true);
});

// ---------- signed links ----------
test('announcement files open only through a signed link and only once the announcement exists', async () => {
  const e = env(); const a = await signup(e, 'a@example.com', 'Acme');
  const up = await files.uploadFile(e, { file: mk('promo.png', PNG), purpose: 'announcement', who: { kind: 'staff', id: '1' } });
  const path = await files.signedPath(e, up.file.id);
  assert.match(path, /^\/f\/[0-9a-f-]{36}\/[0-9a-f]{32}$/);
  assert.equal((await req(e, 'GET', path)).status, 404);   // not attached to any announcement yet
  const sent = await announcements.send(e, { staff: { id: '1' }, subject: 'Promo', body: '<p>Look</p>', format: 'html', kind: 'all', channels: ['dashboard'], fileIds: [up.file.id] });
  assert.equal(sent.ok, true);
  const ok = await req(e, 'GET', path); assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'image/png');
  assert.equal((await req(e, 'GET', path.slice(0, -1) + (path.endsWith('0') ? '1' : '0'))).status, 404);
  assert.equal((await req(e, 'GET', `/f/${up.file.id}/${'0'.repeat(32)}`)).status, 404);
  const sup = await files.uploadFile(e, { file: mk('s.png', PNG), purpose: 'support', who: customerWho(a) });
  assert.equal((await req(e, 'GET', await files.signedPath(e, sup.file.id))).status, 404);   // support files never go public
});

// ---------- audiences ----------
async function addMember(e, orgId, email, role) {
  const id = crypto.randomUUID();
  await e.LUMMET_DB.prepare(`INSERT INTO customer_users (id, email, password_hash, status) VALUES (?, ?, 'x', 'active')`).bind(id, email).run();
  await e.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)`).bind(orgId, id, role).run();
  return id;
}
async function world() {
  const e = env(); const a = await signup(e, 'owner-a@example.com', 'Acme'); const b = await signup(e, 'owner-b@example.com', 'Beta');
  const billA = await addMember(e, a.id, 'bill-a@example.com', 'billing'); const viewA = await addMember(e, a.id, 'view-a@example.com', 'viewer');
  const site = crypto.randomUUID();
  const product = (await e.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first());
  await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, name, slug, product_id) VALUES (?, ?, 'Acme Site', 'acme-site', ?)`).bind(site, a.id, product ? product.id : 'p').run().catch(() => {});
  return { e, a, b, billA, viewA, site };
}
const emails = (r) => r.people.map((p) => p.email).sort();

test('each audience reaches exactly the right people', async () => {
  const { e, a, site } = await world();
  assert.equal((await announcements.resolve(e, 'all')).people.length, 4);
  assert.deepEqual(emails(await announcements.resolve(e, 'user', 'VIEW-A@example.com')), ['view-a@example.com']);
  assert.deepEqual(emails(await announcements.resolve(e, 'organization', a.id)), ['bill-a@example.com', 'owner-a@example.com', 'view-a@example.com']);
  assert.deepEqual(emails(await announcements.resolve(e, 'billing', a.id)), ['bill-a@example.com', 'owner-a@example.com']);
  assert.deepEqual(emails(await announcements.resolve(e, 'billing', '')), ['bill-a@example.com', 'owner-a@example.com', 'owner-b@example.com']);
  const s = await announcements.resolve(e, 'site', site); assert.equal(s.ok, true); assert.deepEqual(emails(s), ['bill-a@example.com', 'owner-a@example.com', 'view-a@example.com']);
  assert.equal((await announcements.resolve(e, 'user', 'nobody@example.com')).error, 'user_not_found');
  assert.equal((await announcements.resolve(e, 'organization', 'nope')).error, 'organization_not_found');
  assert.equal((await announcements.resolve(e, 'weird')).error, 'invalid_audience');
  await e.LUMMET_DB.prepare(`UPDATE customer_users SET status = 'disabled' WHERE email = 'view-a@example.com'`).run();
  assert.equal(emails(await announcements.resolve(e, 'organization', a.id)).includes('view-a@example.com'), false);
});

test('the dashboard shows each person only their announcements, counts unread and marks them read', async () => {
  const { e, a, b, billA, viewA } = await world();
  const s = (kind, ref, subject) => announcements.send(e, { staff: { id: '1' }, subject, body: 'Hello everyone', format: 'text', kind, ref, channels: ['dashboard'] });
  await s('all', '', 'For all'); await s('organization', a.id, 'For Acme'); await s('billing', a.id, 'Invoices'); await s('user', 'owner-b@example.com', 'Just B');
  const titles = async (uid) => (await announcements.inbox(e, uid, { markRead: false })).map((x) => x.subject).sort();
  assert.deepEqual(await titles(a.userId), ['For Acme', 'For all', 'Invoices']);
  assert.deepEqual(await titles(billA), ['For Acme', 'For all', 'Invoices']);
  assert.deepEqual(await titles(viewA), ['For Acme', 'For all']);
  assert.deepEqual(await titles(b.userId), ['For all', 'Just B']);
  assert.equal(await announcements.unreadCount(e, viewA), 2);
  const seen = await announcements.inbox(e, viewA); assert.equal(seen.every((x) => x.unread), true);
  assert.equal(await announcements.unreadCount(e, viewA), 0);
  assert.equal(await announcements.unreadCount(e, b.userId), 2);
  // dashboard-only announcements send no email
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'announcement'`).first()).n, 0);
  // the customer page renders and a hostile subject is escaped
  const html = renderCustomerAnnouncementsPage({ items: [{ id: '1', subject: '<img src=x onerror=1>', bodyHtml: '<p>ok</p>', createdAt: 'now', unread: true, attachments: [] }] });
  assert.ok(!html.includes('<img src=x'));
});

test('announcement email goes through the outbox in batches, once per person, and leaves automatic emails alone', async () => {
  const { e, a } = await world();
  const up = await files.uploadFile(e, { file: mk('guide.pdf', new Uint8Array([1, 2])), purpose: 'announcement', who: { kind: 'staff', id: '1' } });
  const r = await announcements.send(e, { staff: { id: '1' }, subject: 'Maintenance', body: '<h2>Tonight</h2><p onclick="x()">We are updating.</p><script>x()</script>', format: 'html', kind: 'organization', ref: a.id, channels: ['email', 'dashboard'], fileIds: [up.file.id] });
  assert.equal(r.ok, true); assert.equal(r.recipients, 3);
  const rows = (await e.LUMMET_DB.prepare(`SELECT to_email, subject, template FROM email_outbox WHERE template = 'announcement' ORDER BY to_email`).all()).results;
  assert.deepEqual(rows.map((x) => x.to_email), ['bill-a@example.com', 'owner-a@example.com', 'view-a@example.com']);
  assert.equal(rows[0].subject, 'Maintenance');
  const again = await announcements.processEmails(e); assert.equal(again.queued, 0);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM email_outbox WHERE template = 'announcement'`).first()).n, 3);
  const built = await announcements.buildEmail(e, { announcement_id: r.id, subject: 'Maintenance', body_html: sanitizeHtml('<h2>Tonight</h2><script>x()</script>') });
  assert.match(built.html, /guide\.pdf/); assert.match(built.html, /https:\/\/app\.test\/f\//); assert.ok(!/<script/i.test(built.html)); assert.match(built.text, /guide\.pdf: https:\/\/app\.test\/f\//);
  // without PORTAL_BASE_URL the send still works, with a warning and no links
  const e2 = { ...e }; delete e2.PORTAL_BASE_URL;
  const w = await announcements.send(e2, { staff: { id: '1' }, subject: 'No links', body: 'Hi', format: 'text', kind: 'user', ref: 'owner-a@example.com', channels: ['email'] });
  assert.equal(w.ok, true); assert.ok(w.warnings.length === 1);
  // the automatic emails still build as before
  const { templates } = await import('../worker/email.js'); assert.ok(templates.verify_email && templates.password_reset && templates.invitation && templates.notification);
});

test('announcement input is validated', async () => {
  const { e } = await world();
  const base = { staff: { id: '1' }, subject: 'Hello', body: 'Hi there', format: 'text', kind: 'all', channels: ['dashboard'] };
  assert.equal((await announcements.send(e, { ...base, subject: 'a' })).error, 'subject_required');
  assert.equal((await announcements.send(e, { ...base, channels: [] })).error, 'channel_required');
  assert.equal((await announcements.send(e, { ...base, body: '' })).error, 'message_required');
  assert.equal((await announcements.send(e, { ...base, body: 'x'.repeat(130000) })).error, 'body_too_long');
  assert.equal((await announcements.send(e, { ...base, kind: 'user', ref: 'ghost@example.com' })).error, 'user_not_found');
  const p = await announcements.preview(e, { kind: 'all', format: 'html', body: '<script>x</script><b>ok</b>' }); assert.equal(p.ok, true); assert.ok(!p.bodyHtml.includes('script')); assert.equal(p.count, 4);
});

// ---------- cleanup and erasure ----------
test('abandoned uploads are removed and erasing an organization removes its files from storage', async () => {
  const e = env(); const a = await signup(e, 'a@example.com', 'Acme');
  const u = await files.uploadFile(e, { file: mk('a.txt', new Uint8Array([1])), purpose: 'support', who: customerWho(a) });
  assert.equal(await files.purgeOrphans(e, { now: Date.now() }), 0);
  assert.equal(await files.purgeOrphans(e, { now: Date.now() + 3 * 86400000 }), 1);
  assert.equal(e.PLATFORM_MEDIA.m.size, 0); assert.equal(await files.getFile(e, u.file.id), null);
  const k = await files.uploadFile(e, { file: mk('b.txt', new Uint8Array([1])), purpose: 'support', who: customerWho(a) });
  const t = await support.createTicket(e, { organizationId: a.id, customerUserId: a.userId, authorLabel: 'A', subject: 'Hello', body: 'hello there', fileIds: [k.file.id] });
  assert.equal(t.ok, true); assert.equal(await files.purgeOrphans(e, { now: Date.now() + 3 * 86400000 }), 0);
  await files.purgeOrganization(e, a.id); assert.equal(e.PLATFORM_MEDIA.m.size, 0);
});
