// v7I: request ids, structured failure logs, the request_errors table, the Errors page and the alert.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { observe, routeOf, slowThresholdMs } from '../worker/observability.js';
import * as errorsRepo from '../worker/repositories/request-errors.js';
import { runAlertCheck } from '../worker/alerts.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const mk = (extra = {}) => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function captureLogs() {
  const logs = []; const o = { log: console.log, warn: console.warn, error: console.error };
  console.log = (m) => logs.push({ level: 'log', m }); console.warn = (m) => logs.push({ level: 'warn', m }); console.error = (m) => logs.push({ level: 'error', m });
  return { logs, restore: () => Object.assign(console, o), parsed: () => logs.map((l) => ({ ...JSON.parse(l.m) })) };
}
async function fetchAs(e, method, path, { body, cookie, headers = {} } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1), ...headers });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { res, text, json, status: res.status, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
/** A database that works until a statement mentions `needle`, then throws: a way to make one route fail for real. */
function failingOn(db, needle, message = 'D1_ERROR: no such table: secret_table') {
  return { prepare(sql) { if (sql.includes(needle)) throw new Error(message); return db.prepare(sql); }, batch: (x) => db.batch(x), exec: (x) => db.exec(x) };
}

test('routeOf: ids, numbers and tokens become placeholders; nothing else is kept', () => {
  assert.equal(routeOf('/api/organizations/6f1e2d3c-1111-2222-3333-444455556666/sites/42/dashboard-admin'), '/api/organizations/:id/sites/:n/dashboard-admin');
  assert.equal(routeOf('/api/v1/keys/lmk_0123456789abcdef0123456789abcdef'), '/api/v1/keys/:token');
  assert.equal(routeOf('/app/overview'), '/app/overview'); assert.equal(routeOf(''), '/'); assert.equal(routeOf(undefined), '/');
  assert.ok(routeOf('/x/' + 'a'.repeat(500)).length <= 160);
  assert.equal(routeOf('/api/customer/email/verify'), '/api/customer/email/verify');
});

test('observe: a failure is one structured line plus a stored row, with no request data', async () => {
  const e = mk(); const c = captureLogs();
  try {
    const err = new TypeError('Cannot read properties of undefined (reading \'id\')');
    await observe(e, null, { requestId: 'req-1', method: 'POST', pathname: '/api/organizations/6f1e2d3c-1111-2222-3333-444455556666/webhooks', status: 500, startedAt: Date.now() - 30, error: err });
  } finally { c.restore(); }
  const [line] = c.parsed();
  assert.equal(line.level, 'error'); assert.equal(line.event, 'unhandled_exception'); assert.equal(line.request_id, 'req-1');
  assert.equal(line.route, '/api/organizations/:id/webhooks'); assert.equal(line.error_name, 'TypeError'); assert.match(line.error_message, /reading 'id'/);
  assert.ok(line.duration_ms >= 30); assert.ok(line.stack.length <= 500);
  const row = (await errorsRepo.listRecent(e))[0];
  assert.deepEqual({ request_id: row.request_id, method: row.method, route: row.route, status: row.status, error_name: row.error_name }, { request_id: 'req-1', method: 'POST', route: '/api/organizations/:id/webhooks', status: 500, error_name: 'TypeError' });
});

test('observe: a 5xx without an exception is recorded; slow requests warn; normal requests are silent unless LOG_REQUESTS=all', async () => {
  const e = mk(); const c = captureLogs();
  try {
    await observe(e, null, { requestId: 'a', method: 'GET', pathname: '/api/x', status: 502, startedAt: Date.now() });
    await observe(e, null, { requestId: 'b', method: 'GET', pathname: '/api/slow', status: 200, startedAt: Date.now() - 5000 });
    await observe(e, null, { requestId: 'c', method: 'GET', pathname: '/api/fine', status: 200, startedAt: Date.now() });
    await observe({ ...e, LOG_REQUESTS: 'all' }, null, { requestId: 'd', method: 'GET', pathname: '/api/fine', status: 404, startedAt: Date.now() });
  } finally { c.restore(); }
  const p = c.parsed();
  assert.deepEqual(p.map((x) => [x.event, x.request_id]), [['server_error', 'a'], ['slow_request', 'b'], ['request', 'd']]);
  assert.equal((await errorsRepo.listRecent(e)).length, 1);
  assert.equal(slowThresholdMs({}), 2000); assert.equal(slowThresholdMs({ SLOW_REQUEST_MS: '500' }), 500); assert.equal(slowThresholdMs({ SLOW_REQUEST_MS: 'x' }), 2000);
});

test('observe never throws, even with no database at all', async () => {
  const c = captureLogs();
  try { assert.equal(await observe({}, null, { requestId: 'x', method: 'GET', pathname: '/', status: 500, startedAt: Date.now() }) !== undefined, true); }
  finally { c.restore(); }
});

test('the recorder stops at 100 rows a minute so a flood is one incident, not a full table', async () => {
  const e = mk();
  for (let i = 0; i < 130; i++) await errorsRepo.record(e, { requestId: 'r' + i, method: 'GET', route: '/x', status: 500 });
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM request_errors`).first()).n, 100);
});

test('every response carries a fresh X-Request-Id and a Server-Timing header; an id sent by the client is ignored', async () => {
  const e = mk(); const seen = new Set();
  for (const [m, p] of [['GET', '/app/login'], ['GET', '/nothing-here'], ['GET', '/api/health'], ['GET', '/'], ['POST', '/api/customer/login'], ['GET', '/app/overview']]) {
    const r = await fetchAs(e, m, p, { headers: { 'X-Request-Id': 'attacker-chosen' }, body: m === 'POST' ? {} : undefined });
    const id = r.res.headers.get('X-Request-Id');
    assert.match(id, UUID, `${m} ${p}`); assert.notEqual(id, 'attacker-chosen'); seen.add(id);
    assert.match(r.res.headers.get('Server-Timing'), /^app;dur=\d+$/, `${m} ${p}`);
  }
  assert.equal(seen.size, 6);
});

test('an unhandled exception: the client gets the same reference as the header, the log and the stored row; no request data is kept', async () => {
  const e = mk(); const real = e.LUMMET_DB; e.LUMMET_DB = failingOn(real, 'customer_sessions', 'D1_ERROR: no such table: secret_table');
  const c = captureLogs(); let r;
  try {
    r = await fetchAs(e, 'GET', '/api/organizations/6f1e2d3c-1111-2222-3333-444455556666/notifications?token=SUPERSECRETQUERY', { cookie: 'lummet_customer_session=SECRETCOOKIEVALUE', headers: { Authorization: 'Bearer SECRETBEARER' } });
  } finally { c.restore(); }
  assert.equal(r.status, 500, r.text);
  const id = r.res.headers.get('X-Request-Id');
  assert.equal(r.json.error, 'internal_error'); assert.equal(r.json.requestId, id);
  const [line] = c.parsed().filter((x) => x.event === 'unhandled_exception');
  assert.equal(line.request_id, id); assert.equal(line.route, '/api/organizations/:id/notifications'); assert.equal(line.status, 500); assert.match(line.error_message, /no such table/);
  assert.equal(JSON.stringify(c.logs).match(/SUPERSECRET|SECRETCOOKIE|SECRETBEARER|6f1e2d3c/), null, 'nothing from the request reaches the log');
  const rows = (await real.prepare(`SELECT route, status, error_name, message, request_id FROM request_errors WHERE request_id = ?`).bind(id).all()).results;
  assert.equal(rows.length, 1); assert.equal(rows[0].route, '/api/organizations/:id/notifications'); assert.equal(rows[0].status, 500);
  assert.equal(JSON.stringify(rows).match(/SUPERSECRET|SECRETCOOKIE|SECRETBEARER|6f1e2d3c/), null);
});

test('an HTML page that fails shows the reference, not the error', async () => {
  const e = mk(); e.LUMMET_DB = failingOn(e.LUMMET_DB, 'customer_sessions', 'D1_ERROR: leaked internal detail');
  const c = captureLogs(); let r;
  try { r = await fetchAs(e, 'GET', '/app/overview', { cookie: 'lummet_customer_session=x' }); } finally { c.restore(); }
  assert.equal(r.status, 500);
  assert.match(r.text, new RegExp('quote this reference: ' + r.res.headers.get('X-Request-Id')));
  assert.doesNotMatch(r.text, /leaked internal detail/);
});

test('audit rows use the same request id the client sees', async () => {
  const e = mk();
  const r = await fetchAs(e, 'POST', '/api/customer/signup', { body: { email: 'audit@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org' } });
  assert.equal(r.status, 200, r.text);
  const id = r.res.headers.get('X-Request-Id');
  const n = (await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE request_id = ?`).bind(id).first()).n;
  assert.ok(n >= 1, 'at least one audit row carries the response\'s request id');
});

// ---- the staff page and the alert ----
async function staffCookie(e) {
  await fetchAs(e, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  return (await fetchAs(e, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
}

test('staff Errors page: lists recent errors and a 24h summary, escapes everything, needs a super admin, and is in the nav', async () => {
  const e = mk(); const staff = await staffCookie(e);
  const empty = await fetchAs(e, 'GET', '/platform/saas/errors', { cookie: staff });
  assert.equal(empty.status, 200); assert.match(empty.text, /No server errors in the last 24 hours/); assert.match(empty.text, /href="\/platform\/saas\/errors"/);
  await errorsRepo.record(e, { requestId: 'req-A', method: 'POST', route: '/api/x/:id', status: 500, errorName: 'TypeError', message: '<img src=x onerror=alert(1)>' });
  await errorsRepo.record(e, { requestId: 'req-B', method: 'GET', route: '/api/x/:id', status: 500 });
  const page = await fetchAs(e, 'GET', '/platform/saas/errors', { cookie: staff });
  assert.match(page.text, /req-A/); assert.match(page.text, /POST \/api\/x\/:id/); assert.match(page.text, /TypeError: &lt;img src=x/); assert.doesNotMatch(page.text, /<img src=x/);
  assert.match(page.text, />2<\/td>/, 'summary counts both');
  assert.notEqual((await fetchAs(e, 'GET', '/platform/saas/errors')).status, 200, 'signed-out callers do not see it');
});

test('alert: 5 or more server errors within 15 minutes fires, older ones do not count, and it resolves', async () => {
  const e = mk({ ENVIRONMENT: 'staging', ALERT_WEBHOOK_URL: 'https://hooks.example.com/services/T/B/x' });
  const sent = []; const f = async (u, i) => { sent.push(JSON.parse(i.body).text); return { ok: true, status: 200 }; };
  const add = (n, age) => { const rows = []; for (let i = 0; i < n; i++) rows.push(e.LUMMET_DB.prepare(`INSERT INTO request_errors (request_id, method, route, status, created_at) VALUES (?, 'GET', '/x', 500, datetime('now', ?))`).bind('r' + Math.random(), age).run()); return Promise.all(rows); };
  await add(4, '-1 minutes');
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'server_errors').action, 'ok', '4 is noise');
  await add(10, '-2 hours');
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'server_errors').action, 'ok', 'old errors do not count');
  await add(1, '-1 minutes');
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'server_errors').action, 'notified');
  assert.match(sent.join('\n'), /Server errors in the last 15 minutes/); assert.match(sent.join('\n'), /Count: 5/);
  await e.LUMMET_DB.prepare(`DELETE FROM request_errors`).run();
  assert.equal((await runAlertCheck(e, { fetchImpl: f })).results.find((x) => x.key === 'server_errors').action, 'resolved');
});

test('the maintenance tick purges errors older than 14 days and keeps recent ones', async () => {
  const e = mk(); e.ALERT_CHECK_TOKEN = 'tick-token-0123456789';
  await e.LUMMET_DB.prepare(`INSERT INTO request_errors (request_id, method, route, status, created_at) VALUES ('old', 'GET', '/x', 500, datetime('now','-15 days')), ('new', 'GET', '/x', 500, datetime('now','-13 days'))`).run();
  const pending = []; const c = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
  const res = await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method: 'POST', headers: { Authorization: 'Bearer ' + e.ALERT_CHECK_TOKEN } }), e, c);
  assert.equal(res.status, 200); await Promise.all(pending);
  assert.deepEqual((await errorsRepo.listRecent(e)).map((r) => r.request_id), ['new']);
});
