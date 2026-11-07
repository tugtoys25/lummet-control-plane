// Template lines (2.7.1): a second application (brokerage = luminousagents) released and provisioned beside the casino one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService, __setInfraProviderForTests } from '../worker/deployments.js';
import * as jobRunner from '../worker/job-runner.js';
import * as rollouts from '../worker/rollouts.js';
import * as template from '../worker/tenant-template.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import { buildSiteBindings } from '../worker/site-bindings.js';
import { encryptSecret } from '../worker/crypto.js';
import { tenantAssetsConfig } from '../worker/infra-cloudflare.js';
import { lineProfile, normalizeLine } from '../worker/template-lines.js';

function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; } };
}
function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), TENANT_SECRET_ROOT: 'r'.repeat(40), CREDENTIAL_KEK: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'), ...extra };
}
const signup = (email) => ({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org ' + email }; }, headers: { get: () => '203.0.113.30' } });
let n = 0;
async function newSite(env, infra, productId) {
  const s = await customerAuth.signUp(signup(`line${++n}@example.com`), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: s.organizationId, name: 'Site ' + n, productId, actorUserId: s.userId });
  assert.equal(site.ok, true, JSON.stringify(site));
  const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra), templateService: template });
  const start = await prov.startProvisioning(env, site.siteId);
  const run = await prov.runJob(env, start.jobId);
  assert.equal(run.ok, true, JSON.stringify(run));
  return { siteId: site.siteId, autoDeploy: run.result.autoDeploy };
}
const pub = (env, version, line, extra = {}) => template.publishRelease(env, { version, line, scriptContent: `export default {/*${version}*/}`, migrations: [], ...extra });

test('line names are validated and the default is casino', () => {
  assert.equal(normalizeLine(undefined), 'casino'); assert.equal(normalizeLine(''), 'casino');
  assert.equal(normalizeLine('Brokerage'), 'brokerage'); assert.equal(normalizeLine('nope'), null);
  assert.equal(lineProfile('nope').key, 'casino');
  assert.equal(lineProfile('brokerage').r2Binding, 'PRIVATE_FILES');
});

test('each line has its own active release, rollback target and R2 key', async () => {
  const env = makeEnv();
  assert.ok((await pub(env, 'c1', undefined)).ok);
  const b1 = await pub(env, 'b1', 'brokerage'); assert.ok(b1.ok); assert.equal(b1.line, 'brokerage');
  assert.ok(env.TENANT_TEMPLATES.m.has('templates/c1.json'), 'casino key is unchanged');
  assert.ok(env.TENANT_TEMPLATES.m.has('templates/brokerage/b1.json'));
  assert.ok((await pub(env, 'b2', 'brokerage')).ok);
  assert.equal((await template.getCurrentRelease(env)).version, 'c1', 'publishing brokerage does not supersede casino');
  assert.equal((await template.getCurrentRelease(env, 'brokerage')).version, 'b2');
  assert.deepEqual((await template.listReleases(env, 'brokerage')).map((r) => [r.version, r.status]), [['b2', 'active'], ['b1', 'superseded']]);
  assert.equal((await template.listReleases(env)).length, 3);
  assert.deepEqual(await template.activateRelease(env, 'b1'), { ok: true, line: 'brokerage' });
  assert.equal((await template.getCurrentRelease(env, 'brokerage')).version, 'b1');
  assert.equal((await template.getCurrentRelease(env)).version, 'c1');
  assert.equal((await template.getReleaseByVersion(env, 'b1')).line, 'brokerage');
});

test('an unknown line and a bad assetsConfig are refused', async () => {
  const env = makeEnv();
  assert.equal((await pub(env, 'x1', 'cats')).error, 'invalid_template_line');
  for (const bad of [[], { runWorkerFirst: 'x' }, { runWorkerFirst: ['nopath'] }, { headers: 5 }, { runWorkerFirst: Array(51).fill('/a') }]) {
    assert.equal((await pub(env, 'x2', 'brokerage', { assetsConfig: bad })).error, 'assets_config_invalid', JSON.stringify(bad));
  }
  const ok = await pub(env, 'x3', 'brokerage', { assetsConfig: { runWorkerFirst: ['/api/*', '!/static/*'], headers: '/static/*\n  X-A: 1\n' } });
  assert.ok(ok.ok);
  assert.deepEqual((await template.getReleaseByVersion(env, 'x3')).assetsConfig.runWorkerFirst, ['/api/*', '!/static/*']);
});

test('brokerage assets use the release rules; casino keeps the platform rule', () => {
  const brokerage = tenantAssetsConfig({}, { profile: lineProfile('brokerage'), releaseConfig: { runWorkerFirst: ['/api/*'], headers: '/x\n  A: b' } });
  assert.deepEqual(brokerage.run_worker_first, ['/api/*']); assert.equal(brokerage._headers, '/x\n  A: b');
  assert.equal(tenantAssetsConfig({}, { profile: lineProfile('brokerage') }).run_worker_first, true, 'no rules in the release: the Worker answers everything');
  assert.deepEqual(tenantAssetsConfig({}, { profile: lineProfile('casino') }).run_worker_first, ['/*', '!/static/*']);
  assert.deepEqual(tenantAssetsConfig({}).run_worker_first, ['/*', '!/static/*']);
});

async function bindingSetup(env, productId) {
  const db = env.LUMMET_DB;
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url, status) VALUES ('t1', 'T', 't1.example.test', 'https://t1.example.test', 'active')`).run();
  const { encryptedSecret, secretIv } = await encryptSecret(env, 'hmac-secret-value');
  await db.prepare(`INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv, status) VALUES ('t1', 'cred-1', ?, ?, 'active')`).bind(encryptedSecret, secretIv).run();
  await db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('o1', 'O', 'o')`).run();
  await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, tenant_id) VALUES ('s1', 'o1', ?, 'S', 's', 'active', 't1')`).bind(productId).run();
  for (const [type, id] of [['d1', 'db-1'], ['kv', 'kv-1'], ['r2', 'bucket-1']]) {
    await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES ('s1', 'cloudflare', ?, ?, ?)`).bind(type, id, id).run();
  }
  return { id: 's1', tenant_id: 't1' };
}
const named = (b, name) => b.find((x) => x.name === name);

test('brokerage bindings: PRIVATE_FILES, no AI, per-site derived secrets, the application settings', async () => {
  const env = makeEnv({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_x', EMAIL_FROM: 'Hi <a@b.test>' });
  const site = await bindingSetup(env, 'prod_brokerage_site');
  const b = await buildSiteBindings(env, { site, deploymentId: 4, host: 'a.example.test', hasAssets: true, line: 'brokerage' });
  assert.equal(named(b, 'PRIVATE_FILES').bucket_name, 'bucket-1'); assert.equal(named(b, 'MEDIA_BUCKET'), undefined); assert.equal(named(b, 'AI'), undefined);
  assert.equal(named(b, 'DB').id, 'db-1'); assert.equal(named(b, 'CACHE').namespace_id, 'kv-1');
  assert.equal(named(b, 'SUPER_API_SECRET').text, 'hmac-secret-value');
  assert.equal(named(b, 'APP_ENV').text, 'production'); assert.equal(named(b, 'PUBLIC_BASE_URL').text, 'https://a.example.test');
  assert.equal(named(b, 'EMAIL_FROM').text, 'Hi <a@b.test>');
  const ip = named(b, 'IP_HASH_SECRET'); const otp = named(b, 'OTP_ENCRYPTION_KEY');
  assert.equal(ip.type, 'secret_text'); assert.match(ip.text, /^[0-9a-f]{64}$/);
  assert.equal(Buffer.from(otp.text, 'base64').length, 32);
  const again = await buildSiteBindings(env, { site, deploymentId: 5, host: 'a.example.test', hasAssets: true, line: 'brokerage' });
  assert.equal(named(again, 'OTP_ENCRYPTION_KEY').text, otp.text, 'stable across redeploys');
  const other = await buildSiteBindings(makeEnvSameDb(env, { TENANT_SECRET_ROOT: 'q'.repeat(40) }), { site, deploymentId: 5, host: 'a.example.test', hasAssets: true, line: 'brokerage' });
  assert.notEqual(named(other, 'OTP_ENCRYPTION_KEY').text, otp.text, 'depends on the platform root');
});
const makeEnvSameDb = (env, extra) => ({ ...env, ...extra });

test('brokerage deploys fail clearly without TENANT_SECRET_ROOT; casino bindings are unchanged', async () => {
  const env = makeEnv({ TENANT_SECRET_ROOT: undefined });
  const site = await bindingSetup(env, 'prod_brokerage_site');
  await assert.rejects(buildSiteBindings(env, { site, deploymentId: 1, host: 'h', hasAssets: false, line: 'brokerage' }), /TENANT_SECRET_ROOT/);
  const c = await buildSiteBindings(env, { site, deploymentId: 1, host: 'h', hasAssets: false });
  assert.equal(named(c, 'MEDIA_BUCKET').bucket_name, 'bucket-1'); assert.ok(named(c, 'AI')); assert.equal(named(c, 'OTP_ENCRYPTION_KEY'), undefined);
});

test('a brokerage site is provisioned and deployed with the brokerage release, its profile and its health URL', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv();
  await pub(env, 'c1', 'casino'); await pub(env, 'b1', 'brokerage', { assetsConfig: { runWorkerFirst: ['/api/*'] } });
  const brokerage = await newSite(env, infra, 'prod_brokerage_site');
  assert.equal(brokerage.autoDeploy.ok, true, JSON.stringify(brokerage.autoDeploy));
  assert.equal((await sites.getSite(env, brokerage.siteId)).app_version, 'b1');
  const upload = infra._calls.filter((c) => c.method === 'uploadWorkerScript').pop();
  assert.match(upload.scriptContent, /b1/); assert.equal(upload.profile.key, 'brokerage');
  assert.deepEqual(infra._calls.filter((c) => c.method === 'setWorkerSchedule').pop().crons, ['*/5 * * * *']);
  const casino = await newSite(env, infra, 'prod_casino_news');
  assert.equal((await sites.getSite(env, casino.siteId)).app_version, 'c1');
  assert.equal(infra._calls.filter((c) => c.method === 'uploadWorkerScript').pop().profile.key, 'casino');
});

test('a release of one line cannot be deployed to a site of the other line', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv();
  await pub(env, 'c1', 'casino'); await pub(env, 'b1', 'brokerage');
  const { siteId } = await newSite(env, infra, 'prod_brokerage_site');
  const dep = createDeploymentService(infra);
  const rel = await template.getReleaseByVersion(env, 'c1');
  const started = await dep.startDeployment(env, { siteId, version: 'c1', migrations: rel.migrations, scriptContent: rel.scriptContent, actorType: 'system' });
  const ran = await dep.runJob(env, started.jobId);
  assert.equal(ran.ok, false);
  const row = await env.LUMMET_DB.prepare(`SELECT status, error_message FROM deployments WHERE id = ?`).bind(started.deploymentId).first();
  assert.equal(row.status, 'failed'); assert.match(row.error_message, /casino release but this site runs the brokerage application/);
  assert.equal((await sites.getSite(env, siteId)).app_version, 'b1', 'the serving site keeps its version');
});

test('rollouts are per line: they only touch that line\'s sites, and each line can roll out at the same time', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv();
  await pub(env, 'c1', 'casino'); await pub(env, 'b1', 'brokerage');
  const bSite = (await newSite(env, infra, 'prod_brokerage_site')).siteId; const cSite = (await newSite(env, infra, 'prod_casino_news')).siteId;
  await pub(env, 'c2', 'casino'); await pub(env, 'b2', 'brokerage');
  const dispatch = (jobId) => jobRunner.runJobById(env, jobId);

  const bRoll = await rollouts.startRollout(env, { line: 'brokerage' });
  assert.equal(bRoll.ok, true, JSON.stringify(bRoll)); assert.equal(bRoll.version, 'b2'); assert.equal(bRoll.line, 'brokerage'); assert.equal(bRoll.total, 1);
  const cRoll = await rollouts.startRollout(env, {});
  assert.equal(cRoll.ok, true, 'a casino rollout may run while the brokerage one does');
  assert.equal(cRoll.line, 'casino'); assert.equal(cRoll.total, 1);
  const again = await rollouts.startRollout(env, { line: 'brokerage' });
  assert.equal(again.error, 'rollout_in_progress'); assert.equal(again.rolloutId, bRoll.rolloutId);

  for (let i = 0; i < 8; i++) await rollouts.advanceRunning(env, { dispatch });
  assert.equal((await sites.getSite(env, bSite)).app_version, 'b2'); assert.equal((await sites.getSite(env, cSite)).app_version, 'c2');
  const dash = await rollouts.dashboard(env, 'brokerage');
  assert.equal(dash.line, 'brokerage'); assert.equal(dash.active.version, 'b2'); assert.equal(dash.totalLive, 1);
});

test('a rollout cannot name a line that is not the release\'s own', async () => {
  const env = makeEnv();
  await pub(env, 'c1', 'casino'); await pub(env, 'b1', 'brokerage');
  assert.equal((await rollouts.startRollout(env, { version: 'c1', line: 'brokerage' })).error, 'release_line_mismatch');
  assert.equal((await rollouts.startRollout(env, { line: 'cats' })).error, 'invalid_template_line');
});

test('migration 0087 is additive: existing products stay on the casino line and the brokerage product exists', async () => {
  const env = makeEnv();
  const rows = (await env.LUMMET_DB.prepare(`SELECT key, template_line FROM products`).all()).results;
  assert.deepEqual(rows.filter((r) => r.template_line !== 'casino').map((r) => r.key), ['brokerage_site']);
  assert.ok(rows.length > 5);
});

test('a brokerage site has no setup wizard and its first deploy gets none of the casino seed migrations', async (t) => {
  const infra = createFakeInfraProvider(); __setInfraProviderForTests(infra); t.after(() => __setInfraProviderForTests(null));
  const env = makeEnv();
  await pub(env, 'c1', 'casino'); await pub(env, 'b1', 'brokerage', { migrations: [{ name: '0001_init.sql', sql: 'CREATE TABLE t (id INTEGER);' }] });
  const s = await customerAuth.signUp(signup(`wiz${++n}@example.com`), env);
  await plans.startTrialSubscription(env, s.organizationId, 'plan_casino_news_starter');
  const created = await sites.createSite(env, { organizationId: s.organizationId, name: 'Wiz', productId: 'prod_brokerage_site', actorUserId: s.userId });
  assert.equal(created.ok, true); assert.equal(created.setup, null);
  assert.equal((await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS c FROM site_setup_requests WHERE site_id = ?`).bind(created.siteId).first()).c, 0);
  const prov = createProvisioningService(infra, { deploymentService: createDeploymentService(infra), templateService: template });
  const run = await prov.runJob(env, (await prov.startProvisioning(env, created.siteId)).jobId);
  assert.equal(run.ok, true, JSON.stringify(run));
  const applied = (await env.LUMMET_DB.prepare(`SELECT migration_name FROM site_migrations_applied WHERE site_id = ?`).bind(created.siteId).all()).results.map((r) => r.migration_name);
  assert.deepEqual(applied, ['0001_init.sql']);

  const casino = await customerAuth.signUp(signup(`wiz${++n}@example.com`), env);
  await plans.startTrialSubscription(env, casino.organizationId, 'plan_casino_news_starter');
  const cs = await sites.createSite(env, { organizationId: casino.organizationId, name: 'Cas', productId: 'prod_casino_news', actorUserId: casino.userId });
  assert.equal(cs.setup.status, 'pending', 'casino keeps its wizard');
});
