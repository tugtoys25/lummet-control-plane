// Round 6.5A: synthetic monitors (sign-in, test-mode checkout, canary customer site, domain attach).
//
// Acceptance tests, written before the code:
//   AT-1  A failure alerts ONCE, resolves, and the system is quiet when healthy.
//   AT-2  A monitor NEVER reports success on an error (every failure mode below is recorded as a failure, never as ok).
// Plus: flag modes, "not configured / stale / blocked is never healthy", secrets never leave the probe, sessions are not
// leaked, state lives in alert_state (no new table), and the real routes are exercised end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { setPlanPrice } from './support/plan-prices.js';
import worker from '../worker/index.js';
import { runAlertCheck } from '../worker/alerts.js';
import { configIssues } from '../worker/config-check.js';
import * as mon from '../worker/synthetic-monitors.js';

const HOOK = 'https://hooks.example.com/services/T/B/x';
const PORTAL = 'https://app.example.test';
const CANARY = 'https://canary.example.test/';
const PASSWORD = 'Correct-Horse-Battery-9';
const EMAIL = 'monitor@example.test';
const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-25T10:00:00Z');
const ctx = { waitUntil() {} };

function recorder(status = 200) { const calls = []; const f = async (url, init) => { calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null }); return new Response('', { status }); }; f.calls = calls; return f; }

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'staging', STRIPE_SECRET_KEY: 'sk_test_x', PORTAL_BASE_URL: PORTAL, ...extra };
}

/** Everything configured, mode on, against a scripted portal (no worker). */
function scriptedEnv(extra = {}) {
  return makeEnv({
    SYNTHETIC_MONITORS: 'on', SYNTHETIC_SIGNIN_EMAIL: EMAIL, SYNTHETIC_SIGNIN_PASSWORD: PASSWORD, SYNTHETIC_ORGANIZATION_ID: 'org_1',
    SYNTHETIC_CHECKOUT_PLAN_ID: 'plan_x', SYNTHETIC_CANARY_URL: CANARY, SYNTHETIC_CANARY_MARKER: 'canary-ok',
    CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ZONE_ID: 'z', SYNTHETIC_DOMAIN_RESOURCE_ID: 'ch_1', ...extra
  });
}

const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const SESSION_COOKIE = { 'Set-Cookie': 'lummet_customer_session=sess-secret-value; Path=/; HttpOnly; Secure; SameSite=Lax' };

/** A portal + canary that behaves, unless a route is overridden. An override is a Response, a function, or an Error to throw. */
function scripted(over = {}) {
  const calls = [];
  const pick = (key, dflt, u, init) => {
    const o = over[key];
    if (o === undefined) return dflt();
    if (o instanceof Error) throw o;
    return typeof o === 'function' ? o(u, init) : o.clone();
  };
  const f = async (url, init = {}) => {
    const u = new URL(String(url)); const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, host: u.host, path: u.pathname, cookie: new Headers(init.headers || {}).get('Cookie') || null, body: init.body || null });
    if (u.host === 'canary.example.test') return pick('canary', () => new Response('<html>canary-ok</html>', { status: 200 }), u, init);
    if (method === 'POST' && u.pathname === '/api/customer/login') return pick('login', () => json({ success: true }, 200, SESSION_COOKIE), u, init);
    if (method === 'GET' && u.pathname === '/api/organizations') return pick('orgs', () => json({ success: true, data: [{ id: 'org_1', name: 'Monitor' }] }), u, init);
    if (method === 'POST' && u.pathname === '/api/organizations/org_1/billing/checkout') return pick('checkout', () => json({ success: true, checkoutUrl: 'https://checkout.stripe.test/c/pay/cs_secret' }), u, init);
    if (method === 'POST' && u.pathname === '/api/customer/logout') return pick('logout', () => json({ success: true }, 200, { 'Set-Cookie': 'lummet_customer_session=; Max-Age=0' }), u, init);
    return new Response('not found', { status: 404 });
  };
  f.calls = calls; return f;
}

function fakeInfra(over = {}) {
  const calls = [];
  return {
    calls,
    async getFallbackOrigin() { calls.push('fallback'); if (over.fallbackError) throw over.fallbackError; return 'fallback' in over ? over.fallback : { origin: 'origin.example.test', status: 'active' }; },
    async getCustomHostnameDetail(_env, id) { calls.push(`detail:${id}`); if (over.detailError) throw over.detailError; return 'detail' in over ? over.detail : { status: 'active', hostnameStatus: 'active', records: [] }; }
  };
}

const row = (e, key) => e.LUMMET_DB.prepare(`SELECT * FROM alert_state WHERE key = ?`).bind(key).first();
const count = async (e) => (await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM alert_state`).first()).n;

// A tick as the scheduler runs it: probes first, then the alert check.
async function tick(e, deps, t, hook) {
  const probes = await mon.runSyntheticMonitors(e, { ...deps, now: t });
  const alerts = await runAlertCheck(e, { fetchImpl: hook, now: t });
  return { probes, alerts, action: (key) => alerts.results.find((r) => r.key === key)?.action };
}

// ---------------------------------------------------------------------------------------------------------------------
// AT-1: failure alerts once, resolves, quiet when healthy
// ---------------------------------------------------------------------------------------------------------------------

test('AT-1: healthy system is quiet; a failure alerts ONCE (after the threshold), stays quiet while it lasts, and resolves once', async () => {
  const e = scriptedEnv({ ALERT_WEBHOOK_URL: HOOK });
  const hook = recorder(); const infra = fakeInfra(); let canaryDown = false;
  const portal = scripted({ canary: () => (canaryDown ? new Response('oops', { status: 500 }) : new Response('<html>canary-ok</html>', { status: 200 })) });
  const deps = { fetchImpl: portal, infra };

  for (let i = 0; i < 3; i++) {
    const r = await tick(e, deps, T0 + i * 5 * MIN, hook);
    assert.ok(r.alerts.results.filter((x) => x.key.startsWith('synthetic_')).every((x) => x.action === 'ok'), 'healthy: every monitor check is ok');
  }
  assert.equal(hook.calls.length, 0, 'a healthy system sends nothing');

  canaryDown = true;
  const first = await tick(e, deps, T0 + 15 * MIN, hook);
  assert.equal(first.action('synthetic_canary_site'), 'ok', 'one failed probe is below the default threshold of 2: no page yet');
  assert.equal(hook.calls.length, 0);

  const second = await tick(e, deps, T0 + 20 * MIN, hook);
  assert.equal(second.action('synthetic_canary_site'), 'notified');
  assert.equal(hook.calls.length, 1, 'paged exactly once');
  assert.match(hook.calls[0].body.text, /canary/i);
  assert.match(hook.calls[0].body.text, /canary_http_500/, 'the page says why (a reason code, nothing else)');

  for (let i = 0; i < 4; i++) {
    const r = await tick(e, deps, T0 + (25 + i * 5) * MIN, hook);
    assert.equal(r.action('synthetic_canary_site'), 'still_firing_quiet');
  }
  assert.equal(hook.calls.length, 1, 'still failing: no repeat page inside the reminder interval');

  canaryDown = false;
  const fixed = await tick(e, deps, T0 + 45 * MIN, hook);
  assert.equal(fixed.action('synthetic_canary_site'), 'resolved');
  assert.equal(hook.calls.length, 2);
  assert.match(hook.calls[1].body.text, /Resolved/);

  const after = await tick(e, deps, T0 + 50 * MIN, hook);
  assert.equal(after.action('synthetic_canary_site'), 'ok');
  assert.equal(hook.calls.length, 2, 'quiet again once healthy');
  assert.equal((await row(e, 'synthetic_canary_site')).firing, 0);
});

test('AT-1: SYNTHETIC_FAILURE_THRESHOLD=1 pages on the first failed probe; other monitors stay quiet', async () => {
  const e = scriptedEnv({ ALERT_WEBHOOK_URL: HOOK, SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const hook = recorder();
  const r = await tick(e, { fetchImpl: scripted({ canary: new Response('', { status: 503 }) }), infra: fakeInfra() }, T0, hook);
  assert.equal(r.action('synthetic_canary_site'), 'notified');
  for (const k of ['synthetic_signin', 'synthetic_checkout', 'synthetic_domain_attach']) assert.equal(r.action(k), 'ok', k);
  assert.equal(hook.calls.length, 1);
});

test('AT-1: a page that cannot be delivered is retried on the next check (existing alert machinery), not lost', async () => {
  const e = scriptedEnv({ ALERT_WEBHOOK_URL: HOOK, SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const deps = { fetchImpl: scripted({ canary: new Response('', { status: 500 }) }), infra: fakeInfra() };
  const down = await tick(e, deps, T0, recorder(500));
  assert.equal(down.action('synthetic_canary_site'), 'notify_failed');
  const up = recorder(200);
  const retry = await tick(e, deps, T0 + 5 * MIN, up);
  assert.equal(retry.action('synthetic_canary_site'), 'notified');
  assert.equal(up.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// AT-2: a monitor never reports success on error
// ---------------------------------------------------------------------------------------------------------------------

const outcomes = async (over, envExtra = {}, infraOver = {}) => mon.runProbes(scriptedEnv(envExtra), { fetchImpl: scripted(over), infra: fakeInfra(infraOver), now: T0 });

test('AT-2: the control run (nothing broken) is ok for all four monitors', async () => {
  const o = await outcomes({});
  for (const name of ['signin', 'checkout', 'canary_site', 'domain_attach']) assert.equal(o[name].status, 'ok', `${name}: ${o[name].reason || ''}`);
});

const SIGNIN_FAILURES = {
  'network error': [{ login: new Error('connection reset') }, 'login_request_failed'],
  'timeout': [{ login: Object.assign(new Error('timed out'), { name: 'TimeoutError' }) }, 'login_timeout'],
  'HTTP 500': [{ login: new Response('boom', { status: 500 }) }, 'login_http_500'],
  'HTTP 429 (throttled)': [{ login: json({ success: false, error: 'too_many_attempts' }, 429) }, 'login_http_429'],
  'wrong credentials (401)': [{ login: json({ success: false, error: 'invalid_credentials' }, 401) }, 'login_http_401'],
  '200 but success:false': [{ login: json({ success: false }) }, 'login_rejected'],
  '200 but not JSON': [{ login: new Response('<html>maintenance</html>', { status: 200 }) }, 'login_bad_response'],
  '200 but no session cookie': [{ login: json({ success: true }) }, 'login_no_session_cookie'],
  'password ok but MFA required': [{ login: json({ success: true, mfaRequired: true, challengeId: 'c' }, 200, SESSION_COOKIE) }, 'login_mfa_required'],
  'organization requires 2FA enrollment': [{ login: json({ success: true, twoFactorEnrollmentRequired: true }, 200, SESSION_COOKIE) }, 'login_org_2fa_enrollment_required'],
  'session rejected right after login': [{ orgs: json({ success: false, error: 'unauthorized' }, 401) }, 'session_check_http_401'],
  'session check returns no list': [{ orgs: json({ success: true }) }, 'session_check_bad_response'],
  'monitor organization missing from the list': [{ orgs: json({ success: true, data: [{ id: 'other' }] }) }, 'monitor_organization_missing'],
  'logout fails': [{ logout: new Response('', { status: 500 }) }, 'logout_http_500'],
  'logout throws': [{ logout: new Error('reset') }, 'logout_request_failed']
};
for (const [label, [over, reason]] of Object.entries(SIGNIN_FAILURES)) {
  test(`AT-2 sign-in: ${label} is a failure (${reason}), never ok`, async () => {
    const o = await outcomes(over);
    assert.equal(o.signin.status, 'fail');
    assert.equal(o.signin.reason, reason);
  });
}

const CHECKOUT_FAILURES = {
  'network error': [{ checkout: new Error('reset') }, 'checkout_request_failed'],
  'HTTP 502 (provider down)': [{ checkout: json({ success: false, error: 'provider_error' }, 502) }, 'checkout_http_502'],
  'HTTP 409 (monitor organization already subscribed)': [{ checkout: json({ success: false, error: 'organization_already_subscribed' }, 409) }, 'checkout_http_409'],
  'HTTP 422 (plan has no price)': [{ checkout: json({ success: false, error: 'plan_not_configured' }, 422) }, 'checkout_http_422'],
  '200 but success:false': [{ checkout: json({ success: false }) }, 'checkout_rejected'],
  '200 but no checkout URL': [{ checkout: json({ success: true }) }, 'checkout_no_url'],
  '200 but URL is not https': [{ checkout: json({ success: true, checkoutUrl: 'http://checkout.example/pay' }) }, 'checkout_url_not_https'],
  '200 but URL is nonsense': [{ checkout: json({ success: true, checkoutUrl: 'javascript:alert(1)' }) }, 'checkout_url_not_https'],
  '200 but not JSON': [{ checkout: new Response('<html>', { status: 200 }) }, 'checkout_bad_response']
};
for (const [label, [over, reason]] of Object.entries(CHECKOUT_FAILURES)) {
  test(`AT-2 checkout: ${label} is a failure (${reason}), never ok`, async () => {
    const o = await outcomes(over);
    assert.equal(o.checkout.status, 'fail');
    assert.equal(o.checkout.reason, reason);
    assert.equal(o.signin.status, 'ok', 'sign-in itself was fine');
  });
}

const CANARY_FAILURES = {
  'network error': [{ canary: new Error('ENOTFOUND') }, 'canary_request_failed'],
  'timeout': [{ canary: Object.assign(new Error('t'), { name: 'TimeoutError' }) }, 'canary_timeout'],
  'HTTP 404': [{ canary: new Response('nope', { status: 404 }) }, 'canary_http_404'],
  'HTTP 500': [{ canary: new Response('boom', { status: 500 }) }, 'canary_http_500'],
  'HTTP 503 (suspended-site page)': [{ canary: new Response('temporarily unavailable', { status: 503 }) }, 'canary_http_503'],
  'redirect (not followed)': [{ canary: new Response('', { status: 302, headers: { Location: 'https://elsewhere.example/' } }) }, 'canary_http_302'],
  '200 but the marker is missing (an error page with a 200)': [{ canary: new Response('<html>Site temporarily unavailable</html>', { status: 200 }) }, 'canary_marker_missing'],
  '200 with an empty body': [{ canary: new Response('', { status: 200 }) }, 'canary_marker_missing']
};
for (const [label, [over, reason]] of Object.entries(CANARY_FAILURES)) {
  test(`AT-2 canary site: ${label} is a failure (${reason}), never ok`, async () => {
    const o = await outcomes(over);
    assert.equal(o.canary_site.status, 'fail');
    assert.equal(o.canary_site.reason, reason);
  });
}

const DOMAIN_FAILURES = {
  'Cloudflare call throws': [{ fallbackError: Object.assign(new Error('Authentication error'), { httpStatus: 403 }) }, 'domain_cloudflare_error'],
  'no fallback origin set': [{ fallback: { origin: null, status: '' } }, 'domain_fallback_origin_missing'],
  'fallback origin not active': [{ fallback: { origin: 'o.example.test', status: 'pending_deployment' } }, 'domain_fallback_origin_pending_deployment'],
  'fallback origin status unknown': [{ fallback: { origin: 'o.example.test', status: '' } }, 'domain_fallback_origin_unknown'],
  'canary hostname still pending': [{ detail: { status: 'pending', hostnameStatus: 'pending', records: [] } }, 'domain_canary_hostname_pending'],
  'canary hostname failed': [{ detail: { status: 'failed', hostnameStatus: 'blocked', records: [] } }, 'domain_canary_hostname_failed'],
  'canary hostname lookup throws': [{ detailError: new Error('404') }, 'domain_cloudflare_error'],
  'canary hostname detail is empty': [{ detail: null }, 'domain_canary_hostname_unknown']
};
for (const [label, [infraOver, reason]] of Object.entries(DOMAIN_FAILURES)) {
  test(`AT-2 domain attach: ${label} is a failure (${reason}), never ok`, async () => {
    const o = await outcomes({}, {}, infraOver);
    assert.equal(o.domain_attach.status, 'fail');
    assert.equal(o.domain_attach.reason, reason);
  });
}

test('AT-2: an unexpected exception inside a probe is recorded as a failure, never as ok, and does not stop the other probes', async () => {
  const e = scriptedEnv({ SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const infra = { async getFallbackOrigin() { throw new TypeError('boom'); }, async getCustomHostnameDetail() { return { status: 'active' }; } };
  const r = await mon.runSyntheticMonitors(e, { fetchImpl: scripted(), infra, now: T0 });
  assert.equal(r.results.find((x) => x.monitor === 'domain_attach').status, 'fail');
  assert.equal(r.results.find((x) => x.monitor === 'canary_site').status, 'ok');
  assert.equal((await row(e, 'probe:domain_attach')).last_count, 1);
  assert.equal((await row(e, 'probe:domain_attach')).last_notified_at, null, 'no "last ok" time was recorded for a failure');
});

test('AT-2: an exception that nothing inside the probe caught reaches the backstop and is a failure (probe_exception), never ok; only the error class is logged', async () => {
  // A response with no headers object makes the sign-in code throw a TypeError that no step handles itself, so this goes through safe().
  const e = scriptedEnv({ SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const headerless = () => ({ status: 200, text: async () => JSON.stringify({ success: true, secretDetail: PASSWORD }) });
  const errors = []; const realErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  let o;
  try { o = await mon.runProbes(e, { fetchImpl: scripted({ login: headerless }), infra: fakeInfra() }); } finally { console.error = realErr; }
  assert.deepEqual({ status: o.signin.status, reason: o.signin.reason }, { status: 'fail', reason: 'probe_exception' });
  assert.equal(o.checkout.status, 'blocked', 'checkout needs the sign-in session, so it is blocked, not ok');
  assert.equal(o.canary_site.status, 'ok', 'the other probes still ran');
  assert.ok(errors.some((l) => /synthetic_probe_exception/.test(l) && /TypeError/.test(l)), 'the error class is logged');
  assert.ok(!errors.join('\n').includes(PASSWORD), 'no message or secret is logged');
  const r = await mon.runSyntheticMonitors(e, { fetchImpl: scripted({ login: headerless }), infra: fakeInfra(), now: T0 });
  assert.equal(r.results.find((x) => x.monitor === 'signin').status, 'fail');
  assert.equal((await row(e, 'probe:signin')).last_count, 1);
  assert.equal((await row(e, 'probe:signin')).last_notified_at, null, 'no "last ok" time was recorded for a failure');
});

test('AT-2: a probe that cannot be recorded does not advance the state to ok; the failure to record is reported', async () => {
  const e = scriptedEnv();
  const realPrepare = e.LUMMET_DB.prepare.bind(e.LUMMET_DB);
  e.LUMMET_DB = new Proxy(e.LUMMET_DB, { get(t, p) { return p === 'prepare' ? (sql) => { if (/INSERT INTO alert_state/.test(sql)) throw new Error('D1 is down'); return realPrepare(sql); } : t[p].bind ? t[p].bind(t) : t[p]; } });
  const errors = []; const realErr = console.error; console.error = (...a) => errors.push(a.join(' '));
  try {
    const r = await mon.runSyntheticMonitors(e, { fetchImpl: scripted(), infra: fakeInfra(), now: T0 });
    assert.equal(r.results.every((x) => x.recorded === false), true, 'nothing was recorded');
    assert.ok(r.results.every((x) => x.action === 'record_failed'));
  } finally { console.error = realErr; }
  assert.ok(errors.some((l) => /synthetic_monitor_record_failed/.test(l)));
  assert.equal(await count(e), 0, 'no row says ok');
});

test('AT-2: stale results are failures: a monitor that stopped reporting pages instead of looking healthy', async () => {
  const e = scriptedEnv({ ALERT_WEBHOOK_URL: HOOK });
  const hook = recorder();
  await mon.runSyntheticMonitors(e, { fetchImpl: scripted(), infra: fakeInfra(), now: T0 });
  const fresh = await runAlertCheck(e, { fetchImpl: hook, now: T0 + 5 * MIN });
  assert.ok(fresh.results.filter((x) => x.key.startsWith('synthetic_')).every((x) => x.action === 'ok'));
  // Nothing probes for 30 minutes (default stale limit is 20).
  const stale = await runAlertCheck(e, { fetchImpl: hook, now: T0 + 30 * MIN });
  assert.deepEqual(stale.results.filter((x) => x.action === 'notified').map((x) => x.key).sort(), ['synthetic_canary_site', 'synthetic_checkout', 'synthetic_domain_attach', 'synthetic_signin']);
  assert.match(hook.calls[0].body.text, /no probe result/i);
});

test('AT-2: not configured, skipped and blocked monitors are never reported as ok and never page by themselves', async () => {
  const e = makeEnv({ SYNTHETIC_MONITORS: 'on', ALERT_WEBHOOK_URL: HOOK }); // nothing configured at all
  const hook = recorder();
  const r = await tick(e, { fetchImpl: scripted(), infra: fakeInfra() }, T0, hook);
  assert.ok(r.probes.results.every((x) => x.status === 'not_configured'));
  assert.equal(hook.calls.length, 0, 'an unconfigured monitor is a setup gap (config-check), not a page');
  assert.equal(await count(e), 0, 'and it leaves no row that could be read as healthy');
  const tiles = await mon.monitorStatuses(e, { now: T0 });
  assert.ok(tiles.every((t) => t.status === 'not_configured'));
});

test('AT-2: when sign-in fails, checkout is BLOCKED (not ok, not a second page) and a firing checkout alert is not resolved by it', async () => {
  const e = scriptedEnv({ ALERT_WEBHOOK_URL: HOOK, SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const hook = recorder(); const infra = fakeInfra();
  // Checkout is failing first, so its alert is firing.
  const bad = await tick(e, { fetchImpl: scripted({ checkout: json({ success: false }, 502) }), infra }, T0, hook);
  assert.equal(bad.action('synthetic_checkout'), 'notified');
  // Now sign-in breaks: checkout cannot be evaluated.
  const portal = scripted({ login: new Response('', { status: 500 }) });
  const r = await tick(e, { fetchImpl: portal, infra }, T0 + 5 * MIN, hook);
  assert.equal(r.probes.results.find((x) => x.monitor === 'checkout').status, 'blocked');
  assert.equal(portal.calls.some((c) => c.path.endsWith('/billing/checkout')), false, 'checkout was not attempted without a session');
  assert.equal(r.action('synthetic_signin'), 'notified');
  assert.equal(r.action('synthetic_checkout'), 'still_firing_quiet', 'blocked does not resolve the earlier failure');
  const tile = (await mon.monitorStatuses(e, { now: T0 + 5 * MIN })).find((t) => t.monitor === 'checkout');
  assert.equal(tile.status, 'blocked');
});

test('AT-2: a live-mode Stripe key skips the checkout monitor unless the owner explicitly allows it; skipped is never ok', async () => {
  const e = scriptedEnv({ STRIPE_SECRET_KEY: 'sk_live_x' });
  const portal = scripted();
  const r = await mon.runSyntheticMonitors(e, { fetchImpl: portal, infra: fakeInfra(), now: T0 });
  const c = r.results.find((x) => x.monitor === 'checkout');
  assert.equal(c.status, 'skipped'); assert.equal(c.reason, 'stripe_live_mode_key');
  assert.equal(portal.calls.some((x) => x.path.endsWith('/billing/checkout')), false, 'no checkout session was created against a live key');
  assert.equal(await row(e, 'probe:checkout'), null);
  assert.equal((await mon.monitorStatuses(e, { now: T0 })).find((t) => t.monitor === 'checkout').status, 'skipped');
  // Explicit owner approval turns it on.
  const e2 = scriptedEnv({ STRIPE_SECRET_KEY: 'sk_live_x', SYNTHETIC_CHECKOUT_ALLOW_LIVE: 'yes' });
  assert.equal((await mon.runSyntheticMonitors(e2, { fetchImpl: scripted(), infra: fakeInfra(), now: T0 })).results.find((x) => x.monitor === 'checkout').status, 'ok');
  // An unknown or missing key is not "test mode" either.
  for (const key of [undefined, '', 'whatever']) {
    const e3 = scriptedEnv({ STRIPE_SECRET_KEY: key });
    assert.equal((await mon.runSyntheticMonitors(e3, { fetchImpl: scripted(), infra: fakeInfra(), now: T0 })).results.find((x) => x.monitor === 'checkout').status, 'skipped', String(key));
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// Flag modes
// ---------------------------------------------------------------------------------------------------------------------

test('mode off (default, also unset or invalid): nothing is probed and nothing is written', async () => {
  for (const v of [undefined, '', 'off', 'OFF', 'banana', 'enforce']) {
    const e = scriptedEnv({ SYNTHETIC_MONITORS: v, ALERT_WEBHOOK_URL: HOOK });
    const portal = scripted(); const infra = fakeInfra(); const hook = recorder();
    const r = await tick(e, { fetchImpl: portal, infra }, T0, hook);
    assert.equal(r.probes.skipped, 'off', String(v));
    assert.equal(portal.calls.length, 0); assert.equal(infra.calls.length, 0);
    assert.equal(await count(e), 0); assert.equal(hook.calls.length, 0);
  }
  assert.equal(mon.monitorMode({}), 'off');
});

test('mode shadow: probes run and are recorded (visible to staff), but a failure never pages', async () => {
  const e = scriptedEnv({ SYNTHETIC_MONITORS: 'shadow', ALERT_WEBHOOK_URL: HOOK, SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const hook = recorder();
  for (let i = 0; i < 3; i++) await tick(e, { fetchImpl: scripted({ canary: new Response('', { status: 500 }) }), infra: fakeInfra() }, T0 + i * 5 * MIN, hook);
  assert.equal(hook.calls.length, 0, 'shadow never pages');
  assert.equal((await row(e, 'probe:canary_site')).last_count, 3, 'but the failures are recorded');
  assert.equal(await row(e, 'synthetic_canary_site'), null, 'and no alert row exists');
  const tile = (await mon.monitorStatuses(e, { now: T0 + 10 * MIN })).find((t) => t.monitor === 'canary_site');
  assert.equal(tile.status, 'failing'); assert.equal(tile.consecutiveFailures, 3); assert.equal(tile.mode, 'shadow');
});

test('switching on to off resolves open monitor alerts (documented), instead of leaving them firing forever', async () => {
  const e = scriptedEnv({ ALERT_WEBHOOK_URL: HOOK, SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const hook = recorder();
  await tick(e, { fetchImpl: scripted({ canary: new Response('', { status: 500 }) }), infra: fakeInfra() }, T0, hook);
  assert.equal((await row(e, 'synthetic_canary_site')).firing, 1);
  e.SYNTHETIC_MONITORS = 'off';
  const r = await tick(e, { fetchImpl: scripted(), infra: fakeInfra() }, T0 + 5 * MIN, hook);
  assert.equal(r.action('synthetic_canary_site'), 'resolved');
});

// ---------------------------------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------------------------------

test('secrets: the password, session cookie, checkout URL and monitor address never reach logs, alerts or audit rows', async () => {
  const e = scriptedEnv({ ALERT_WEBHOOK_URL: HOOK, SYNTHETIC_FAILURE_THRESHOLD: '1' });
  const hook = recorder(); const out = [];
  const real = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = (...a) => out.push(a.join(' '));
  try {
    await tick(e, { fetchImpl: scripted({ checkout: json({ success: false, error: `bad ${PASSWORD}`, checkoutUrl: 'https://checkout.stripe.test/c/pay/cs_secret' }, 500), canary: new Response(`${PASSWORD} sess-secret-value`, { status: 500 }) }), infra: fakeInfra() }, T0, hook);
  } finally { Object.assign(console, real); }
  const audit = JSON.stringify((await e.LUMMET_DB.prepare(`SELECT * FROM lummet_audit_logs`).all()).results);
  const state = JSON.stringify((await e.LUMMET_DB.prepare(`SELECT * FROM alert_state`).all()).results);
  const everything = [out.join('\n'), JSON.stringify(hook.calls), audit, state].join('\n');
  for (const secret of [PASSWORD, 'sess-secret-value', 'cs_secret', EMAIL]) assert.equal(everything.includes(secret), false, `leaked: ${secret}`);
  assert.ok(hook.calls.length >= 1, 'it did page');
});

test('the probe talks only to the configured portal and canary hosts, over https, with no redirects followed', async () => {
  const e = scriptedEnv(); const portal = scripted();
  const seen = [];
  const spy = async (url, init) => { seen.push({ url: String(url), redirect: init && init.redirect }); return portal(url, init); };
  await mon.runSyntheticMonitors(e, { fetchImpl: spy, infra: fakeInfra(), now: T0 });
  assert.ok(seen.length >= 5);
  for (const s of seen) { assert.match(s.url, /^https:\/\/(app|canary)\.example\.test\//); assert.equal(s.redirect, 'manual'); }
});

test('an unsafe canary URL (private address, credentials, http) is not configured, so it is never fetched', async () => {
  for (const url of ['http://canary.example.test/', 'https://169.254.169.254/', 'https://user:pw@canary.example.test/', 'https://localhost/', 'not a url']) {
    const e = scriptedEnv({ SYNTHETIC_CANARY_URL: url }); const portal = scripted();
    const r = await mon.runSyntheticMonitors(e, { fetchImpl: portal, infra: fakeInfra(), now: T0 });
    assert.equal(r.results.find((x) => x.monitor === 'canary_site').status, 'not_configured', url);
    assert.equal(portal.calls.some((c) => c.host !== 'app.example.test'), false, url);
  }
});

test('a canary without an expected marker is not configured: a 200 error page must not be able to look healthy', async () => {
  const e = scriptedEnv({ SYNTHETIC_CANARY_MARKER: '' });
  assert.equal((await mon.runSyntheticMonitors(e, { fetchImpl: scripted(), infra: fakeInfra(), now: T0 })).results.find((x) => x.monitor === 'canary_site').status, 'not_configured');
});

test('the sign-in probe leaves no session behind (it logs out) and reuses ONE login for sign-in and checkout', async () => {
  const e = scriptedEnv(); const portal = scripted();
  await mon.runSyntheticMonitors(e, { fetchImpl: portal, infra: fakeInfra(), now: T0 });
  const paths = portal.calls.filter((c) => c.host === 'app.example.test').map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(paths, ['POST /api/customer/login', 'GET /api/organizations', 'POST /api/organizations/org_1/billing/checkout', 'POST /api/customer/logout']);
  assert.equal(portal.calls.find((c) => c.path === '/api/customer/logout').cookie, 'lummet_customer_session=sess-secret-value');
});

test('the session is logged out even when a later step fails', async () => {
  const e = scriptedEnv(); const portal = scripted({ checkout: new Response('', { status: 500 }) });
  await mon.runSyntheticMonitors(e, { fetchImpl: portal, infra: fakeInfra(), now: T0 });
  assert.ok(portal.calls.some((c) => c.path === '/api/customer/logout'));
});

test('state reuses alert_state: no new table, no new migration, probe rows are hidden from the generic alert list', async () => {
  const e = scriptedEnv(); const infra = fakeInfra();
  await mon.runSyntheticMonitors(e, { fetchImpl: scripted({ canary: new Response('', { status: 500 }) }), infra, now: T0 });
  const p = await row(e, 'probe:canary_site');
  assert.equal(p.last_count, 1); assert.equal(p.firing, 1); assert.equal(p.first_seen_at, new Date(T0).toISOString());
  const ok = await row(e, 'probe:signin');
  assert.equal(ok.last_count, 0); assert.equal(ok.firing, 0); assert.equal(ok.last_notified_at, new Date(T0).toISOString());
  const { listAlertState } = await import('../worker/alerts.js');
  assert.equal((await listAlertState(e)).some((r) => r.key.startsWith('probe:')), false);
  const migrations = (await readdir(new URL('../migrations/', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(migrations.includes('0072_org_security_policy.sql') && migrations.every((m) => m.slice(0, 4) <= '0073'), 'Round 6.5A adds no migration of its own (0073 is the public copy refresh)');
});

test('a streak keeps its start time and counts up; recovery clears it and records the last ok time', async () => {
  const e = scriptedEnv(); const infra = fakeInfra();
  const bad = { fetchImpl: scripted({ canary: new Response('', { status: 500 }) }), infra };
  await mon.runSyntheticMonitors(e, { ...bad, now: T0 });
  await mon.runSyntheticMonitors(e, { ...bad, now: T0 + 5 * MIN });
  let p = await row(e, 'probe:canary_site');
  assert.equal(p.last_count, 2); assert.equal(p.first_seen_at, new Date(T0).toISOString());
  await mon.runSyntheticMonitors(e, { fetchImpl: scripted(), infra, now: T0 + 10 * MIN });
  p = await row(e, 'probe:canary_site');
  assert.equal(p.last_count, 0); assert.equal(p.firing, 0); assert.equal(p.first_seen_at, null); assert.equal(p.last_notified_at, new Date(T0 + 10 * MIN).toISOString());
});

test('transitions (not every probe) are audited with a reason code and no secrets; a changed reason is audited again', async () => {
  const e = scriptedEnv(); const infra = fakeInfra();
  const run = (over, t) => mon.runSyntheticMonitors(e, { fetchImpl: scripted(over), infra, now: t });
  await run({ canary: new Response('', { status: 500 }) }, T0);
  await run({ canary: new Response('', { status: 500 }) }, T0 + 5 * MIN);
  await run({ canary: new Response('', { status: 404 }) }, T0 + 10 * MIN);
  await run({}, T0 + 15 * MIN);
  const rows = (await e.LUMMET_DB.prepare(`SELECT action, success, error_message, actor_type, resource_id FROM lummet_audit_logs WHERE resource = 'synthetic_monitor' ORDER BY rowid`).all()).results;
  assert.deepEqual(rows.map((r) => `${r.resource_id}:${r.action}:${r.error_message || ''}`), ['canary_site:fail:canary_http_500', 'canary_site:fail:canary_http_404', 'canary_site:recover:']);
  assert.ok(rows.every((r) => r.actor_type === 'system'));
});

// ---------------------------------------------------------------------------------------------------------------------
// Settings and the staff view
// ---------------------------------------------------------------------------------------------------------------------

test('settings are clamped: threshold 1..10 (default 2), stale minutes 10..120 (default 20)', () => {
  assert.equal(mon.monitorSettings({}).threshold, 2);
  assert.equal(mon.monitorSettings({ SYNTHETIC_FAILURE_THRESHOLD: '0' }).threshold, 2);
  assert.equal(mon.monitorSettings({ SYNTHETIC_FAILURE_THRESHOLD: '99' }).threshold, 2);
  assert.equal(mon.monitorSettings({ SYNTHETIC_FAILURE_THRESHOLD: '3' }).threshold, 3);
  assert.equal(mon.monitorSettings({}).staleMinutes, 20);
  assert.equal(mon.monitorSettings({ SYNTHETIC_STALE_MINUTES: '5' }).staleMinutes, 20);
  assert.equal(mon.monitorSettings({ SYNTHETIC_STALE_MINUTES: '45' }).staleMinutes, 45);
});

test('staff statuses: ok, failing, stale, unknown (configured but never probed) are told apart', async () => {
  const e = scriptedEnv();
  assert.ok((await mon.monitorStatuses(e, { now: T0 })).every((t) => t.status === 'unknown'), 'configured but never probed is unknown, not ok');
  await mon.runSyntheticMonitors(e, { fetchImpl: scripted({ canary: new Response('', { status: 500 }) }), infra: fakeInfra(), now: T0 });
  const s = Object.fromEntries((await mon.monitorStatuses(e, { now: T0 + MIN })).map((t) => [t.monitor, t.status]));
  assert.deepEqual(s, { signin: 'ok', checkout: 'ok', canary_site: 'failing', domain_attach: 'ok' });
  const later = Object.fromEntries((await mon.monitorStatuses(e, { now: T0 + 60 * MIN })).map((t) => [t.monitor, t.status]));
  assert.deepEqual(later, { signin: 'stale', checkout: 'stale', canary_site: 'stale', domain_attach: 'stale' });
});

test('the staff alerts page shows the monitors, escapes everything and never shows an unprobed monitor as healthy', async () => {
  const { renderOpsAlertsPage } = await import('../worker/views/pages/saas-admin.js');
  const e = scriptedEnv({ SYNTHETIC_MONITORS: 'shadow' });
  const admin = { id: 1, email: 'staff@example.com', role: 'super_admin' };
  const html = await renderOpsAlertsPage(e, admin);
  assert.match(html, /Synthetic monitors/);
  assert.match(html, /Unknown/i);
  assert.doesNotMatch(html, />ok</i, 'nothing has been probed yet, so nothing may read ok');
  await mon.runSyntheticMonitors(e, { fetchImpl: scripted({ canary: new Response('', { status: 500 }) }), infra: fakeInfra(), now: Date.now() });
  const after = await renderOpsAlertsPage(e, admin);
  assert.match(after, /canary_http_500/);
  assert.match(after, /Failing/i);
});

// ---------------------------------------------------------------------------------------------------------------------
// Production configuration check
// ---------------------------------------------------------------------------------------------------------------------

test('config-check: invalid monitor settings are refused in production; unset means off and is fine', () => {
  const issues = (extra) => configIssues({ ENVIRONMENT: 'production', ...extra }).map((i) => i.key);
  assert.equal(issues({}).includes('SYNTHETIC_MONITORS'), false, 'unset is off');
  assert.equal(issues({ SYNTHETIC_MONITORS: 'off' }).includes('SYNTHETIC_MONITORS'), false);
  assert.equal(issues({ SYNTHETIC_MONITORS: 'maybe' }).includes('SYNTHETIC_MONITORS'), true);
  assert.equal(issues({ SYNTHETIC_FAILURE_THRESHOLD: 'x' }).includes('SYNTHETIC_FAILURE_THRESHOLD'), true);
  assert.equal(issues({ SYNTHETIC_FAILURE_THRESHOLD: '3' }).includes('SYNTHETIC_FAILURE_THRESHOLD'), false);
  assert.equal(issues({ SYNTHETIC_STALE_MINUTES: '1' }).includes('SYNTHETIC_STALE_MINUTES'), true);
  assert.equal(issues({ SYNTHETIC_CHECKOUT_ALLOW_LIVE: 'maybe' }).includes('SYNTHETIC_CHECKOUT_ALLOW_LIVE'), true);
  assert.equal(issues({ SYNTHETIC_MONITORS: 'on' }).some((k) => k.startsWith('SYNTHETIC_MONITORS/')), true, 'on with nothing configured is a coverage gap');
});

test('config-check: monitors set to on and fully configured raise no monitor issue', () => {
  const full = { ENVIRONMENT: 'production', SYNTHETIC_MONITORS: 'on', SYNTHETIC_SIGNIN_EMAIL: EMAIL, SYNTHETIC_SIGNIN_PASSWORD: PASSWORD, SYNTHETIC_ORGANIZATION_ID: 'org_1', SYNTHETIC_CHECKOUT_PLAN_ID: 'plan_x', SYNTHETIC_CANARY_URL: CANARY, SYNTHETIC_CANARY_MARKER: 'canary-ok', CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ZONE_ID: 'z', PORTAL_BASE_URL: PORTAL };
  assert.deepEqual(configIssues(full).map((i) => i.key).filter((k) => k.startsWith('SYNTHETIC')), []);
  assert.equal(configIssues({ ...full, SYNTHETIC_CANARY_MARKER: '' }).some((i) => i.key.startsWith('SYNTHETIC_MONITORS/')), true);
  assert.equal(configIssues({ ENVIRONMENT: 'staging', SYNTHETIC_MONITORS: 'maybe' }).length, 0, 'not nagged outside production');
});

test('config-check: login Turnstile with monitors on is a named conflict (the monitors cannot pass a challenge)', () => {
  const base = { ENVIRONMENT: 'production', SYNTHETIC_MONITORS: 'on', SYNTHETIC_SIGNIN_EMAIL: EMAIL, SYNTHETIC_SIGNIN_PASSWORD: PASSWORD, SYNTHETIC_ORGANIZATION_ID: 'org_1', SYNTHETIC_CHECKOUT_PLAN_ID: 'plan_x', SYNTHETIC_CANARY_URL: CANARY, SYNTHETIC_CANARY_MARKER: 'canary-ok', CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ZONE_ID: 'z', PORTAL_BASE_URL: PORTAL };
  const keys = (extra) => configIssues({ ...base, ...extra }).map((i) => i.key);
  assert.equal(keys({ CUSTOMER_TURNSTILE_REQUIRED: 'on', TURNSTILE_SECRET_KEY: 's', TURNSTILE_SITE_KEY: 'k' }).includes('SYNTHETIC_MONITORS/CUSTOMER_TURNSTILE_REQUIRED'), true);
  assert.equal(keys({ CUSTOMER_TURNSTILE_REQUIRED: 'off' }).includes('SYNTHETIC_MONITORS/CUSTOMER_TURNSTILE_REQUIRED'), false);
  assert.equal(keys({ SYNTHETIC_MONITORS: 'shadow', CUSTOMER_TURNSTILE_REQUIRED: 'on' }).includes('SYNTHETIC_MONITORS/CUSTOMER_TURNSTILE_REQUIRED'), false, 'only a monitor that pages is a coverage problem');
});

test('config-check names settings only, never values', () => {
  const text = JSON.stringify(configIssues({ ENVIRONMENT: 'production', SYNTHETIC_MONITORS: 'on', SYNTHETIC_SIGNIN_PASSWORD: PASSWORD, SYNTHETIC_CANARY_MARKER: 'marker-secret' }));
  assert.equal(text.includes(PASSWORD), false); assert.equal(text.includes('marker-secret'), false);
});

// ---------------------------------------------------------------------------------------------------------------------
// Boundaries and wiring
// ---------------------------------------------------------------------------------------------------------------------

test('boundary: the new SQL lives in worker/repositories/, which imports only other repositories', async () => {
  const src = await readFile(new URL('../worker/repositories/synthetic-monitors.js', import.meta.url), 'utf8');
  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) assert.match(m[1], /^\.\/[a-z-]+\.js$/);
  const mod = await readFile(new URL('../worker/synthetic-monitors.js', import.meta.url), 'utf8');
  assert.equal(/\.prepare\(/.test(mod), false, 'no direct SQL in the monitor module');
  assert.equal(/catch\s*(\(\s*\w*\s*\))?\s*\{\s*\}/.test(mod), false, 'no empty catch');
});

test('wiring: the five-minute tick and the external pinger both run the monitors before or alongside the alert check', async () => {
  const src = await readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
  const tick = src.slice(src.indexOf('async function runScheduled'), src.indexOf('async function captureDailyUsageSnapshots'));
  assert.match(tick, /runMonitorsThenAlertCheck\(env\)/);
  const pinger = src.slice(src.indexOf('"/api/ops/alert-check"'), src.indexOf('CI release API'));
  assert.match(pinger, /runSyntheticMonitors\(env\)/);
});

test('integration: scheduled() runs the probes then the alert check; a failing canary pages through the existing webhook, once', async () => {
  const e = makeEnv({ SYNTHETIC_MONITORS: 'on', SYNTHETIC_FAILURE_THRESHOLD: '1', SYNTHETIC_CANARY_URL: CANARY, SYNTHETIC_CANARY_MARKER: 'canary-ok', ALERT_WEBHOOK_URL: HOOK });
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(HOOK)) { sent.push(JSON.parse(init.body)); return new Response('', { status: 200 }); }
    if (u.startsWith('https://canary.example.test')) return new Response('down', { status: 500 });
    return new Response('unexpected', { status: 599 });
  };
  const pending = [];
  const c = { waitUntil(p) { pending.push(Promise.resolve(p).catch((x) => { throw x; })); } };
  try {
    await worker.scheduled({ cron: '*/5 * * * *' }, e, c);
    await Promise.allSettled(pending);
    await worker.scheduled({ cron: '*/5 * * * *' }, e, c);
    await Promise.allSettled(pending);
  } finally { globalThis.fetch = realFetch; }
  const pages = sent.filter((b) => /canary/i.test(b.text));
  assert.equal(pages.length, 1, 'paged once across two failing ticks');
  assert.equal((await row(e, 'synthetic_canary_site')).firing, 1);
});

// ---------------------------------------------------------------------------------------------------------------------
// End to end against the real routes (real sign-in, real checkout code, fake Stripe HTTP)
// ---------------------------------------------------------------------------------------------------------------------

async function realStack(extra = {}) {
  const e = makeEnv({ SYNTHETIC_MONITORS: 'on', SYNTHETIC_SIGNIN_EMAIL: EMAIL, SYNTHETIC_SIGNIN_PASSWORD: PASSWORD, SYNTHETIC_CHECKOUT_PLAN_ID: 'plan_casino_news_starter', SYNTHETIC_CANARY_URL: CANARY, SYNTHETIC_CANARY_MARKER: 'canary-ok', ...extra });
  await setPlanPrice(e, 'plan_casino_news_starter', 'price_x');
  const signup = await worker.fetch(new Request(`${PORTAL}/api/customer/signup`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD, organizationName: 'Monitor org' }) }), e, ctx);
  const body = await signup.json();
  assert.equal(signup.status, 200, JSON.stringify(body));
  e.SYNTHETIC_ORGANIZATION_ID = body.organizationId;
  const state = { canary: () => new Response('<html>canary-ok</html>', { status: 200 }) };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host === 'canary.example.test') return state.canary();
    const h = new Headers(init.headers || {}); h.set('CF-Connecting-IP', '198.51.100.7');
    return worker.fetch(new Request(String(url), { ...init, headers: h, redirect: 'manual' }), e, ctx);
  };
  return { e, fetchImpl, state };
}

async function withStripe(fn, { sessionOk = true } = {}) {
  const realFetch = globalThis.fetch; const sent = [];
  globalThis.fetch = async (u, init) => {
    sent.push({ url: String(u), body: init && init.body ? String(init.body) : '' });
    if (!sessionOk) return new Response(JSON.stringify({ error: { message: 'down' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const body = String(u).endsWith('/customers') ? { id: 'cus_mon' } : { id: 'cs_mon', url: 'https://checkout.stripe.test/c/pay/cs_mon' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try { return await fn(sent); } finally { globalThis.fetch = realFetch; }
}

test('end to end: the real login, session check, checkout session and logout all pass; no session or charge is left behind', async () => {
  const { e, fetchImpl } = await realStack();
  const sessionsBefore = (await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM customer_sessions`).first()).n;     // signup in realStack logged the test user in; that session is not the monitor's
  await withStripe(async (sent) => {
    const r = await mon.runSyntheticMonitors(e, { fetchImpl, infra: fakeInfra(), now: T0 });
    const by = Object.fromEntries(r.results.map((x) => [x.monitor, x.status]));
    assert.deepEqual(by, { signin: 'ok', checkout: 'ok', canary_site: 'ok', domain_attach: 'not_configured' });
    assert.match(r.results.find((x) => x.monitor === 'domain_attach').reason, /^missing: CF_API_TOKEN/, 'not configured names the missing settings and is never ok');
    assert.ok(sent.some((s) => s.url.endsWith('/checkout/sessions')), 'a checkout session was created at the (fake) provider');
    assert.equal(sent.some((s) => /payment_intents|charges|invoices/.test(s.url)), false, 'nothing was charged');
  });
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM customer_sessions`).first()).n, sessionsBefore, 'the monitor session was logged out: no session was left behind');
});

test('end to end: a provider outage makes the checkout monitor fail (never fake success) while sign-in stays ok', async () => {
  const { e, fetchImpl } = await realStack();
  await withStripe(async () => {
    const r = await mon.runSyntheticMonitors(e, { fetchImpl, infra: fakeInfra(), now: T0 });
    const c = r.results.find((x) => x.monitor === 'checkout');
    assert.equal(c.status, 'fail'); assert.match(c.reason, /^checkout_http_5\d\d$/);
    assert.equal(r.results.find((x) => x.monitor === 'signin').status, 'ok');
  }, { sessionOk: false });
});

test('end to end: a changed monitor password is a sign-in failure, and checkout is blocked rather than ok', async () => {
  const { e, fetchImpl } = await realStack({ SYNTHETIC_SIGNIN_PASSWORD: 'Wrong-Password-123456' });
  await withStripe(async () => {
    const r = await mon.runSyntheticMonitors(e, { fetchImpl, infra: fakeInfra(), now: T0 });
    assert.equal(r.results.find((x) => x.monitor === 'signin').reason, 'login_http_401');
    assert.equal(r.results.find((x) => x.monitor === 'checkout').status, 'blocked');
  });
});

test('end to end: an organization that requires 2FA fails the monitor with a clear reason (the monitor organization must not require it)', async () => {
  const { e, fetchImpl } = await realStack({ ORG_SECURITY_POLICY: 'enforce' });
  await e.LUMMET_DB.prepare(`INSERT INTO organization_security_policies (organization_id, require_2fa) VALUES (?, 1) ON CONFLICT(organization_id) DO UPDATE SET require_2fa = 1`).bind(e.SYNTHETIC_ORGANIZATION_ID).run();
  await withStripe(async () => {
    const r = await mon.runSyntheticMonitors(e, { fetchImpl, infra: fakeInfra(), now: T0 });
    assert.equal(r.results.find((x) => x.monitor === 'signin').status, 'fail');
    assert.match(r.results.find((x) => x.monitor === 'signin').reason, /^(login_org_2fa_enrollment_required|session_check_http_\d+)$/);
  });
});
