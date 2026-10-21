// Route level: single subdomains end to end through the customer API and the Domains page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeDnsResolver } from './support/fake-dns-resolver.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import { __setZoneProvidersForTests } from '../worker/zone-domains.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';

let ipn = 1;
function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), PLATFORM_DOMAIN_SUFFIX: 'sites.lummet.test' };
}
function makeCtx() {
  const pending = [];
  return { pending, waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); }, async settle() { await Promise.all(pending.splice(0)); } };
}
async function call(env, ctx, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${ipn++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function setup(env, ctx, email) {
  const s = await call(env, ctx, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } });
  assert.equal(s.status, 200, s.text);
  await plans.startTrialSubscription(env, s.json.organizationId, 'plan_agency_30');
  const site = await sites.createSite(env, { organizationId: s.json.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: s.json.userId });
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(site.siteId).run();
  return { orgId: s.json.organizationId, cookie: s.cookie, siteId: site.siteId };
}

test('subdomain API: add, list, check (TXT -> live), page render, remove; cross-organization access is 404', async (t) => {
  const infra = createFakeInfraProvider(); const dns = createFakeDnsResolver();
  __setZoneProvidersForTests({ infra, dns }); t.after(() => __setZoneProvidersForTests());
  const env = makeEnv(); const ctx = makeCtx();
  const a = await setup(env, ctx, 'sub-routes@example.com');
  const base = `/api/organizations/${a.orgId}`;

  const apex = await call(env, ctx, 'POST', `${base}/sites/${a.siteId}/subdomains`, { cookie: a.cookie, body: { hostname: 'example.com' } });
  assert.equal(apex.status, 422);
  assert.equal(apex.json.error, 'apex_needs_nameservers');

  const add = await call(env, ctx, 'POST', `${base}/sites/${a.siteId}/subdomains`, { cookie: a.cookie, body: { hostname: 'shop.example.com' } });
  assert.equal(add.status, 201, add.text);
  assert.equal(add.json.mode, 'cname');
  const txt = add.json.instructions.find((i) => i.type === 'TXT');

  const list = await call(env, ctx, 'GET', `${base}/sites/${a.siteId}/subdomains`, { cookie: a.cookie });
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].progress.phase, 'awaiting_dns');

  const page = await call(env, ctx, 'GET', '/app/domains', { cookie: a.cookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('shop.example.com') && page.text.includes('Add these DNS records'));
  assert.ok(page.text.includes('One subdomain'));

  // Legacy routes must not touch it.
  const legacy = await call(env, ctx, 'POST', `${base}/domains/${add.json.domainId}/request-ssl`, { cookie: a.cookie });
  assert.equal(legacy.status, 409);
  assert.equal(infra._calls.filter((c) => c.method === 'createCustomHostname').length, 0);

  dns._setTXTRecords('_lummet-verify.shop.example.com', [txt.value]);
  const check = await call(env, ctx, 'POST', `${base}/subdomains/${add.json.domainId}/check`, { cookie: a.cookie });
  assert.equal(check.status, 200, check.text);
  assert.equal(check.json.domain.status, 'ssl_pending');

  const read = await call(env, ctx, 'GET', `${base}/subdomains/${add.json.domainId}`, { cookie: a.cookie });
  assert.equal(read.json.progress.phase, 'issuing_certificates');

  const b = await setup(env, ctx, 'sub-routes-b@example.com');
  const cross = await call(env, ctx, 'GET', `/api/organizations/${b.orgId}/subdomains/${add.json.domainId}`, { cookie: b.cookie });
  assert.equal(cross.status, 404);
  const crossCheck = await call(env, ctx, 'POST', `/api/organizations/${b.orgId}/subdomains/${add.json.domainId}/check`, { cookie: b.cookie });
  assert.equal(crossCheck.status, 404);
  const crossAdd = await call(env, ctx, 'POST', `/api/organizations/${b.orgId}/sites/${a.siteId}/subdomains`, { cookie: b.cookie, body: { hostname: 'x.example.org' } });
  assert.equal(crossAdd.status, 404);

  const del = await call(env, ctx, 'DELETE', `${base}/domains/${add.json.domainId}`, { cookie: a.cookie });
  assert.equal(del.status, 200, del.text);
  assert.ok(infra._calls.some((c) => c.method === 'deleteWorkerRoute'));
  assert.ok(infra._calls.some((c) => c.method === 'deleteCustomHostname'));
  const after = await call(env, ctx, 'GET', `${base}/sites/${a.siteId}/subdomains`, { cookie: a.cookie });
  assert.deepEqual(after.json.data, []);
});

test('the maintenance tick advances waiting subdomains', async (t) => {
  const infra = createFakeInfraProvider(); const dns = createFakeDnsResolver();
  __setZoneProvidersForTests({ infra, dns }); t.after(() => __setZoneProvidersForTests());
  const env = { ...makeEnv(), ALERT_CHECK_TOKEN: 'tick-token' }; const ctx = makeCtx();
  const a = await setup(env, ctx, 'tick@example.com');
  const add = await call(env, ctx, 'POST', `/api/organizations/${a.orgId}/sites/${a.siteId}/subdomains`, { cookie: a.cookie, body: { hostname: 'shop.example.com' } });
  dns._setTXTRecords('_lummet-verify.shop.example.com', [add.json.instructions.find((i) => i.type === 'TXT').value]);
  await env.LUMMET_DB.prepare(`UPDATE domains SET next_check_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(add.json.domainId).run();
  const res = await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method: 'POST', headers: { Authorization: 'Bearer tick-token', 'CF-Connecting-IP': '198.51.100.9' } }), env, ctx);
  assert.equal(res.status, 200);
  await ctx.settle();
  const row = await env.LUMMET_DB.prepare(`SELECT status FROM domains WHERE id = ?`).bind(add.json.domainId).first();
  assert.equal(row.status, 'ssl_pending');
});
