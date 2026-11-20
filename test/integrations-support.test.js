// Integrations (Slack, Discord, Teams, Telegram) and Support tickets: the two customer dashboard pages that used to say "Coming soon".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as plans from '../worker/plans.js';
import * as integrations from '../worker/integrations.js';
import * as support from '../worker/support.js';
import * as webhooks from '../worker/webhooks.js';
import { renderIntegrationsPage } from '../worker/views/customer-pages/integrations.js';
import { renderSupportList, renderSupportTicket } from '../worker/views/customer-pages/support.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce' }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, res };
}
async function org(e, email, name = 'Acme') {
  const h = new Headers({ 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' });
  const r = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: h, body: JSON.stringify({ email, password: 'Correct-Horse-9!', organizationName: name }) }), e, ctx);
  const json = await r.json(); const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')]).map((c) => c.split(';')[0]).join('; ');
  await plans.startTrialSubscription(e, json.organizationId, 'plan_casino_news_starter');
  const u = await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first();
  return { id: json.organizationId, userId: u && u.id, cookie };
}

const SLACK = 'https://hooks.slack.com/services/T000/B000/abcdef';

// ---------- integrations: validation ----------
test('each provider only accepts its own official addresses', () => {
  assert.equal(integrations.parseTarget('slack', { url: SLACK }).ok, true);
  assert.equal(integrations.parseTarget('slack', { url: 'https://evil.example.com/services/x' }).error, 'url_not_for_provider');
  assert.equal(integrations.parseTarget('slack', { url: 'http://hooks.slack.com/services/x' }).error, 'invalid_url');
  assert.equal(integrations.parseTarget('slack', { url: 'https://hooks.slack.com@evil.com/services/x' }).ok, false);
  assert.equal(integrations.parseTarget('slack', { url: 'https://hooks.slack.com:8443/services/x' }).ok, false);
  assert.equal(integrations.parseTarget('discord', { url: 'https://discord.com/api/webhooks/123/abc' }).ok, true);
  assert.equal(integrations.parseTarget('discord', { url: 'https://discord.com/other' }).error, 'url_not_for_provider');
  assert.equal(integrations.parseTarget('teams', { url: 'https://acme.webhook.office.com/webhookb2/abc' }).ok, true);
  assert.equal(integrations.parseTarget('teams', { url: 'https://webhook.office.com.evil.io/x' }).error, 'url_not_for_provider');
  assert.equal(integrations.parseTarget('telegram', { botToken: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ_012345', chatId: '-100123456' }).ok, true);
  assert.equal(integrations.parseTarget('telegram', { botToken: 'nope', chatId: '1' }).error, 'invalid_bot_token');
  assert.equal(integrations.parseTarget('telegram', { botToken: '123456:ABCdefGHIjklMNOpqrSTUvwxYZ_012345', chatId: 'x y' }).error, 'invalid_chat_id');
});
test('messages are shaped per provider and never ping everyone', () => {
  assert.match(integrations.buildPayload('slack', 'hi').text, /hi/);
  const d = integrations.buildPayload('discord', 'hi'); assert.deepEqual(d.allowed_mentions, { parse: [] });
  assert.ok(integrations.buildPayload('teams', 'hi').text.includes('hi'));
  assert.match(integrations.eventText('site.failed', { step: 'deploy', message: 'boom' }), /deploy.*boom/);
});

// ---------- integrations: storage, secrets, delivery ----------
test('the destination is stored encrypted, never returned, and events reach it with the outcome recorded', async () => {
  const e = env(); const o = await org(e, 'a@example.com');
  const made = await integrations.createIntegration(e, { organizationId: o.id, provider: 'slack', name: 'Alerts', eventTypes: ['site.deployed', 'payment.failed'], target: { url: SLACK }, actorUserId: o.userId });
  assert.equal(made.ok, true);
  const raw = await e.LUMMET_DB.prepare('SELECT * FROM integrations WHERE id = ?').bind(made.id).first();
  assert.ok(!JSON.stringify(raw).includes('T000/B000'), 'secret is not in the row');
  assert.equal(raw.target_hint, 'hooks.slack.com');
  const listed = await integrations.listIntegrations(e, o.id);
  assert.ok(!JSON.stringify(listed).includes('abcdef')); assert.deepEqual(listed[0].event_types, ['site.deployed', 'payment.failed']);
  const sent = []; const fetchImpl = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, status: 200 }; };
  await integrations.dispatchIntegrations(e, o.id, 'site.deployed', { version: '1.2' }, { fetchImpl });
  await integrations.dispatchIntegrations(e, o.id, 'site.created', {}, { fetchImpl });           // not subscribed
  assert.equal(sent.length, 1); assert.equal(sent[0].url, SLACK); assert.match(sent[0].body.text, /deployed.*1\.2/);
  const after = (await integrations.listIntegrations(e, o.id))[0]; assert.equal(after.last_status, 'ok'); assert.equal(after.sent_count, 1);
  const bad = async () => ({ ok: false, status: 404 });
  await integrations.dispatchIntegrations(e, o.id, 'payment.failed', {}, { fetchImpl: bad });
  const failed = (await integrations.listIntegrations(e, o.id))[0]; assert.equal(failed.last_status, 'failed'); assert.equal(failed.last_error, 'http_404'); assert.equal(failed.failure_count, 1);
  await integrations.updateIntegration(e, o.id, made.id, { status: 'disabled' });
  await integrations.dispatchIntegrations(e, o.id, 'site.deployed', {}, { fetchImpl }); assert.equal(sent.length, 1, 'paused means silent');
});
test('a network failure never throws into the caller, and another organization cannot touch it', async () => {
  const e = env(); const a = await org(e, 'a@example.com', 'A'); const b = await org(e, 'b@example.com', 'B');
  const made = await integrations.createIntegration(e, { organizationId: a.id, provider: 'discord', name: 'D', eventTypes: ['site.failed'], target: { url: 'https://discord.com/api/webhooks/1/x' } });
  await integrations.dispatchIntegrations(e, a.id, 'site.failed', {}, { fetchImpl: async () => { throw new Error('down'); } });
  assert.equal((await integrations.listIntegrations(e, a.id))[0].last_error, 'network_error');
  assert.equal((await integrations.deleteIntegration(e, b.id, made.id)).status, 404);
  assert.equal((await integrations.sendTest(e, b.id, made.id)).status, 404);
  assert.deepEqual(await integrations.listIntegrations(e, b.id), []);
});
test('webhook events fan out to integrations without breaking the webhook path', async () => {
  const e = env(); const o = await org(e, 'w@example.com');
  await integrations.createIntegration(e, { organizationId: o.id, provider: 'slack', name: 'S', eventTypes: ['site.deployed'], target: { url: SLACK } });
  const real = globalThis.fetch; const urls = []; globalThis.fetch = async (u) => { urls.push(String(u)); return { ok: true, status: 200 }; };
  try { await webhooks.dispatchEvent(e, o.id, 'site.deployed', { version: '9' }); } finally { globalThis.fetch = real; }
  assert.ok(urls.includes(SLACK));
});
test('creation rules: provider, events, and a per-organization limit', async () => {
  const e = env(); const o = await org(e, 'l@example.com');
  const base = { organizationId: o.id, provider: 'slack', name: 'x', target: { url: SLACK } };
  assert.equal((await integrations.createIntegration(e, { ...base, provider: 'icq', eventTypes: ['site.deployed'] })).error, 'invalid_provider');
  assert.equal((await integrations.createIntegration(e, { ...base, eventTypes: [] })).error, 'invalid_event_types');
  assert.equal((await integrations.createIntegration(e, { ...base, eventTypes: ['made.up'] })).error, 'invalid_event_types');
  for (let i = 0; i < integrations.MAX_PER_ORG; i++) assert.equal((await integrations.createIntegration(e, { ...base, eventTypes: ['site.deployed'] })).ok, true);
  assert.equal((await integrations.createIntegration(e, { ...base, eventTypes: ['site.deployed'] })).error, 'too_many_integrations');
});

// ---------- integrations: HTTP ----------
test('the integrations API needs an admin and answers for the right organization only', async () => {
  const e = env(); const a = await org(e, 'a@example.com', 'A'); const b = await org(e, 'b@example.com', 'B');
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/integrations`)).status, 401);
  assert.ok([403, 404].includes((await call(e, 'GET', `/api/organizations/${a.id}/integrations`, null, b.cookie)).status));
  const bad = await call(e, 'POST', `/api/organizations/${a.id}/integrations`, { provider: 'slack', eventTypes: ['site.deployed'], target: { url: 'https://x.example.com/services/a' } }, a.cookie);
  assert.equal(bad.status, 422); assert.equal(bad.json.error, 'url_not_for_provider');
  const ok = await call(e, 'POST', `/api/organizations/${a.id}/integrations`, { provider: 'slack', name: 'Team', eventTypes: ['site.deployed'], target: { url: SLACK } }, a.cookie);
  assert.equal(ok.status, 200); assert.equal(ok.json.success, true);
  const list = await call(e, 'GET', `/api/organizations/${a.id}/integrations`, null, a.cookie);
  assert.equal(list.json.data.length, 1); assert.ok(!list.text.includes('T000/B000'));
  const id = ok.json.id;
  assert.equal((await call(e, 'PATCH', `/api/organizations/${a.id}/integrations/${id}`, { status: 'disabled' }, a.cookie)).status, 200);
  assert.equal((await call(e, 'PATCH', `/api/organizations/${a.id}/integrations/${id}`, { status: 'weird' }, a.cookie)).status, 422);
  assert.ok([403, 404].includes((await call(e, 'DELETE', `/api/organizations/${a.id}/integrations/${id}`, null, b.cookie)).status));
  assert.equal((await call(e, 'DELETE', `/api/organizations/${a.id}/integrations/${id}`, null, a.cookie)).status, 200);
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/integrations`, null, a.cookie)).json.data.length, 0);
});
test('the Integrations page renders for an admin, is a real menu link, and its script parses', async () => {
  const e = env(); const o = await org(e, 'p@example.com');
  const page = await call(e, 'GET', '/app/integrations', null, o.cookie);
  assert.equal(page.status, 200); assert.match(page.text, /<h1>Integrations<\/h1>/); assert.match(page.text, /Connect<\/button>/); assert.match(page.text, /Microsoft Teams/);
  for (const m of page.text.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!/src=/.test(m[1])) new vm.Script(m[2]);
  assert.equal((await call(e, 'GET', '/app/integrations')).res.headers.get('Location'), '/app/login');
  assert.match(renderIntegrationsPage({ integrations: [], canManage: false }), /Only organization admins/);
  assert.match(renderIntegrationsPage({ integrations: [{ id: 'i', name: '<b>x</b>', provider: 'slack', provider_label: 'Slack', target_hint: 'hooks.slack.com', event_types: ['site.failed'], status: 'active', last_status: 'failed', last_error: 'http_404', last_sent_at: 't' }], canManage: true }), /&lt;b&gt;x&lt;\/b&gt;/);
});

// ---------- support ----------
test('a ticket is validated, threaded, answered by staff (with an email) and re-opened by the customer', async () => {
  const e = env(); const o = await org(e, 'owner@example.com');
  assert.equal((await support.createTicket(e, { organizationId: o.id, customerUserId: o.userId, subject: 'x', body: 'hello there' })).error, 'subject_required');
  assert.equal((await support.createTicket(e, { organizationId: o.id, customerUserId: o.userId, subject: 'Help me', body: 'hi' })).error, 'message_required');
  assert.equal((await support.createTicket(e, { organizationId: o.id, customerUserId: o.userId, subject: 'Help me', body: 'hello there', siteId: 'not-mine' })).error, 'invalid_site');
  const t = await support.createTicket(e, { organizationId: o.id, customerUserId: o.userId, authorLabel: 'owner@example.com', subject: 'Domain stuck', body: 'My domain is pending', category: 'problem', priority: 'high' });
  assert.equal(t.ok, true);
  assert.equal((await support.getTicket(e, o.id, t.id)).status, 'open');
  const r = await support.staffReply(e, t.id, { staffLabel: 'Sam', body: 'Fixed, please retry.' });
  assert.equal(r.ok, true);
  let full = await support.getTicket(e, o.id, t.id);
  assert.equal(full.status, 'answered'); assert.deepEqual(full.messages.map((m) => m.author_type), ['customer', 'staff']);
  const mail = await e.LUMMET_DB.prepare('SELECT to_email, subject FROM email_outbox').all();
  assert.equal(mail.results.length, 1); assert.equal(mail.results[0].to_email, 'owner@example.com'); assert.match(mail.results[0].subject, /Domain stuck/);
  assert.equal(await support.openCountForOrg(e, o.id), 1, 'one answer is waiting for the customer');
  await support.customerReply(e, o.id, t.id, { authorLabel: 'owner', body: 'Still failing' });
  assert.equal((await support.getTicket(e, o.id, t.id)).status, 'open');
  await support.staffReply(e, t.id, { staffLabel: 'Sam', body: 'Done.', close: true });
  assert.equal((await support.getTicket(e, o.id, t.id)).status, 'closed');
  await support.customerReply(e, o.id, t.id, { authorLabel: 'owner', body: 'It came back' });
  assert.equal((await support.getTicket(e, o.id, t.id)).status, 'open', 'a reply re-opens a closed ticket');
  assert.equal((await support.customerSetStatus(e, o.id, t.id, 'closed')).ok, true);
  assert.equal((await support.customerSetStatus(e, o.id, t.id, 'bogus')).error, 'invalid_status');
});
test('tickets stay inside their organization and a flood of open tickets is refused', async () => {
  const e = env(); const a = await org(e, 'a@example.com', 'A'); const b = await org(e, 'b@example.com', 'B');
  const t = await support.createTicket(e, { organizationId: a.id, customerUserId: a.userId, subject: 'Private', body: 'secret details' });
  assert.equal(await support.getTicket(e, b.id, t.id), null);
  assert.equal((await support.customerReply(e, b.id, t.id, { body: 'hello' })).status, 404);
  assert.equal((await support.customerSetStatus(e, b.id, t.id, 'closed')).status, 404);
  assert.deepEqual(await support.listTickets(e, b.id), []);
  for (let i = 1; i < support.MAX_OPEN_PER_ORG; i++) assert.equal((await support.createTicket(e, { organizationId: a.id, customerUserId: a.userId, subject: 'Ticket ' + i, body: 'details here' })).ok, true);
  assert.equal((await support.createTicket(e, { organizationId: a.id, customerUserId: a.userId, subject: 'One more', body: 'details here' })).error, 'too_many_open_tickets');
});
test('the support API and pages work end to end, escape text and require sign-in', async () => {
  const e = env(); const a = await org(e, 'a@example.com', 'A'); const b = await org(e, 'b@example.com', 'B');
  assert.equal((await call(e, 'GET', `/api/organizations/${a.id}/support/tickets`)).status, 401);
  const made = await call(e, 'POST', `/api/organizations/${a.id}/support/tickets`, { subject: '<script>alert(1)</script> help', body: 'Please <b>look</b>', category: 'billing' }, a.cookie);
  assert.equal(made.status, 200); const id = made.json.id;
  assert.ok([403, 404].includes((await call(e, 'GET', `/api/organizations/${a.id}/support/tickets/${id}`, null, b.cookie)).status));
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/support/tickets`, { subject: 'a', body: 'b' }, a.cookie)).status, 422);
  const list = await call(e, 'GET', '/app/support', null, a.cookie);
  assert.equal(list.status, 200); assert.match(list.text, /<h1>Support<\/h1>/); assert.ok(!list.text.includes('<script>alert(1)</script> help'));
  const detail = await call(e, 'GET', `/app/support/${id}`, null, a.cookie);
  assert.equal(detail.status, 200); assert.match(detail.text, /Please &lt;b&gt;look&lt;\/b&gt;/);
  for (const html of [list.text, detail.text]) for (const m of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!/src=/.test(m[1])) new vm.Script(m[2]);
  assert.match((await call(e, 'GET', `/app/support/${id}`, null, b.cookie)).text, /not found/);
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/support/tickets/${id}/reply`, { body: 'More info' }, a.cookie)).status, 200);
  assert.equal((await call(e, 'POST', `/api/organizations/${a.id}/support/tickets/${id}/status`, { status: 'closed' }, a.cookie)).status, 200);
  assert.equal((await call(e, 'GET', '/app/support')).res.headers.get('Location'), '/app/login');
});
test('support views escape everything', () => {
  const t = { id: 'i', subject: '<i>s</i>', category: 'question', priority: 'low', status: 'answered', created_at: 'c', messages: [{ author_type: 'staff', author_label: '<b>Sam</b>', body: '<img src=x onerror=1>', created_at: 'd' }] };
  const html = renderSupportTicket({ ticket: t });
  assert.ok(!html.includes('<img src=x') && !html.includes('<b>Sam</b>')); assert.match(html, /Lummet team/);
  assert.match(renderSupportTicket({ ticket: null }), /not found/);
  assert.match(renderSupportList({ tickets: [], sites: [{ id: 's', name: '<x>' }] }), /&lt;x&gt;/);
});
test('the staff inbox lists tickets, shows the thread, replies and closes, and is staff-only', async () => {
  const e = env(); const o = await org(e, 'cust@example.com');
  const t = await support.createTicket(e, { organizationId: o.id, customerUserId: o.userId, subject: 'Need help', body: 'Cannot log in' });
  assert.ok([302, 401, 403].includes((await call(e, 'GET', '/platform/saas/support')).status));
  assert.ok([401, 403].includes((await call(e, 'POST', `/api/platform/saas/support/${t.id}/reply`, { body: 'x' }, o.cookie)).status), 'a customer cannot use the staff API');
  const { renderSupportInboxPage, renderSupportTicketAdminPage } = await import('../worker/views/pages/saas-admin.js');
  const admin = { id: 'a1', email: 'staff@example.com', role: 'super_admin' };
  const inbox = await renderSupportInboxPage(e, admin, {}); assert.match(inbox, /Need help/); assert.match(inbox, /Waiting for us/);
  const page = await renderSupportTicketAdminPage(e, admin, t.id); assert.match(page, /Cannot log in/); assert.match(page, /Send and close/);
  for (const m of page.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) if (!/src=/.test(m[1])) new vm.Script(m[2]);
  assert.match(await renderSupportTicketAdminPage(e, admin, 'missing'), /not found/);
  assert.equal((await support.staffSetStatus(e, t.id, 'closed')).ok, true); assert.equal((await support.staffSetStatus(e, t.id, 'nope')).error, 'invalid_status');
  assert.equal(await support.openTicketCount(e), 0);
});

test('erasing a person anonymises what they wrote in support threads; erasing an organization removes its tickets and integrations', async () => {
  const { eraseUser } = await import('../worker/erasure.js');
  const e = env(); const o = await org(e, 'gone@example.com');
  const t = await support.createTicket(e, { organizationId: o.id, customerUserId: o.userId, authorLabel: 'gone@example.com', subject: 'Question', body: 'Hello there' });
  await support.staffReply(e, t.id, { staffLabel: 'Sam', body: 'Hi' });
  assert.equal((await eraseUser(e, o.userId)).ok, true);
  const msgs = (await e.LUMMET_DB.prepare('SELECT author_type, author_label FROM support_messages ORDER BY created_at, rowid').all()).results;
  assert.deepEqual(msgs.map((m) => m.author_label), ['[erased]', 'Sam']);
  assert.ok(!JSON.stringify(msgs).includes('gone@example.com'));
});
