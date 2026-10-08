// Static assets + Worker bindings on deploy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import worker from '../worker/index.js';
import { createProvisioningService } from '../worker/provisioning.js';
import { createDeploymentService } from '../worker/deployments.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as tenantTemplate from '../worker/tenant-template.js';
import * as infraCf from '../worker/infra-cloudflare.js';
import { assetHash, validateAssetManifest, validateAssetPath, contentTypeFor } from '../worker/asset-hash.js';

const enc = (s) => new TextEncoder().encode(s);
function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v instanceof Uint8Array ? v : new TextEncoder().encode(String(v))); },
    async get(k) { return m.has(k) ? { text: async () => new TextDecoder().decode(m.get(k)), arrayBuffer: async () => m.get(k).buffer.slice(m.get(k).byteOffset, m.get(k).byteOffset + m.get(k).byteLength) } : null; } };
}
function makeEnv() {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, TENANT_TEMPLATES: fakeR2(), ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)) };
}
async function putAll(env, files) {
  const manifest = {};
  for (const [path, text] of Object.entries(files)) {
    const r = await tenantTemplate.putAsset(env, { path, bytes: enc(text) });
    assert.ok(r.ok, JSON.stringify(r));
    manifest[path] = { hash: r.hash, size: r.size };
  }
  return manifest;
}

test('asset hash: deterministic, 32 hex, depends on content and extension; paths and manifests are validated', async () => {
  const a = await assetHash(enc('body{}'), '/static/a.css');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, await assetHash(enc('body{}'), '/other/dir/b.css'));
  assert.notEqual(a, await assetHash(enc('body{}'), '/static/a.js'));
  assert.notEqual(a, await assetHash(enc('body{ }'), '/static/a.css'));
  for (const bad of ['static/a.css', '/a/../b.css', '/a//b.css', '/a?x=1', '/a#b', '', '/']) assert.ok(validateAssetPath(bad), bad);
  assert.equal(validateAssetPath('/static/css/a.css'), null);
  assert.equal(validateAssetManifest({ '/a.css': { hash: a, size: 6 } }), null);
  assert.ok(validateAssetManifest({ '/a.css': { hash: 'xyz', size: 6 } }));
  assert.ok(validateAssetManifest({}));
  assert.equal(contentTypeFor('/x.woff2'), 'font/woff2');
  assert.equal(contentTypeFor('/x.unknown'), 'application/octet-stream');
});

test('publishRelease: refuses assets that were never uploaded; stores and returns the manifest otherwise', async () => {
  const env = makeEnv();
  const ghost = { '/static/ghost.css': { hash: 'a'.repeat(32), size: 3 } };
  const refused = await tenantTemplate.publishRelease(env, { version: '1.0.0', scriptContent: 'x', migrations: [], assets: ghost });
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'asset_files_missing');
  assert.deepEqual(refused.missing, ['/static/ghost.css']);

  const manifest = await putAll(env, { '/static/app.css': 'body{}', '/templates/home.html': '<h1>hi</h1>' });
  const ok = await tenantTemplate.publishRelease(env, { version: '1.0.1', scriptContent: 'x', migrations: [], assets: manifest });
  assert.ok(ok.ok, JSON.stringify(ok));
  assert.equal(ok.assetCount, 2);
  const rel = await tenantTemplate.getReleaseByVersion(env, '1.0.1');
  assert.deepEqual(rel.assets, manifest);
  assert.equal(new TextDecoder().decode(await tenantTemplate.readAsset(env, manifest['/static/app.css'].hash)), 'body{}');
  assert.equal(await tenantTemplate.readAsset(env, 'not-a-hash'), null);

  const legacy = await tenantTemplate.publishRelease(env, { version: '0.9.0', scriptContent: 'x', migrations: [] });
  assert.equal((await tenantTemplate.getReleaseByVersion(env, '0.9.0')).assets, null);
});

test('putAsset rejects bad paths and oversized files', async () => {
  const env = makeEnv();
  assert.equal((await tenantTemplate.putAsset(env, { path: '/a/../x.css', bytes: enc('x') })).error, 'invalid_asset_path');
  assert.equal((await tenantTemplate.putAsset(env, { path: '/x.css', bytes: new Uint8Array(25 * 1024 * 1024 + 1) })).error, 'asset_too_large');
  assert.equal((await tenantTemplate.putAsset({}, { path: '/x.css', bytes: enc('x') })).error, 'template_storage_not_configured');
});

async function provisioned(env, infra) {
  const ctx = { waitUntil() {} };
  const s = await worker.fetch(new Request('https://cp.test/api/customer/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.9' }, body: JSON.stringify({ email: 'assets@example.com', password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' }) }), env, ctx);
  const sj = await s.json();
  await plans.startTrialSubscription(env, sj.organizationId, 'plan_casino_news_starter');
  const site = await sites.createSite(env, { organizationId: sj.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: sj.userId });
  const prov = createProvisioningService(infra);
  const start = await prov.startProvisioning(env, site.siteId);
  const ran = await prov.runJob(env, start.jobId);
  return { siteId: site.siteId, credential: ran.result.credential };
}

test('deploy uploads the Worker with all bindings and the release assets; ASSETS only when the release has assets', async () => {
  const infra = createFakeInfraProvider(); const env = makeEnv();
  const { siteId, credential } = await provisioned(env, infra);
  const manifest = await putAll(env, { '/static/css/app.css': 'body{}', '/templates/home.html': '<h1/>' });
  await tenantTemplate.publishRelease(env, { version: '2.0.0', scriptContent: 'export default {}', migrations: [], assets: manifest });

  const svc = createDeploymentService(infra);
  const d = await svc.startDeployment(env, { siteId, version: '2.0.0', migrations: [], scriptContent: 'export default {}', actorType: 'system' });
  const ran = await svc.runJob(env, d.jobId);
  assert.ok(ran.ok, JSON.stringify(ran));

  const up = infra._calls.filter((c) => c.method === 'uploadWorkerScript').pop();
  const by = Object.fromEntries(up.bindings.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(by).sort(), ['AI', 'ASSETS', 'CACHE', 'DB', 'DEPLOYMENT_ID', 'MEDIA_BUCKET', 'SITE_URL', 'SUPER_API_CREDENTIAL_ID', 'SUPER_API_SECRET']);
  const resources = Object.fromEntries((await env.LUMMET_DB.prepare(`SELECT resource_type, resource_id FROM site_resources WHERE site_id = ?`).bind(siteId).all()).results.map((r) => [r.resource_type, r.resource_id]));
  assert.equal(by.DB.id, resources.d1);
  assert.equal(by.CACHE.namespace_id, resources.kv);
  assert.equal(by.MEDIA_BUCKET.bucket_name, resources.r2);
  assert.equal(by.SUPER_API_CREDENTIAL_ID.text, credential.credentialId);
  assert.equal(by.SUPER_API_SECRET.type, 'secret_text');
  assert.equal(by.SUPER_API_SECRET.text, credential.secret); // decrypted, matches what the tenant is told
  assert.equal(by.DEPLOYMENT_ID.text, d.deploymentId);
  assert.match(by.SITE_URL.text, /^https:\/\//);
  assert.deepEqual(up.assetManifest, manifest);

  // Health check also fetched a stylesheet from the site.
  const checks = infra._calls.filter((c) => c.method === 'checkHealth').map((c) => c.url);
  assert.ok(checks.some((u) => u.endsWith('/static/css/app.css')), checks.join(','));

  // A release without assets: no ASSETS binding and no asset check.
  await tenantTemplate.publishRelease(env, { version: '2.0.1', scriptContent: 'export default {}', migrations: [] });
  const before = infra._calls.length;
  const d2 = await svc.startDeployment(env, { siteId, version: '2.0.1', migrations: [], scriptContent: 'export default {}', actorType: 'system' });
  assert.ok((await svc.runJob(env, d2.jobId)).ok);
  const later = infra._calls.slice(before);
  const up2 = later.filter((c) => c.method === 'uploadWorkerScript').pop();
  assert.ok(!up2.bindings.some((b) => b.name === 'ASSETS'));
  assert.equal(up2.assetManifest, null);
  assert.ok(!later.filter((c) => c.method === 'checkHealth').some((c) => /\.css$/.test(c.url)));
});

test('a broken stylesheet fails the deployment instead of reporting a working site', async () => {
  const infra = createFakeInfraProvider(); const env = makeEnv();
  const { siteId } = await provisioned(env, infra);
  const manifest = await putAll(env, { '/static/app.css': 'body{}' });
  await tenantTemplate.publishRelease(env, { version: '3.0.0', scriptContent: 'x', migrations: [], assets: manifest });
  const realCheck = infra.checkHealth;
  infra.checkHealth = async (e, p) => (p.url.endsWith('.css') ? { ok: false, statusCode: 404 } : realCheck(e, p));
  const svc = createDeploymentService(infra);
  const d = await svc.startDeployment(env, { siteId, version: '3.0.0', migrations: [], scriptContent: 'x', actorType: 'system' });
  const ran = await svc.runJob(env, d.jobId);
  assert.equal(ran.ok, false);
  assert.match(ran.error, /static asset check failed/);
});

test('deploy fails clearly when a site is missing a provisioned resource', async () => {
  const infra = createFakeInfraProvider(); const env = makeEnv();
  const { siteId } = await provisioned(env, infra);
  await env.LUMMET_DB.prepare(`DELETE FROM site_resources WHERE site_id = ? AND resource_type = 'kv'`).bind(siteId).run();
  const svc = createDeploymentService(infra);
  const d = await svc.startDeployment(env, { siteId, version: '4.0.0', migrations: [], scriptContent: 'x', actorType: 'system' });
  const ran = await svc.runJob(env, d.jobId);
  assert.equal(ran.ok, false);
  assert.match(ran.error, /missing kv/);
});

test('Cloudflare adapter: session -> upload missing buckets -> completion token -> script metadata (mocked fetch)', async () => {
  const env = { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' };
  const manifest = { '/static/a.css': { hash: 'a'.repeat(32), size: 6 }, '/static/b.js': { hash: 'b'.repeat(32), size: 3 }, '/static/copy.css': { hash: 'a'.repeat(32), size: 6 } };
  const store = { [manifest['/static/a.css'].hash]: enc('body{}'), [manifest['/static/b.js'].hash]: enc('x=1') };
  const reqs = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    reqs.push({ url: String(url), init });
    if (url.endsWith('/assets-upload-session')) return new Response(JSON.stringify({ success: true, result: { jwt: 'session-jwt', buckets: [['a'.repeat(32)], ['b'.repeat(32)]] } }));
    if (url.includes('/workers/assets/upload')) {
      const last = reqs.filter((r) => r.url.includes('/workers/assets/upload')).length === 2;
      return new Response(JSON.stringify({ success: true, result: last ? { jwt: 'completion-jwt' } : {} }), { status: last ? 201 : 202 });
    }
    return new Response(JSON.stringify({ success: true, result: {} }));
  };
  try {
    await infraCf.uploadWorkerScript(env, { workerName: 'w1', scriptContent: 'export default {}', bindings: [{ type: 'ai', name: 'AI' }], assets: { manifest, readAsset: async (h) => store[h] } });
  } finally { globalThis.fetch = realFetch; }

  assert.equal(reqs.length, 4);
  assert.match(reqs[0].url, /\/accounts\/acct\/workers\/scripts\/w1\/assets-upload-session$/);
  assert.deepEqual(JSON.parse(reqs[0].init.body), { manifest });
  for (const i of [1, 2]) {
    assert.match(reqs[i].url, /\/workers\/assets\/upload\?base64=true$/);
    assert.equal(reqs[i].init.headers.Authorization, 'Bearer session-jwt');
  }
  const part = reqs[1].init.body.get('a'.repeat(32));
  assert.equal(await part.text(), btoa('body{}'));
  assert.equal(part.type, 'text/css; charset=utf-8');
  assert.match(reqs[3].url, /\/workers\/scripts\/w1$/);
  const meta = JSON.parse(reqs[3].init.body.get('metadata'));
  assert.equal(meta.assets.jwt, 'completion-jwt');
  assert.equal(meta.assets.config.run_worker_first, true);
  assert.deepEqual(meta.bindings, [{ type: 'ai', name: 'AI' }]);
  assert.ok(meta.compatibility_flags.includes('nodejs_compat'));
});

test('Cloudflare adapter: nothing to upload uses the session token; a missing completion token or API error throws', async () => {
  const env = { CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct' };
  const manifest = { '/a.css': { hash: 'c'.repeat(32), size: 1 } };
  const realFetch = globalThis.fetch;
  try {
    let metaJwt;
    globalThis.fetch = async (url, init) => {
      if (url.endsWith('/assets-upload-session')) return new Response(JSON.stringify({ success: true, result: { jwt: 'already', buckets: [] } }));
      metaJwt = JSON.parse(init.body.get('metadata')).assets.jwt;
      return new Response(JSON.stringify({ success: true, result: {} }));
    };
    await infraCf.uploadWorkerScript(env, { workerName: 'w', scriptContent: 'x', assets: { manifest, readAsset: async () => { throw new Error('should not read'); } } });
    assert.equal(metaJwt, 'already');

    globalThis.fetch = async (url) => url.endsWith('/assets-upload-session')
      ? new Response(JSON.stringify({ success: true, result: { jwt: 's', buckets: [['c'.repeat(32)]] } }))
      : new Response(JSON.stringify({ success: true, result: {} }), { status: 202 });
    await assert.rejects(infraCf.uploadAssets(env, { workerName: 'w', manifest, readAsset: async () => enc('x') }), /without a completion token/);

    globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'nope' }] }), { status: 400 });
    await assert.rejects(infraCf.uploadAssets(env, { workerName: 'w', manifest, readAsset: async () => enc('x') }), /assets upload session: nope/);
  } finally { globalThis.fetch = realFetch; }
});

test('staff routes: asset upload is super-admin only, recomputes the hash, and publish accepts the manifest', async () => {
  const env = makeEnv(); const ctx = { waitUntil() {} }; let n = 1;
  const call = async (method, path, { body, cookie, raw } = {}) => {
    const h = new Headers({ 'CF-Connecting-IP': `198.18.2.${n++ % 250 + 1}` });
    if (cookie) h.set('Cookie', cookie);
    if (body !== undefined) h.set('Content-Type', 'application/json');
    const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
    const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
  };
  assert.ok([401, 403, 302].includes((await call('PUT', '/api/platform/saas/tenant-template/assets?path=/x.css', { raw: 'x' })).status));

  await call('POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } });
  const staff = (await call('POST', '/api/auth/login', { body: { email: 'root@example.com', password: 'Correct-Horse-Battery-9' } })).cookie;

  const bad = await call('PUT', '/api/platform/saas/tenant-template/assets?path=/a/../x.css', { cookie: staff, raw: 'x' });
  assert.equal(bad.status, 422);
  const up = await call('PUT', '/api/platform/saas/tenant-template/assets?path=/static/app.css', { cookie: staff, raw: 'body{}' });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.hash, await assetHash(enc('body{}'), '/static/app.css'));

  const pub = await call('POST', '/api/platform/saas/tenant-template/publish', { cookie: staff, body: { version: '9.9.9', scriptContent: 'x', migrations: [], assets: { '/static/app.css': { hash: up.json.hash, size: up.json.size } } } });
  assert.equal(pub.status, 200, pub.text);
  const pubBad = await call('POST', '/api/platform/saas/tenant-template/publish', { cookie: staff, body: { version: '9.9.8', scriptContent: 'x', migrations: [], assets: { '/static/nope.css': { hash: 'd'.repeat(32), size: 1 } } } });
  assert.equal(pubBad.status, 422);
});
