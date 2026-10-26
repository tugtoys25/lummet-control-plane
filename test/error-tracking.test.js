// Round 6.3C (stage 2): optional error tracking (SENTRY_DSN or any Sentry-protocol service) with PII scrubbing.
// Acceptance tests written first. Nothing here talks to a real tracker: the transport is a stub, so wire compatibility with a
// live service is NOT VERIFIED by this file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { observe } from '../worker/observability.js';
import { containsSensitive } from '../worker/redact.js';
import { errorTrackingMode, parseDsn, buildEvent, buildEnvelope, captureException, resetErrorTrackingForTests } from '../worker/error-tracking.js';

const DSN = 'https://0123abcd4567ef89@o42.ingest.tracker.example/4501';
const UUID = '6f1e2d3c-1111-2222-3333-444455556666';
const j = (...p) => p.join('');
const STRIPE = j('sk_', 'live_', '4eC39HqLyjWDarjtT1zdp7dc');

const nowFixed = (t = 1_761_400_000_000) => ({ now: () => t });
const okFetch = () => { const calls = []; const fn = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"id":"x"}', { status: 200 }); }; fn.calls = calls; return fn; };

function piiError() {
  const e = new TypeError(`Cannot charge jane.doe@example.com from 203.0.113.7 with ${STRIPE}: GET https://app.example.test/api/customer/email/verify?token=SECRETQUERY failed; password=hunter2`);
  e.stack = [
    `TypeError: ${e.message}`,
    '    at chargeCustomer (worker/billing.js:412:19)',
    '    at async handleRequest (https://app.example.test/worker/index.js?token=SECRETQUERY:88:7)',
    '    at async Object.fetch (worker/index.js:405:20)'
  ].join('\n');
  return e;
}
const CTX = { requestId: UUID, method: 'POST', route: '/api/organizations/:id/webhooks', status: 500 };

function captureConsole() {
  const out = []; const saved = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(saved)) console[k] = (...a) => out.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  return { out, restore: () => Object.assign(console, saved) };
}

// ---- mode and DSN --------------------------------------------------------------------------------------------------

test('ERROR_TRACKING is off by default; shadow and on are exact words (case and spaces tolerated); anything else is off', () => {
  assert.equal(errorTrackingMode({}), 'off'); assert.equal(errorTrackingMode(undefined), 'off');
  assert.equal(errorTrackingMode({ ERROR_TRACKING: 'shadow' }), 'shadow'); assert.equal(errorTrackingMode({ ERROR_TRACKING: ' ON ' }), 'on');
  for (const v of ['', 'off', 'true', 'yes', '1', 'enabled', 'sentry']) assert.equal(errorTrackingMode({ ERROR_TRACKING: v }), 'off', v);
});

test('parseDsn builds the envelope endpoint and keeps only the public key (a legacy secret part is ignored, never returned)', () => {
  const a = parseDsn(DSN);
  assert.deepEqual({ ok: a.ok, endpoint: a.endpoint, publicKey: a.publicKey, projectId: a.projectId }, { ok: true, endpoint: 'https://o42.ingest.tracker.example/api/4501/envelope/', publicKey: '0123abcd4567ef89', projectId: '4501' });
  const legacy = parseDsn('https://pub:legacysecret@tracker.example/7');
  assert.equal(legacy.ok, true); assert.ok(!JSON.stringify(legacy).includes('legacysecret'));
  assert.equal(parseDsn('https://k@host.example:8443/sentry/12').endpoint, 'https://host.example:8443/sentry/api/12/envelope/');
});

test('parseDsn refuses anything that is not a public HTTPS tracker address', () => {
  for (const bad of [undefined, null, '', '   ', 'not a url', 'http://k@host.example/1', 'https://host.example/1', 'https://k@host.example/', 'https://k@host.example',
    'https://k@localhost/1', 'https://k@127.0.0.1/1', 'https://k@10.0.0.5/1', 'https://k@192.168.1.9/1', 'https://k@[::1]/1', 'https://k@169.254.169.254/1',
    'https://k@db.internal/1', 'https://k@printer.local/1', 'https://k@host.example/not valid', 'ftp://k@host.example/1', 'https://k@host.example/1?x=1']) {
    assert.equal(parseDsn(bad).ok, false, String(bad));
  }
  assert.equal(parseDsn('https://k@host.example/1').ok, true);
});

// ---- the event: PII scrubbing (acceptance test) ---------------------------------------------------------------------

test('PII SCRUBBING: nothing personal or secret from the error, its stack or the request context reaches the event', () => {
  const event = buildEvent(piiError(), { ...CTX, extra: { email: 'jane.doe@example.com', headers: { cookie: 'sid=1' }, ip: '203.0.113.7' } }, { ENVIRONMENT: 'production' });
  const text = JSON.stringify(event);
  assert.deepEqual(containsSensitive(text), [], text);
  for (const leaked of ['jane.doe', 'example.com/api', '203.0.113.7', STRIPE, 'SECRETQUERY', 'hunter2', 'sid=1']) assert.ok(!text.includes(leaked), `leaked: ${leaked}`);
  // What is wanted for debugging survives.
  assert.equal(event.exception.values[0].type, 'TypeError');
  assert.match(event.exception.values[0].value, /Cannot charge \[email\] from \[ip\]/);
  assert.equal(event.tags.request_id, UUID); assert.equal(event.tags.route, '/api/organizations/:id/webhooks'); assert.equal(event.tags.status, '500'); assert.equal(event.tags.method, 'POST');
  assert.equal(event.environment, 'production'); assert.equal(event.level, 'error'); assert.equal(event.platform, 'javascript');
});

test('the event carries no request URL, query, headers, cookies, body, user or IP fields at all', () => {
  const event = buildEvent(piiError(), CTX, { ENVIRONMENT: 'production' });
  const flat = JSON.stringify(event);
  for (const key of ['"url"', '"query_string"', '"headers"', '"cookies"', '"data"', '"user"', '"ip_address"', '"server_name"', '"env"', '"contexts"', '"breadcrumbs"', '"extra"']) assert.ok(!flat.includes(key), key);
  assert.deepEqual(Object.keys(event.request || {}), ['method']);
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.ok(Number.isFinite(event.timestamp));
});

test('stack frames: function, bare file name and position only; no query strings or hosts; at most 20; oldest first', () => {
  const err = new Error('x'); err.stack = ['Error: x', ...Array.from({ length: 40 }, (_, i) => `    at fn${i} (https://h.example/dir/file${i}.js?token=T${i}:${i + 1}:2)`)].join('\n');
  const frames = buildEvent(err, CTX, {}).exception.values[0].stacktrace.frames;
  assert.equal(frames.length, 20);
  assert.equal(frames[frames.length - 1].function, 'fn0', 'Sentry wants the innermost frame last');
  for (const f of frames) { assert.match(f.filename, /^[A-Za-z0-9_.\/-]+$/); assert.ok(!f.filename.includes('h.example') && !f.filename.includes('token')); assert.ok(Number.isInteger(f.lineno)); }
  const none = new Error('no stack'); none.stack = undefined;
  assert.doesNotThrow(() => buildEvent(none, CTX, {}));
  assert.doesNotThrow(() => buildEvent('a string with a@b.com', CTX, {}));
  assert.doesNotMatch(JSON.stringify(buildEvent('a string with a@b.com', CTX, {})), /a@b\.com/);
  assert.doesNotThrow(() => buildEvent(null, undefined, undefined));
});

test('the release id is included only when the owner sets one', () => {
  assert.equal(buildEvent(new Error('x'), CTX, {}).release, undefined);
  assert.equal(buildEvent(new Error('x'), CTX, { ERROR_TRACKING_RELEASE: '2.6.0.8' }).release, '2.6.0.8');
});

test('the envelope is three JSON lines, matches the event id, and does not contain the DSN', () => {
  const event = buildEvent(piiError(), CTX, {});
  const lines = buildEnvelope(event, nowFixed().now()).split('\n');
  assert.equal(lines.length, 4); assert.equal(lines[3], '');
  const [head, item, body] = lines.slice(0, 3).map((l) => JSON.parse(l));
  assert.equal(head.event_id, event.event_id); assert.equal(item.type, 'event'); assert.deepEqual(body, JSON.parse(JSON.stringify(event)));
  assert.ok(!lines.join('').includes('0123abcd4567ef89'));
});

// ---- capture: modes, transport, limits -----------------------------------------------------------------------------

test('off: nothing is built, logged or sent, and the answer says why', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); const c = captureConsole();
  let r; try { r = await captureException({ ERROR_TRACKING: 'off', SENTRY_DSN: DSN }, null, piiError(), CTX, { fetchImpl: f }); } finally { c.restore(); }
  assert.deepEqual({ status: r.status, reason: r.reason }, { status: 'skipped', reason: 'off' });
  assert.equal(f.calls.length, 0); assert.deepEqual(c.out, []);
});

test('shadow: the event is built and scrubbed and a one-line summary is logged, but nothing leaves the Worker (works without a DSN)', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); const c = captureConsole();
  let r; try { r = await captureException({ ERROR_TRACKING: 'shadow' }, null, piiError(), CTX, { fetchImpl: f }); } finally { c.restore(); }
  assert.equal(r.status, 'shadowed'); assert.equal(f.calls.length, 0);
  const line = JSON.parse(c.out.find((l) => l.includes('error_tracking_shadow')));
  assert.equal(line.event, 'error_tracking_shadow'); assert.match(line.event_id, /^[0-9a-f]{32}$/); assert.ok(line.bytes > 0); assert.equal(line.route, CTX.route);
  assert.deepEqual(containsSensitive(c.out.join('\n')), []);
});

test('on: one POST to the envelope endpoint with the public key in X-Sentry-Auth, a scrubbed body and a timeout signal', async () => {
  resetErrorTrackingForTests(); const f = okFetch();
  const r = await captureException({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN, ENVIRONMENT: 'production' }, null, piiError(), CTX, { fetchImpl: f });
  assert.equal(r.status, 'sent'); assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://o42.ingest.tracker.example/api/4501/envelope/'); assert.equal(init.method, 'POST');
  assert.match(init.headers['X-Sentry-Auth'], /^Sentry sentry_version=7, sentry_client=lummet-error-tracking\/1, sentry_key=0123abcd4567ef89$/);
  assert.equal(init.headers['Content-Type'], 'application/x-sentry-envelope');
  assert.ok(init.signal && typeof init.signal.aborted === 'boolean'); assert.equal(init.redirect, 'error');
  assert.deepEqual(containsSensitive(init.body), [], init.body);
  for (const leaked of ['jane.doe', '203.0.113.7', 'SECRETQUERY', 'hunter2']) assert.ok(!init.body.includes(leaked), leaked);
  assert.ok(!('credentials' in init) || init.credentials === 'omit');
});

test('on with a missing or invalid DSN sends nothing, never throws, and never logs the DSN', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); const c = captureConsole(); const results = [];
  try { for (const dsn of [undefined, '', 'http://k@h.example/1', 'garbage']) results.push(await captureException({ ERROR_TRACKING: 'on', SENTRY_DSN: dsn }, null, new Error('x' + results.length), CTX, { fetchImpl: f })); } finally { c.restore(); }
  for (const r of results) assert.deepEqual({ status: r.status, reason: r.reason }, { status: 'skipped', reason: 'dsn_invalid' });
  assert.equal(f.calls.length, 0); assert.ok(!c.out.join('').includes('garbage'));
});

test('a failing tracker (network error, 429, 500, redirect error) is reported as failed, is not retried, and never throws or logs the DSN', async () => {
  const c = captureConsole(); const results = [];
  try {
    for (const make of [() => async () => { throw new Error('connect ECONNREFUSED to ' + DSN); }, () => async () => new Response('', { status: 429 }), () => async () => new Response('', { status: 500 })]) {
      resetErrorTrackingForTests(); let n = 0; const base = make(); const f = async (...a) => { n++; return base(...a); };
      results.push({ r: await captureException({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }, null, piiError(), CTX, { fetchImpl: f }), n });
    }
  } finally { c.restore(); }
  for (const { r, n } of results) { assert.equal(r.status, 'failed'); assert.equal(n, 1, 'no retry'); }
  assert.ok(!c.out.join('\n').includes('0123abcd4567ef89')); assert.ok(!c.out.join('\n').includes('tracker.example'));
});

test('a tracker that never answers is cut off at the timeout', async () => {
  resetErrorTrackingForTests();
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const started = Date.now();
  const r = await captureException({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }, null, new Error('slow'), CTX, { fetchImpl: hang, timeoutMs: 25 });
  assert.equal(r.status, 'failed'); assert.ok(Date.now() - started < 1500);
});

test('limits: the same error on the same route is sent once a minute, and ERROR_TRACKING_MAX_PER_MINUTE caps a flood', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); let t = 1_761_400_000_000; const opts = { fetchImpl: f, now: () => t };
  const env = { ERROR_TRACKING: 'on', SENTRY_DSN: DSN, ERROR_TRACKING_MAX_PER_MINUTE: '2' };
  assert.equal((await captureException(env, null, new TypeError('same'), CTX, opts)).status, 'sent');
  assert.equal((await captureException(env, null, new TypeError('same'), CTX, opts)).status, 'deduped');
  t += 61_000; assert.equal((await captureException(env, null, new TypeError('same'), CTX, opts)).status, 'sent');
  assert.equal((await captureException(env, null, new RangeError('other 1'), CTX, opts)).status, 'sent');
  const capped = await captureException(env, null, new URIError('other 2'), { ...CTX, route: '/api/other' }, opts);
  assert.deepEqual({ status: capped.status, reason: capped.reason }, { status: 'skipped', reason: 'rate_limited' });
  t += 61_000; assert.equal((await captureException(env, null, new URIError('other 2'), { ...CTX, route: '/api/other' }, opts)).status, 'sent');
  assert.equal(f.calls.length, 4);
});

test('ERROR_TRACKING_MAX_PER_MINUTE: unusable values fall back to 30, 0 means unlimited', async () => {
  for (const [value, expected] of [['abc', 30], ['', 30], [undefined, 30], ['0', 60]]) {
    resetErrorTrackingForTests(); const f = okFetch(); const opts = { fetchImpl: f, now: () => 1_761_400_000_000 };
    for (let i = 0; i < 60; i++) await captureException({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN, ERROR_TRACKING_MAX_PER_MINUTE: value }, null, new Error('e' + i), { ...CTX, route: '/r' + i }, opts);
    assert.equal(f.calls.length, expected, `value ${JSON.stringify(value)}`);
  }
});

test('captureException never throws, whatever it is given', async () => {
  resetErrorTrackingForTests();
  for (const args of [[undefined, null, undefined, undefined], [{}, null, null, null], [{ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }, { waitUntil() { throw new Error('ctx'); } }, { get message() { throw new Error('getter'); } }, CTX]]) {
    await assert.doesNotReject(captureException(...args, { fetchImpl: async () => { throw new Error('x'); } }));
  }
});

// ---- wiring into the Worker ----------------------------------------------------------------------------------------

const ctxCollect = () => { const p = []; return { waitUntil: (x) => p.push(Promise.resolve(x).catch(() => {})), settle: () => Promise.all(p), count: () => p.length }; };
const mk = (extra = {}) => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...extra }; };
function failingOn(db, needle, message) { return { prepare(sql) { if (sql.includes(needle)) throw new Error(message); return db.prepare(sql); }, batch: (x) => db.batch(x), exec: (x) => db.exec(x) }; }

test('observe hands an unhandled exception to the tracker (route only, no URL), after the request is answered, through waitUntil', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); const realFetch = globalThis.fetch; globalThis.fetch = f; const c = captureConsole(); const ctx = ctxCollect();
  try {
    await observe(mk({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }), ctx, { requestId: UUID, method: 'POST', pathname: '/api/organizations/6f1e2d3c-1111-2222-3333-444455556666/webhooks', status: 500, startedAt: Date.now(), error: piiError() });
    assert.ok(ctx.count() >= 2, 'the row save and the tracker call are both handed to waitUntil, so the caller does not wait for the tracker');
    await ctx.settle();
  } finally { c.restore(); globalThis.fetch = realFetch; }
  assert.equal(f.calls.length, 1);
  const body = f.calls[0].init.body;
  assert.ok(body.includes('/api/organizations/:id/webhooks')); assert.ok(!body.includes('6f1e2d3c-1111-2222-3333-444455556666/webhooks'));
  assert.deepEqual(containsSensitive(body), []);
});

test('observe does not send a 5xx that had no exception, nor anything while the flag is off', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); const realFetch = globalThis.fetch; globalThis.fetch = f; const c = captureConsole(); const ctx = ctxCollect();
  try {
    await observe(mk({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }), ctx, { requestId: 'a', method: 'GET', pathname: '/x', status: 502, startedAt: Date.now() });
    await observe(mk({ ERROR_TRACKING: 'off', SENTRY_DSN: DSN }), ctx, { requestId: 'b', method: 'GET', pathname: '/x', status: 500, startedAt: Date.now(), error: new Error('boom') });
    await observe(mk({ SENTRY_DSN: DSN }), ctx, { requestId: 'c', method: 'GET', pathname: '/x', status: 500, startedAt: Date.now(), error: new Error('boom') });
    await ctx.settle();
  } finally { c.restore(); globalThis.fetch = realFetch; }
  assert.equal(f.calls.length, 0);
});

test('end to end: a real unhandled exception in a route reaches the tracker once, scrubbed, while the client still gets only the request reference', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); const realFetch = globalThis.fetch; globalThis.fetch = f; const c = captureConsole(); const ctx = ctxCollect();
  const e = mk({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN, ENVIRONMENT: 'staging' }); e.LUMMET_DB = failingOn(e.LUMMET_DB, 'customer_sessions', 'D1_ERROR: no such table for jane.doe@example.com');
  let res, text;
  try {
    res = await worker.fetch(new Request('https://cp.test/api/organizations/' + UUID + '/notifications?token=SUPERSECRETQUERY', { headers: { Cookie: 'lummet_customer_session=SECRETCOOKIEVALUE', Authorization: 'Bearer SECRETBEARER', 'CF-Connecting-IP': '198.51.100.20' } }), e, ctx);
    text = await res.text(); await ctx.settle();
  } finally { c.restore(); globalThis.fetch = realFetch; }
  assert.equal(res.status, 500);
  assert.ok(!text.includes('jane.doe'));
  assert.equal(f.calls.length, 1);
  const body = f.calls[0].init.body;
  for (const leaked of ['jane.doe', 'SUPERSECRETQUERY', 'SECRETCOOKIEVALUE', 'SECRETBEARER', '198.51.100.20']) assert.ok(!body.includes(leaked), leaked);
  assert.ok(body.includes('"environment":"staging"'));
});

test('scheduled(): a throw is reported (scrubbed) and still propagates, so Cloudflare keeps its own record of the failed run', async () => {
  resetErrorTrackingForTests(); const f = okFetch(); const realFetch = globalThis.fetch; globalThis.fetch = f; const c = captureConsole(); const ctx = ctxCollect();
  const event = { get cron() { throw new Error('tick failed for ops@example.com'); } };
  try {
    await assert.rejects(worker.scheduled(event, mk({ ERROR_TRACKING: 'on', SENTRY_DSN: DSN }), ctx), /tick failed/);
    await ctx.settle();
  } finally { c.restore(); globalThis.fetch = realFetch; }
  assert.equal(f.calls.length, 1); assert.ok(!f.calls[0].init.body.includes('ops@example.com'));
  assert.match(f.calls[0].init.body, /"event_kind":"scheduled"/);
});
