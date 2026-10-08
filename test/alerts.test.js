// Roadmap 2.2: operational alerts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { runAlertCheck, tokenMatches, REMINDER_HOURS } from '../worker/alerts.js';

// Every setting the production configuration check looks for, so a "healthy" production baseline stays healthy.
const FULL_CONFIG = { ALERT_CHECK_TOKEN: 'tick-token-value', PORTAL_BASE_URL: 'https://app.example.com', STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'whsec_x',
  CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ZONE_ID: 'z', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'a@example.com',
  WEBAUTHN_RP_ID: 'app.example.com', WEBAUTHN_ORIGIN: 'https://app.example.com', CSP_MODE: 'enforce' };
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...FULL_CONFIG, ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const HOOK = 'https://hooks.example.com/services/T/B/x';
function recorder(status = 200) { const calls = []; const f = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return new Response('', { status }); }; f.calls = calls; return f; }
async function failJob(e, id = 'j1') {
  await e.LUMMET_DB.prepare(`INSERT INTO jobs (id, type, status) VALUES (?, 'tenant_provisioning', 'failed')`).bind(id).run();
}
const HOUR = 3600 * 1000;

test('no channel configured: nothing is sent and nothing is recorded as notified', async () => {
  const e = env(); await failJob(e);
  const r = await runAlertCheck(e, { fetchImpl: recorder() });
  assert.equal(r.skipped, 'no_alert_channel_configured');
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM alert_state`).first()).n, 0);
});

test('a new problem notifies once; repeated checks stay quiet; reminder after the interval; resolved when it clears', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const f = recorder(); const t0 = Date.parse('2026-10-04T10:00:00Z');
  assert.ok((await runAlertCheck(e, { fetchImpl: f, now: t0 })).results.every((r) => r.action === 'ok'));
  assert.equal(f.calls.length, 0, 'healthy system sends nothing');

  await failJob(e);
  const first = await runAlertCheck(e, { fetchImpl: f, now: t0 });
  assert.equal(first.results.find((r) => r.key === 'failed_jobs').action, 'notified');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].body.text, /Failed background jobs/);
  assert.match(f.calls[0].body.text, /Count: 1/);

  const quiet = await runAlertCheck(e, { fetchImpl: f, now: t0 + 5 * 60 * 1000 });
  assert.equal(quiet.results.find((r) => r.key === 'failed_jobs').action, 'still_firing_quiet');
  assert.equal(f.calls.length, 1, 'no repeat within the reminder interval');

  const reminder = await runAlertCheck(e, { fetchImpl: f, now: t0 + REMINDER_HOURS * HOUR + 1000 });
  assert.equal(reminder.results.find((r) => r.key === 'failed_jobs').action, 'reminded');
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].body.text, /Still happening/);

  await e.LUMMET_DB.prepare(`UPDATE jobs SET status = 'success'`).run();
  const cleared = await runAlertCheck(e, { fetchImpl: f, now: t0 + 7 * HOUR });
  assert.equal(cleared.results.find((r) => r.key === 'failed_jobs').action, 'resolved');
  assert.match(f.calls[2].body.text, /Resolved/);
  const again = await runAlertCheck(e, { fetchImpl: f, now: t0 + 8 * HOUR });
  assert.equal(again.results.find((r) => r.key === 'failed_jobs').action, 'ok');
  assert.equal(f.calls.length, 3);
});

test('a failed delivery is NOT recorded as notified, so the next check tries again', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); await failJob(e);
  const t0 = Date.parse('2026-10-04T10:00:00Z');
  const down = await runAlertCheck(e, { fetchImpl: recorder(500), now: t0 });
  assert.equal(down.results.find((r) => r.key === 'failed_jobs').action, 'notify_failed');
  const up = recorder(200);
  const retry = await runAlertCheck(e, { fetchImpl: up, now: t0 + 60 * 1000 });
  assert.equal(retry.results.find((r) => r.key === 'failed_jobs').action, 'notified');
  assert.equal(up.calls.length, 1);
});

test('the alert webhook URL goes through the same safety check as customer webhooks', async () => {
  const e = env({ ALERT_WEBHOOK_URL: 'https://169.254.169.254/x' }); await failJob(e); const f = recorder();
  const r = await runAlertCheck(e, { fetchImpl: f });
  assert.equal(r.results.find((x) => x.key === 'failed_jobs').action, 'notify_failed');
  assert.equal(f.calls.length, 0);
});

test('messages contain counts only, never customer data', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const f = recorder();
  await e.LUMMET_DB.prepare(`INSERT INTO email_outbox (id, to_email, template, subject, body_encrypted, body_iv, status) VALUES ('m1','private.person@example.com','notification','Secret subject','x','y','failed')`).run();
  await runAlertCheck(e, { fetchImpl: f });
  const text = JSON.stringify(f.calls);
  assert.match(text, /Emails that could not be delivered/);
  assert.equal(text.includes('private.person'), false);
  assert.equal(text.includes('Secret subject'), false);
});

test('checks fire independently: a stuck job alerts only the stuck-jobs check', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const f = recorder();
  await e.LUMMET_DB.prepare(`INSERT INTO jobs (id, type, status, created_at) VALUES ('stuck','x','running', datetime('now','-2 hours'))`).run();
  const r = await runAlertCheck(e, { fetchImpl: f });
  const fired = r.results.filter((x) => x.action === 'notified').map((x) => x.key);
  assert.deepEqual(fired, ['stuck_jobs']);
});

test('email channel queues a notification once per event', async () => {
  const e = env({ ALERT_EMAIL: 'oncall@example.com' }); await failJob(e);
  const r = await runAlertCheck(e, { fetchImpl: recorder() });
  assert.equal(r.results.find((x) => x.key === 'failed_jobs').action, 'notified');
  const rows = await e.LUMMET_DB.prepare(`SELECT to_email, subject FROM email_outbox`).all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].to_email, 'oncall@example.com');
  assert.match(rows.results[0].subject, /Lummet alert/);
});

test('tokenMatches is exact and fails closed', async () => {
  assert.equal(await tokenMatches('abc', 'abc'), true);
  assert.equal(await tokenMatches('abd', 'abc'), false);
  assert.equal(await tokenMatches('', 'abc'), false);
  assert.equal(await tokenMatches('abc', undefined), false);
  assert.equal(await tokenMatches('abc', ''), false);
});

async function call(e, method, path, { token, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '203.0.113.9' });
  if (token) h.set('Authorization', 'Bearer ' + token); if (cookie) h.set('Cookie', cookie);
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t };
}

test('external trigger endpoint: 404 without a matching token (or when no token is configured), 200 with it', async () => {
  const off = env();
  assert.equal((await call(off, 'POST', '/api/ops/alert-check', { token: 'anything' })).status, 404, 'disabled when ALERT_CHECK_TOKEN is unset');
  const e = env({ ALERT_CHECK_TOKEN: 'secret-token-value' });
  assert.equal((await call(e, 'POST', '/api/ops/alert-check')).status, 404);
  assert.equal((await call(e, 'POST', '/api/ops/alert-check', { token: 'wrong' })).status, 404);
  const ok = await call(e, 'POST', '/api/ops/alert-check', { token: 'secret-token-value' });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.skipped, 'no_alert_channel_configured');
  assert.equal((await call(e, 'GET', '/api/ops/alert-check', { token: 'secret-token-value' })).status, 200, 'GET works for simple uptime pingers');
});

test('staff alerts page renders and is closed to anonymous callers', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK });
  assert.ok([301, 302, 303].includes((await call(e, 'GET', '/platform/saas/alerts')).status));
  const post = await call(e, 'POST', '/api/platform/saas/alerts/check');
  assert.equal(post.status, 401);
});

test('signed-in super admin can open the alerts page and run a check (409 when no channel is set)', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK, ALERT_CHECK_TOKEN: '' });
  const post = async (path, body, cookie) => {
    const h = new Headers({ 'CF-Connecting-IP': '198.51.100.20', 'Content-Type': 'application/json' }); if (cookie) h.set('Cookie', cookie);
    const res = await worker.fetch(new Request('https://cp.test' + path, { method: 'POST', headers: h, body: JSON.stringify(body || {}), redirect: 'manual' }), e, ctx);
    return { status: res.status, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0], text: await res.text() };
  };
  assert.equal((await post('/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).status, 200);
  const cookie = (await post('/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;
  const page = await call(e, 'GET', '/platform/saas/alerts', { cookie });
  assert.equal(page.status, 200);
  assert.match(page.text, /chat webhook/);
  assert.match(page.text, /ALERT_CHECK_TOKEN is not set/);
  const realFetch = globalThis.fetch; globalThis.fetch = async () => new Response('', { status: 200 });
  try { assert.equal((await post('/api/platform/saas/alerts/check', {}, cookie)).status, 200); } finally { globalThis.fetch = realFetch; }
});

// ---- v6A: four checks ported from v4B ----
const firedKeys = (r) => r.results.filter((x) => x.action === 'notified').map((x) => x.key);

test('unhealthy_tenants: an active tenant whose health check is not Online fires; Online, Disabled and disabled tenants do not', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const db = e.LUMMET_DB;
  const add = async (id, tenantStatus, health) => {
    await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url, status) VALUES (?, ?, ?, ?, ?)`).bind(id, id, id + '.example.com', 'https://' + id + '.example.com', tenantStatus).run();
    await db.prepare(`INSERT INTO tenant_health (tenant_id, status) VALUES (?, ?)`).bind(id, health).run();
  };
  await add('ok', 'active', 'Online'); await add('off', 'active', 'Disabled'); await add('retired', 'disabled', 'Unauthorized');
  const f = recorder();
  assert.deepEqual(firedKeys(await runAlertCheck(e, { fetchImpl: f })), [], 'nothing unhealthy yet');
  await add('broken', 'active', 'Timeout');
  const r = await runAlertCheck(e, { fetchImpl: f });
  assert.deepEqual(firedKeys(r), ['unhealthy_tenants']);
  assert.match(f.calls[0].body.text, /Tenants failing health checks/);
  assert.match(f.calls[0].body.text, /Count: 1/);
  await db.prepare(`UPDATE tenant_health SET status = 'Online' WHERE tenant_id = 'broken'`).run();
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'unhealthy_tenants').action, 'resolved');
});

test('stale_email_queue: mail still queued after 30 minutes fires; fresh mail and sent mail do not; no addresses in the message', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const db = e.LUMMET_DB; const f = recorder();
  const mail = (id, status, age) => db.prepare(`INSERT INTO email_outbox (id, to_email, template, subject, body_encrypted, body_iv, status, created_at) VALUES (?, 'someone.private@example.com', 'notification', 'Private subject', 'x', 'y', ?, datetime('now', ?))`).bind(id, status, age).run();
  await mail('fresh', 'queued', '-5 minutes'); await mail('done', 'sent', '-3 hours');
  assert.deepEqual(firedKeys(await runAlertCheck(e, { fetchImpl: f })), []);
  await mail('stale', 'queued', '-45 minutes');
  assert.deepEqual(firedKeys(await runAlertCheck(e, { fetchImpl: f })), ['stale_email_queue']);
  const text = JSON.stringify(f.calls);
  assert.match(text, /Emails queued for over 30 minutes/);
  assert.equal(text.includes('someone.private'), false);
  assert.equal(text.includes('Private subject'), false);
});

test('failed_billing_webhooks: a failed provider event in the last 7 days fires; processed and old failures do not', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const db = e.LUMMET_DB; const f = recorder();
  const ev = (id, status, age) => db.prepare(`INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, status, error_message, received_at) VALUES ('stripe', ?, 'invoice.paid', ?, 'secret failure detail', datetime('now', ?))`).bind(id, status, age).run();
  await ev('evt_ok', 'processed', '-1 hours'); await ev('evt_old', 'failed', '-10 days');
  assert.deepEqual(firedKeys(await runAlertCheck(e, { fetchImpl: f })), []);
  await ev('evt_bad', 'failed', '-2 hours');
  assert.deepEqual(firedKeys(await runAlertCheck(e, { fetchImpl: f })), ['failed_billing_webhooks']);
  assert.equal(JSON.stringify(f.calls).includes('secret failure detail'), false, 'error text is never sent');
  // Ages out of the window on its own.
  await db.prepare(`UPDATE billing_webhook_events SET received_at = datetime('now','-8 days') WHERE provider_event_id = 'evt_bad'`).run();
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'failed_billing_webhooks').action, 'resolved');
});

test('incomplete_deletions: fires while the LATEST erasure attempt for a subject is partial or failed, and clears once a later attempt completes', async () => {
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const db = e.LUMMET_DB; const f = recorder();
  for (const o of ['org-done', 'org-stuck', 'org-broken', 'org-stopped']) {
    await db.prepare(`INSERT INTO organizations (id, name, slug, status, scheduled_deletion_at) VALUES (?, ?, ?, 'closed', '2000-01-01T00:00:00.000Z')`).bind(o, o, o).run();
  }
  const log = (id, subject, status, at) => db.prepare(`INSERT INTO erasure_log (id, kind, subject_id, status, summary, created_at) VALUES (?, 'organization', ?, ?, '{}', ?)`).bind(id, subject, status, at).run();
  await log('l1', 'org-done', 'partial', '2026-10-01 10:00:00');
  await log('l2', 'org-done', 'complete', '2026-10-01 11:00:00');       // retried successfully: not a problem
  assert.deepEqual(firedKeys(await runAlertCheck(e, { fetchImpl: f })), []);

  await log('l3', 'org-stuck', 'partial', '2026-10-02 10:00:00');       // external resources left behind
  await log('l4', 'org-broken', 'failed', '2026-10-02 10:00:00');
  const r = await runAlertCheck(e, { fetchImpl: f });
  assert.deepEqual(firedKeys(r), ['incomplete_deletions']);
  assert.match(f.calls[0].body.text, /Count: 2/);
  assert.match(f.calls[0].body.text, /could not fully clean up/);

  // Staff stop a deletion after a partial attempt: it is no longer retried, so it must not count.
  const repo = await import('../worker/repositories/alert-state.js');
  assert.equal(await repo.countFor(e, 'incomplete_deletions'), 2);
  await log('l7', 'org-stopped', 'partial', '2026-10-02 10:00:00');
  assert.equal(await repo.countFor(e, 'incomplete_deletions'), 3, 'still scheduled, so it counts');
  await db.prepare(`UPDATE organizations SET scheduled_deletion_at = NULL, status = 'active' WHERE id = 'org-stopped'`).run();
  assert.equal(await repo.countFor(e, 'incomplete_deletions'), 2, 'stopped, so it no longer counts');
  await log('l5', 'org-stuck', 'complete', '2026-10-03 10:00:00');
  await log('l6', 'org-broken', 'complete', '2026-10-03 10:00:00');
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'incomplete_deletions').action, 'resolved');
});

test('incomplete_deletions end to end: a real erasure that cannot delete a Cloudflare resource raises the alert', async () => {
  const { eraseOrganization } = await import('../worker/erasure.js');
  const { createFakeInfraProvider } = await import('./support/fake-infra-provider.js');
  const e = env({ ALERT_WEBHOOK_URL: HOOK }); const db = e.LUMMET_DB; const f = recorder();
  await db.prepare(`INSERT INTO organizations (id, name, slug, status, scheduled_deletion_at) VALUES ('o1', 'Leaving', 'leaving', 'active', '2000-01-01T00:00:00.000Z')`).run();
  const prod = await db.prepare(`SELECT id FROM products LIMIT 1`).first();
  await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) VALUES ('s1', 'o1', ?, 'S', 's', 'active')`).bind(prod.id).run();
  await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES ('s1','cloudflare','d1','db-1','db')`).run();
  const infra = createFakeInfraProvider();
  infra.deleteDatabase = async () => { throw new Error('cloudflare is down'); };
  const r = await eraseOrganization(e, 'o1', { infra });
  assert.equal(r.partial, true);
  assert.deepEqual(firedKeys(await runAlertCheck(e, { fetchImpl: f })), ['incomplete_deletions']);
});

test('the new checks use the repository for their SQL and every check key has a count query', async () => {
  const repo = await import('../worker/repositories/alert-state.js');
  const e = env();
  for (const key of ['stale_email_queue', 'unhealthy_tenants', 'incomplete_deletions', 'failed_billing_webhooks']) {
    assert.equal(await repo.countFor(e, key), 0, key);
  }
});
