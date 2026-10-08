// Route-level: deploy-latest and rollback, end to end, with a fake
// infrastructure provider (previously only auth/404 paths were covered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import { __setInfraProviderForTests } from '../worker/deployments.js';
import { createProvisioningService } from '../worker/provisioning.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as tenantTemplate from '../worker/tenant-template.js';

let ipn = 1;
function fakeR2() {
  const m = new Map();
  return { async put(k, v) { m.set(k, String(v)); }, async get(k) { return m.has(k) ? { text: async () => m.get(k) } : null; } };
}
function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
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
async function setup(env, ctx, infra, email) {
  const s = await call(env, ctx, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } });
  assert.equal(s.status, 200, s.text);
  await plans.startTrialSubscription(env, s.json.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: s.json.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: s.json.userId });
  assert.ok(site.ok, JSON.stringify(site));
  const prov = createProvisioningService(infra);
  const start = await prov.startProvisioning(env, site.siteId);
  await prov.runJob(env, start.jobId);
  return { orgId: s.json.organizationId, cookie: s.cookie, siteId: site.siteId };
}
const release = (env, version, code) => tenantTemplate.publishRelease(env, { version, scriptContent: code, migrations: [] });
const uploads = (infra) => infra._calls.filter((c) => c.method === 'uploadWorkerScript').map((c) => c.scriptContent);

test('deploy-latest deploys the published release, then rollback restores the stored earlier release', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'deploy@example.com');
  const base = `/api/organizations/${a.orgId}/sites/${a.siteId}/deployments`;

  // No release published yet -> refuses, deploys nothing.
  const none = await call(env, ctx, 'POST', base + '/latest', { cookie: a.cookie });
  assert.equal(none.status, 404);
  assert.equal(uploads(infra).length, 0);

  const r1 = await release(env, '1.0.0', 'export default {/*v1*/}');
  assert.ok(r1.ok, JSON.stringify(r1));
  const d1 = await call(env, ctx, 'POST', base + '/latest', { cookie: a.cookie });
  assert.equal(d1.status, 202, d1.text);
  await ctx.settle();
  assert.deepEqual(uploads(infra), ['export default {/*v1*/}']);
  let site = await sites.getSite(env, a.siteId);
  assert.equal(site.status, 'active');
  assert.equal(site.app_version, '1.0.0');

  const r2 = await release(env, '2.0.0', 'export default {/*v2*/}');
  assert.ok(r2.ok);
  await tenantTemplate.activateRelease(env, '2.0.0');
  const d2 = await call(env, ctx, 'POST', base + '/latest', { cookie: a.cookie });
  assert.equal(d2.status, 202, d2.text);
  await ctx.settle();
  site = await sites.getSite(env, a.siteId);
  assert.equal(site.app_version, '2.0.0');

  // Roll back to the first deployment; body script must be ignored.
  const rb = await call(env, ctx, 'POST', `${base}/${d1.json.deploymentId}/rollback`, { cookie: a.cookie, body: { scriptContent: 'EVIL' } });
  assert.equal(rb.status, 202, rb.text);
  await ctx.settle();
  const up = uploads(infra);
  assert.equal(up[up.length - 1], 'export default {/*v1*/}');
  assert.ok(!up.includes('EVIL'));
  site = await sites.getSite(env, a.siteId);
  assert.equal(site.app_version, '1.0.0');

  const audit = (await env.LUMMET_DB.prepare(`SELECT action, success FROM lummet_audit_logs WHERE resource = 'deployment' ORDER BY rowid`).all()).results;
  assert.deepEqual(audit.map((x) => `${x.action}:${x.success}`).slice(-3), ['create:1', 'create:1', 'rollback:1']);
});

test('another organization cannot deploy to or roll back this site', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'owner@example.com');
  const b = await call(env, ctx, 'POST', '/api/customer/signup', { body: { email: 'intruder@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Other', displayName: 'X' } });
  await release(env, '1.0.0', 'export default {}');
  const path = `/api/organizations/${b.json.organizationId}/sites/${a.siteId}/deployments/latest`;
  const r = await call(env, ctx, 'POST', path, { cookie: b.cookie });
  assert.equal(r.status, 404);
  await ctx.settle();
  assert.equal(uploads(infra).length, 0);
});
