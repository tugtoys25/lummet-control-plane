// Platform domains (c): hosts, route zones, reserved names, CNAME target, config check. Real code over an in-memory D1 and the fake infra.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import { createProvisioningService, computeResourceNames } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as pd from '../worker/platform-domains.js';
import * as repo from '../worker/repositories/platform-domains.js';
import { reservedDomains, normalizeDomainInput, normalizeSubdomainInput, cnameTargetFor, resolveCnameTarget } from '../worker/zone-domains.js';
import { platformDomainIssues } from '../worker/config-check.js';

const ctx = { waitUntil() {} };
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default', PORTAL_BASE_URL: 'https://portal.lummet.com', ...extra };
}
let seq = 0;
async function newSite(env, domainId) {
  const email = `pd${++seq}@example.com`;
  const s = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' }) }), env, ctx);
  const sj = await s.json();
  const user = await env.LUMMET_DB.prepare(`SELECT id FROM customer_users WHERE email = ?`).bind(email).first();
  await plans.startTrialSubscription(env, sj.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: sj.organizationId, name: 'Routed', productId: 'prod_casino_news', actorUserId: user.id });
  if (domainId) await repo.setSiteDomain(env, site.siteId, domainId);   // createSite stores this itself in commit (e)
  return site.siteId;
}
async function provisionAndDeploy(env, infra, siteId) {
  const prov = createProvisioningService(infra);
  const start = await prov.startProvisioning(env, siteId);
  await prov.runJob(env, start.jobId);
  const svc = createDeploymentService(infra);
  const d = await svc.startDeployment(env, { siteId, version: '1.0.0', migrations: [], scriptContent: 'export default {}', actorType: 'system' });
  return svc.runJob(env, d.jobId);
}
const row = (env, id) => env.LUMMET_DB.prepare(`SELECT primary_domain, platform_domain_id FROM sites WHERE id = ?`).bind(id).first();

test('computeResourceNames: per-domain host, env fallback when none given', () => {
  const env = { PLATFORM_DOMAIN_SUFFIX: 'lummet.app' };
  assert.equal(computeResourceNames({ slug: 'a' }, env).host, 'a.lummet.app');
  assert.equal(computeResourceNames({ slug: 'a' }, env, { hostname: 'genteelisms.com' }).host, 'a.genteelisms.com');
  assert.equal(computeResourceNames({ slug: 'a' }, {}).host, 'a.sites.lummet.app');
});

test('a site with no platform domain deploys on the default domain and default zone (as before)', async () => {
  const env = makeEnv(); const infra = createFakeInfraProvider();
  const siteId = await newSite(env);
  assert.ok((await provisionAndDeploy(env, infra, siteId)).ok);
  const r = infra._calls.find((c) => c.method === 'ensureWorkerRoute');
  assert.match(r.pattern, /\.lummet\.app\/\*$/);
  assert.equal(r.zoneId, 'zone-default');
});

test('a site on a second domain gets that host and that zone, recorded on the route row', async () => {
  const env = makeEnv(); const infra = createFakeInfraProvider();
  await pd.ensureBootstrap(env);
  await repo.insert(env, { id: 'x', hostname: 'genteelisms.com', label: 'G', cfZoneId: 'zone-x', status: 'active' });
  const siteId = await newSite(env, 'x');
  assert.ok((await provisionAndDeploy(env, infra, siteId)).ok);
  const s = await row(env, siteId);
  assert.match(s.primary_domain, /\.genteelisms\.com$/);
  const r = infra._calls.find((c) => c.method === 'ensureWorkerRoute');
  assert.equal(r.pattern, `${s.primary_domain}/*`);
  assert.equal(r.zoneId, 'zone-x');
  const rec = await env.LUMMET_DB.prepare(`SELECT metadata FROM site_resources WHERE site_id = ? AND resource_type = 'route'`).bind(siteId).first();
  assert.deepEqual(JSON.parse(rec.metadata), { zoneId: 'zone-x' });
});

test('reservedDomains covers every platform domain; customers cannot connect any of them', async () => {
  const env = makeEnv();
  await pd.ensureBootstrap(env);
  await repo.insert(env, { id: 'x', hostname: 'genteelisms.com', label: 'G', cfZoneId: 'zone-x', status: 'disabled' });
  const names = await pd.reservedHostnames(env);
  assert.ok(reservedDomains(env, names).includes('genteelisms.com'));
  for (const host of ['genteelisms.com', 'shop.genteelisms.com', 'lummet.app']) {
    assert.equal(normalizeDomainInput(host, env, names).error, 'domain_reserved', host);
    assert.equal(normalizeSubdomainInput(`shop.${host}`, env, names).error, 'domain_reserved', host);
  }
  assert.equal(normalizeDomainInput('example.org', env, names).ok, true);
  // without the list (old call shape) a second domain is not known: that is why the service passes it
  assert.equal(normalizeDomainInput('genteelisms.com', env).ok, true);
});

test('cname target is unchanged for existing setups; a row with cname_target wins', async () => {
  const env = makeEnv();
  assert.equal(cnameTargetFor(env), 'customers.lummet.app');
  assert.equal(await resolveCnameTarget(env), 'customers.lummet.app');
  await repo.insert(env, { id: 'x', hostname: 'genteelisms.com', label: 'G', cfZoneId: 'zone-x', status: 'active', cnameTarget: 'edge.genteelisms.com' });
  assert.equal(await resolveCnameTarget(env), 'edge.genteelisms.com');
  assert.equal(await resolveCnameTarget({ ...env, PLATFORM_CNAME_TARGET: 'Fixed.Example.com.' }), 'fixed.example.com');
});

test('config check: default present, zone ids present, no domain equals the portal host', async () => {
  const env = makeEnv();
  assert.deepEqual(await platformDomainIssues(env), []);
  await repo.insert(env, { id: 'z', hostname: 'nozone.com', label: 'N', status: 'active' });
  await repo.insert(env, { id: 'p', hostname: 'portal.lummet.com', label: 'P', cfZoneId: 'zp', status: 'pending' });
  const keys = (await platformDomainIssues(env)).map((i) => i.key);
  assert.deepEqual(keys, ['platform_domains.nozone.com', 'platform_domains.portal.lummet.com']);
  const empty = makeEnv({ PLATFORM_DOMAIN_SUFFIX: undefined, CF_ZONE_ID: undefined });
  await repo.insert(empty, { id: 'd', hostname: 'off.com', label: 'D', status: 'disabled' });
  assert.ok((await platformDomainIssues(empty)).some((i) => i.key === 'platform_domains.default'));
});
