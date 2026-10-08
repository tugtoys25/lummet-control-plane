// SSO email-domain ownership (closes address squatting through a self-hosted IdP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import * as d from '../worker/sso-domains.js';
import * as sso from '../worker/sso.js';

function env() { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production' }; }
const ctx = { waitUntil() {} };
let ipn = 1;
async function call(e, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (ipn++ % 250 + 1) }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
const signup = async (e, email) => { const r = await call(e, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'O ' + email } }); return { org: r.json.organizationId, cookie: r.cookie }; };

test('domain names are validated and normalized', () => {
  assert.equal(d.normalizeDomain(' @Corp.Example. '), 'corp.example');
  for (const bad of ['', 'localhost', 'a', '10.0.0.1', 'bad_domain.com', '-x.com', 'x.c', 'http://x.com', 'a b.com']) assert.equal(d.normalizeDomain(bad), null, bad);
});

test('adding returns the DNS record to publish; verification needs that exact TXT value', async () => {
  const e = env(); const { org } = await signup(e, 'a@example.com');
  const added = await d.addSsoDomain(e, org, 'Corp.Example');
  assert.equal(added.ok, true); assert.equal(added.txtHost, '_lummet-sso.corp.example'); assert.match(added.txtValue, /^lummet-sso-verification=[0-9a-f]{40}$/);
  assert.equal((await d.addSsoDomain(e, org, 'corp.example')).error, 'domain_already_added');
  assert.equal((await d.addSsoDomain(e, org, 'localhost')).error, 'invalid_domain');

  const seen = [];
  const miss = await d.verifySsoDomain(e, org, added.id, { lookup: async (h) => { seen.push(h); return ['lummet-sso-verification=wrong', 'v=spf1 -all']; } });
  assert.deepEqual(miss, { ok: true, verified: false }); assert.deepEqual(seen, ['_lummet-sso.corp.example']);
  assert.equal(await d.emailDomainAllowed(e, org, 'x@corp.example'), false, 'pending is not enough');
  assert.equal((await d.verifySsoDomain(e, org, added.id, { lookup: async () => [added.txtValue] })).verified, true);
  assert.equal(await d.emailDomainAllowed(e, org, 'someone@CORP.example'), true);
  assert.equal(await d.emailDomainAllowed(e, org, 'someone@sub.corp.example'), false, 'subdomains are separate; add them explicitly');
  assert.equal((await d.listSsoDomains(e, org))[0].txtValue, undefined, 'the token is not shown once verified');
});

test('only one organization can hold a verified domain, and a pending claim does not block the real owner', async () => {
  const e = env(); const a = await signup(e, 'a@example.com'); const b = await signup(e, 'b@example.com');
  const squatter = await d.addSsoDomain(e, a.org, 'victim.example');       // anyone can ADD, nobody can verify without the DNS record
  const owner = await d.addSsoDomain(e, b.org, 'victim.example');
  assert.equal(owner.ok, true, 'a pending claim by someone else does not block the real owner');
  assert.equal((await d.verifySsoDomain(e, b.org, owner.id, { lookup: async () => [owner.txtValue] })).verified, true);
  assert.equal((await d.verifySsoDomain(e, a.org, squatter.id, { lookup: async () => [] })).verified, false);
  assert.equal((await d.addSsoDomain(e, (await signup(e, 'c@example.com')).org, 'victim.example')).error, 'domain_claimed_by_another_organization');
  assert.equal((await d.verifySsoDomain(e, a.org, squatter.id, { lookup: async () => [squatter.txtValue] })).error, 'domain_claimed_by_another_organization', 'even a TXT match cannot take a held domain');
  assert.equal(await d.emailDomainAllowed(e, a.org, 'x@victim.example'), false);
});

test('verification is scoped to the caller\'s organization', async () => {
  const e = env(); const a = await signup(e, 'a@example.com'); const b = await signup(e, 'b@example.com');
  const added = await d.addSsoDomain(e, a.org, 'mine.example');
  assert.equal((await d.verifySsoDomain(e, b.org, added.id, { lookup: async () => [added.txtValue] })).status, 404);
  assert.equal((await d.removeSsoDomain(e, b.org, added.id)).status, 404);
  assert.equal((await d.removeSsoDomain(e, a.org, added.id)).ok, true);
});

test('SSO sign-in is refused for an email outside the verified domains, before any account is touched', async () => {
  const e = env(); const { org } = await signup(e, 'owner@example.com');
  await sso.configureSso(e, org, { issuer: 'https://idp.example.test', clientId: 'c', clientSecret: 's', authorizationEndpoint: 'https://idp.example.test/authorize', tokenEndpoint: 'https://idp.example.test/token', jwksUri: 'https://idp.example.test/jwks' });
  // the attacker adds, but cannot verify, the victim's domain
  await d.addSsoDomain(e, org, 'gmail.com');
  assert.equal(await d.emailDomainAllowed(e, org, 'victim@gmail.com'), false);
});

test('routes: admins manage domains over the API; others and anonymous callers cannot; each step is audited', async () => {
  const e = env(); const owner = await signup(e, 'owner@example.com'); const other = await signup(e, 'other@example.com');
  const url = `/api/organizations/${owner.org}/sso/domains`;
  assert.equal((await call(e, 'GET', url)).status, 401);
  assert.equal((await call(e, 'POST', url, { cookie: other.cookie, body: { domain: 'x.example' } })).status, 403);
  const added = await call(e, 'POST', url, { cookie: owner.cookie, body: { domain: 'corp.example' } });
  assert.equal(added.status, 200); assert.match(added.json.txtValue, /^lummet-sso-verification=/);
  assert.equal((await call(e, 'POST', url, { cookie: owner.cookie, body: { domain: 'bad domain' } })).status, 422);
  const listed = await call(e, 'GET', url, { cookie: owner.cookie });
  assert.equal(listed.json.data.length, 1); assert.equal(listed.json.data[0].status, 'pending');
  const verify = await call(e, 'POST', `${url}/${added.json.id}/verify`, { cookie: owner.cookie });
  assert.equal(verify.status, 200); assert.equal(verify.json.verified, false);       // the real DNS lookup finds no such record
  assert.equal((await call(e, 'DELETE', `${url}/${added.json.id}`, { cookie: owner.cookie })).status, 200);
  const n = await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource = 'organization_sso' AND action LIKE '%_domain'`).first();
  assert.ok(n.n >= 3);
});
