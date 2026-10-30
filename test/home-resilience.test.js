// The homepage must survive a failing secondary read (updates, insights, partners, banner, plans) and say why when it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePublicRoute } from '../worker/public-site/router.js';
import { createPublicEnv } from './support/public-env.js';

const quiet = async (fn) => { const o = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = o; } };
const home = (env) => handlePublicRoute({ request: new Request('https://lummet.test/'), env, ctx: { waitUntil() {} } });
function failing(env, needle) {
  const real = env.LUMMET_DB.prepare.bind(env.LUMMET_DB);
  env.LUMMET_DB = { ...env.LUMMET_DB, prepare: (sql) => { if (sql.includes(needle)) throw new Error(`boom: ${needle}`); return real(sql); }, batch: env.LUMMET_DB.batch };
  return env;
}

test('a failing updates list read leaves that section out; the homepage still renders', async () => {
  const res = await quiet(() => home(failing(createPublicEnv(), 'FROM lummet_updates u')));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>/);
});

test('a failing plans read leaves the plans block out; the homepage still renders', async () => {
  const res = await quiet(() => home(failing(createPublicEnv(), 'FROM plans p')));
  assert.equal(res.status, 200);
  assert.doesNotMatch(await res.text(), /plans-teaser/);
});

test('a failing primary read is a 503 (after the router retry), with the reason in a header on staging only', async () => {
  const staging = failing(createPublicEnv(), 'FROM lummet_homepage_sections'); staging.ENVIRONMENT = 'staging';
  const r1 = await quiet(() => home(staging));
  assert.equal(r1.status, 503);
  assert.match(r1.headers.get('x-public-error') || '', /boom: FROM lummet_homepage_sections/);
  const prod = failing(createPublicEnv(), 'FROM lummet_homepage_sections'); prod.ENVIRONMENT = 'production';
  const r2 = await quiet(() => home(prod));
  assert.equal(r2.status, 503);
  assert.equal(r2.headers.get('x-public-error'), null, 'production never exposes error text');
});

test('HOME_PLANS=off removes the plans block and issues no plans reads on the homepage', async () => {
  const env = createPublicEnv(); env.HOME_PLANS = 'off';
  const real = env.LUMMET_DB.prepare.bind(env.LUMMET_DB); const seen = [];
  env.LUMMET_DB = { ...env.LUMMET_DB, prepare: (sql) => { seen.push(sql); return real(sql); }, batch: env.LUMMET_DB.batch };
  const res = await home(env);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.doesNotMatch(html, /plans-teaser/);
  assert.doesNotMatch(html, /Plans from/);
  assert.ok(!seen.some((s) => s.includes('FROM plans p')), 'the plans read is skipped');
  const on = await home(createPublicEnv());
  assert.match(await on.text(), /plans-teaser/, 'default (unset) keeps the block');
});

test('on production the error header appears only for a request carrying the secret debug token', async () => {
  const mk = () => { const e = failing(createPublicEnv(), 'FROM lummet_homepage_sections'); e.ENVIRONMENT = 'production'; return e; };
  const call = (env, headers) => handlePublicRoute({ request: new Request('https://lummet.test/', { headers }), env, ctx: { waitUntil() {} } });
  const withToken = mk(); withToken.PUBLIC_DEBUG_TOKEN = 'correct-horse-battery-staple';
  const ok = await quiet(() => call(withToken, { 'x-debug-token': 'correct-horse-battery-staple' }));
  assert.equal(ok.status, 503);
  assert.match(ok.headers.get('x-public-error') || '', /boom: FROM lummet_homepage_sections/);
  const wrong = await quiet(() => call(withToken, { 'x-debug-token': 'wrong-token-of-same-lengthxx' }));
  assert.equal(wrong.headers.get('x-public-error'), null);
  const none = await quiet(() => call(withToken, {}));
  assert.equal(none.headers.get('x-public-error'), null);
  const unset = await quiet(() => call(mk(), { 'x-debug-token': 'anything' }));
  assert.equal(unset.headers.get('x-public-error'), null, 'no token configured = feature off');
});

// ---- 2.6.1.4: per-read retry, batched reads, stale-if-error ----

// Fails the first `times` database calls of any kind (prepare().all/first, batch), then behaves normally.
function flaky(env, times) {
  const real = env.LUMMET_DB; let left = times;
  const boom = () => { if (left > 0) { left--; return true; } return false; };
  const wrap = (st) => new Proxy(st, { get(t, k) {
    if (k === '__raw') return t;
    if (k === 'bind') return (...a) => wrap(t.bind(...a));
    if (k === 'all' || k === 'first') return (...a) => (boom() ? Promise.reject(new Error('D1_ERROR: Network connection lost')) : t[k](...a));
    const v = t[k]; return typeof v === 'function' ? v.bind(t) : v;
  } });
  env.LUMMET_DB = { prepare: (sql) => wrap(real.prepare(sql)), batch: (arr) => (boom() ? Promise.reject(new Error('D1_ERROR: Network connection lost')) : real.batch(arr.map((a) => a.__raw || a))) };
  return env;
}

test('a cold homepage render reads the layout and the page in a handful of round trips, not a dozen queries', async () => {
  const env = createPublicEnv(); env.HOME_PLANS = 'off';
  const real = env.LUMMET_DB; let calls = 0;
  env.LUMMET_DB = { prepare: (sql) => real.prepare(sql), batch: (arr) => { calls++; return real.batch(arr); } };
  const res = await home(env);
  assert.equal(res.status, 200);
  assert.ok(calls <= 3, `expected at most 3 batched round trips, saw ${calls}`);
});

test('transient database errors are retried per read: three failures in a row still give a 200', async () => {
  const res = await quiet(() => home(flaky(createPublicEnv(), 3)));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<h1>/);
});

test('a deterministic SQL error is not retried (no such table fails fast)', async () => {
  const env = createPublicEnv(); let seen = 0;
  const real = env.LUMMET_DB;
  env.LUMMET_DB = { prepare: (sql) => real.prepare(sql), batch: () => { seen++; return Promise.reject(new Error('D1_ERROR: no such table: lummet_site_settings')); } };
  const res = await quiet(() => home(env));
  assert.equal(res.status, 503);
  assert.equal(seen, 2, 'one attempt per render, two renders (router retry); the read itself is not retried');
});

test('when the database fails after a successful render, the last good copy is served instead of the 503 page', async () => {
  const env = createPublicEnv();
  const ok = await home(env);
  assert.equal(ok.status, 200);
  const goodHtml = await ok.text();
  const real = env.LUMMET_DB;
  env.LUMMET_DB = { prepare: (sql) => real.prepare(sql), batch: () => Promise.reject(new Error('D1_ERROR: Network connection lost')) };
  const res = await quiet(() => home(env));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-lm-cache'), 'stale-if-error-memory');
  assert.equal(await res.text(), goodHtml);
});

test('a 503 carries Retry-After and is never cached', async () => {
  const env = createPublicEnv(); const real = env.LUMMET_DB;
  env.LUMMET_DB = { prepare: (sql) => real.prepare(sql), batch: () => Promise.reject(new Error('D1_ERROR: Network connection lost')) };
  const res = await quiet(() => home(env));
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('retry-after'), '3');
  assert.equal(res.headers.get('cache-control'), 'no-store');
});
