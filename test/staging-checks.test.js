// v7J: the staging checks pass on the real Worker, and each one really fails when what it guards is broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import worker from '../worker/index.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createAssets } from './support/public-env.js';
import { runStagingChecks } from '../scripts/staging-checks.mjs';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
function makeEnv(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ASSETS: createAssets(), CONTACT_EMAIL: 'hello@lummet.test', CREDENTIAL_KEK: btoa('k'.repeat(32)), CSP_MODE: 'enforce', ...extra }; }
/** The real Worker behind a fetch, with one optional saboteur that can rewrite requests or responses. */
function world(env, { before, after } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.protocol === 'http:') return new Response(null, { status: 301, headers: { Location: 'https://' + u.host + u.pathname } });
    const h = new Headers(init.headers || {}); if (!h.has('CF-Connecting-IP')) h.set('CF-Connecting-IP', '198.51.100.77');
    let req = new Request(url, { ...init, headers: h });
    if (before) { const early = await before(req, u); if (early instanceof Response) return early; if (early) req = early; }
    let res = await worker.fetch(req, env, ctx);
    if (after) res = (await after(res, u, req)) || res;
    return res;
  };
}
const rewrite = (res, { status, headers = {}, drop = [], body }) => {
  const h = new Headers(res.headers); for (const d of drop) h.delete(d); for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Response(body === undefined ? res.body : body, { status: status ?? res.status, headers: h });
};
const failed = (r) => r.results.filter((x) => !x.ok).map((x) => x.id);
const run = (fetchImpl, extra = {}) => runStagingChecks({ base: 'https://cp.test', fetchImpl, ...extra });

test('on the real Worker every blocker and warning passes; the only open launch gate is the draft terms page', async () => {
  const r = await run(world(makeEnv()), { withSignup: true, rateLimit: true });
  assert.deepEqual(failed(r), ['D7'], JSON.stringify(r.results.filter((x) => !x.ok)));
  assert.equal(r.ok, true); assert.deepEqual(r.launch.map((x) => x.id), ['D7']);
  assert.ok(r.counts.blocker.total >= 25);
  assert.ok(r.results.find((x) => x.id === 'C5').ok, 'cross-organization isolation was exercised');
});

test('report-only mode passes the blockers but leaves the enforcement launch gate open', async () => {
  const r = await run(world(makeEnv({ CSP_MODE: undefined })));
  assert.equal(r.ok, true);
  assert.deepEqual(failed(r).sort(), ['A9', 'D7']);
  assert.equal(r.results.find((x) => x.id === 'A8').detail, 'report-only');
});

test('optional groups only run when asked for', async () => {
  const r = await run(world(makeEnv()));
  assert.equal(r.results.some((x) => x.id.startsWith('C') || x.id.startsWith('E') || x.id.startsWith('F')), false);
});

// ---- each check fails when its subject is broken ----
const sabotage = [
  ['A4', 'HSTS missing', { after: (res, u) => u.pathname === '/app/login' && rewrite(res, { drop: ['strict-transport-security'] }) }],
  ['A5', 'nosniff missing', { after: (res, u) => u.pathname === '/app/login' && rewrite(res, { drop: ['x-content-type-options'] }) }],
  ['A6', 'framing allowed', { after: (res, u) => u.pathname === '/app/login' && rewrite(res, { headers: { 'x-frame-options': 'SAMEORIGIN' } }) }],
  ['A8', 'no script policy at all', { after: (res, u) => u.pathname === '/app/login' && rewrite(res, { drop: ['content-security-policy', 'content-security-policy-report-only'] }) }],
  ['A10', 'an inline script without the nonce', { after: async (res, u) => u.pathname === '/app/login' && rewrite(res, { body: (await res.text()).replace('</body>', '<script>alert(1)</script></body>') }) }],
  ['A11', 'an inline handler', { after: async (res, u) => u.pathname === '/app/login' && rewrite(res, { body: (await res.text()).replace('<form', '<form onsubmit="x()"') }) }],
  ['A12', 'a repeated request id', { after: (res) => rewrite(res, { headers: { 'x-request-id': '6f1e2d3c-1111-2222-3333-444455556666' } }) }],
  ['A13', 'a stack trace on an unknown path', { after: async (res, u) => /does-not-exist/.test(u.pathname) && rewrite(res, { status: 404, body: 'TypeError: x at async handleRequest (/worker/index.js:12:3)' }) }],
  ['B1', 'portal open to a signed-out visitor', { after: (res, u) => u.pathname === '/app/overview' && rewrite(res, { status: 200 }) }],
  ['B2', 'organization API open', { after: (res, u) => /^\/api\/organizations\/0{8}/.test(u.pathname) && rewrite(res, { status: 200 }) }],
  ['B3', 'staff console open', { after: (res, u) => u.pathname === '/platform/saas' && rewrite(res, { status: 200 }) }],
  ['B4', 'staff API open', { after: (res, u) => u.pathname === '/api/platform/saas/jobs' && rewrite(res, { status: 200 }) }],
  ['B5', 'developer API accepts a bad key', { after: (res, u) => u.pathname === '/api/v1/sites' && rewrite(res, { status: 200 }) }],
  ['B6', 'maintenance tick open', { after: (res, u) => u.pathname === '/api/ops/alert-check' && rewrite(res, { status: 200 }) }],
  ['D1', 'public home down', { after: (res, u) => u.pathname === '/' && rewrite(res, { status: 503 }) }],
  ['D2', 'public CSP allows inline scripts', { after: (res, u) => u.pathname === '/' && rewrite(res, { headers: { 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'" } }) }],
  ['D4', 'sitemap points at localhost', { after: async (res, u) => u.pathname === '/sitemap.xml' && rewrite(res, { body: (await res.text()).replace(/https:\/\/[^<]+/g, 'http://localhost:8787/x') }) }]
];
for (const [id, what, hooks] of sabotage) {
  test(`check ${id} fails when ${what}, and only that one`, async () => {
    const r = await run(world(makeEnv(), hooks));
    assert.ok(failed(r).includes(id), `${id} did not fail: ${JSON.stringify(failed(r))}`);
    assert.equal(r.ok, false);
    const dependents = id === 'A8' ? ['A6', 'A9', 'A10'] : [];   // with no policy header there is also no frame-ancestors, no enforcement and no nonce
    assert.deepEqual(failed(r).filter((x) => x !== id && x !== 'D7' && !dependents.includes(x)), [], `collateral failures for ${id}`);
  });
}

test('cookies, CSRF and isolation checks fail when they are broken', async () => {
  const weakCookie = await run(world(makeEnv(), { after: (res, u) => u.pathname === '/api/customer/signup' && (() => { const h = new Headers(res.headers); h.set('Set-Cookie', (res.headers.get('Set-Cookie') || '').split(';')[0] + '; Path=/'); return new Response(res.body, { status: res.status, headers: h }); })() }), { withSignup: true });
  assert.ok(failed(weakCookie).includes('C2'), JSON.stringify(failed(weakCookie)));
  const noCsrf = await run(world(makeEnv(), { before: (req) => (req.headers.get('Origin') === 'https://evil.example' && /logout/.test(req.url) ? new Response('{"success":true}', { status: 200 }) : null) }), { withSignup: true });
  assert.ok(failed(noCsrf).includes('C3'));
  const crossRead = await run(world(makeEnv(), { after: async (res, u) => { const m = u.pathname.match(/^\/api\/organizations\/([^/]+)\/sites$/); if (m && !/^0{8}-/.test(m[1]) && res.status !== 200 && res.status !== 401) return rewrite(res, { status: 200, body: '{"success":true,"data":[{"id":"s"}]}' }); return null; } }), { withSignup: true });
  assert.ok(failed(crossRead).includes('C5'), JSON.stringify(failed(crossRead)));
});

test('the attempt limiter check fails when no 429 ever comes', async () => {
  const r = await run(world(makeEnv(), { after: (res, u) => u.pathname === '/api/customer/login' && res.status === 429 && rewrite(res, { status: 401 }) }), { rateLimit: true });
  assert.ok(failed(r).includes('E1'));
});

// ---- the site group, against a stand-in for a deployed customer site ----
function siteWorld(o = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.host === 'site.test') {
      const p = u.pathname; const m = init.method || 'GET';
      if (p === '/') return o.home || new Response('<html><head><link rel="stylesheet" href="/static/css/app.css"></head></html>', { headers: { 'Content-Type': 'text/html' } });
      if (p === '/static/css/app.css') return new Response('x{}', { headers: { 'Content-Type': 'text/css' } });
      if (p === '/en/api/v1/setup/admin' && m === 'POST') return o.setup || new Response('{"success":false,"error":"Not found"}', { status: 404 });
      if (p === '/en/api/super/analytics-overview') return o.superApi || new Response('{}', { status: 401 });
      if (p === '/en/dashboard') return o.dashboard || new Response(null, { status: 302, headers: { Location: '/en/login' } });
      if (p === '/en/login') return new Response(o.widget ? '<div class="cf-turnstile" data-sitekey="k"></div>' : '<form></form>', { headers: { 'Content-Type': 'text/html' } });
    }
    return world(makeEnv())(url, init);
  };
}
const runSite = (o, site = 'https://site.test') => run(siteWorld(o), { site });

test('site checks pass on a healthy site and report Turnstile as information', async () => {
  const off = await runSite({}); assert.deepEqual(failed(off).filter((x) => x.startsWith('F')), []);
  assert.match(off.results.find((x) => x.id === 'F8').detail, /off/);
  assert.match((await runSite({ widget: true })).results.find((x) => x.id === 'F8').detail, /on/);
});

test('site checks fail for an open admin setup, an open Super API, an open dashboard, a missing stylesheet and plain HTTP', async () => {
  assert.ok(failed(await runSite({ setup: new Response('{"success":true}', { status: 200 }) })).includes('F4'));
  assert.ok(failed(await runSite({ superApi: new Response('{}', { status: 200 }) })).includes('F5'));
  assert.ok(failed(await runSite({ dashboard: new Response('<html>dash</html>', { status: 200 }) })).includes('F6'));
  assert.ok(failed(await runSite({ home: new Response('<html>no css</html>', { headers: { 'Content-Type': 'text/html' } }) })).includes('F3'));
  assert.ok(failed(await runSite({}, 'http://site.test')).includes('F1'));
});

test('an unreachable control plane fails the run clearly instead of crashing', async () => {
  const r = await run(async () => { throw new Error('getaddrinfo ENOTFOUND cp.test'); });
  assert.equal(r.ok, false); assert.ok(failed(r).includes('A3'));
});

test('the script with no arguments prints usage and exits 2', () => {
  const r = spawnSync(process.execPath, ['scripts/staging-checks.mjs'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, timeout: 20000 });
  assert.equal(r.status, 2); assert.match(r.stderr, /Usage: node scripts\/staging-checks\.mjs/);
});

// ---- the health endpoint the checks (and uptime monitors) use ----
test('/api/health: 200 {"ok":true} with nothing else, no auth needed; 503 {"ok":false} and a recorded error when the database is down', async () => {
  const env = makeEnv();
  const ok = await worker.fetch(new Request('https://cp.test/api/health'), env, ctx);
  assert.equal(ok.status, 200); assert.deepEqual(await ok.json(), { ok: true });
  assert.equal((await worker.fetch(new Request('https://cp.test/api/health', { method: 'HEAD' }), env, ctx)).status, 200);
  assert.equal((await worker.fetch(new Request('https://cp.test/api/health', { method: 'POST' }), env, ctx)).status, 401, 'only GET and HEAD');
  const real = env.LUMMET_DB;
  env.LUMMET_DB = { prepare(sql) { if (sql.startsWith('SELECT 1')) throw new Error('D1_ERROR: database offline secret-detail'); return real.prepare(sql); } };
  const down = await worker.fetch(new Request('https://cp.test/api/health'), env, ctx);
  assert.equal(down.status, 503);
  const body = await down.text();
  assert.deepEqual(JSON.parse(body), { ok: false }); assert.doesNotMatch(body, /secret-detail|offline/);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await real.prepare(`SELECT COUNT(*) n FROM request_errors WHERE route = '/api/health' AND status = 503`).first()).n, 1);
});
