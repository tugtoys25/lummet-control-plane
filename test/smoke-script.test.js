// The first-site smoke test script: each branch reports the right failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke } from '../scripts/smoke-test.mjs';

const BASE = 'https://cp.test';
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...headers } });

// A scripted control plane + site. `o` overrides pieces of the story.
function fakeWorld(o = {}) {
  const log = []; let polls = 0;
  const statuses = o.statuses || ['provisioning', 'provisioned', 'active'];
  const impl = async (url, init = {}) => {
    const u = new URL(url); const method = init.method || 'GET'; log.push(`${method} ${u.pathname}`);
    if (u.host === 'cp.test') {
      if (u.pathname === '/api/customer/signup') return o.signup || json({ success: true, organizationId: 'org1' }, 200, { 'Set-Cookie': 'lummet_customer_session=abc; Path=/; HttpOnly' });
      if (u.pathname.endsWith('/trial')) return o.trial || json({ success: true });
      if (method === 'POST' && u.pathname.endsWith('/sites')) return o.create || json({ success: true, siteId: 's1' });
      if (method === 'GET' && u.pathname.endsWith('/sites')) {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        return json({ success: true, data: [{ id: 's1', status, primary_domain: 'smoke.sites.example.com' }] });
      }
      if (u.pathname.endsWith('/deployments')) return json({ success: true, data: o.deployments || [] });
      if (u.pathname.endsWith('/dashboard-admin')) return o.setPassword || json({ success: true, email: 'x' });
      if (u.pathname.endsWith('/request-deletion')) return o.del || json({ success: true });
    }
    if (u.host === 'smoke.sites.example.com') {
      if (o.siteDown) throw new Error('getaddrinfo ENOTFOUND');
      if (u.pathname === '/') return o.home || new Response('<html><head><link rel="stylesheet" href="/static/css/app.css"></head></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      if (u.pathname === '/en/api/v1/auth/login') return o.login || json({ success: true }, 200, { 'Set-Cookie': 'session=tok123; Path=/; HttpOnly; Secure' });
      if (u.pathname === '/en/dashboard') return o.dashboard || new Response('<html>dashboard</html>', { headers: { 'Content-Type': 'text/html' } });
      if (u.pathname === '/static/css/app.css') return o.css || new Response('body{}', { headers: { 'Content-Type': 'text/css' } });
    }
    return new Response('not found', { status: 404 });
  };
  return { impl, log };
}
const run = (world, extra = {}) => runSmoke({ base: BASE, fetchImpl: world.impl, pollMs: 1, timeoutMs: 500, ...extra });
const names = (r) => r.steps.map((s) => `${s.ok ? '+' : '-'}${s.name}`);

test('smoke: the happy path passes every step and schedules clean-up', async () => {
  const w = fakeWorld(); const r = await run(w);
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(names(r), ['+sign up', '+start trial', '+create site', '+site becomes active', '+homepage loads', '+stylesheet loads', '+request clean-up (organization deletion)']);
  assert.ok(w.log.includes('POST /api/organizations/org1/request-deletion'));
});

test('smoke: --keep leaves the organization alone', async () => {
  const w = fakeWorld(); const r = await run(w, { keep: true });
  assert.equal(r.ok, true);
  assert.ok(!w.log.some((l) => l.includes('request-deletion')));
});

test('smoke: a refused trial stops early, says why, and still cleans up', async () => {
  const w = fakeWorld({ trial: json({ success: false, error: 'invalid_plan' }, 422) });
  const r = await run(w);
  assert.equal(r.ok, false);
  assert.deepEqual(names(r).slice(0, 2), ['+sign up', '-start trial']);
  assert.match(r.steps[1].detail, /invalid_plan/);
  assert.ok(w.log.some((l) => l.includes('request-deletion')));
});

test('smoke: a failed site reports the deployment error', async () => {
  const w = fakeWorld({ statuses: ['provisioning', 'failed'], deployments: [{ error_message: 'static asset check failed for https://x/static/a.css (status 404)' }] });
  const r = await run(w);
  assert.equal(r.ok, false);
  const step = r.steps.find((s) => s.name === 'site becomes active');
  assert.equal(step.ok, false);
  assert.match(step.detail, /static asset check failed/);
});

test('smoke: a site stuck at provisioned points at the missing release', async () => {
  const w = fakeWorld({ statuses: ['provisioned'] });
  const r = await run(w, { timeoutMs: 30 });
  const step = r.steps.find((s) => s.name === 'site becomes active');
  assert.equal(step.ok, false);
  assert.match(step.detail, /still 'provisioned'/);
  assert.match(step.detail, /no tenant release is published/);
});

test('smoke: an unreachable hostname is reported as DNS / route / certificate', async () => {
  const r = await run(fakeWorld({ siteDown: true }));
  assert.equal(r.ok, false);
  assert.match(r.steps.find((s) => s.name === 'homepage loads').detail, /DNS, route or certificate/);
});

test('smoke: a homepage that is not HTML, or a missing stylesheet, fails', async () => {
  const notHtml = await run(fakeWorld({ home: new Response('{}', { headers: { 'Content-Type': 'application/json' } }) }));
  assert.equal(notHtml.steps.find((s) => s.name === 'homepage loads').ok, false);

  const noLink = await run(fakeWorld({ home: new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }) }));
  assert.match(noLink.steps.find((s) => s.name === 'stylesheet loads').detail, /no stylesheet link/);

  const css404 = await run(fakeWorld({ css: new Response('nope', { status: 404 }) }));
  const cssStep = css404.steps.find((s) => s.name === 'stylesheet loads');
  assert.equal(cssStep.ok, false);
  assert.match(cssStep.detail, /HTTP 404/);
  assert.equal(css404.ok, false);
});

test('smoke: a failed clean-up request does not turn a passing run into a failure', async () => {
  const r = await run(fakeWorld({ del: json({ success: false }, 500) }));
  assert.equal(r.ok, true);
  assert.equal(r.steps.at(-1).ok, false);
});


// ---- v7J: the customer's own dashboard login ----
test('smoke: with the dashboard steps on, it sets the password, signs in and opens the dashboard', async () => {
  const w = fakeWorld(); const r = await run(w, { dashboardLogin: true });
  assert.equal(r.ok, true, JSON.stringify(r.steps));
  assert.deepEqual(names(r).slice(4), ['+homepage loads', '+stylesheet loads', '+set dashboard password', '+sign in to the dashboard', '+dashboard opens', '+request clean-up (organization deletion)']);
  assert.ok(w.log.some((l) => l.endsWith('/dashboard-admin')) && w.log.includes('POST /en/api/v1/auth/login') && w.log.includes('GET /en/dashboard'));
});

test('smoke: a refused dashboard password names the likely cause (the Worker token cannot edit the site database)', async () => {
  const r = await run(fakeWorld({ setPassword: json({ success: false, error: 'site_database_unavailable' }, 502) }), { dashboardLogin: true });
  assert.equal(r.ok, false);
  const step = r.steps.find((s) => s.name === 'set dashboard password');
  assert.equal(step.ok, false); assert.match(step.detail, /site_database_unavailable/); assert.match(step.detail, /CF_API_TOKEN/);
});

test('smoke: a 403 at the site login points at Turnstile; --turnstile-on skips the step instead of failing', async () => {
  const blocked = await run(fakeWorld({ login: json({ success: false, error: 'Security verification failed. Please try again.' }, 403) }), { dashboardLogin: true });
  assert.equal(blocked.ok, false);
  assert.match(blocked.steps.find((s) => s.name === 'sign in to the dashboard').detail, /Turnstile/);
  const w = fakeWorld({ login: json({ success: false }, 403) });
  const skipped = await run(w, { dashboardLogin: true, turnstileOn: true });
  assert.equal(skipped.ok, true);
  assert.ok(!w.log.includes('POST /en/api/v1/auth/login'), 'no login attempt is made');
  assert.match(skipped.steps.find((s) => s.name === 'sign in to the dashboard').detail, /by hand/);
});

test('smoke: a successful login whose dashboard does not open is reported', async () => {
  const r = await run(fakeWorld({ dashboard: new Response('', { status: 302, headers: { Location: '/en/login' } }) }), { dashboardLogin: true });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === 'dashboard opens').ok, false);
});

test('smoke: a login that answers 200 without a session cookie does not count as signed in', async () => {
  const r = await run(fakeWorld({ login: json({ success: true }) }), { dashboardLogin: true });
  assert.equal(r.ok, false);
  assert.equal(r.steps.find((s) => s.name === 'sign in to the dashboard').ok, false);
});
