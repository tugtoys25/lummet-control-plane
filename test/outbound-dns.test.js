// v7E: customer-supplied hostnames are resolved and every address checked (DNS rebinding defence in depth).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { isBlockedAddress, checkOutboundUrlResolved, dnsCheckEnabled, clearResolveCache } from '../worker/url-safety.js';
import { lookupAddresses } from '../worker/dns-doh.js';
import * as webhooks from '../worker/webhooks.js';
import * as sso from '../worker/sso.js';
import * as customerAuth from '../worker/customer-auth.js';

beforeEach(() => clearResolveCache());

const resolverFor = (map, calls = []) => async (host) => { calls.push(host); const v = map[host]; return v === 'fail' ? { ok: false } : { ok: true, addresses: v || [] }; };
const ON = (map, calls) => ({ OUTBOUND_DNS_CHECK: 'on', OUTBOUND_DNS_RESOLVER: resolverFor(map, calls) });

test('isBlockedAddress: private, loopback, metadata, mapped, NAT64, multicast and documentation ranges; public stays allowed', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fd00::1', 'fc00::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '64:ff9b::10.0.0.1', 'not-an-ip', '[::1]']) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) assert.equal(isBlockedAddress(ip), false, ip);
});

test('dnsCheckEnabled: on in production, off elsewhere, and the flag overrides either way', () => {
  assert.equal(dnsCheckEnabled({ ENVIRONMENT: 'production' }), true);
  assert.equal(dnsCheckEnabled({}), false);
  assert.equal(dnsCheckEnabled({ ENVIRONMENT: 'staging' }), false);
  assert.equal(dnsCheckEnabled({ ENVIRONMENT: 'production', OUTBOUND_DNS_CHECK: 'off' }), false);
  assert.equal(dnsCheckEnabled({ OUTBOUND_DNS_CHECK: 'on' }), true);
});

test('checkOutboundUrlResolved: a public name that resolves to a private address is refused', async () => {
  const env = ON({ 'evil.example.com': ['93.184.216.34', '10.0.0.5'], 'rebind.example.com': ['127.0.0.1'], 'v6.example.com': ['fd00::1'], 'fine.example.com': ['93.184.216.34', '2606:4700:4700::1111'] });
  assert.equal((await checkOutboundUrlResolved('https://fine.example.com/h', env)).ok, true);
  for (const h of ['evil', 'rebind', 'v6']) {
    const r = await checkOutboundUrlResolved(`https://${h}.example.com/h`, env);
    assert.equal(r.ok, false, h); assert.equal(r.error, 'host_resolves_to_blocked_address');
  }
});

test('checkOutboundUrlResolved: names with no addresses, failed lookups, and text-level rejections', async () => {
  const env = ON({ 'gone.example.com': [], 'down.example.com': 'fail' });
  assert.equal((await checkOutboundUrlResolved('https://gone.example.com/', env)).error, 'host_does_not_resolve');
  assert.equal((await checkOutboundUrlResolved('https://down.example.com/', env)).error, 'host_lookup_failed');
  assert.equal((await checkOutboundUrlResolved('http://fine.example.com/', env)).error, 'url_must_be_https');
  assert.equal((await checkOutboundUrlResolved('https://localhost/', env)).error, 'url_host_not_allowed');
});

test('checkOutboundUrlResolved: IP literals need no lookup; the lookup is cached briefly; a failed lookup is not cached', async () => {
  const calls = []; const map = { 'a.example.com': ['93.184.216.34'], 'flaky.example.com': 'fail' };
  const env = ON(map, calls);
  assert.equal((await checkOutboundUrlResolved('https://93.184.216.34/x', env)).ok, true);
  assert.equal((await checkOutboundUrlResolved('https://10.0.0.1/x', env)).ok, false);
  assert.deepEqual(calls, [], 'no lookups for literals');
  await checkOutboundUrlResolved('https://a.example.com/1', env); await checkOutboundUrlResolved('https://a.example.com/2', env);
  assert.equal(calls.filter((h) => h === 'a.example.com').length, 1, 'one lookup serves both');
  await checkOutboundUrlResolved('https://flaky.example.com/', env);
  map['flaky.example.com'] = ['93.184.216.34'];
  assert.equal((await checkOutboundUrlResolved('https://flaky.example.com/', env)).ok, true, 'recovers on the next call');
});

test('checkOutboundUrlResolved does no lookup when the check is off (tests, staging, OUTBOUND_DNS_CHECK=off)', async () => {
  const calls = []; const resolver = resolverFor({ 'x.example.com': ['10.0.0.1'] }, calls);
  assert.equal((await checkOutboundUrlResolved('https://x.example.com/', { OUTBOUND_DNS_RESOLVER: resolver })).ok, true);
  assert.equal((await checkOutboundUrlResolved('https://x.example.com/', { ENVIRONMENT: 'production', OUTBOUND_DNS_CHECK: 'off', OUTBOUND_DNS_RESOLVER: resolver })).ok, true);
  assert.deepEqual(calls, []);
});

test('lookupAddresses reads A and AAAA answers, ignores CNAMEs, and reports a failed lookup as not ok', async () => {
  const answers = { A: [{ type: 5, data: 'edge.example.net.' }, { type: 1, data: '93.184.216.34' }], AAAA: [{ type: 28, data: '2606:4700::1' }] };
  const fake = async (url) => { const t = new URL(url).searchParams.get('type'); return { ok: true, json: async () => ({ Answer: answers[t] }) }; };
  assert.deepEqual(await lookupAddresses('x.example.com', fake), { ok: true, addresses: ['93.184.216.34', '2606:4700::1'] });
  assert.deepEqual(await lookupAddresses('x.example.com', async () => ({ ok: true, json: async () => ({ Status: 3 }) })), { ok: true, addresses: [] });
  assert.deepEqual(await lookupAddresses('x.example.com', async () => ({ ok: false, status: 503 })), { ok: false });
  assert.deepEqual(await lookupAddresses('x.example.com', async () => { throw new Error('network'); }), { ok: false });
});

// ---- webhooks and SSO use it ----
function setup(map, calls) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ...ON(map, calls) };
}
const signup = (env, email) => customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.9' } }, env);

test('webhooks: a URL whose host resolves privately cannot be saved', async () => {
  const env = setup({ 'bad.example.com': ['169.254.169.254'], 'good.example.com': ['93.184.216.34'] });
  const org = (await signup(env, 'w1@example.com')).organizationId;
  const bad = await webhooks.createWebhook(env, { organizationId: org, url: 'https://bad.example.com/h', eventTypes: ['site.deployed'] });
  assert.equal(bad.ok, false); assert.equal(bad.status, 422); assert.equal(bad.error, 'host_resolves_to_blocked_address');
  assert.equal((await webhooks.createWebhook(env, { organizationId: org, url: 'https://good.example.com/h', eventTypes: ['site.deployed'] })).ok, true);
});

test('webhooks: DNS that changes after saving (rebinding) stops every later delivery attempt, for good', async () => {
  const map = { 'hook.example.com': ['93.184.216.34'] };
  const env = setup(map);
  const org = (await signup(env, 'w2@example.com')).organizationId;
  assert.equal((await webhooks.createWebhook(env, { organizationId: org, url: 'https://hook.example.com/h', eventTypes: ['site.deployed'] })).ok, true);
  map['hook.example.com'] = ['10.1.2.3'];       // the attacker flips the record
  clearResolveCache();
  const sent = []; const real = globalThis.fetch; globalThis.fetch = async (u) => { sent.push(String(u)); return new Response('', { status: 200 }); };
  try { await webhooks.dispatchEvent(env, org, 'site.deployed', { a: 1 }); } finally { globalThis.fetch = real; }
  assert.deepEqual(sent, [], 'nothing was sent to the rebound address');
  const d = await env.LUMMET_DB.prepare(`SELECT status, error_message FROM webhook_deliveries`).first();
  assert.equal(d.status, 'dead'); assert.match(d.error_message, /url_host_not_allowed/);
});

test('webhooks: when the DNS lookup itself fails the delivery is retried later, not killed', async () => {
  const map = { 'hook.example.com': ['93.184.216.34'] };
  const env = setup(map);
  const org = (await signup(env, 'w3@example.com')).organizationId;
  await webhooks.createWebhook(env, { organizationId: org, url: 'https://hook.example.com/h', eventTypes: ['site.deployed'] });
  map['hook.example.com'] = 'fail'; clearResolveCache();
  const real = globalThis.fetch; globalThis.fetch = async () => new Response('', { status: 200 });
  try { await webhooks.dispatchEvent(env, org, 'site.deployed', {}); } finally { globalThis.fetch = real; }
  const d = await env.LUMMET_DB.prepare(`SELECT status, error_message, attempt, last_attempt_at FROM webhook_deliveries`).first();
  assert.equal(d.status, 'failed'); assert.match(d.error_message, /host_lookup_failed/); assert.equal(d.attempt, 1); assert.ok(d.last_attempt_at);
});

test('SSO: token and key-set endpoints are resolved; the browser-side authorization endpoint is only text-checked', async () => {
  const env = setup({ 'idp.example.com': ['93.184.216.34'], 'internal-idp.example.com': ['10.0.0.9'] });
  const org = (await signup(env, 's1@example.com')).organizationId;
  const base = { issuer: 'https://idp.example.com', clientId: 'c', clientSecret: 's', authorizationEndpoint: 'https://idp.example.com/auth', tokenEndpoint: 'https://idp.example.com/token', jwksUri: 'https://idp.example.com/jwks', defaultRole: 'viewer' };
  const bad = await sso.configureSso(env, org, { ...base, tokenEndpoint: 'https://internal-idp.example.com/token' });
  assert.equal(bad.ok, false); assert.equal(bad.error, 'token_endpoint_host_resolves_to_blocked_address');
  const badJwks = await sso.configureSso(env, org, { ...base, jwksUri: 'https://internal-idp.example.com/jwks' });
  assert.equal(badJwks.error, 'jwks_uri_host_resolves_to_blocked_address');
  const authOnly = await sso.configureSso(env, org, { ...base, authorizationEndpoint: 'https://internal-idp.example.com/auth' });
  assert.equal(authOnly.ok, true, 'the browser follows that URL, not this server');
});

test('lookupTXT: an unreachable resolver means "no record yet", not an exception (verification must not 500)', async () => {
  const { lookupTXT } = await import('../worker/dns-doh.js');
  const real = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    assert.deepEqual(await lookupTXT('_lummet.example.com'), []);
    globalThis.fetch = async () => new Response('nope', { status: 503 });
    assert.deepEqual(await lookupTXT('_lummet.example.com'), []);
    globalThis.fetch = async () => new Response(JSON.stringify({ Answer: [{ type: 16, data: '"lummet-verify=abc"' }, { type: 5, data: 'x.' }] }), { status: 200 });
    assert.deepEqual(await lookupTXT('_lummet.example.com'), ['lummet-verify=abc']);
  } finally { globalThis.fetch = real; }
});
