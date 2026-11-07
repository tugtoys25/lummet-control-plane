// Platform domains foundation: migration 0085, lazy bootstrap, resolver. Real code over an in-memory D1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as pd from '../worker/platform-domains.js';
import * as repo from '../worker/repositories/platform-domains.js';

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default', ...extra };
}

test('migration applies twice cleanly and creates the table, indexes and sites column', async () => {
  const env = makeEnv();
  applyMigrations(env.LUMMET_DB);
  const cols = (await env.LUMMET_DB.prepare(`PRAGMA table_info(sites)`).all()).results.map((c) => c.name);
  assert.ok(cols.includes('platform_domain_id'));
  const idx = (await env.LUMMET_DB.prepare(`PRAGMA index_list(platform_domains)`).all()).results.map((i) => i.name);
  assert.ok(idx.includes('idx_platform_domains_hostname') && idx.includes('idx_platform_domains_one_default'));
});

test('only one default row can exist; hostname is unique', async () => {
  const env = makeEnv();
  await repo.insert(env, { id: 'a', hostname: 'a.com', label: 'A', status: 'active', isDefault: true });
  await assert.rejects(repo.insert(env, { id: 'b', hostname: 'b.com', label: 'B', status: 'active', isDefault: true }));
  assert.equal(await repo.insert(env, { id: 'c', hostname: 'a.com', label: 'dup' }), false);
  await repo.insert(env, { id: 'b', hostname: 'b.com', label: 'B', status: 'active' });
  await repo.setDefault(env, 'b');
  assert.equal((await repo.getDefault(env)).id, 'b');
  assert.equal((await repo.get(env, 'a')).is_default, false);
});

test('lazy bootstrap: no rows -> default from env; rows present -> env ignored', async () => {
  const env = makeEnv();
  const d = await pd.getDefaultDomain(env);
  assert.deepEqual([d.hostname, d.cf_zone_id, d.status, d.is_default], ['lummet.app', 'zone-default', 'active', true]);
  assert.equal(await repo.count(env), 1);
  await pd.getDefaultDomain(env);
  assert.equal(await repo.count(env), 1, 'second call does not create another');
  const env2 = { ...env, PLATFORM_DOMAIN_SUFFIX: 'changed.example' };
  assert.equal((await pd.getDefaultDomain(env2)).hostname, 'lummet.app');
});

test('no env and no rows behaves as today (sites.lummet.app)', async () => {
  const env = makeEnv({ PLATFORM_DOMAIN_SUFFIX: undefined, CF_ZONE_ID: undefined });
  assert.equal((await pd.getDefaultDomain(env)).hostname, 'sites.lummet.app');
});

test('hostFor and old sites without platform_domain_id resolve to the default', async () => {
  const env = makeEnv();
  await pd.ensureBootstrap(env);
  await repo.insert(env, { id: 'x', hostname: 'genteelisms.com', label: 'G', cfZoneId: 'zone-x', status: 'active' });
  assert.equal(pd.hostFor({ slug: 'my-brand' }, 'genteelisms.com'), 'my-brand.genteelisms.com');
  assert.equal((await pd.getDomainForSite(env, { slug: 'old', platform_domain_id: null })).hostname, 'lummet.app');
  const d = await pd.getDomainForSite(env, { slug: 'new', platform_domain_id: 'x' });
  assert.equal(pd.hostFor({ slug: 'new' }, d), 'new.genteelisms.com');
  assert.equal(pd.zoneIdFor(env, d), 'zone-x');
  assert.equal(pd.zoneIdFor(env, { cf_zone_id: null }), 'zone-default', 'no zone recorded -> default zone');
});

test('choosable list respects status and customer-choice flag; reserved list covers disabled rows', async () => {
  const env = makeEnv();
  await pd.ensureBootstrap(env);
  await repo.insert(env, { id: 'p', hostname: 'pending.com', label: 'P', status: 'pending' });
  await repo.insert(env, { id: 'h', hostname: 'hidden.com', label: 'H', status: 'active', allowCustomerChoice: false });
  await repo.insert(env, { id: 'd', hostname: 'off.com', label: 'D', status: 'disabled' });
  await repo.insert(env, { id: 'o', hostname: 'ok.com', label: 'O', status: 'active', sortOrder: 5 });
  const names = (await pd.listChoosableDomains(env, { organizationId: 'org1' })).map((x) => x.hostname);
  assert.deepEqual(names, ['lummet.app', 'ok.com']);
  const reserved = await pd.reservedHostnames(env);
  for (const h of ['lummet.app', 'pending.com', 'hidden.com', 'off.com', 'ok.com']) assert.ok(reserved.includes(h), h);
});

test('hostname validation', () => {
  assert.ok(pd.isValidHostname('Lummet.App'));
  assert.ok(!pd.isValidHostname('localhost'));
  assert.ok(!pd.isValidHostname('bad host.com'));
  assert.equal(pd.normalizeHostname('*.Example.com.'), 'example.com');
});

// ---- (b) zone-aware routes ----
import * as infraCf from '../worker/infra-cloudflare.js';
import { saveRoute, routeZoneId, findActiveResource } from '../worker/repositories/site-resources.js';

function mockCf(handler) {
  const orig = globalThis.fetch; const reqs = [];
  globalThis.fetch = async (url, init) => { reqs.push({ url: String(url), init }); return handler(String(url), init); };
  return { reqs, restore() { globalThis.fetch = orig; } };
}
const okRes = (result) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
const cfEnv = { CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'acct', CF_ZONE_ID: 'zone-default' };

test('ensureWorkerRoute / deleteWorkerRoute use the given zone, else the default zone', async () => {
  const m = mockCf(() => okRes({ id: 'r1' }));
  try {
    await infraCf.ensureWorkerRoute(cfEnv, { pattern: 'a.other.com/*', workerName: 'w', zoneId: 'zone-x' });
    await infraCf.ensureWorkerRoute(cfEnv, { pattern: 'a.lummet.app/*', workerName: 'w' });
    await infraCf.deleteWorkerRoute(cfEnv, 'r1', { zoneId: 'zone-x' });
    await infraCf.deleteWorkerRoute(cfEnv, 'r2');
  } finally { m.restore(); }
  assert.deepEqual(m.reqs.map((r) => r.url.split('/zones/')[1].split('/')[0]), ['zone-x', 'zone-default', 'zone-x', 'zone-default']);
});

test('a route row records its zone; rows without one resolve to the default zone', async () => {
  const env = makeEnv();
  env.LUMMET_DB._exec('PRAGMA foreign_keys = OFF;');
  env.LUMMET_DB._exec(`INSERT INTO sites (id, organization_id, name, slug, product_id) VALUES ('s1','o1','S','s1','p1'), ('s2','o1','S2','s2','p1')`);
  await saveRoute(env, { siteId: 's1', provider: 'cloudflare', routeId: 'rt1', pattern: 's1.other.com/*', zoneId: 'zone-x' });
  await saveRoute(env, { siteId: 's2', provider: 'cloudflare', routeId: 'rt2', pattern: 's2.lummet.app/*' });
  assert.equal(routeZoneId(await findActiveResource(env, 's1', 'route')), 'zone-x');
  assert.equal(routeZoneId(await findActiveResource(env, 's2', 'route')), null);
  assert.equal(pd.zoneIdFor(env, { cf_zone_id: routeZoneId(await findActiveResource(env, 's2', 'route')) }), 'zone-default');
});
