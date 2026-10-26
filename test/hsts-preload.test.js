// Round 6.3C (stage _pre): HSTS with preload (header + preload-eligibility check). Acceptance tests written first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import worker from '../worker/index.js';
import * as hsts from '../worker/hsts.js';
import { configIssues } from '../worker/config-check.js';
import { main as preloadCheck } from '../scripts/hsts-preload-check.mjs';

const BASE = 'max-age=31536000; includeSubDomains';
const PRELOAD = 'max-age=63072000; includeSubDomains; preload';

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@example.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce', ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const raw = (e, method, path, headers = {}, body) => worker.fetch(new Request('https://cp.example.test' + path, { method, headers: { 'CF-Connecting-IP': '198.51.100.9', ...headers }, body, redirect: 'manual' }), e, ctx);

// ---- the header value ----------------------------------------------------------------------------------------------

test('default: the HSTS header is exactly what 2.6.0.7 sent (no preload), so nothing changes until the owner flips the flag', () => {
  assert.equal(hsts.hstsHeaderValue({}), BASE);
  assert.equal(hsts.hstsHeaderValue(undefined), BASE);
  for (const v of ['off', '', 'true', 'yes', '1', 'preload', 'enabled']) assert.equal(hsts.hstsHeaderValue({ HSTS_PRELOAD: v }), BASE, `"${v}" is not "on"`);
});

test('HSTS_PRELOAD=on sends max-age of two years, includeSubDomains and preload; case and spaces are tolerated', () => {
  for (const v of ['on', 'ON', ' on ']) assert.equal(hsts.hstsHeaderValue({ HSTS_PRELOAD: v }), PRELOAD);
  assert.equal(hsts.hstsPreloadMode({ HSTS_PRELOAD: 'on' }), 'on');
  assert.equal(hsts.hstsPreloadMode({}), 'off');
});

// ---- headers on every page type -----------------------------------------------------------------------------------

const REQUESTS = [
  ['customer portal login (HTML, nonce CSP)', 'GET', '/login'],
  ['customer token page', 'GET', '/app/reset-password?uid=u&token=t'],
  ['staff console redirect to login', 'GET', '/platform/saas/jobs'],
  ['public site home (own CSP)', 'GET', '/'],
  ['public site pricing', 'GET', '/pricing'],
  ['public site contact', 'GET', '/contact'],
  ['public site 404', 'GET', '/definitely-not-a-page'],
  ['static script asset', 'GET', '/static/js/nav.js'],
  ['robots.txt', 'GET', '/robots.txt'],
  ['health JSON', 'GET', '/api/health'],
  ['JSON 404', 'GET', '/api/nothing-here'],
  ['CSP report endpoint (204)', 'POST', '/api/csp-report', { 'Content-Type': 'application/csp-report' }, '{"csp-report":{}}'],
  ['CSRF-blocked POST (403)', 'POST', '/api/customer/signup', { Cookie: 'a=b', Origin: 'https://evil.example.com' }],
  ['HEAD request', 'HEAD', '/login'],
  ['OPTIONS request', 'OPTIONS', '/api/health']
];

for (const flag of ['off', 'on']) {
  test(`HSTS_PRELOAD=${flag}: Strict-Transport-Security and the other security headers are on every page type`, async () => {
    const e = env({ HSTS_PRELOAD: flag });
    const want = flag === 'on' ? PRELOAD : BASE;
    for (const [label, method, path, headers, body] of REQUESTS) {
      const res = await raw(e, method, path, headers, body);
      assert.equal(res.headers.get('Strict-Transport-Security'), want, `${label} (${res.status})`);
      assert.equal((res.headers.get('X-Content-Type-Options') || '').toLowerCase(), 'nosniff', label);
      assert.ok(res.headers.get('X-Frame-Options') || /frame-ancestors/.test(res.headers.get('Content-Security-Policy') || ''), `${label}: framing is restricted`);
      assert.ok(res.headers.get('X-Request-Id'), label);
    }
  });
}

test('an unhandled exception still returns a response with the security headers (HSTS included)', async () => {
  const e = { HSTS_PRELOAD: 'on', CSP_MODE: 'enforce' }; // no database at all
  const res = await raw(e, 'POST', '/api/customer/login', { 'Content-Type': 'application/json' }, JSON.stringify({ email: 'a@b.c', password: 'x' }));
  assert.ok(res.status >= 400);
  assert.equal(res.headers.get('Strict-Transport-Security'), PRELOAD);
});

test('a value a route already set is kept only when it is at least as strong; otherwise ours replaces it', () => {
  const on = { HSTS_PRELOAD: 'on' };
  assert.equal(hsts.hstsHeaderValue(on, 'max-age=1000'), PRELOAD, 'weaker is replaced');
  assert.equal(hsts.hstsHeaderValue(on, BASE), PRELOAD, 'no preload is replaced when preload is on');
  assert.equal(hsts.hstsHeaderValue(on, 'max-age=94608000; includeSubDomains; preload'), 'max-age=94608000; includeSubDomains; preload', 'stronger is kept');
  assert.equal(hsts.hstsHeaderValue({}, 'max-age=63072000; includeSubDomains; preload'), 'max-age=63072000; includeSubDomains; preload');
  assert.equal(hsts.hstsHeaderValue({}, 'max-age=100'), BASE);
  assert.equal(hsts.hstsHeaderValue({}, ''), BASE);
  assert.equal(hsts.hstsHeaderValue({}, null), BASE);
});

// ---- eligibility check --------------------------------------------------------------------------------------------

test('parseHsts reads max-age, includeSubDomains and preload', () => {
  assert.deepEqual(hsts.parseHsts(PRELOAD), { maxAge: 63072000, includeSubDomains: true, preload: true });
  assert.deepEqual(hsts.parseHsts('MAX-AGE=10; includesubdomains'), { maxAge: 10, includeSubDomains: true, preload: false });
  assert.deepEqual(hsts.parseHsts(''), { maxAge: null, includeSubDomains: false, preload: false });
  assert.deepEqual(hsts.parseHsts(null), { maxAge: null, includeSubDomains: false, preload: false });
  assert.equal(hsts.parseHsts('max-age=abc').maxAge, null);
});

test('checkPreloadEligibility: the preload header passes; each missing requirement is named', () => {
  assert.deepEqual(hsts.checkPreloadEligibility(PRELOAD, { httpRedirectsToHttps: true }), { eligible: true, problems: [], unchecked: [] });
  const noPreload = hsts.checkPreloadEligibility(BASE, { httpRedirectsToHttps: true });
  assert.equal(noPreload.eligible, false); assert.match(noPreload.problems.join(), /preload/);
  const short = hsts.checkPreloadEligibility('max-age=15552000; includeSubDomains; preload', { httpRedirectsToHttps: true });
  assert.equal(short.eligible, false); assert.match(short.problems.join(), /max-age/);
  const noSub = hsts.checkPreloadEligibility('max-age=63072000; preload', { httpRedirectsToHttps: true });
  assert.equal(noSub.eligible, false); assert.match(noSub.problems.join(), /includeSubDomains/);
  const missing = hsts.checkPreloadEligibility(null, { httpRedirectsToHttps: true });
  assert.equal(missing.eligible, false); assert.match(missing.problems.join(), /missing/i);
  const noRedirect = hsts.checkPreloadEligibility(PRELOAD, { httpRedirectsToHttps: false });
  assert.equal(noRedirect.eligible, false); assert.match(noRedirect.problems.join(), /redirect/i);
});

test('checkPreloadEligibility: an unchecked redirect is listed, not assumed, and does not make the answer "eligible: true" by itself', () => {
  const r = hsts.checkPreloadEligibility(PRELOAD, {});
  assert.equal(r.eligible, false, 'unknown is not eligible');
  assert.deepEqual(r.problems, []);
  assert.equal(r.unchecked.length, 1); assert.match(r.unchecked[0], /redirect/i);
});

test('the shipped header with the flag on passes the eligibility check; the 2.6.0.7 header does not', () => {
  assert.equal(hsts.checkPreloadEligibility(hsts.hstsHeaderValue({ HSTS_PRELOAD: 'on' }), { httpRedirectsToHttps: true }).eligible, true);
  assert.equal(hsts.checkPreloadEligibility(hsts.hstsHeaderValue({}), { httpRedirectsToHttps: true }).eligible, false);
});

// ---- the owner-run check script -----------------------------------------------------------------------------------

const io = () => { const out = [], err = []; return { out, err, log: (m) => out.push(String(m)), error: (m) => err.push(String(m)) }; };

test('script: --header checks a value offline (no network); exit 0 only when eligible', async () => {
  const a = io();
  assert.equal(await preloadCheck(['--header', PRELOAD, '--assume-redirect'], {}, async () => { throw new Error('no network expected'); }, a), 0);
  assert.equal(JSON.parse(a.out.join('')).eligible, true);
  const b = io();
  assert.equal(await preloadCheck(['--header', BASE, '--assume-redirect'], {}, async () => { throw new Error('no network'); }, b), 1);
  assert.match(JSON.parse(b.out.join('')).problems.join(), /preload/);
  const c = io();
  assert.equal(await preloadCheck(['--header', PRELOAD], {}, async () => { throw new Error('no network'); }, c), 1, 'redirect unchecked is not eligible');
  assert.equal(JSON.parse(c.out.join('')).unchecked.length, 1);
});

test('script: no arguments prints usage and exits 2; --url must be https', async () => {
  const a = io(); assert.equal(await preloadCheck([], {}, async () => null, a), 2); assert.match(a.err.join(), /Usage/);
  const b = io(); assert.equal(await preloadCheck(['--url', 'http://example.com/'], {}, async () => null, b), 2); assert.match(b.err.join(), /https/);
  const c = io(); assert.equal(await preloadCheck(['--url', 'not a url'], {}, async () => null, c), 2);
});

test('script: --url fetches the HTTPS header and the http:// redirect (injected fetch), without following redirects', async () => {
  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push([String(url), opts && opts.redirect]);
    if (String(url).startsWith('https://')) return new Response('ok', { status: 200, headers: { 'strict-transport-security': PRELOAD } });
    return new Response(null, { status: 301, headers: { location: 'https://example.com/' } });
  };
  const a = io();
  assert.equal(await preloadCheck(['--url', 'https://example.com/'], {}, fakeFetch, a), 0);
  const out = JSON.parse(a.out.join(''));
  assert.equal(out.eligible, true); assert.equal(out.host, 'example.com');
  assert.deepEqual(seen.map((s) => s[0]), ['https://example.com/', 'http://example.com/']);
  assert.ok(seen.every((s) => s[1] === 'manual'));
  // a redirect to another host does not count
  const wrong = async (url) => String(url).startsWith('https://') ? new Response('', { status: 200, headers: { 'strict-transport-security': PRELOAD } }) : new Response(null, { status: 301, headers: { location: 'https://other.example/' } });
  const b = io(); assert.equal(await preloadCheck(['--url', 'https://example.com/'], {}, wrong, b), 1);
  assert.match(JSON.parse(b.out.join('')).problems.join(), /redirect/i);
  // a network failure is reported, not swallowed
  const c = io(); assert.equal(await preloadCheck(['--url', 'https://example.com/'], {}, async () => { throw new Error('boom'); }, c), 1);
  assert.match(c.err.join(), /boom/);
});

test('script: a subdomain host is warned about (preload lists registrable domains)', async () => {
  const f = async (url) => String(url).startsWith('https://') ? new Response('', { status: 200, headers: { 'strict-transport-security': PRELOAD } }) : new Response(null, { status: 301, headers: { location: 'https://app.example.com/' } });
  const a = io(); await preloadCheck(['--url', 'https://app.example.com/'], {}, f, a);
  assert.match(JSON.parse(a.out.join('')).warnings.join(), /apex|registrable/i);
});

// ---- production configuration -------------------------------------------------------------------------------------

const keys = (e) => configIssues({ ENVIRONMENT: 'production', ...e }).map((i) => i.key);

test('config-check: production requires HSTS_PRELOAD to be set explicitly to off or on', () => {
  assert.ok(keys({}).includes('HSTS_PRELOAD'));
  assert.ok(keys({ HSTS_PRELOAD: 'maybe' }).includes('HSTS_PRELOAD'));
  assert.ok(!keys({ HSTS_PRELOAD: 'off' }).includes('HSTS_PRELOAD'));
});

test('config-check: HSTS_PRELOAD=on also needs the recorded owner approval (preload is hard to undo)', () => {
  assert.ok(keys({ HSTS_PRELOAD: 'on' }).includes('HSTS_PRELOAD_APPROVED'));
  assert.ok(keys({ HSTS_PRELOAD: 'on', HSTS_PRELOAD_APPROVED: 'no' }).includes('HSTS_PRELOAD_APPROVED'));
  assert.ok(!keys({ HSTS_PRELOAD: 'on', HSTS_PRELOAD_APPROVED: 'yes' }).includes('HSTS_PRELOAD_APPROVED'));
  assert.ok(!keys({ HSTS_PRELOAD: 'off' }).includes('HSTS_PRELOAD_APPROVED'), 'not needed while off');
});

test('wrangler.jsonc and wrangler.example.jsonc declare HSTS_PRELOAD as off, and CSP_MODE is not flipped to enforce', () => {
  for (const f of ['wrangler.jsonc', 'wrangler.example.jsonc']) {
    const text = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
    assert.match(text, /"HSTS_PRELOAD":\s*"off"/, f);
    assert.doesNotMatch(text, /"CSP_MODE":\s*"enforce"/, f);
  }
});

test('docs: the preload runbook exists, says preload is hard to undo, and nothing claims it was verified live', () => {
  const doc = readFileSync(new URL('../docs/HSTS_PRELOAD.md', import.meta.url), 'utf8');
  assert.match(doc, /hard to (undo|reverse)/i);
  assert.match(doc, /includeSubDomains/);
  assert.match(doc, /NOT VERIFIED/);
  assert.match(doc, /hsts-preload-check/);
});
