// Security review 2.1: cross-site request guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ...extra }; }
const ctx = { waitUntil() {} };
async function call(e, method, path, { headers = {}, body, ip = '198.51.100.9' } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': ip, ...headers });
  if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.example.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
const signup = (e, email, extra = {}) => call(e, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'O' }, ...extra });

test('a state-changing request that carries cookies is refused when it comes from another origin', async () => {
  const e = env(); const s = await signup(e, 'c1@example.com'); const org = s.json.organizationId;
  const attempt = (headers) => call(e, 'POST', `/api/organizations/${org}/api-keys`, { headers: { Cookie: s.cookie, ...headers }, body: { name: 'x', scopes: ['sites:read'] } });

  for (const h of [{ Origin: 'https://evil.example.com' }, { Origin: 'https://customer.sites.example.test' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    const r = await attempt(h);
    assert.equal(r.status, 403, JSON.stringify(h)); assert.equal(r.json.error, 'cross_site_request_blocked');
  }
  assert.equal((await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM customer_api_keys`).first()).n, 0, 'no key was created by a blocked request');

  assert.equal((await attempt({ Origin: 'https://cp.example.test' })).status, 200, 'same origin works');
  assert.equal((await attempt({ 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await attempt({ 'Sec-Fetch-Site': 'none' })).status, 200);
  assert.equal((await attempt({})).status, 200, 'non-browser clients that send neither header still work');
});

test('the same guard protects the staff console', async () => {
  const e = env();
  await call(e, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  const cookie = (await call(e, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;
  const evil = await call(e, 'POST', '/api/platform/saas/alerts/check', { headers: { Cookie: cookie, Origin: 'https://evil.example.com' }, body: {} });
  assert.equal(evil.status, 403);
  const ok = await call(e, 'POST', '/api/platform/saas/alerts/check', { headers: { Cookie: cookie, Origin: 'https://cp.example.test' }, body: {} });
  assert.notEqual(ok.status, 403);
});

test('requests without cookies (API keys, webhooks, the pinger) and safe GETs are not affected', async () => {
  const e = env({ ALERT_CHECK_TOKEN: 'tok' });
  assert.equal((await call(e, 'POST', '/api/ops/alert-check', { headers: { Authorization: 'Bearer tok', Origin: 'https://anything.example' } })).status, 200);
  assert.equal((await call(e, 'GET', '/login', { headers: { Cookie: 'a=b', Origin: 'https://evil.example.com' } })).status, 200, 'GET is never blocked');
  assert.notEqual((await call(e, 'POST', '/api/v1/sites', { headers: { Authorization: 'Bearer lk_x', Origin: 'https://other.example' } })).status, 403);
});

test('every response carries the security headers: pages, JSON, redirects, errors', async () => {
  const e = env();
  const check = (res, label) => {
    assert.equal(res.headers.get('X-Frame-Options'), 'DENY', label);
    assert.match(res.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/, label);
    assert.equal(res.headers.get('Referrer-Policy'), 'no-referrer', label);
    assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff', label);
    assert.match(res.headers.get('Strict-Transport-Security'), /max-age=/, label);
  };
  const raw = (method, path, headers = {}) => worker.fetch(new Request('https://cp.example.test' + path, { method, headers: { 'CF-Connecting-IP': '198.51.100.9', ...headers }, redirect: 'manual' }), e, ctx);
  check(await raw('GET', '/login'), 'html page');
  check(await raw('GET', '/app/reset-password?uid=u&token=t'), 'token page');
  check(await raw('GET', '/platform/saas/jobs'), 'redirect to login');
  check(await raw('GET', '/api/nothing-here'), 'json error');
  const blocked = await raw('POST', '/api/customer/signup', { Cookie: 'a=b', Origin: 'https://evil.example.com' });
  assert.equal(blocked.status, 403); check(blocked, 'csrf block');
  const login = await raw('GET', '/login');
  assert.ok(login.headers.get('Content-Type'), 'content type preserved');
});

test('the Worker still exposes a scheduled handler after the header wrapper', async () => {
  assert.equal(typeof worker.scheduled, 'function');
  assert.equal(typeof worker.fetch, 'function');
});

test('cookies set by login survive the header wrapper', async () => {
  const e = env();
  const s = await signup(e, 'wrap@example.com');
  assert.ok(s.cookie.includes('='), 'Set-Cookie still present');
});

test('the CSP blocks exfiltration channels (connect, frames, workers) but is honest about not restricting scripts', async () => {
  const e = env();
  const res = await worker.fetch(new Request('https://cp.example.test/login', { headers: { 'CF-Connecting-IP': '198.51.100.9' } }), e, ctx);
  const csp = res.headers.get('Content-Security-Policy');
  for (const d of ["connect-src 'self'", "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'"]) assert.ok(csp.includes(d), d);
  assert.equal(/script-src|default-src/.test(csp), false, 'no script-src: inline scripts still run (documented gap)');
});

test('the pages still work under the CSP: login and portal pages load no external resources and fetch only same-origin', async () => {
  const e = env();
  const s = await signup(e, 'csp@example.com');
  for (const path of ['/login', '/app/billing', '/app/account', '/app/domains', '/app/backups']) {
    const r = await call(e, 'GET', path, { headers: { Cookie: s.cookie } });
    assert.equal(r.status === 200 || r.status === 302, true, path);
    assert.equal(/<(script|img|link|iframe)[^>]+(src|href)="https?:\/\//i.test(r.text), false, path + ' loads an external resource');
    assert.equal(/fetch\(\s*['"]https?:\/\//.test(r.text), false, path + ' calls an external URL');
  }
});
