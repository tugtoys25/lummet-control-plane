import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { queueEmail, flushOutbox, portalLink, emailConfigured } from '../worker/email.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as organizations from '../worker/organizations.js';
import worker from '../worker/index.js';

function env(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'test-message' }), { status: 200 }), ...extra };
}
const cfg = { EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test', EMAIL_FROM: 'Lummet <no-reply@example.test>', PORTAL_BASE_URL: 'https://app.example.test' };
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };

test('portalLink is built only from PORTAL_BASE_URL, never from the request', () => {
  assert.equal(portalLink({}, '/x', { a: 1 }), null);
  assert.equal(portalLink({ PORTAL_BASE_URL: 'https://app.example.test/' }, '/app/x', { a: '1' }), 'https://app.example.test/app/x?a=1');
  assert.equal(portalLink({ PORTAL_BASE_URL: 'javascript:alert(1)' }, '/x'), null);
});

test('unconfigured provider: message stays queued, nothing reported as sent', async () => {
  const e = env();
  const q = await queueEmail(e, { to: 'a@x.test', template: 'password_reset', vars: { link: 'https://app.example.test/r?t=1' } });
  assert.ok(q.ok);
  const r = await flushOutbox(e, { fetchImpl: () => { throw new Error('must not call provider'); } });
  assert.equal(r.skipped, 'not_configured');
  const row = await e.LUMMET_DB.prepare('SELECT status FROM email_outbox').first();
  assert.equal(row.status, 'queued');
});

test('body is encrypted at rest while queued and wiped after send', async () => {
  const e = env(cfg);
  await queueEmail(e, { to: 'a@x.test', template: 'password_reset', vars: { link: 'https://app.example.test/r?token=SECRETTOKEN' } });
  const raw = await e.LUMMET_DB.prepare('SELECT * FROM email_outbox').first();
  assert.ok(!JSON.stringify(raw).includes('SECRETTOKEN'));
  let sentBody;
  const r = await flushOutbox(e, { fetchImpl: async (url, init) => { sentBody = JSON.parse(init.body); return new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }); } });
  assert.equal(r.sent, 1);
  assert.match(sentBody.text, /SECRETTOKEN/);
  const after = await e.LUMMET_DB.prepare('SELECT * FROM email_outbox').first();
  assert.equal(after.status, 'sent'); assert.equal(after.body_encrypted, null); assert.equal(after.provider_message_id, 'msg_1');
});

test('transient provider failure retries with backoff, then fails permanently after max attempts', async () => {
  const e = env(cfg);
  await queueEmail(e, { to: 'a@x.test', template: 'verify_email', vars: { link: 'https://app.example.test/v' } });
  let now = Date.now();
  const failing = async () => new Response('x', { status: 503 });
  let res = await flushOutbox(e, { fetchImpl: failing, now });
  assert.equal(res.retried, 1);
  assert.equal((await flushOutbox(e, { fetchImpl: failing, now })).retried + 0, 0, 'not due yet: backoff respected');
  for (let i = 0; i < 6; i++) { now += 3600e3 * 24; await flushOutbox(e, { fetchImpl: failing, now }); }
  const row = await e.LUMMET_DB.prepare('SELECT status, attempts, last_error FROM email_outbox').first();
  assert.equal(row.status, 'failed'); assert.equal(row.attempts, 5); assert.equal(row.last_error, 'provider_http_503');
});

test('permanent 4xx failure is not retried', async () => {
  const e = env(cfg);
  await queueEmail(e, { to: 'a@x.test', template: 'verify_email', vars: { link: 'https://app.example.test/v' } });
  const r = await flushOutbox(e, { fetchImpl: async () => new Response('bad', { status: 422 }) });
  assert.equal(r.failed, 1);
});

test('dedupe key prevents double-queueing', async () => {
  const e = env(cfg);
  const a = await queueEmail(e, { to: 'a@x.test', template: 'verify_email', vars: { link: 'https://x.test/v' }, dedupeKey: 'k1' });
  const b = await queueEmail(e, { to: 'a@x.test', template: 'verify_email', vars: { link: 'https://x.test/v' }, dedupeKey: 'k1' });
  assert.ok(a.id); assert.equal(b.duplicate, true);
});

test('without PORTAL_BASE_URL nothing is queued (no broken links)', async () => {
  const e = env();
  const q = await queueEmail(e, { to: 'a@x.test', template: 'verify_email', vars: { link: portalLink(e, '/v') } });
  assert.equal(q.ok, false);
});

async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie);
  if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('signup queues a verification email through the real route', async () => {
  const e = env(cfg);
  const s = await call(e, 'POST', '/api/customer/signup', { email: 'v@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'V' });
  assert.equal(s.status, 200);
  const row = await e.LUMMET_DB.prepare("SELECT template, to_email FROM email_outbox").first();
  assert.equal(row.template, 'verify_email'); assert.equal(row.to_email, 'v@example.com');
});

test('forgot-password: same response for unknown email, queues only for real accounts', async () => {
  const e = env(cfg);
  await call(e, 'POST', '/api/customer/signup', { email: 'r@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'R' });
  await e.LUMMET_DB.prepare('DELETE FROM email_outbox').run();
  const a = await call(e, 'POST', '/api/customer/password/forgot', { email: 'nobody@example.com' });
  const b = await call(e, 'POST', '/api/customer/password/forgot', { email: 'r@example.com' });
  assert.deepEqual(a.json, b.json); assert.equal(a.status, b.status);
  const rows = await e.LUMMET_DB.prepare('SELECT template FROM email_outbox').all();
  assert.deepEqual(rows.results.map((r) => r.template), ['password_reset']);
});

test('invitation cannot be accepted by a different email address', async () => {
  const e = env(cfg);
  const owner = await call(e, 'POST', '/api/customer/signup', { email: 'own@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'O' });
  const intruder = await call(e, 'POST', '/api/customer/signup', { email: 'evil@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'E' });
  const inv = await call(e, 'POST', `/api/organizations/${owner.json.organizationId}/invitations`, { email: 'friend@example.com', role: 'admin' }, owner.cookie);
  assert.equal(inv.status, 200, inv.text);
  assert.equal(inv.json.token, undefined, 'token must not be returned when email is configured');
  const token = await (async () => {
    // recover the link the invitee would have received
    let body; await flushOutbox(e, { fetchImpl: async (u, i) => { body = JSON.parse(i.body); return new Response('{"id":"m"}', { status: 200 }); } });
    return body.text.match(/token=([^\s&"]+)/)[1];
  })();
  const bad = await call(e, 'POST', `/api/invitations/${token}/accept`, null, intruder.cookie);
  assert.equal(bad.status, 403); assert.equal(bad.json.error, 'invitation_email_mismatch');
  const friend = await call(e, 'POST', '/api/customer/signup', { email: 'friend@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'F' });
  const ok = await call(e, 'POST', `/api/invitations/${token}/accept`, null, friend.cookie);
  assert.equal(ok.status, 200, ok.text);
});

test('forgot-password is throttled per IP and per address, with an unchanged response (no oracle, no email bombing)', async () => {
  const e = env(cfg);
  await call(e, 'POST', '/api/customer/signup', { email: 'bomb@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'B' });
  await e.LUMMET_DB.prepare('DELETE FROM email_outbox').run();
  const hit = async (ip) => {
    const res = await worker.fetch(new Request('https://cp.test/api/customer/password/forgot', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip }, body: JSON.stringify({ email: 'bomb@example.com' }) }), e, ctx);
    return res.json();
  };
  for (let i = 0; i < 8; i++) assert.deepEqual(await hit('203.0.113.' + (i + 1)), { success: true });
  const n = await e.LUMMET_DB.prepare("SELECT COUNT(*) n FROM email_outbox WHERE template='password_reset'").first();
  assert.equal(n.n, 3, 'at most 3 reset emails per address per hour, regardless of source IP');
});

test('signup is throttled per IP', async () => {
  const e = env(cfg); let last;
  for (let i = 0; i < 12; i++) {
    const res = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.77' }, body: JSON.stringify({ email: `t${i}@example.com`, password: 'Correct-Horse-Battery-9', organizationName: 'T' + i }) }), e, ctx);
    last = res.status;
  }
  assert.equal(last, 429);
});
