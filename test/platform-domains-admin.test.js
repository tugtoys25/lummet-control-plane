// Platform domains, staff service: validation, the five checks (every pass and fail path), and the manage rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createPlatformDomainAdmin, safeMessage } from '../worker/platform-domains-admin.js';
import * as repo from '../worker/repositories/platform-domains.js';
import * as pd from '../worker/platform-domains.js';
import { reservedDomains, normalizeDomainInput } from '../worker/zone-domains.js';

function setup({ probeOk = true } = {}) {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default', PORTAL_BASE_URL: 'https://portal.lummet.test', CF_API_TOKEN: 'secret-token-value' };
  const infra = createFakeInfraProvider();
  const fetched = [];
  const fetcher = async (url) => { fetched.push(url); return probeOk ? new Response(JSON.stringify({ ok: true }), { status: 200 }) : new Response('{}', { status: 522 }); };
  const svc = createPlatformDomainAdmin({ infra, fetcher });
  return { env, infra, svc, fetched };
}

/** An organization, one product and N sites (FKs are enforced), optionally on a platform domain. */
async function seedSites(env, specs) {
  const db = env.LUMMET_DB;
  await db.prepare(`INSERT OR IGNORE INTO organizations (id, name, slug, status) VALUES ('o1', 'Org', 'org', 'active')`).run();
  const prod = await db.prepare(`SELECT id FROM products LIMIT 1`).first();
  for (const { id, slug, domainId = null, status = 'active' } of specs) {
    await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, platform_domain_id) VALUES (?, 'o1', ?, ?, ?, ?, ?)`).bind(id, prod.id, slug, slug, status, domainId).run();
  }
}
const stepsByKey = (r) => Object.fromEntries(r.steps.map((s) => [s.key, s]));

test('validation: bad names, subdomains, portal host, workers.dev, duplicates, customer domains', async () => {
  const { env, svc } = setup();
  assert.equal((await svc.addDomain(env, { hostname: 'not a domain' })).error, 'invalid_domain');
  assert.equal((await svc.addDomain(env, { hostname: 'sub.example.com' })).error, 'not_registrable');
  assert.equal((await svc.addDomain(env, { hostname: 'foo.workers.dev' })).error, 'domain_reserved');
  assert.equal((await svc.addDomain(env, { hostname: 'lummet.test', label: 'x' })).ok, true);          // not the portal host (portal.lummet.test)
  const ok = await svc.addDomain(env, { hostname: 'Genteelisms.com', label: 'Genteelisms' });
  assert.equal(ok.ok, true);
  assert.equal(ok.domain.hostname, 'genteelisms.com');
  assert.equal(ok.domain.status, 'pending');
  assert.equal(ok.domain.is_default, false);
  assert.equal((await svc.addDomain(env, { hostname: 'genteelisms.com' })).error, 'domain_exists');
  await seedSites(env, [{ id: 's1', slug: 'cust' }]);
  await env.LUMMET_DB.prepare(`INSERT INTO domain_zones (id, site_id, zone_name, provider_zone_id, status) VALUES ('z1','s1','customer-owned.com','pz1','active')`).run();
  const custom = await svc.addDomain(env, { hostname: 'customer-owned.com' });
  assert.equal(custom.ok ? 'added' : custom.error, 'domain_in_use_by_customer');
});

test('portal host itself is refused', async () => {
  const { env, svc } = setup();
  env.PORTAL_BASE_URL = 'https://example.org';
  assert.equal((await svc.addDomain(env, { hostname: 'example.org' })).error, 'domain_is_portal');
});

test('add flow: every check passes -> active, route created in the new zone then removed, wildcard confirmed first', async () => {
  const { env, svc, infra, fetched } = setup();
  const zoneId = infra._seedZone('genteelisms.com');
  const { domain } = await svc.addDomain(env, { hostname: 'genteelisms.com', label: 'G' });

  const first = await svc.verify(env, domain.id);
  assert.equal(first.passed, false);
  assert.equal(first.needsConfirmation, 'create_wildcard');
  assert.equal(stepsByKey(first).wildcard.state, 'warn');
  assert.equal(stepsByKey(first).certificate.state, 'skipped');
  assert.equal(first.domain.status, 'pending', 'not selectable yet');
  assert.equal(infra._calls.filter((c) => c.method === 'createDnsRecord').length, 0, 'never creates DNS without confirmation');

  const second = await svc.verify(env, domain.id, { createWildcard: true });
  assert.equal(second.passed, true);
  assert.deepEqual(second.steps.map((s) => s.state), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(second.domain.status, 'active');
  assert.equal(second.domain.cf_zone_id, zoneId);
  const rec = infra._calls.find((c) => c.method === 'createDnsRecord');
  assert.deepEqual([rec.zoneId, rec.record.name, rec.record.type, rec.record.content, rec.record.proxied], [zoneId, '*.genteelisms.com', 'AAAA', '100::', true]);
  const created = infra._calls.find((c) => c.method === 'ensureWorkerRoute');
  assert.deepEqual([created.pattern, created.zoneId], ['platform-check.genteelisms.com/*', zoneId]);
  assert.ok(infra._calls.some((c) => c.method === 'deleteWorkerRoute' && c.zoneId === zoneId), 'test route removed from the same zone');
  assert.deepEqual(fetched, ['https://platform-check.genteelisms.com/api/health']);
  assert.equal((await repo.get(env, domain.id)).last_check.passed, true);
});

test('zone missing, zone inactive, missing token permission, grey-cloud wildcard, SSL off, probe failing: stays not-active with a plain fix', async () => {
  // zone missing
  let t = setup(); let d = (await t.svc.addDomain(t.env, { hostname: 'nozone.com' })).domain;
  let r = await t.svc.verify(t.env, d.id);
  assert.equal(stepsByKey(r).zone.state, 'fail'); assert.match(stepsByKey(r).zone.fix, /Add nozone\.com to this Cloudflare account/); assert.equal(r.domain.status, 'failed');
  // zone inactive
  t = setup(); t.infra._seedZone('inactive.com', { status: 'pending' }); d = (await t.svc.addDomain(t.env, { hostname: 'inactive.com' })).domain;
  r = await t.svc.verify(t.env, d.id);
  assert.match(stepsByKey(r).zone.detail, /not active/); assert.equal(r.domain.status, 'failed');
  // missing permission
  t = setup(); let zid = t.infra._seedZone('perm.com'); t.infra._accessMissing.set(zid, ['Workers Routes: Edit']); d = (await t.svc.addDomain(t.env, { hostname: 'perm.com' })).domain;
  r = await t.svc.verify(t.env, d.id);
  assert.match(stepsByKey(r).permissions.detail, /Missing permission: Workers Routes: Edit/); assert.equal(stepsByKey(r).wildcard.state, 'skipped');
  // wildcard present but not proxied
  t = setup(); zid = t.infra._seedZone('grey.com', { records: [{ id: 'r1', type: 'AAAA', name: '*.grey.com', content: '100::', proxied: false }] }); d = (await t.svc.addDomain(t.env, { hostname: 'grey.com' })).domain;
  r = await t.svc.verify(t.env, d.id, { createWildcard: true });
  assert.match(stepsByKey(r).wildcard.detail, /not proxied/); assert.equal(r.domain.status, 'failed');
  // universal SSL off
  t = setup(); zid = t.infra._seedZone('nossl.com', { records: [{ id: 'r1', type: 'AAAA', name: '*.nossl.com', content: '100::', proxied: true }] }); t.infra._ssl.set(zid, false); d = (await t.svc.addDomain(t.env, { hostname: 'nossl.com' })).domain;
  r = await t.svc.verify(t.env, d.id);
  assert.equal(stepsByKey(r).certificate.state, 'fail'); assert.equal(stepsByKey(r).routing.state, 'skipped');
  // probe failing: still not active, and the test route is removed anyway
  t = setup({ probeOk: false }); zid = t.infra._seedZone('probe.com', { records: [{ id: 'r1', type: 'AAAA', name: '*.probe.com', content: '100::', proxied: true }] }); d = (await t.svc.addDomain(t.env, { hostname: 'probe.com' })).domain;
  r = await t.svc.verify(t.env, d.id);
  assert.equal(r.passed, false); assert.equal(stepsByKey(r).routing.state, 'fail'); assert.equal(r.domain.status, 'failed');
  assert.ok(t.infra._calls.some((c) => c.method === 'deleteWorkerRoute'), 'test route cleaned up after a failed probe');
});

test('a failed domain can pass on re-run; re-run never demotes the default', async () => {
  const { env, svc, infra } = setup();
  const d = (await svc.addDomain(env, { hostname: 'later.com' })).domain;
  assert.equal((await svc.verify(env, d.id)).domain.status, 'failed');
  infra._seedZone('later.com', { records: [{ id: 'r', type: 'AAAA', name: '*.later.com', content: '100::', proxied: true }] });
  assert.equal((await svc.verify(env, d.id)).domain.status, 'active');
  const def = await pd.getDefaultDomain(env);                     // bootstrap row (lummet.app) has no zone in the fake
  const rr = await svc.verify(env, def.id);
  assert.equal(rr.passed, false);
  assert.equal((await repo.get(env, def.id)).status, 'active', 'default stays active; the failure is only shown');
});

test('default rules: only an active domain can become default; default cannot be disabled or removed', async () => {
  const { env, svc } = setup();
  const def = await pd.getDefaultDomain(env);
  const d = (await svc.addDomain(env, { hostname: 'second.com' })).domain;
  assert.equal((await svc.setDefault(env, d.id)).error, 'domain_not_active');
  await repo.update(env, d.id, { status: 'active' });
  assert.equal((await svc.disable(env, def.id)).error, 'cannot_disable_default');
  assert.equal((await svc.remove(env, def.id)).error, 'cannot_remove_default');
  assert.equal((await svc.setDefault(env, d.id)).ok, true);
  assert.equal((await repo.getDefault(env)).id, d.id);
  assert.equal((await svc.disable(env, def.id)).ok, true);
  assert.equal((await svc.disable(env, d.id)).error, 'cannot_disable_default');
});

test('disable stops customer choice; enable returns it to pending (must re-pass checks)', async () => {
  const { env, svc } = setup();
  const d = (await svc.addDomain(env, { hostname: 'toggle.com' })).domain;
  await repo.update(env, d.id, { status: 'active' });
  assert.deepEqual((await pd.listChoosableDomains(env, {})).map((x) => x.hostname).sort(), ['lummet.app', 'toggle.com']);
  await svc.disable(env, d.id);
  assert.deepEqual((await pd.listChoosableDomains(env, {})).map((x) => x.hostname), ['lummet.app']);
  assert.equal((await svc.enable(env, d.id)).domain.status, 'pending');
});

test('remove is refused while sites use the domain, with the count; allowed once empty', async () => {
  const { env, svc } = setup();
  const d = (await svc.addDomain(env, { hostname: 'used.com' })).domain;
  await seedSites(env, [{ id: 's1', slug: 'one', domainId: d.id }, { id: 's2', slug: 'two', domainId: d.id }]);
  const refused = await svc.remove(env, d.id);
  assert.deepEqual([refused.ok, refused.error, refused.sites], [false, 'domain_in_use', 2]);
  assert.match(refused.detail, /2 sites/);
  await env.LUMMET_DB.prepare(`UPDATE sites SET platform_domain_id = NULL`).run();
  assert.equal((await svc.remove(env, d.id)).ok, true);
  assert.equal(await repo.get(env, d.id), null);
});

test('update: label, customer choice, entitlement key validated; reorder rejects unknown ids', async () => {
  const { env, svc } = setup();
  const d = (await svc.addDomain(env, { hostname: 'edit.com' })).domain;
  assert.equal((await svc.update(env, d.id, { label: '  ' })).error, 'label_required');
  assert.equal((await svc.update(env, d.id, { entitlementKey: 'bad key!' })).error, 'invalid_entitlement_key');
  const u = await svc.update(env, d.id, { label: 'Edit', allowCustomerChoice: false, entitlementKey: 'sites.premium_domain' });
  assert.deepEqual([u.domain.label, u.domain.allow_customer_choice, u.domain.entitlement_key], ['Edit', false, 'sites.premium_domain']);
  assert.equal((await svc.reorder(env, ['nope'])).error, 'invalid_order');
  const ids = (await repo.list(env)).map((x) => x.id).reverse();
  assert.equal((await svc.reorder(env, ids)).ok, true);
  assert.deepEqual((await repo.list(env)).map((x) => x.id), ids);
});

test('customers can never claim any platform domain, disabled ones included', async () => {
  const { env, svc } = setup();
  const d = (await svc.addDomain(env, { hostname: 'reserved-one.com' })).domain;
  await repo.update(env, d.id, { status: 'disabled' });
  const names = await pd.reservedHostnames(env);
  assert.ok(names.includes('lummet.app') && names.includes('reserved-one.com'));
  for (const host of ['reserved-one.com', 'shop.reserved-one.com', 'lummet.app', 'x.lummet.app']) {
    assert.equal(normalizeDomainInput(host, env, names).error, 'domain_reserved', host);
  }
  assert.ok(reservedDomains(env, names).includes('reserved-one.com'));
});

test('error messages never show tokens or long ids', () => {
  const m = safeMessage(new Error('bad Bearer abcDEF123456.secret and zone 0123456789abcdef0123456789abcdef'));
  assert.doesNotMatch(m, /abcDEF123456|0123456789abcdef0123456789abcdef/);
});
