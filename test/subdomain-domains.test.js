// Single subdomains (v1.1): inside an already-delegated zone, or kept at the customer's own DNS (CNAME + TXT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeDnsResolver } from './support/fake-dns-resolver.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createZoneDomainService, normalizeSubdomainInput, isLikelyApex, cnameTargetFor, describeSubdomainProgress } from '../worker/zone-domains.js';
import * as customerAuth from '../worker/customer-auth.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';

const MIN = 60 * 1000;
const HOUR = 3600 * 1000;

function makeEnv(extra = {}) {
  const db = createTestDb(); applyMigrations(db);
  return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), PLATFORM_DOMAIN_SUFFIX: 'sites.lummet.test', PORTAL_BASE_URL: 'https://app.lummet.test', ...extra };
}
async function org(env, email, planKey = 'plan_agency_30') {
  const signup = await customerAuth.signUp({ async json() { return { email, password: 'correct-horse-battery', organizationName: 'Org' }; }, headers: { get: () => '203.0.113.20' } }, env);
  await plans.startTrialSubscription(env, signup.organizationId, planKey);
  const site = await sites.createSite(env, { organizationId: signup.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: signup.userId });
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(site.siteId).run();
  return { organizationId: signup.organizationId, userId: signup.userId, siteId: site.siteId };
}
async function extraSite(env, o, name) {
  const site = await sites.createSite(env, { organizationId: o.organizationId, name, productId: 'prod_casino_news', actorUserId: o.userId });
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'active' WHERE id = ?`).bind(site.siteId).run();
  return site.siteId;
}
function services() {
  const dns = createFakeDnsResolver(); const infra = createFakeInfraProvider();
  return { dns, infra, svc: createZoneDomainService({ dns, infra }) };
}
const txtOf = (view) => view.instructions.find((i) => i.type === 'TXT');

test('normalizeSubdomainInput keeps www, refuses apex names, reserved names and junk', () => {
  const env = { PLATFORM_DOMAIN_SUFFIX: 'sites.lummet.test', PORTAL_BASE_URL: 'https://app.lummet.test' };
  assert.equal(normalizeSubdomainInput('https://Shop.Example.com/x', env).hostname, 'shop.example.com');
  assert.equal(normalizeSubdomainInput('www.example.com', env).hostname, 'www.example.com');
  assert.equal(normalizeSubdomainInput('shop.example.co.uk', env).hostname, 'shop.example.co.uk');
  assert.equal(normalizeSubdomainInput('example.com', env).error, 'apex_needs_nameservers');
  assert.equal(normalizeSubdomainInput('example.co.uk', env).error, 'apex_needs_nameservers');
  assert.equal(normalizeSubdomainInput('x.sites.lummet.test', env).error, 'domain_reserved');
  for (const bad of ['', 'a b.example.com', '1.2.3.4', 'shop.example']) assert.equal(normalizeSubdomainInput(bad, env).ok, false, bad);
  assert.equal(isLikelyApex('a.b.com'), false);
  assert.equal(cnameTargetFor({ PLATFORM_DOMAIN_SUFFIX: 'sites.x.test' }), 'customers.sites.x.test');
  assert.equal(cnameTargetFor({ PLATFORM_CNAME_TARGET: 'Edge.X.Test.' }), 'edge.x.test');
  assert.equal(describeSubdomainProgress({ status: 'pending' }).phase, 'awaiting_dns');
  assert.equal(describeSubdomainProgress({ status: 'ssl_pending' }).phase, 'issuing_certificates');
  assert.equal(describeSubdomainProgress({ status: 'active' }).phase, 'live');
});

test('CNAME path: records shown -> TXT proves ownership -> hostname registered and routed -> HTTPS verified -> live + primary + redeploy', async () => {
  const env = makeEnv(); const { dns, infra, svc } = services();
  const a = await org(env, 'cname@example.com');
  const added = await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'Shop.Example.com', actorUserId: a.userId, organizationId: a.organizationId });
  assert.ok(added.ok, JSON.stringify(added));
  assert.equal(added.mode, 'cname');
  assert.equal(added.progress.phase, 'awaiting_dns');
  const cname = added.instructions.find((i) => i.type === 'CNAME');
  assert.deepEqual([cname.name, cname.value], ['shop.example.com', 'customers.sites.lummet.test']);
  assert.equal(txtOf(added).name, '_lummet-verify.shop.example.com');
  assert.equal(infra._calls.filter((c) => c.method === 'createCustomHostname').length, 0, 'nothing is registered before ownership is proven');

  const redeploys = []; const redeploy = async (id) => redeploys.push(id);
  let now = Date.now();
  let v = await svc.checkSubdomain(env, added.domainId, { now, redeploy });
  assert.equal(v.progress.phase, 'awaiting_dns');
  assert.equal(infra._calls.filter((c) => c.method === 'createCustomHostname').length, 0);

  // The CNAME alone is progress, not proof.
  dns._setCNAME('shop.example.com', ['customers.sites.lummet.test']);
  now += 5 * MIN;
  v = await svc.checkSubdomain(env, added.domainId, { now, redeploy });
  assert.equal(v.progress.phase, 'awaiting_dns');
  assert.ok(v.domain.cname_seen_at);
  assert.match(v.progress.steps[1].detail, /CNAME/);
  assert.equal(infra._calls.filter((c) => c.method === 'createCustomHostname').length, 0);

  // A wrong TXT value is not proof either.
  dns._setTXTRecords('_lummet-verify.shop.example.com', ['lummet-site-verification=wrong']);
  now += 5 * MIN;
  v = await svc.checkSubdomain(env, added.domainId, { now, redeploy });
  assert.equal(v.domain.status, 'pending');

  // The real TXT: registered + routed, certificate still issuing.
  infra._customHostnameRecords.set('shop.example.com', [{ type: 'TXT', name: '_cf-custom-hostname.shop.example.com', value: 'cf-owner-123' }]);
  infra._healthCheckResult = { ok: false, statusCode: null };
  dns._setTXTRecords('_lummet-verify.shop.example.com', [txtOf(added).value]);
  now += 5 * MIN;
  v = await svc.checkSubdomain(env, added.domainId, { now, redeploy });
  assert.equal(v.domain.status, 'ssl_pending');
  assert.equal(v.progress.phase, 'issuing_certificates');
  assert.ok(v.domain.route_id && v.domain.ssl_resource_id);
  const site = await sites.getSite(env, a.siteId);
  assert.deepEqual(infra._calls.filter((c) => c.method === 'ensureWorkerRoute').map((c) => [c.pattern, c.workerName]).pop(), ['shop.example.com/*', `lummet-site-${site.slug}`]);
  assert.ok(v.instructions.some((i) => i.value === 'cf-owner-123'), "Cloudflare's own ownership record is shown to the customer");

  // Cloudflare says the certificate is active, but HTTPS does not work yet: still not live.
  infra._setCustomHostnameStatus(v.domain.ssl_resource_id, 'active');
  now += 3 * MIN;
  v = await svc.checkSubdomain(env, added.domainId, { now, redeploy });
  assert.equal(v.domain.status, 'ssl_pending');
  assert.equal(redeploys.length, 0);

  infra._healthCheckResult = { ok: true, statusCode: 200 };
  now += 3 * MIN;
  v = await svc.checkSubdomain(env, added.domainId, { now, redeploy });
  assert.equal(v.progress.phase, 'live');
  assert.equal((await sites.getSite(env, a.siteId)).primary_domain, 'shop.example.com');
  assert.deepEqual(redeploys, [a.siteId]);
  const mail = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE subject LIKE '%is live%'`).first();
  assert.equal(mail.c, 1);

  // Finished rows are not re-run.
  assert.equal((await svc.sweep(env, { now: now + HOUR })).checked, 0);
});

test('CNAME path: registration problems retry, then fail after 24h; a failed certificate fails at once', async () => {
  const env = makeEnv(); const { dns, infra, svc } = services();
  const a = await org(env, 'retry@example.com');
  const add = async (host) => {
    const r = await svc.addSubdomain(env, { siteId: a.siteId, hostname: host, organizationId: a.organizationId });
    dns._setTXTRecords(`_lummet-verify.${host}`, [txtOf(r).value]);
    return r;
  };
  const one = await add('one.example.com');
  infra._deleteFailures.set('createCustomHostname', 'SaaS quota exceeded');
  let now = Date.now();
  let v = await svc.checkSubdomain(env, one.domainId, { now });
  assert.equal(v.domain.status, 'dns_verified');
  assert.match(v.domain.failure_reason, /attach_failed: SaaS quota exceeded/);
  infra._deleteFailures.clear();
  v = await svc.checkSubdomain(env, one.domainId, { now: now + 6 * MIN });
  assert.equal(v.domain.status, 'ssl_pending');
  assert.equal(v.domain.failure_reason, null);
  const registered = infra._calls.filter((c) => c.method === 'createCustomHostname').length;
  v = await svc.checkSubdomain(env, one.domainId, { now: now + 12 * MIN });
  assert.equal(infra._calls.filter((c) => c.method === 'createCustomHostname').length, registered, 'never registered twice');

  const two = await add('two.example.com');
  infra._deleteFailures.set('createCustomHostname', 'still down');
  now = Date.now();
  await svc.checkSubdomain(env, two.domainId, { now });
  v = await svc.checkSubdomain(env, two.domainId, { now: now + 25 * HOUR });
  assert.equal(v.domain.status, 'failed');
  infra._deleteFailures.clear();

  const three = await add('three.example.com');
  now = Date.now();
  v = await svc.checkSubdomain(env, three.domainId, { now });
  infra._setCustomHostnameStatus(v.domain.ssl_resource_id, 'failed');
  v = await svc.checkSubdomain(env, three.domainId, { now: now + 3 * MIN });
  assert.equal(v.domain.status, 'failed');
  assert.equal(v.domain.failure_reason, 'certificate_validation_failed');

  // A certificate that never validates (CNAME never added) fails after 24h instead of waiting forever.
  const four = await add('four.example.com');
  now = Date.now();
  v = await svc.checkSubdomain(env, four.domainId, { now });
  v = await svc.checkSubdomain(env, four.domainId, { now: now + 25 * HOUR });
  assert.equal(v.domain.failure_reason, 'certificate_or_routing_not_ready');
});

test('CNAME path: a request without records reminds once after 24h and expires after 7 days, releasing the name', async () => {
  const env = makeEnv(); const { svc } = services();
  const a = await org(env, 'expire-sub@example.com');
  const r = await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'shop.example.com', organizationId: a.organizationId });
  const t = Date.now() + 25 * HOUR;
  await svc.checkSubdomain(env, r.domainId, { now: t });
  await svc.checkSubdomain(env, r.domainId, { now: t + HOUR });
  const reminders = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE subject LIKE 'Finish connecting%'`).first();
  assert.equal(reminders.c, 1);

  const gone = await svc.checkSubdomain(env, r.domainId, { now: Date.now() + 8 * 24 * HOUR });
  assert.equal(gone.domain.status, 'removed');
  const mail = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM email_outbox WHERE subject LIKE '%was not connected%'`).first();
  assert.equal(mail.c, 1);
  const again = await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'shop.example.com', organizationId: a.organizationId });
  assert.ok(again.ok, JSON.stringify(again));
});

test('addSubdomain refuses: apex names, duplicates, unready sites, other organizations, missing operator setup, the flow switched off, plan limit', async () => {
  const env = makeEnv(); const { infra, svc } = services();
  const a = await org(env, 'refuse@example.com');
  assert.equal((await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'example.com' })).error, 'apex_needs_nameservers');
  assert.ok((await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'shop.example.com' })).ok);
  assert.equal((await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'shop.example.com' })).error, 'hostname_already_in_use');

  const b = await org(env, 'refuse-b@example.com');
  assert.equal((await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'x.example.org', organizationId: b.organizationId })).status, 404);
  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'pending' WHERE id = ?`).bind(b.siteId).run();
  assert.equal((await svc.addSubdomain(env, { siteId: b.siteId, hostname: 'x.example.org' })).error, 'site_not_ready');

  infra._setFallbackOrigin({ origin: 'customers.sites.lummet.test', status: 'pending_deployment' });
  assert.equal((await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'blog.example.com' })).error, 'custom_hostnames_not_configured');
  infra._setFallbackOrigin(null);
  assert.equal((await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'blog.example.com' })).error, 'custom_hostnames_not_configured');
  infra._setFallbackOrigin({ origin: 'customers.sites.lummet.test', status: 'active' });

  const off = makeEnv({ SUBDOMAIN_CNAME_FLOW: 'off' }); const c = await org(off, 'off@example.com');
  const r = await svc.addSubdomain(off, { siteId: c.siteId, hostname: 'shop.example.com' });
  assert.equal(r.error, 'subdomain_flow_disabled');
  assert.equal(r.status, 503);

  const limited = makeEnv(); const d = await org(limited, 'lim@example.com', 'plan_casino_news_starter');   // 1 custom domain
  assert.ok((await svc.addSubdomain(limited, { siteId: d.siteId, hostname: 'one.example.com' })).ok);
  assert.equal((await svc.addSubdomain(limited, { siteId: d.siteId, hostname: 'two.example.com' })).error, 'domain_limit_reached');
});

test('a subdomain of a domain already delegated to Lummet (same site) joins that zone and goes live through it', async () => {
  const env = makeEnv(); const { dns, infra, svc } = services();
  const a = await org(env, 'inzone@example.com');
  const zone = await svc.addZone(env, { siteId: a.siteId, domain: 'example.com', organizationId: a.organizationId });
  const cfId = infra._zoneIdByName('example.com');
  infra._activateZone(cfId);
  dns._setNameservers('example.com', ['amy.ns.fake.test', 'bob.ns.fake.test']);
  await svc.checkZone(env, zone.zoneId, { now: Date.now() });
  await svc.checkZone(env, zone.zoneId, { now: Date.now() + 2 * MIN });

  // The customer had shop.example.com pointing at another service: that record is replaced on attach.
  infra._zones.get(cfId).records.push({ id: 'old-shop', type: 'CNAME', name: 'shop.example.com', content: 'old.shopify.test' });
  const calls = infra._calls.length;
  infra._healthCheckResult = { ok: false, statusCode: null };
  const r = await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'shop.example.com', organizationId: a.organizationId });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.mode, 'zone');
  const shop = r.hostnames.find((h) => h.hostname === 'shop.example.com');
  assert.equal(shop.status, 'ssl_pending');
  assert.ok(infra._calls.slice(calls).some((c) => c.method === 'attachWorkerDomain' && c.hostname === 'shop.example.com'));
  assert.ok(!infra._zones.get(cfId).records.some((x) => x.id === 'old-shop'));
  assert.equal(infra._calls.filter((c) => c.method === 'createCustomHostname').length, 0, 'no SaaS custom hostname needed inside a delegated zone');

  infra._healthCheckResult = { ok: true, statusCode: 200 };
  const live = await svc.checkZone(env, zone.zoneId, { now: Date.now() + 5 * MIN });
  assert.equal(live.hostnames.find((h) => h.hostname === 'shop.example.com').status, 'active');

  // Removing it detaches just that hostname.
  const row = live.hostnames.find((h) => h.hostname === 'shop.example.com');
  assert.ok((await svc.removeAnyHostname(env, row)).ok);
  assert.equal((await svc.view(env, zone.zoneId)).hostnames.some((h) => h.hostname === 'shop.example.com'), false);
});

test('a subdomain of a zone that is still waiting for nameservers waits with it; other sites/accounts are refused', async () => {
  const env = makeEnv(); const { svc } = services();
  const a = await org(env, 'pendingzone@example.com');
  const zone = await svc.addZone(env, { siteId: a.siteId, domain: 'example.com', organizationId: a.organizationId });
  const r = await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'shop.example.com', organizationId: a.organizationId });
  assert.equal(r.mode, 'zone');
  assert.equal(r.hostnames.find((h) => h.hostname === 'shop.example.com').status, 'awaiting_nameservers');
  assert.equal(r.zone.id, zone.zoneId);

  const otherSite = await extraSite(env, a, 'Second site');
  assert.equal((await svc.addSubdomain(env, { siteId: otherSite, hostname: 'blog.example.com', organizationId: a.organizationId })).error, 'zone_belongs_to_another_site');

  const b = await org(env, 'stranger@example.com');
  assert.equal((await svc.addSubdomain(env, { siteId: b.siteId, hostname: 'blog.example.com', organizationId: b.organizationId })).error, 'domain_belongs_to_another_account');
});

test('removing a CNAME subdomain removes its route and custom hostname; cleanupForSite sweeps leftover routes', async () => {
  const env = makeEnv(); const { dns, infra, svc } = services();
  const a = await org(env, 'rm-sub@example.com');
  const r = await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'shop.example.com', organizationId: a.organizationId });
  dns._setTXTRecords('_lummet-verify.shop.example.com', [txtOf(r).value]);
  await svc.checkSubdomain(env, r.domainId, { now: Date.now() });
  infra._setCustomHostnameStatus((await svc.subdomainView(env, r.domainId)).domain.ssl_resource_id, 'active');
  await svc.checkSubdomain(env, r.domainId, { now: Date.now() + 3 * MIN });
  assert.equal((await sites.getSite(env, a.siteId)).primary_domain, 'shop.example.com');

  const row = (await svc.subdomainView(env, r.domainId)).domain;
  infra._deleteFailures.set('deleteWorkerRoute', 'Cloudflare 500');
  assert.equal((await svc.removeAnyHostname(env, row)).error, 'provider_error');
  assert.equal((await svc.subdomainView(env, r.domainId)).domain.status, 'active', 'nothing is marked removed while the provider still serves it');
  infra._deleteFailures.clear();
  assert.ok((await svc.removeAnyHostname(env, row)).ok);
  assert.ok(infra._calls.some((c) => c.method === 'deleteWorkerRoute' && c.routeId === row.route_id));
  assert.ok(infra._calls.some((c) => c.method === 'deleteCustomHostname' && c.resourceId === row.ssl_resource_id));
  const site = await sites.getSite(env, a.siteId);
  assert.equal(site.primary_domain, `${site.slug}.sites.lummet.test`);
  assert.deepEqual(await svc.listSubdomainsForSite(env, a.siteId), []);

  // Erasure marks rows removed first; the route must still be cleaned up afterwards.
  const r2 = await svc.addSubdomain(env, { siteId: a.siteId, hostname: 'blog.example.com', organizationId: a.organizationId });
  dns._setTXTRecords('_lummet-verify.blog.example.com', [txtOf(r2).value]);
  await svc.checkSubdomain(env, r2.domainId, { now: Date.now() });
  await env.LUMMET_DB.prepare(`UPDATE domains SET status = 'removed', ssl_resource_id = NULL WHERE id = ?`).bind(r2.domainId).run();
  infra._deleteFailures.set('deleteWorkerRoute', 'Cloudflare 500');
  const failures = await svc.cleanupForSite(env, a.siteId);
  assert.equal(failures.length, 1);
  assert.match(failures[0].step, /^route:/);
  infra._deleteFailures.clear();
  assert.deepEqual(await svc.cleanupForSite(env, a.siteId), []);
});
