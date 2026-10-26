import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { verifyCloudflareAccessJwt, platformAccessGate, isPlatformAccessPath, parsePlatformAccessMode, normalizeAccessIssuer, resetAccessJwksCache } from '../worker/cloudflare-access-jwt.js';
import worker from '../worker/index.js';
import { configIssues } from '../worker/config-check.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { main as accessConfigMain } from '../scripts/cloudflare-access-config.mjs';
import { loadConfig, validateConfig, openPlaceholders, overlaps } from '../scripts/lib/access-policy.mjs';

const issuer = 'https://lummet-test.cloudflareaccess.com';
const audience = 'access-app-audience-test';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwkOf = (key, kid) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' });
const publicJwk = jwkOf(publicKey, 'test-key-1');
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);
function token(claims = {}, header = {}, key = privateKey) {
  const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'test-key-1', ...header });
  const body = b64({ iss: issuer, aud: [audience], sub: 'staff-subject-123', email: 'staff@example.test', iat: now(), exp: now() + 300, ...claims });
  const input = `${head}.${body}`;
  return `${input}.${signBytes('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
}
function jwksFetch(keys = [publicJwk], counter = { n: 0 }) {
  const fn = async (url) => { counter.n++; assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys }), { status: 200 }); };
  fn.counter = counter; return fn;
}
const env = (extra = {}) => ({ PLATFORM_ACCESS_JWT_MODE: 'enforce', CF_ACCESS_ISSUER: issuer, CF_ACCESS_AUD: audience, ...extra });
const req = (jwt, path = '/api/platform/saas/rollouts', headers = {}) => new Request(`https://cp.test${path}`, { headers: { ...(jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {}), ...headers } });
const verify = (jwt, e = env(), fetchImpl = jwksFetch(), extra = {}) => verifyCloudflareAccessJwt(req(jwt), e, { fetchImpl, ...extra });

beforeEach(() => resetAccessJwksCache());

// ---------- acceptance: JWT accepted and rejected correctly ----------
test('accepts a valid RS256 token (array audience and string audience)', async () => {
  assert.deepEqual(await verify(token()), { ok: true, reason: 'valid' });
  assert.equal((await verify(token({ aud: audience }))).ok, true);
  assert.equal((await verify(token({ aud: ['other-app-aud', audience] }))).ok, true);
});
test('rejects an expired token, including exp equal to now and exp missing', async () => {
  assert.equal((await verify(token({ exp: now() - 10 }))).reason, 'expired');
  assert.equal((await verify(token({ exp: now() }))).reason, 'expired');
  const noExp = token({ exp: undefined });
  assert.equal((await verify(noExp)).reason, 'expired');
});
test('rejects the wrong audience (string, array and empty)', async () => {
  assert.equal((await verify(token({ aud: 'wrong-audience-value' }))).reason, 'audience');
  assert.equal((await verify(token({ aud: ['a-1-1-1-1-1', 'b-2-2-2-2-2'] }))).reason, 'audience');
  assert.equal((await verify(token({ aud: [] }))).reason, 'audience');
});
test('rejects the wrong issuer, including a lookalike and a trailing path', async () => {
  assert.equal((await verify(token({ iss: 'https://attacker.example' }))).reason, 'issuer');
  assert.equal((await verify(token({ iss: 'https://lummet-test.cloudflareaccess.com.evil.example' }))).reason, 'issuer');
  assert.equal((await verify(token({ iss: `${issuer}/x` }))).reason, 'issuer');
});
test('rejects a missing token; Authorization Bearer is not an Access assertion', async () => {
  assert.equal((await verify(null)).reason, 'missing');
  const viaAuthorization = await verifyCloudflareAccessJwt(req(null, '/api/platform/saas/rollouts', { Authorization: `Bearer ${token()}` }), env(), { fetchImpl: jwksFetch() });
  assert.equal(viaAuthorization.reason, 'missing');
});
test('rejects malformed, oversized, wrong-algorithm and tampered tokens', async () => {
  assert.equal((await verify('not-a-jwt')).reason, 'malformed');
  assert.equal((await verify('a.b.c')).reason, 'malformed');
  assert.equal((await verify(`${'a'.repeat(9000)}.b.c`)).reason, 'malformed');
  const none = `${b64({ alg: 'none', typ: 'JWT', kid: 'test-key-1' })}.${b64({ iss: issuer, aud: audience, exp: now() + 300 })}.${Buffer.from('x').toString('base64url')}`;
  assert.equal((await verify(none)).reason, 'algorithm');
  const hs = token({}, { alg: 'HS256' });
  assert.equal((await verify(hs)).reason, 'algorithm');
  const noKid = token({}, { kid: undefined });
  assert.equal((await verify(noKid)).reason, 'algorithm');
  const [h, , s] = token().split('.');
  assert.equal((await verify(`${h}.${b64({ iss: issuer, aud: audience, exp: now() + 9999 })}.${s}`)).reason, 'signature');
});
test('a token signed by another key under the right kid is refused; claims are not trusted before the signature', async () => {
  const forged = token({ iss: 'https://attacker.example' }, {}, other.privateKey);
  assert.equal((await verify(forged)).reason, 'signature');
});
test('nbf and iat in the future are refused; small clock skew is tolerated', async () => {
  assert.equal((await verify(token({ nbf: now() + 3600 }))).reason, 'not_yet_valid');
  assert.equal((await verify(token({ iat: now() + 3600 }))).reason, 'issued_in_future');
  assert.equal((await verify(token({ nbf: now() + 5, iat: now() + 5 }))).ok, true);
  assert.equal((await verify(token({ nbf: 'soon' }))).reason, 'not_yet_valid');
});
test('configuration problems are reported, never accepted', async () => {
  for (const bad of [{ CF_ACCESS_ISSUER: '' }, { CF_ACCESS_ISSUER: 'http://lummet-test.cloudflareaccess.com' }, { CF_ACCESS_ISSUER: 'https://example.com' }, { CF_ACCESS_ISSUER: 'https://x.cloudflareaccess.com/path' }, { CF_ACCESS_AUD: '' }, { CF_ACCESS_AUD: 'short' }]) {
    assert.equal((await verify(token(), env(bad))).reason, 'configuration', JSON.stringify(bad));
  }
  assert.equal(normalizeAccessIssuer(`${issuer}/`), issuer);
});

// ---------- JWKS handling ----------
test('JWKS failures fail closed: HTTP error, thrown fetch, empty and malformed key sets', async () => {
  const cases = [async () => new Response('{}', { status: 503 }), async () => { throw new Error('network'); }, async () => new Response(JSON.stringify({ keys: [] }), { status: 200 }), async () => new Response('not json', { status: 200 }), async () => new Response(JSON.stringify({ keys: [{ kid: 'x', kty: 'EC' }] }), { status: 200 })];
  for (const fetchImpl of cases) { resetAccessJwksCache(); assert.equal((await verify(token(), env(), fetchImpl)).reason, 'jwks_unavailable'); }
});
test('the key set is cached; an unknown kid triggers at most one rate-limited refresh', async () => {
  const counter = { n: 0 };
  const f = jwksFetch([publicJwk], counter);
  assert.equal((await verify(token(), env(), f)).ok, true);
  assert.equal((await verify(token(), env(), f)).ok, true);
  assert.equal(counter.n, 1);
  const unknown = token({}, { kid: 'rotated-key' });
  assert.equal((await verify(unknown, env(), f, { nowMs: Date.now() + 1000 })).reason, 'key_not_found');
  assert.equal(counter.n, 1, 'refresh within 30s of the last fetch is suppressed');
  assert.equal((await verify(unknown, env(), f, { nowMs: Date.now() + 40000 })).reason, 'key_not_found');
  assert.equal(counter.n, 2);
});
test('a rotated key is picked up by the refresh', async () => {
  const f1 = jwksFetch([publicJwk]);
  assert.equal((await verify(token(), env(), f1)).ok, true);
  const rotated = jwkOf(other.publicKey, 'rotated-key');
  const f2 = jwksFetch([publicJwk, rotated]);
  const t = token({}, { kid: 'rotated-key' }, other.privateKey);
  assert.equal((await verify(t, env(), f2, { nowMs: Date.now() + 40000 })).ok, true);
});

// ---------- path scope and mode parsing ----------
test('only platform page and API paths are in scope', () => {
  for (const yes of ['/platform', '/platform/', '/platform/saas', '/api/platform', '/api/platform/saas/rollouts', '/Platform/saas', '/API/Platform/x', '//platform/saas', '/api//platform/x']) assert.equal(isPlatformAccessPath(yes), true, yes);
  for (const no of ['/api/health', '/platformer', '/api/platformer', '/api/customer/platform', '/api/ci/tenant-release/publish', '/api/billing/webhook/stripe', '/api/csp-report', '/api/auth/login', '/']) assert.equal(isPlatformAccessPath(no), false, no);
});
test('mode parsing: unset and blank are off, known values parse, anything else is invalid', () => {
  assert.equal(parsePlatformAccessMode({}), 'off');
  assert.equal(parsePlatformAccessMode({ PLATFORM_ACCESS_JWT_MODE: '  ' }), 'off');
  assert.equal(parsePlatformAccessMode({ PLATFORM_ACCESS_JWT_MODE: ' Enforce ' }), 'enforce');
  assert.equal(parsePlatformAccessMode({ PLATFORM_ACCESS_JWT_MODE: 'shadow' }), 'shadow');
  for (const bad of ['on', 'true', 'enforced', '1']) assert.equal(parsePlatformAccessMode({ PLATFORM_ACCESS_JWT_MODE: bad }), 'invalid', bad);
});

// ---------- the gate and the Worker (fails closed in production; flag off unchanged) ----------
async function call(path, e, headers = {}, method = 'GET') {
  const db = createTestDb(); applyMigrations(db);
  return worker.fetch(new Request(`https://cp.test${path}`, { method, headers }), { LUMMET_DB: db, ...e }, { waitUntil() {} });
}
const withFetch = async (impl, fn) => { const original = globalThis.fetch; globalThis.fetch = impl; try { return await fn(); } finally { globalThis.fetch = original; } };

test('production enforce: no JWT, bad JWT and wrong audience are refused with 403 before staff auth', async () => {
  const e = { ENVIRONMENT: 'production', ...env() };
  await withFetch(jwksFetch(), async () => {
    for (const headers of [{}, { 'Cf-Access-Jwt-Assertion': 'garbage' }, { 'Cf-Access-Jwt-Assertion': token({ aud: 'wrong-audience-value' }) }, { 'Cf-Access-Jwt-Assertion': token({ exp: now() - 5 }) }]) {
      for (const path of ['/api/platform/saas/rollouts', '/platform/saas']) {
        const response = await call(path, e, headers);
        assert.equal(response.status, 403, path);
        assert.equal((await response.json()).error, 'platform_access_required');
      }
    }
  });
});
test('production enforce fails closed with 503 when Access is misconfigured or the JWKS is unreachable', async () => {
  const withJwt = { 'Cf-Access-Jwt-Assertion': token() };
  const misconfigured = await call('/api/platform/saas/rollouts', { ENVIRONMENT: 'production', PLATFORM_ACCESS_JWT_MODE: 'enforce' }, withJwt);
  assert.equal(misconfigured.status, 503);
  assert.equal((await misconfigured.json()).error, 'platform_access_unavailable');
  await withFetch(async () => new Response('{}', { status: 500 }), async () => {
    const down = await call('/api/platform/saas/rollouts', { ENVIRONMENT: 'production', ...env() }, withJwt);
    assert.equal(down.status, 503);
    assert.equal((await down.json()).error, 'platform_access_unavailable');
  });
});
test('an invalid mode value fails closed in every environment (a typo must not disable the control)', async () => {
  for (const environment of ['production', 'staging', undefined]) {
    const response = await call('/api/platform/saas/rollouts', { ENVIRONMENT: environment, PLATFORM_ACCESS_JWT_MODE: 'enforced' });
    assert.equal(response.status, 503, String(environment));
  }
});
test('production enforce with a valid JWT passes through to the existing staff authentication (still 401 without a session)', async () => {
  await withFetch(jwksFetch(), async () => {
    const response = await call('/api/platform/saas/rollouts', { ENVIRONMENT: 'production', ...env() }, { 'Cf-Access-Jwt-Assertion': token() });
    assert.equal(response.status, 401);
    assert.notEqual((await response.clone().json()).error, 'platform_access_required');
  });
});
test('flag off or unset leaves behavior unchanged and never contacts Cloudflare', async () => {
  let fetched = 0;
  await withFetch(async () => { fetched++; return new Response('{}'); }, async () => {
    for (const mode of [{}, { PLATFORM_ACCESS_JWT_MODE: 'off' }, { PLATFORM_ACCESS_JWT_MODE: '' }]) {
      const api = await call('/api/platform/saas/rollouts', { ENVIRONMENT: 'production', ...mode });
      assert.equal(api.status, 401);
      assert.notEqual((await api.json()).error, 'platform_access_required');
      const page = await call('/platform/saas', { ENVIRONMENT: 'production', ...mode });
      assert.notEqual(page.status, 403);
      assert.notEqual(page.status, 503);
    }
  });
  assert.equal(fetched, 0);
});
test('shadow mode logs a reason code but never blocks, and never logs the token or claims', async () => {
  const warnings = []; const original = console.warn; console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const jwt = token();
    const [h, p, s] = jwt.split('.');
    await withFetch(jwksFetch(), async () => {
      const bad = await call('/api/platform/saas/rollouts', { ENVIRONMENT: 'production', ...env({ PLATFORM_ACCESS_JWT_MODE: 'shadow' }) }, { 'Cf-Access-Jwt-Assertion': `${h}.${p}.${Buffer.from('bad').toString('base64url')}` });
      assert.equal(bad.status, 401, 'shadow lets the request reach staff auth');
    });
    const logged = warnings.join('\n');
    assert.match(logged, /cloudflare_access_jwt_check/);
    assert.match(logged, /"reason":"signature"/);
    for (const secret of [p, s, 'staff-subject-123', 'staff@example.test']) assert.ok(!logged.includes(secret));
  } finally { console.warn = original; }
});
test('enforce does not touch other routes: health, CSP report, staff sign-in and the CI release API stay reachable', async () => {
  const e = { ENVIRONMENT: 'production', ...env() };
  const health = await call('/api/health', e);
  assert.equal(health.status, 200);
  for (const path of ['/api/auth/login', '/api/ci/tenant-release/publish', '/api/billing/webhook/stripe']) {
    const response = await call(path, e, {}, 'POST');
    assert.notEqual((await response.clone().json().catch(() => ({}))).error, 'platform_access_required', path);
  }
});
test('platformAccessGate returns null for non-platform paths without reading configuration', async () => {
  assert.equal(await platformAccessGate(req(null, '/api/health'), { PLATFORM_ACCESS_JWT_MODE: 'enforce' }, '/api/health'), null);
});

// ---------- production config-check ----------
test('production config-check: explicit valid mode is required; issuer and audience once the mode is not off', () => {
  const keys = (e) => configIssues({ ENVIRONMENT: 'production', ...e }).map((i) => i.key);
  assert.ok(keys({}).includes('PLATFORM_ACCESS_JWT_MODE'));
  assert.ok(keys({ PLATFORM_ACCESS_JWT_MODE: 'enforced' }).includes('PLATFORM_ACCESS_JWT_MODE'));
  assert.ok(!keys({ PLATFORM_ACCESS_JWT_MODE: 'off' }).includes('PLATFORM_ACCESS_JWT_MODE'));
  assert.ok(!keys({ PLATFORM_ACCESS_JWT_MODE: 'off' }).includes('CF_ACCESS_ISSUER/CF_ACCESS_AUD'));
  for (const mode of ['shadow', 'enforce']) {
    assert.ok(keys({ PLATFORM_ACCESS_JWT_MODE: mode }).includes('CF_ACCESS_ISSUER/CF_ACCESS_AUD'));
    assert.ok(keys({ PLATFORM_ACCESS_JWT_MODE: mode, CF_ACCESS_ISSUER: 'https://example.com', CF_ACCESS_AUD: audience }).includes('CF_ACCESS_ISSUER/CF_ACCESS_AUD'));
    assert.ok(!keys({ PLATFORM_ACCESS_JWT_MODE: mode, CF_ACCESS_ISSUER: issuer, CF_ACCESS_AUD: audience }).some((k) => k.startsWith('CF_ACCESS') || k === 'PLATFORM_ACCESS_JWT_MODE'));
  }
  assert.deepEqual(configIssues({ ENVIRONMENT: 'staging' }), []);
});

// ---------- config as code ----------
test('policy config is valid, covers exactly the platform routes and keeps machine callers out', () => {
  const config = loadConfig();
  assert.deepEqual(validateConfig(config), []);
  assert.deepEqual(config.protectedPaths, ['/platform/*', '/api/platform/*']);
  assert.equal(config.denyByDefault, true);
  assert.ok(openPlaceholders(config).length >= 6, 'owner values stay as open placeholders');
});
test('policy validator refuses broad paths, missing MFA and removed machine-caller exclusions', () => {
  const base = () => structuredClone(loadConfig());
  const bad = (mutate) => { const c = base(); mutate(c); return validateConfig(c); };
  assert.ok(bad((c) => { c.protectedPaths = ['/*']; }).length);
  assert.ok(bad((c) => { c.protectedPaths = ['/platform/*', '/api/*']; }).length);
  assert.ok(bad((c) => { c.protectedPaths.push('/api/ci/*'); }).length);
  assert.ok(bad((c) => { c.denyByDefault = false; }).length);
  assert.ok(bad((c) => { c.allowPolicies[0].requireMfaAtIdp = false; }).length);
  assert.ok(bad((c) => { c.allowPolicies[0].decision = 'bypass'; }).length);
  assert.ok(bad((c) => { c.neverProtect = c.neverProtect.filter((p) => p !== '/api/ci/'); }).length);
  assert.equal(overlaps('/api/platform/*', '/api/ci/'), false);
  assert.equal(overlaps('/api/*', '/api/ci/'), true);
});
test('check script is offline: lists placeholders, never mutates, --strict fails while any remain', async () => {
  const out = []; const err = [];
  const io = { log: (m) => out.push(m), error: (m) => err.push(m) };
  assert.equal(await accessConfigMain([], {}, io), 0);
  const report = JSON.parse(out[0]);
  assert.equal(report.mutates, false); assert.equal(report.callsCloudflare, false);
  assert.ok(report.openPlaceholders.length > 0 && report.applyBlockedBy.length === 1);
  assert.equal(await accessConfigMain(['--strict'], {}, io), 1);
  assert.ok(!JSON.stringify(report).includes('CF_API_TOKEN'));
});
