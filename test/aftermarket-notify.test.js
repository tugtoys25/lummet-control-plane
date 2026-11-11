// test/aftermarket-notify.test.js — end-to-end emails: enquiries, approvals, verification, expiry. Sellers never get buyer contact details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv, post } from './support/public-env.js';
import { handleApi } from '../worker/aftermarket-portal.js';
import * as notify from '../worker/aftermarket-notify.js';
import { flushOutbox } from '../worker/email.js';

const config = { CREDENTIAL_KEK: btoa('k'.repeat(32)), ALERT_EMAIL: 'staff@lummet.test', PORTAL_BASE_URL: 'https://app.lummet.test' };
const mkEnv = (extra = {}) => { const env = createPublicEnv(); Object.assign(env, config, extra); env.LUMMET_DB = env.LUMMET_DB || env.db; return env; };
const outbox = async (env) => (await env.db.prepare('SELECT to_email, subject, dedupe_key FROM email_outbox ORDER BY created_at, rowid').all()).results;
const guard = async () => null;
const customer = { id: 'u1', email: 'seller@example.test' };
async function api(env, method, subPath, body) {
  const request = new Request('https://cp.test/x', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await handleApi({ env, request, method, path: `/api/organizations/orgA${subPath}`, organizationId: 'orgA', customer, requireOrgRole: guard, audit: async () => {} });
  return res.json();
}
const buyer = { f_name: 'Secret Buyer', f_email: 'buyer@secret.test', f_message: 'hello', f_offer: '77' };

test('an enquiry about a seller listing emails staff (with the buyer) and the seller (without the buyer)', async () => {
  const env = mkEnv();
  const { id, slug } = await api(env, 'POST', '/aftermarket/listings', { title: 'Mail Shop', category_slug: 'websites' });
  await env.db.prepare(`UPDATE lummet_listings SET status='listed', notified_status='listed' WHERE id=?`).bind(id).run();
  await env.db.prepare('DELETE FROM email_outbox').run();
  assert.equal((await post(handlePublicRoute, env, `/aftermarket/listings/${slug}`, buyer)).status, 303);
  const mails = await outbox(env);
  assert.deepEqual(mails.map((m) => m.to_email).sort(), ['seller@example.test', 'staff@lummet.test']);
  // what each recipient can read: decrypt through a recording sender
  const sent = [];
  await flushOutbox(env, { fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); }, ...{} }).catch(() => {});
  env.EMAIL_PROVIDER = 'resend'; env.RESEND_API_KEY = 'k'; env.EMAIL_FROM = 'Lummet <no-reply@lummet.test>';
  await flushOutbox(env, { fetchImpl: async (_u, init) => { sent.push(JSON.parse(init.body)); return new Response('{"id":"m"}', { status: 200 }); } });
  const toSeller = sent.find((m) => m.to[0] === 'seller@example.test');
  const toStaff = sent.find((m) => m.to[0] === 'staff@lummet.test');
  assert.ok(toSeller && toStaff);
  assert.doesNotMatch(JSON.stringify(toSeller), /buyer@secret\.test|Secret Buyer/);
  assert.match(JSON.stringify(toStaff), /buyer@secret\.test/);
  assert.match(toSeller.text, /app\.lummet\.test\/app\/aftermarket\/business\//);
});

test('seller emails about enquiries are limited to one per item per hour; admin-listed items notify staff only', async () => {
  const env = mkEnv();
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source, owner_email, notified_status) VALUES ('s.app','listed','seller','o@example.test','listed')`).run();
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source) VALUES ('a.app','listed','admin')`).run();
  for (let i = 0; i < 2; i += 1) await post(handlePublicRoute, env, '/aftermarket/domains/s.app', { f_name: `B${i}`, f_email: `b${i}@example.test`, f_domain: 's.app', f_offer: '5' });
  await post(handlePublicRoute, env, '/aftermarket/domains/a.app', { f_name: 'C', f_email: 'c@example.test', f_domain: 'a.app', f_offer: '5' });
  const mails = await outbox(env);
  assert.equal(mails.filter((m) => m.to_email === 'o@example.test').length, 1);
  assert.equal(mails.filter((m) => m.to_email === 'staff@lummet.test').length, 3);
});

test('no recipient configured: nothing is queued and the visitor is unaffected', async () => {
  const env = mkEnv({ ALERT_EMAIL: '', CONTACT_EMAIL: '' });
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source) VALUES ('q.app','listed','admin')`).run();
  assert.equal((await post(handlePublicRoute, env, '/aftermarket/domains/q.app', { f_name: 'A', f_email: 'a@example.test', f_domain: 'q.app', f_offer: '5' })).status, 303);
  assert.equal((await outbox(env)).length, 0);
  assert.equal(notify.staffRecipient({ AFTERMARKET_NOTIFY_EMAIL: 'x@y.test', ALERT_EMAIL: 'a@b.test' }), 'x@y.test');
});

test('a new or edited seller listing asks staff to approve it', async () => {
  const env = mkEnv();
  const { id } = await api(env, 'POST', '/aftermarket/listings', { title: 'Approve Me', category_slug: 'saas-apps' });
  assert.deepEqual((await outbox(env)).map((m) => [m.to_email, m.subject]), [['staff@lummet.test', 'Listing waiting for approval: Approve Me']]);
  await env.db.prepare(`UPDATE lummet_listings SET status='listed' WHERE id=?`).bind(id).run();
  await notify.sweep(env);
  await api(env, 'POST', `/aftermarket/listings/${id}`, { summary: 'changed' });   // listed -> pending
  assert.equal((await outbox(env)).filter((m) => /waiting for approval/.test(m.subject)).length, 2);
});

test('sweep: approved, declined with a note, verified, expired; own actions and the past are silent; run twice sends once', async () => {
  const env = mkEnv();
  const a = await api(env, 'POST', '/aftermarket/listings', { title: 'Good One', category_slug: 'websites' });
  const b = await api(env, 'POST', '/aftermarket/listings', { title: 'Bad One', category_slug: 'websites' });
  await env.db.prepare('DELETE FROM email_outbox').run();
  await env.db.prepare(`UPDATE lummet_listings SET status='listed' WHERE id=?`).bind(a.id).run();
  await env.db.prepare(`UPDATE lummet_listings SET status='unlisted', review_note='Add revenue proof' WHERE id=?`).bind(b.id).run();
  // domains: one verified (listed), one expired (unlisted, never verified), one the seller unlisted themselves
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source, owner_email, notified_status, hosted, verified_method, verified_at) VALUES ('live.app','listed','seller','s@example.test','pending',1,'ns','2026-11-01')`).run();
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source, owner_email, notified_status) VALUES ('late.app','unlisted','seller','s@example.test','pending')`).run();
  await env.db.prepare(`INSERT INTO lummet_aftermarket_domains (domain, status, source, owner_email, notified_status, verified_at) VALUES ('mine.app','unlisted','seller','s@example.test','unlisted','2026-11-01')`).run();

  assert.deepEqual(await notify.sweep(env), { domains: 2, listings: 2 });
  const subjects = (await outbox(env)).map((m) => m.subject).sort();
  assert.deepEqual(subjects, [
    'Seller domain listed: live.app', 'Your listing "Bad One" was not approved', 'Your listing "Good One" is live',
    'late.app could not be verified in time', 'live.app is verified and listed'
  ].sort());
  assert.deepEqual(await notify.sweep(env), { domains: 0, listings: 0 });
  assert.equal((await outbox(env)).length, 5);
});

test('seller actions in the portal never trigger a status email', async () => {
  const env = mkEnv();
  const { id } = await api(env, 'POST', '/aftermarket/listings', { title: 'Mine', category_slug: 'other' });
  await api(env, 'POST', `/aftermarket/listings/${id}/status`, { status: 'unlisted' });
  await api(env, 'POST', `/aftermarket/listings/${id}/status`, { status: 'sold' });
  await env.db.prepare('DELETE FROM email_outbox').run();
  assert.deepEqual(await notify.sweep(env), { domains: 0, listings: 0 });
  assert.equal((await outbox(env)).length, 0);
});
