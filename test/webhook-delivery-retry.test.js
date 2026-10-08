// v7D: webhook delivery retries. dispatchEvent makes the first attempt; sweepDeliveries retries with backoff,
// dead-letters after MAX_ATTEMPTS, and redeliver() lets a customer re-send by hand.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as webhooks from '../worker/webhooks.js';
import * as customerAuth from '../worker/customer-auth.js';
import { runAlertCheck } from '../worker/alerts.js';

const { MAX_ATTEMPTS } = webhooks;
const HOUR = 3600 * 1000;
const URL_OK = 'https://hooks.example.com/in';

function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64') };
}
const signup = (email) => ({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.81' } });
async function setup(email = 'wh@example.com') {
  const env = makeEnv();
  const s = await customerAuth.signUp(signup(email), env);
  const hook = await webhooks.createWebhook(env, { organizationId: s.organizationId, url: URL_OK, eventTypes: ['site.created'], actorUserId: s.userId });
  return { env, orgId: s.organizationId, webhookId: hook.webhookId, secret: hook.secret };
}
/** Replaces global fetch with a scripted fake: each call takes the next status (or an Error) from `script`, then repeats the last. */
function fakeFetch(script) {
  const calls = []; const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    const r = script[Math.min(calls.length - 1, script.length - 1)];
    if (r instanceof Error) throw r;
    return new Response('', { status: r });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const rows = (env) => env.LUMMET_DB.prepare(`SELECT * FROM webhook_deliveries ORDER BY rowid`).all().then((r) => r.results);
const fire = (env, orgId) => webhooks.dispatchEvent(env, orgId, 'site.created', { siteId: 's1' });

test('a failed first attempt is recorded as failed (attempt 1) and shows when the next attempt is due', async () => {
  const { env, orgId, webhookId } = await setup(); const f = fakeFetch([500]);
  try { await fire(env, orgId); } finally { f.restore(); }
  const [d] = await rows(env);
  assert.equal(d.status, 'failed'); assert.equal(d.attempt, 1); assert.equal(d.response_code, 500); assert.equal(d.error_message, 'http_500');
  const listed = (await webhooks.listDeliveries(env, orgId, webhookId)).data[0];
  assert.ok(Math.abs(Date.parse(listed.next_attempt_at) - (Date.parse(d.last_attempt_at.replace(' ', 'T') + 'Z') + 60000)) < 1000, 'first retry after 1 minute');
});

test('the sweep retries only when the wait has passed, re-sends the SAME body and delivery id, signs afresh, and marks it delivered', async () => {
  const { env, orgId, secret } = await setup(); const f = fakeFetch([503, 200]);
  try {
    await fire(env, orgId);
    assert.equal((await webhooks.sweepDeliveries(env)).retried, 0, 'not due yet');
    const r = await webhooks.sweepDeliveries(env, { now: Date.now() + 2 * 60 * 1000 });
    assert.equal(r.retried, 1);
  } finally { f.restore(); }
  const [d] = await rows(env);
  assert.equal(d.status, 'delivered'); assert.equal(d.attempt, 2); assert.equal(d.response_code, 200); assert.ok(d.delivered_at);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body, f.calls[1].body, 'identical payload on every attempt');
  assert.equal(JSON.parse(f.calls[1].body).id, d.id);
  assert.equal(f.calls[1].headers['Lummet-Delivery-Id'], d.id);
  assert.deepEqual([f.calls[0].headers['Lummet-Delivery-Attempt'], f.calls[1].headers['Lummet-Delivery-Attempt']], ['1', '2']);
  const [, t, v1] = f.calls[1].headers['Lummet-Signature'].match(/^t=(\d+),v1=([0-9a-f]+)$/);
  assert.equal(v1, createHmac('sha256', secret).update(`${t}.${f.calls[1].body}`).digest('hex'), 'valid signature over the fresh timestamp');
});

test('a delivery that never succeeds ends up dead after MAX_ATTEMPTS and is then left alone', async () => {
  const { env, orgId } = await setup(); const f = fakeFetch([500]);
  try {
    await fire(env, orgId);
    for (let i = 1; i < MAX_ATTEMPTS; i++) assert.equal((await webhooks.sweepDeliveries(env, { now: Date.now() + i * 7 * HOUR })).retried, 1, `retry ${i}`);
    assert.equal((await webhooks.sweepDeliveries(env, { now: Date.now() + 99 * HOUR })).retried, 0);
  } finally { f.restore(); }
  const [d] = await rows(env);
  assert.equal(d.status, 'dead'); assert.equal(d.attempt, MAX_ATTEMPTS); assert.equal(f.calls.length, MAX_ATTEMPTS);
});

test('permanent failures go straight to dead without retrying: a blocked address, and an endpoint that answers 410', async () => {
  const a = await setup('perm1@example.com'); const f1 = fakeFetch([200]);
  await a.env.LUMMET_DB.prepare(`UPDATE webhooks SET url = 'https://10.0.0.5/x' WHERE id = ?`).bind(a.webhookId).run();
  try { await fire(a.env, a.orgId); } finally { f1.restore(); }
  const [d1] = await rows(a.env);
  assert.equal(d1.status, 'dead'); assert.equal(d1.error_message, 'url_host_not_allowed'); assert.equal(f1.calls.length, 0, 'nothing was sent');

  const b = await setup('perm2@example.com'); const f2 = fakeFetch([410]);
  try { await fire(b.env, b.orgId); } finally { f2.restore(); }
  const [d2] = await rows(b.env);
  assert.equal(d2.status, 'dead'); assert.equal(d2.error_message, 'endpoint_gone');
});

test('network errors are retried like any other failure', async () => {
  const { env, orgId } = await setup(); const f = fakeFetch([new Error('connect timeout'), 200]);
  try { await fire(env, orgId); await webhooks.sweepDeliveries(env, { now: Date.now() + 2 * 60 * 1000 }); } finally { f.restore(); }
  const [d] = await rows(env);
  assert.equal(d.status, 'delivered'); assert.equal(d.attempt, 2);
});

test('a webhook that was disabled or deleted meanwhile: its pending retry is closed as dead, nothing is sent', async () => {
  const { env, orgId, webhookId } = await setup(); const f = fakeFetch([500]);
  try {
    await fire(env, orgId);
    await env.LUMMET_DB.prepare(`UPDATE webhooks SET status = 'disabled' WHERE id = ?`).bind(webhookId).run();
    await webhooks.sweepDeliveries(env, { now: Date.now() + 2 * 60 * 1000 });
  } finally { f.restore(); }
  const [d] = await rows(env);
  assert.equal(d.status, 'dead'); assert.equal(d.error_message, 'webhook_disabled_or_deleted'); assert.equal(f.calls.length, 1);
});

test('two sweeps at the same moment send each retry once', async () => {
  const { env, orgId } = await setup(); const f = fakeFetch([500, 200]);
  try {
    await fire(env, orgId);
    const now = Date.now() + 2 * 60 * 1000;
    await Promise.all([webhooks.sweepDeliveries(env, { now }), webhooks.sweepDeliveries(env, { now })]);
  } finally { f.restore(); }
  assert.equal(f.calls.length, 2, 'one first attempt + one retry');
  assert.equal((await rows(env))[0].attempt, 2);
});

test('old failures from before retries existed are closed as dead, not suddenly re-sent; a send stuck mid-flight is picked up', async () => {
  const { env, webhookId } = await setup(); const f = fakeFetch([200]);
  const body = JSON.stringify({ id: 'old1', type: 'site.created', created: 1, data: {} });
  const ins = (id, status, attempt, createdAgo, lastAgo) => env.LUMMET_DB.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempt, created_at, last_attempt_at) VALUES (?, ?, 'site.created', ?, ?, ?, datetime('now', ?), ${lastAgo ? "datetime('now', ?)" : 'NULL'})`
  ).bind(...[id, webhookId, body, status, attempt, createdAgo, ...(lastAgo ? [lastAgo] : [])]).run();
  await ins('old1', 'failed', 1, '-5 days', null);
  await ins('stuck1', 'retrying', 2, '-1 hours', '-10 minutes');
  try { await webhooks.sweepDeliveries(env); } finally { f.restore(); }
  const byId = Object.fromEntries((await rows(env)).map((r) => [r.id, r]));
  assert.equal(byId.old1.status, 'dead'); assert.match(byId.old1.error_message, /retry window expired/);
  assert.equal(byId.stuck1.status, 'delivered'); assert.equal(byId.stuck1.attempt, 3);
  assert.equal(f.calls.length, 1, 'only the stuck one was sent');
});

test('redeliver: a customer can re-send a dead delivery by hand; not another org\'s, not one already delivered', async () => {
  const a = await setup('re1@example.com'); const other = await setup('re2@example.com');
  const f = fakeFetch([500, 200]);
  try {
    await fire(a.env, a.orgId);
    await a.env.LUMMET_DB.prepare(`UPDATE webhook_deliveries SET status = 'dead', attempt = ?`).bind(MAX_ATTEMPTS).run();
    const [d] = await rows(a.env);
    assert.equal((await webhooks.redeliver(a.env, 'someone-else', a.webhookId, d.id)).status, 404, 'wrong organization');
    assert.equal((await webhooks.redeliver(a.env, a.orgId, a.webhookId, 'nope')).status, 404);
    const ok = await webhooks.redeliver(a.env, a.orgId, a.webhookId, d.id);
    assert.equal(ok.ok, true); assert.equal(ok.data.status, 'delivered'); assert.equal(ok.data.attempt, MAX_ATTEMPTS + 1);
    assert.equal((await webhooks.redeliver(a.env, a.orgId, a.webhookId, d.id)).error, 'already_delivered');
  } finally { f.restore(); }
  void other;
});

test('redeliver of a delivery that fails again leaves it dead (no automatic retries resume)', async () => {
  const { env, orgId, webhookId } = await setup(); const f = fakeFetch([500]);
  try {
    await fire(env, orgId);
    await env.LUMMET_DB.prepare(`UPDATE webhook_deliveries SET status = 'dead', attempt = ?`).bind(MAX_ATTEMPTS).run();
    const [d] = await rows(env);
    assert.equal((await webhooks.redeliver(env, orgId, webhookId, d.id)).data.status, 'dead');
    assert.equal((await webhooks.sweepDeliveries(env, { now: Date.now() + 99 * HOUR })).retried, 0);
  } finally { f.restore(); }
});

test('the dead_webhook_deliveries alert only fires on a spike (10 or more in 24 hours), not for one customer\'s dead endpoint', async () => {
  const { env, webhookId } = await setup();
  const add = (n) => { const q = []; for (let i = 0; i < n; i++) q.push(env.LUMMET_DB.prepare(`INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempt, last_attempt_at) VALUES (?, ?, 'site.created', '{}', 'dead', 6, CURRENT_TIMESTAMP)`).bind(crypto.randomUUID(), webhookId)); return env.LUMMET_DB.batch(q); };
  const check = () => runAlertCheck({ ...env, ENVIRONMENT: 'staging', ALERT_WEBHOOK_URL: 'https://hooks.example.com/x/y' }, { fetchImpl: async () => new Response('', { status: 200 }) });
  await add(9);
  assert.equal((await check()).results.find((r) => r.key === 'dead_webhook_deliveries').action, 'ok');
  await add(1);
  assert.equal((await check()).results.find((r) => r.key === 'dead_webhook_deliveries').action, 'notified');
});

// ---- the customer API route ----
import worker from '../worker/index.js';
test('POST .../webhooks/:id/deliveries/:deliveryId/redeliver: needs a session, re-sends, is audited, and lists attempt info', async () => {
  const env = makeEnv(); env.ENVIRONMENT = 'staging';
  const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
  let n = 10;
  const call = async (method, path, { body, cookie } = {}) => {
    const h = new Headers({ 'CF-Connecting-IP': `203.0.113.${n++}` }); if (cookie) h.set('Cookie', cookie);
    let payload; if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
    const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  const s = await call('POST', '/api/customer/signup', { body: { email: 'route@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } });
  const orgId = s.json.organizationId;
  const created = await call('POST', `/api/organizations/${orgId}/webhooks`, { cookie: s.cookie, body: { url: URL_OK, eventTypes: ['site.created'] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const hookId = created.json.webhookId;
  const f = fakeFetch([500, 200]);
  try {
    await fire(env, orgId);
    await env.LUMMET_DB.prepare(`UPDATE webhook_deliveries SET status = 'dead', attempt = 6`).run();
    const [d] = await rows(env);
    const path = `/api/organizations/${orgId}/webhooks/${hookId}/deliveries/${d.id}/redeliver`;
    assert.equal((await call('POST', path)).status, 401);
    const ok = await call('POST', path, { cookie: s.cookie });
    assert.equal(ok.status, 200); assert.equal(ok.json.data.status, 'delivered');
    assert.equal((await call('POST', path, { cookie: s.cookie })).status, 409);
    const list = await call('GET', `/api/organizations/${orgId}/webhooks/${hookId}/deliveries`, { cookie: s.cookie });
    assert.equal(list.json.data[0].attempt, 7); assert.equal(list.json.data[0].status, 'delivered');
    const audit = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE action = 'redeliver'`).first();
    assert.equal(audit.n, 2, 'both the success and the refusal are audited');
  } finally { f.restore(); }
});
