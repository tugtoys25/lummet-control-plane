// Custom domains by nameserver delegation (v1): pure helpers, the service against fake Cloudflare + DNS, and the
// customer routes end to end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createFakeDnsResolver } from './support/fake-dns-resolver.js';
import worker from '../worker/index.js';
import { __setZoneProvidersForTests, createZoneDomainService, normalizeDomainInput, delegationMatches, nextCheckDelayMs, describeProgress, validateRecord, qualifyRecordName } from '../worker/zone-domains.js';
import { createProvisioningService } from '../worker/provisioning.js';
import * as plans from '../worker/plans.js';
import * as sites from '../worker/sites.js';
import * as repo from '../worker/repositories/domain-zones.js';

const MIN = 60 * 1000, HOUR = 60 * MIN;
let ipn = 1;
const makeEnv = (extra = {}) => { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ENVIRONMENT: 'production', CREDENTIAL_KEK: btoa('k'.repeat(32)), PLATFORM_DOMAIN_SUFFIX: 'sites.lummet.test', PORTAL_BASE_URL: 'https://app.lummet.test', ...extra }; };
const makeCtx = () => { const p = []; return { waitUntil(x) { p.push(Promise.resolve(x).catch(() => {})); }, async settle() { await Promise.all(p.splice(0)); } }; };
async function call(env, ctx, method, path, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': `198.51.100.${ipn++ % 250 + 1}` });
  if (cookie) h.set('Cookie', cookie);
  if (body !== undefined) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) }), env, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function setup(env, ctx, infra, email, plan = 'plan_casino_news_starter') {
  const s = await call(env, ctx, 'POST', '/api/customer/signup', { body: { email, password: 'Correct-Horse-Battery-9', organizationName: 'Org', displayName: 'T' } });
  assert.equal(s.status, 200, s.text);
  await plans.startTrialSubscription(env, s.json.organizationId, plan);
  const site = await sites.createSite(env, { organizationId: s.json.organizationId, name: 'Site', productId: 'prod_casino_news', actorUserId: s.json.userId });
  const prov = createProvisioningService(infra);
  const start = await prov.startProvisioning(env, site.siteId);
  await prov.runJob(env, start.jobId);
  return { orgId: s.json.organizationId, userId: s.json.userId, cookie: s.cookie, siteId: site.siteId };
}
function services(envExtra) {
  const infra = createFakeInfraProvider(); const dns = createFakeDnsResolver();
  return { infra, dns, svc: createZoneDomainService({ infra, dns }), env: makeEnv(envExtra) };
}
const NS = ['amy.ns.fake.test', 'bob.ns.fake.test'];

// ---------------------------------------------------------------- pure helpers
test('normalizeDomainInput cleans input, drops www, rejects junk and the platform\'s own names', () => {
  const env = { PLATFORM_DOMAIN_SUFFIX: 'sites.lummet.test', PORTAL_BASE_URL: 'https://app.lummet.test' };
  assert.equal(normalizeDomainInput('https://WWW.Example.COM/path?x=1', env).zoneName, 'example.com');
  assert.equal(normalizeDomainInput('example.co.uk.', env).zoneName, 'example.co.uk');
  assert.equal(normalizeDomainInput('bücher.de', env).zoneName, 'xn--bcher-kva.de');
  for (const bad of ['', 'not a domain', 'localhost', '10.0.0.1', 'example', '-x.com', 'a..com', 'foo.123']) assert.equal(normalizeDomainInput(bad, env).ok, false, bad);
  for (const r of ['sites.lummet.test', 'foo.sites.lummet.test', 'lummet.test', 'app.lummet.test', 'workers.dev', 'x.workers.dev']) {
    assert.equal(normalizeDomainInput(r, env).error, 'domain_reserved', r);
  }
});

test('delegationMatches / nextCheckDelayMs / describeProgress behave', () => {
  assert.equal(delegationMatches(NS, ['BOB.ns.fake.test.', 'amy.ns.fake.test']), true);
  assert.equal(delegationMatches(NS, ['amy.ns.fake.test']), false);
  assert.equal(delegationMatches(NS, [...NS, 'old.ns.registrar.test']), false);
  assert.equal(delegationMatches([], []), false);
  assert.equal(nextCheckDelayMs(0, 10 * MIN), 3 * MIN);
  assert.equal(nextCheckDelayMs(0, 3 * HOUR), 10 * MIN);
  assert.equal(nextCheckDelayMs(0, 5 * 24 * HOUR), 6 * HOUR);

  const hosts = [{ status: 'awaiting_nameservers' }, { status: 'awaiting_nameservers' }];
  assert.equal(describeProgress({ status: 'pending' }, hosts).phase, 'awaiting_nameservers');
  assert.equal(describeProgress({ status: 'pending', nameservers_detected_at: 'x' }, hosts).phase, 'nameservers_detected');
  assert.equal(describeProgress({ status: 'active' }, [{ status: 'dns_verified' }]).phase, 'attaching');
  assert.equal(describeProgress({ status: 'active' }, [{ status: 'ssl_pending' }]).phase, 'issuing_certificates');
  const live = describeProgress({ status: 'active' }, [{ status: 'active' }, { status: 'active' }]);
  assert.equal(live.phase, 'live'); assert.ok(live.steps.every((s) => s.state === 'done'));
  assert.equal(describeProgress({ status: 'expired' }, []).phase, 'expired');
});

test('record validation: names stay inside the zone, values match the type', () => {
  assert.equal(qualifyRecordName('@', 'example.com'), 'example.com');
  assert.equal(qualifyRecordName('mail', 'example.com'), 'mail.example.com');
  assert.equal(qualifyRecordName('_dmarc', 'example.com'), '_dmarc.example.com');
  assert.equal(qualifyRecordName('a.example.com', 'example.com'), 'a.example.com');
  assert.equal(qualifyRecordName('evil.org', 'example.com'), null);
  assert.equal(validateRecord({ type: 'MX', name: '@', content: 'Mail.Example.net.', priority: 10 }, 'example.com').record.content, 'mail.example.net');
  assert.equal(validateRecord({ type: 'MX', name: '@', content: 'mail.example.net' }, 'example.com').error, 'invalid_record_priority');
  assert.equal(validateRecord({ type: 'A', name: '@', content: '999.1.1.1' }, 'example.com').error, 'invalid_record_content');
  assert.equal(validateRecord({ type: 'CNAME', name: '@', content: 'x.example.net' }, 'example.com').error, 'cname_at_root_not_allowed');
  assert.equal(validateRecord({ type: 'SRV', name: '@', content: 'x' }, 'example.com').error, 'unsupported_record_type');
  assert.equal(validateRecord({ type: 'TXT', name: '@', content: 'v=spf1 -all' }, 'example.com').ok, true);
  assert.equal(validateRecord({ type: 'TXT', name: 'x.evil.org', content: 'a' }, 'example.com').error, 'record_outside_domain');
});

// ---------------------------------------------------------------- addZone
test('addZone creates the zone, stores the nameservers, registers apex + www and asks for a records scan', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'add@example.com');
  const r = await svc.addZone(env, { siteId: a.siteId, domain: 'WWW.Example.com', actorUserId: a.userId, organizationId: a.orgId });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.zone.name_servers, NS);
  assert.equal(r.zone.zone_name, 'example.com');
  assert.deepEqual(r.hostnames.map((h) => [h.hostname, h.status, h.method]), [['example.com', 'awaiting_nameservers', 'nameservers'], ['www.example.com', 'awaiting_nameservers', 'nameservers']]);
  assert.equal(r.progress.phase, 'awaiting_nameservers');
  assert.ok(infra._calls.some((c) => c.method === 'triggerDnsScan'));
  assert.ok(r.zone.expires_at > new Date().toISOString());
});

test('addZone refuses: bad input, reserved names, another org\'s site, duplicates, unready site, provider refusals', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'refuse-a@example.com');
  const b = await setup(env, ctx, infra, 'refuse-b@example.com');
  assert.equal((await svc.addZone(env, { siteId: a.siteId, domain: 'nope' })).error, 'invalid_domain');
  assert.equal((await svc.addZone(env, { siteId: a.siteId, domain: 'sites.lummet.test' })).error, 'domain_reserved');
  assert.equal((await svc.addZone(env, { siteId: a.siteId, domain: 'x.com', organizationId: b.orgId })).status, 404);
  assert.equal((await svc.addZone(env, { siteId: 'missing', domain: 'x.com' })).status, 404);
  assert.equal((await svc.addZone(env, { siteId: a.siteId, domain: 'taken.com', organizationId: a.orgId })).ok, true);
  const dup = await svc.addZone(env, { siteId: b.siteId, domain: 'taken.com', organizationId: b.orgId });
  assert.equal(dup.error, 'domain_already_connected'); assert.equal(dup.status, 409);

  infra._zoneFailure = 'Please ensure you are providing the root domain and not any subdomains.';
  assert.equal((await svc.addZone(env, { siteId: b.siteId, domain: 'a.b.com' })).error, 'not_a_root_domain');
  infra._zoneFailure = 'This zone is already on another account';
  assert.equal((await svc.addZone(env, { siteId: b.siteId, domain: 'c.com' })).error, 'domain_unavailable');
  infra._zoneFailure = 'boom';
  const pe = await svc.addZone(env, { siteId: b.siteId, domain: 'd.com' });
  assert.equal(pe.error, 'provider_error'); assert.equal(pe.status, 502);

  await env.LUMMET_DB.prepare(`UPDATE sites SET status = 'suspended' WHERE id = ?`).bind(b.siteId).run();
  assert.equal((await svc.addZone(env, { siteId: b.siteId, domain: 'e.com' })).error, 'site_not_ready');
});

test('addZone never adopts the platform zone, a claimed zone, or an active unclaimed zone', async () => {
  const { infra, svc, env } = services({ CF_ZONE_ID: 'fake-zone-platform' }); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'adopt@example.com');
  infra._zones.set('fake-zone-platform', { name: 'platform.test', status: 'pending', nameServers: NS, records: [], scanned: [] });
  assert.equal((await svc.addZone(env, { siteId: a.siteId, domain: 'platform.test' })).error, 'domain_unavailable');
  infra._zones.set('fake-zone-ops', { name: 'ops-owned.test', status: 'active', nameServers: NS, records: [], scanned: [] });
  assert.equal((await svc.addZone(env, { siteId: a.siteId, domain: 'ops-owned.test' })).error, 'domain_unavailable');
  // nothing was stored for either
  assert.equal((await repo.listForSite(env, a.siteId)).length, 0);
});

test('the plan\'s custom domain limit counts a zone (apex + www) once, and 0 means none', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'limit@example.com');           // starter: 1 custom domain
  assert.equal((await svc.addZone(env, { siteId: a.siteId, domain: 'one.com' })).ok, true);
  const second = await svc.addZone(env, { siteId: a.siteId, domain: 'two.com' });
  assert.equal(second.error, 'domain_limit_reached'); assert.equal(second.status, 403); assert.equal(second.limit, 1);
  assert.equal(await repo.countCustomDomains(env, a.orgId), 1);
});

// ---------------------------------------------------------------- the whole journey
test('full journey: nameservers detected -> Cloudflare active -> old records replaced -> certificate -> live + primary + redeploy', async () => {
  const { infra, dns, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'journey@example.com');
  const added = await svc.addZone(env, { siteId: a.siteId, domain: 'example.com', actorUserId: a.userId });
  const zoneId = added.zoneId, cfId = infra._zoneIdByName('example.com');
  // The customer's old website records, imported into the zone.
  infra._zones.get(cfId).records.push({ id: 'old-a', type: 'A', name: 'example.com', content: '192.0.2.1' }, { id: 'old-www', type: 'CNAME', name: 'www.example.com', content: 'old.host.test' }, { id: 'mx', type: 'MX', name: 'example.com', content: 'mail.example.net', priority: 10 });
  let now = Date.now(); const redeploys = [];
  const check = (opts = {}) => svc.checkZone(env, zoneId, { now, redeploy: async (id) => { redeploys.push(id); }, ...opts });

  // 1. registrar still on the old nameservers
  dns._setNameservers('example.com', ['ns1.oldhost.test', 'ns2.oldhost.test']);
  let r = await check();
  assert.equal(r.progress.phase, 'awaiting_nameservers');
  assert.equal(infra._activationChecks, 0, 'no point asking Cloudflare to re-check yet');

  // 2. registrar updated; public DNS shows our nameservers; Cloudflare not yet convinced
  dns._setNameservers('example.com', NS); now += 5 * MIN;
  r = await check();
  assert.equal(r.progress.phase, 'nameservers_detected');
  assert.ok(r.zone.nameservers_detected_at);
  assert.equal(infra._activationChecks, 1, 'asked Cloudflare to re-check once');
  now += 5 * MIN; r = await check();
  assert.equal(infra._activationChecks, 1, 'but not again within the rate-limit window');
  assert.equal(r.zone.status, 'pending');

  // 3. Cloudflare confirms. Old A/CNAME replaced, hostnames attached, certificates pending (HTTPS not up yet).
  infra._activateZone(cfId); now += 5 * MIN;
  infra._healthByUrl.set('https://example.com/', { ok: false, statusCode: null });
  infra._healthByUrl.set('https://www.example.com/', { ok: false, statusCode: null });
  r = await check();
  assert.equal(r.zone.status, 'active');
  assert.equal(r.progress.phase, 'issuing_certificates');
  assert.deepEqual(r.hostnames.map((h) => h.status), ['ssl_pending', 'ssl_pending']);
  const left = infra._zones.get(cfId).records.map((x) => x.id);
  assert.deepEqual(left, ['mx'], 'website records removed, the MX record untouched');
  const attach = infra._calls.filter((c) => c.method === 'attachWorkerDomain');
  assert.deepEqual(attach.map((c) => c.hostname).sort(), ['example.com', 'www.example.com']);
  assert.ok(attach.every((c) => c.workerName.startsWith('lummet-site-') && c.zoneId === cfId));
  assert.equal(redeploys.length, 0, 'not live yet, nothing to redeploy for');

  // 4. HTTPS answers on one hostname: it is live, becomes primary, redeploy happens once
  infra._healthByUrl.set('https://example.com/', { ok: true, statusCode: 200 });
  now += 2 * MIN; r = await check();
  assert.deepEqual(r.hostnames.map((h) => h.status), ['active', 'ssl_pending']);
  let site = await sites.getSite(env, a.siteId);
  assert.equal(site.primary_domain, 'example.com');
  assert.deepEqual(redeploys, [a.siteId]);

  // 5. both live; zone finished (no more sweeping); still exactly one redeploy
  infra._healthByUrl.set('https://www.example.com/', { ok: true, statusCode: 200 });
  now += 2 * MIN; r = await check();
  assert.equal(r.progress.phase, 'live');
  assert.equal(redeploys.length, 1);
  const done = await repo.getZone(env, zoneId);
  assert.equal(done.next_check_at, null);
  assert.equal((await repo.listDueForSweep(env, { nowIso: new Date(now + 99 * HOUR).toISOString() })).length, 0);
  // exactly one primary
  assert.equal((await repo.listHostnames(env, zoneId)).filter((h) => h.is_primary).length, 1);
});

test('a hostname that cannot be attached keeps retrying and gives up after the window; a zone deleted at the provider fails cleanly', async () => {
  const { infra, dns, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'attachfail@example.com');
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'flaky.com' });
  const cfId = infra._zoneIdByName('flaky.com'); infra._activateZone(cfId); infra._attachFailure = 'worker not found';
  let now = Date.now();
  let r = await svc.checkZone(env, zoneId, { now });
  assert.deepEqual(r.hostnames.map((h) => h.status), ['dns_verified', 'dns_verified']);
  assert.match(r.hostnames[0].failure_reason, /attach_failed: worker not found/);
  now += 25 * HOUR;
  r = await svc.checkZone(env, zoneId, { now });
  assert.equal(r.zone.status, 'failed', 'every hostname failed, so the zone is failed and says why');
  assert.equal(r.zone.failure_reason, 'could_not_connect_hostnames');

  const b = await setup(env, ctx, infra, 'gone@example.com');
  const z2 = await svc.addZone(env, { siteId: b.siteId, domain: 'gone.com' });
  infra._setZoneStatus(infra._zoneIdByName('gone.com'), 'deleted');
  r = await svc.checkZone(env, z2.zoneId, { now });
  assert.equal(r.zone.status, 'failed'); assert.equal(r.zone.failure_reason, 'zone_removed_at_provider');
});

test('manual checks are throttled; provider outages do not break the check; DNS lookup failures are not errors', async () => {
  const { infra, dns, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'throttle@example.com');
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'throttle.com' });
  const now = Date.now();
  assert.ok(!(await svc.checkZone(env, zoneId, { manual: true, now })).throttled);
  const second = await svc.checkZone(env, zoneId, { manual: true, now: now + 5000 });
  assert.equal(second.throttled, true);
  assert.ok(!(await svc.checkZone(env, zoneId, { manual: true, now: now + 30000 })).throttled);
  dns._failNsLookups();
  const r = await svc.checkZone(env, zoneId, { now: now + 60000 });
  assert.equal(r.ok, true); assert.equal(r.zone.status, 'pending');
  infra.getZone = async () => { throw new Error('cloudflare down'); };
  const out = await svc.checkZone(env, zoneId, { now: now + 120000 });
  assert.equal(out.ok, true); assert.equal(out.providerError, true); assert.equal(out.zone.status, 'pending');
  assert.ok(out.zone.next_check_at > new Date(now).toISOString());
});

test('a claim whose nameservers never change expires, is released, and the name can be claimed again', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'expire@example.com');
  const first = await svc.addZone(env, { siteId: a.siteId, domain: 'squat.com' });
  const cf = infra._zoneIdByName('squat.com');
  let r = await svc.checkZone(env, first.zoneId, { now: Date.now() + 8 * 24 * HOUR });
  assert.equal(r.zone.status, 'expired'); assert.equal(r.progress.phase, 'expired');
  assert.equal(infra._zones.get(cf).status, 'deleted', 'the provider zone is deleted');
  assert.deepEqual((await repo.listHostnames(env, first.zoneId)), [], 'hostnames freed');
  const again = await svc.addZone(env, { siteId: a.siteId, domain: 'squat.com' });
  assert.equal(again.ok, true, JSON.stringify(again));
});

test('a reminder goes out once after a day without a nameserver change', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'remind@example.com');
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'remind.com' });
  const t0 = Date.now();
  await svc.checkZone(env, zoneId, { now: t0 + 25 * HOUR });
  await svc.checkZone(env, zoneId, { now: t0 + 26 * HOUR });
  const events = (await repo.listEvents(env, zoneId)).filter((e) => e.kind === 'reminder');
  assert.equal(events.length, 1);
  const queued = (await env.LUMMET_DB.prepare(`SELECT subject FROM email_outbox WHERE dedupe_key LIKE 'domain-reminder:%'`).all()).results;
  assert.equal(queued.length, 1);
  assert.match(queued[0].subject, /remind\.com/);
});

test('sweep advances only due zones and survives one broken zone', async () => {
  const { infra, dns, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'sweep@example.com', 'plan_agency_30');
  const z1 = await svc.addZone(env, { siteId: a.siteId, domain: 'one.com' });
  const z2 = await svc.addZone(env, { siteId: a.siteId, domain: 'two.com' });
  const now = Date.now();
  assert.equal((await svc.sweep(env, { now })).checked, 0, 'neither is due for 3 minutes');
  infra.getZone = async (e, id) => { if (id === infra._zoneIdByName('one.com')) throw new Error('x'); return { zoneId: id, nameServers: NS, cfStatus: 'pending', status: 'pending' }; };
  dns.lookupNS = async (d) => { if (d === 'one.com') throw new Error('unexpected'); return { ok: true, nameServers: NS }; };
  const out = await svc.sweep(env, { now: now + 10 * MIN });
  assert.equal(out.checked, 2);
  assert.ok(out.results.some((r) => r.error === 'unexpected_exception'));
  assert.ok(out.results.some((r) => r.phase === 'nameservers_detected'));
  assert.ok((await repo.getZone(env, z1.zoneId)).next_check_at > new Date(now + 10 * MIN).toISOString());
});

// ---------------------------------------------------------------- removal
test('removing an active, still-delegated domain needs acknowledgement; hostnames and the zone are cleaned up', async () => {
  const { infra, dns, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'remove@example.com');
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'bye.com' });
  const cf = infra._zoneIdByName('bye.com'); infra._activateZone(cf);
  await svc.checkZone(env, zoneId, { now: Date.now() });
  dns._setNameservers('bye.com', NS);
  const refused = await svc.removeZone(env, zoneId, { organizationId: a.orgId });
  assert.equal(refused.error, 'nameservers_still_delegated'); assert.equal(refused.status, 409);
  assert.equal((await repo.getZone(env, zoneId)).status, 'active');
  assert.equal((await svc.removeZone(env, zoneId, { organizationId: 'someone-else', acknowledgeOutage: true })).status, 404);
  const ok = await svc.removeZone(env, zoneId, { organizationId: a.orgId, acknowledgeOutage: true });
  assert.equal(ok.ok, true);
  assert.equal(infra._zones.get(cf).status, 'deleted');
  assert.equal(infra._customDomains.size, 0, 'both hostnames detached');
  assert.equal((await repo.getZone(env, zoneId)).status, 'removed');

  // delegated away already -> no acknowledgement needed
  const b = await setup(env, ctx, infra, 'remove2@example.com');
  const z = await svc.addZone(env, { siteId: b.siteId, domain: 'away.com' });
  infra._activateZone(infra._zoneIdByName('away.com'));
  await svc.checkZone(env, z.zoneId, { now: Date.now() });
  dns._setNameservers('away.com', ['ns1.back.test', 'ns2.back.test']);
  assert.equal((await svc.removeZone(env, z.zoneId, { organizationId: b.orgId })).ok, true);
});

test('a provider failure while removing leaves everything in place for a retry', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'removefail@example.com');
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'stuck.com' });
  infra._deleteFailures.set('deleteZone', 'cloudflare 500');
  const r = await svc.removeZone(env, zoneId, { organizationId: a.orgId });
  assert.equal(r.error, 'provider_error');
  assert.equal((await repo.getZone(env, zoneId)).status, 'pending');
  infra._deleteFailures.delete('deleteZone');
  assert.equal((await svc.removeZone(env, zoneId, { organizationId: a.orgId })).ok, true);
});

test('cleanupForSite removes custom domains and zones and reports failures', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'cleanup@example.com');
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'clean.com' });
  infra._activateZone(infra._zoneIdByName('clean.com'));
  await svc.checkZone(env, zoneId, { now: Date.now() });
  infra._deleteFailures.set('deleteZone', 'nope');
  const failures = await svc.cleanupForSite(env, a.siteId);
  assert.equal(failures.length, 1); assert.match(failures[0].step, /^zone:/);
  assert.equal(infra._customDomains.size, 0);
  infra._deleteFailures.delete('deleteZone');
  assert.deepEqual(await svc.cleanupForSite(env, a.siteId), []);
  assert.equal((await repo.getZone(env, zoneId)).status, 'removed');
});

// ---------------------------------------------------------------- DNS records
test('records: list marks managed ones, add validates, managed website records are protected, import skips them', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'records@example.com');
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'mail.com', organizationId: a.orgId });
  const cf = infra._zoneIdByName('mail.com'); const z = infra._zones.get(cf);
  z.scanned.push({ id: 's1', type: 'A', name: 'mail.com', content: '192.0.2.1' }, { id: 's2', type: 'MX', name: 'mail.com', content: 'mx.host.net', priority: 5 }, { id: 's3', type: 'TXT', name: 'mail.com', content: 'v=spf1 -all' });

  const imp = await svc.importScanned(env, zoneId, { organizationId: a.orgId });
  assert.deepEqual(imp, { ok: true, imported: 2 });
  assert.deepEqual(z.records.map((r) => r.id).sort(), ['s2', 's3'], 'the old A record for the hostname Lummet serves is not imported');

  assert.equal((await svc.addRecord(env, zoneId, { type: 'A', name: '@', content: '1.2.3.4' }, { organizationId: a.orgId })).error, 'hostname_managed_by_lummet');
  assert.equal((await svc.addRecord(env, zoneId, { type: 'A', name: 'www', content: '1.2.3.4' }, { organizationId: a.orgId })).error, 'hostname_managed_by_lummet');
  const added = await svc.addRecord(env, zoneId, { type: 'A', name: 'shop', content: '1.2.3.4' }, { organizationId: a.orgId });
  assert.equal(added.ok, true); assert.equal(added.record.name, 'shop.mail.com');
  assert.equal((await svc.addRecord(env, zoneId, { type: 'A', name: 'shop', content: '1.2.3.4' }, { organizationId: a.orgId })).error, 'record_exists');
  assert.equal((await svc.addRecord(env, zoneId, { type: 'TXT', name: 'x', content: 'y' }, { organizationId: 'other' })).status, 404);

  const list = await svc.listRecords(env, zoneId, { organizationId: a.orgId });
  assert.equal(list.ok, true);
  assert.equal(list.records.length, 3);
  const del = await svc.deleteRecord(env, zoneId, added.record.id, { organizationId: a.orgId });
  assert.equal(del.ok, true);
  assert.equal((await svc.deleteRecord(env, zoneId, 'missing', { organizationId: a.orgId })).error, 'record_not_found');
});

// ---------------------------------------------------------------- routes
test('routes: add, view, check, records and removal work for admins; are scoped to the organization; legacy actions refuse nameserver domains', async (t) => {
  const infra = createFakeInfraProvider(), dns = createFakeDnsResolver();
  __setZoneProvidersForTests({ infra, dns }); t.after(() => __setZoneProvidersForTests());
  const env = makeEnv(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'routes-a@example.com');
  const b = await setup(env, ctx, infra, 'routes-b@example.com');
  const base = `/api/organizations/${a.orgId}`;

  const unauth = await call(env, ctx, 'POST', `${base}/sites/${a.siteId}/domain-zones`, { body: { domain: 'routes.com' } });
  assert.ok([401, 403].includes(unauth.status));

  const bad = await call(env, ctx, 'POST', `${base}/sites/${a.siteId}/domain-zones`, { cookie: a.cookie, body: { domain: 'nope' } });
  assert.equal(bad.status, 422); assert.equal(bad.json.error, 'invalid_domain');

  const add = await call(env, ctx, 'POST', `${base}/sites/${a.siteId}/domain-zones`, { cookie: a.cookie, body: { domain: 'routes.com' } });
  assert.equal(add.status, 201, add.text);
  assert.deepEqual(add.json.zone.name_servers, NS);
  const zoneId = add.json.zoneId;

  // another organization can neither see nor touch it
  assert.equal((await call(env, ctx, 'GET', `/api/organizations/${b.orgId}/domain-zones/${zoneId}`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(env, ctx, 'POST', `/api/organizations/${b.orgId}/domain-zones/${zoneId}/check`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(env, ctx, 'DELETE', `/api/organizations/${b.orgId}/domain-zones/${zoneId}`, { cookie: b.cookie })).status, 404);
  assert.equal((await call(env, ctx, 'GET', `/api/organizations/${b.orgId}/sites/${a.siteId}/domain-zones`, { cookie: b.cookie })).status, 404);

  const list = await call(env, ctx, 'GET', `${base}/sites/${a.siteId}/domain-zones`, { cookie: a.cookie });
  assert.equal(list.json.data.length, 1);
  assert.equal(list.json.data[0].progress.phase, 'awaiting_nameservers');

  // legacy verify/ssl refuse a nameserver-method hostname
  const hostId = add.json.hostnames[0].id;
  const legacy = await call(env, ctx, 'POST', `${base}/domains/${hostId}/verify`, { cookie: a.cookie });
  assert.equal(legacy.status, 409); assert.equal(legacy.json.error, 'managed_by_nameserver_flow');

  // customer's records
  const rec = await call(env, ctx, 'POST', `${base}/domain-zones/${zoneId}/records`, { cookie: a.cookie, body: { type: 'TXT', name: '@', content: 'hello' } });
  assert.equal(rec.status, 200, rec.text);
  const recs = await call(env, ctx, 'GET', `${base}/domain-zones/${zoneId}/records`, { cookie: a.cookie });
  assert.equal(recs.json.records.length, 1);

  // check now -> detected
  dns._setNameservers('routes.com', NS);
  const chk = await call(env, ctx, 'POST', `${base}/domain-zones/${zoneId}/check`, { cookie: a.cookie });
  assert.equal(chk.status, 200, chk.text);
  assert.equal(chk.json.progress.phase, 'nameservers_detected');

  // the portal page renders the card with the nameservers
  const page = await call(env, ctx, 'GET', '/app/domains', { cookie: a.cookie });
  assert.equal(page.status, 200);
  assert.ok(page.text.includes('amy.ns.fake.test') && page.text.includes('routes.com'));

  // removal of a not-yet-active domain needs no acknowledgement
  const del = await call(env, ctx, 'DELETE', `${base}/domain-zones/${zoneId}`, { cookie: a.cookie });
  assert.equal(del.status, 200, del.text);
  assert.equal((await call(env, ctx, 'GET', `${base}/sites/${a.siteId}/domain-zones`, { cookie: a.cookie })).json.data.length, 0);
});

test('the maintenance tick sweeps delegated domains', async (t) => {
  const infra = createFakeInfraProvider(), dns = createFakeDnsResolver();
  __setZoneProvidersForTests({ infra, dns }); t.after(() => __setZoneProvidersForTests());
  const env = makeEnv({ ALERT_CHECK_TOKEN: 'tick-token' }); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'tick@example.com');
  const svc = createZoneDomainService({ infra, dns });
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'tick.com' });
  await env.LUMMET_DB.prepare(`UPDATE domain_zones SET next_check_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).bind(zoneId).run();
  infra._activateZone(infra._zoneIdByName('tick.com'));
  infra._healthByUrl.set('https://tick.com/', { ok: true, statusCode: 200 });
  const h = new Headers({ Authorization: 'Bearer tick-token' });
  const res = await worker.fetch(new Request('https://cp.test/api/ops/alert-check', { method: 'POST', headers: h }), env, ctx);
  assert.equal(res.status, 200);
  await ctx.settle();
  assert.equal((await repo.getZone(env, zoneId)).status, 'active');
  assert.ok((await repo.listHostnames(env, zoneId)).some((x) => x.status === 'active'));
});

// ---------------------------------------------------------------- alert, staff screen, page, config checker
import { runAlertCheck } from '../worker/alerts.js';
import * as staff from '../worker/staff-saas.js';
import { renderDomainsPage } from '../worker/views/customer-pages/domains.js';
import { execFileSync } from 'node:child_process';

test('failed_domains alert fires for a failed zone, not for a customer who has simply not changed nameservers', async () => {
  const { infra, svc, env } = services({ ALERT_WEBHOOK_URL: 'https://hooks.example.test/x', STRIPE_SECRET_KEY: 's', STRIPE_WEBHOOK_SECRET: 's', CF_API_TOKEN: 't', CF_ACCOUNT_ID: 'a', CF_ZONE_ID: 'z', EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'r', EMAIL_FROM: 'a <a@b.test>', ALERT_CHECK_TOKEN: 'x', CSP_MODE: 'enforce', WEBAUTHN_RP_ID: 'a.test', WEBAUTHN_ORIGIN: 'https://a.test' });
  const ctx = makeCtx(); const a = await setup(env, ctx, infra, 'alert@example.com');
  const sent = []; const fetchImpl = async (u, i) => { sent.push(i?.body); return new Response('', { status: 200 }); };
  const { zoneId } = await svc.addZone(env, { siteId: a.siteId, domain: 'alert.com' });
  const fired = (r) => r.results.filter((x) => x.action === 'notified').map((x) => x.key);
  assert.ok(!fired(await runAlertCheck(env, { fetchImpl })).includes('failed_domains'));
  infra._setZoneStatus(infra._zoneIdByName('alert.com'), 'deleted');
  await svc.checkZone(env, zoneId, { now: Date.now() });
  assert.ok(fired(await runAlertCheck(env, { fetchImpl })).includes('failed_domains'));
});

test('staff can list delegated domains with their organization', async () => {
  const { infra, svc, env } = services(); const ctx = makeCtx();
  const a = await setup(env, ctx, infra, 'staff@example.com');
  await svc.addZone(env, { siteId: a.siteId, domain: 'staff.com' });
  const rows = await staff.listAllZones(env, {});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].zone_name, 'staff.com'); assert.deepEqual(rows[0].name_servers, NS); assert.equal(rows[0].organization_id, a.orgId);
  assert.equal((await staff.listAllZones(env, { status: 'active' })).length, 0);
});

test('the Domains page shows nameservers while waiting, escapes everything, and offers no controls to read-only members', async () => {
  const zone = { id: 'z1', zone_name: 'evil"><b>.com', status: 'pending', name_servers: ['a.ns.test', 'b.ns.test'], expires_at: '2026-10-23T00:00:00Z' };
  const hostnames = [{ id: 'h1', hostname: 'x<i>.com', status: 'awaiting_nameservers', ssl_status: 'none', is_primary: 0 }];
  const progress = describeProgress(zone, hostnames);
  const data = { sites: [{ id: 's1', name: 'S' }], domainsBySite: { s1: [] }, zonesBySite: { s1: [{ zone, hostnames, progress, events: [] }] } };
  const admin = renderDomainsPage({ ...data, canManage: true });
  assert.ok(admin.includes('a.ns.test') && admin.includes('Check now') && admin.includes('Connect your domain'));
  assert.ok(!admin.includes('<b>.com') && !admin.includes('x<i>'));
  const member = renderDomainsPage({ ...data, canManage: false });
  assert.ok(member.includes('a.ns.test'));
  assert.ok(!member.includes('Check now') && !member.includes('Connect your domain') && !member.includes('Remove domain'));
  const script = admin.match(/<script nonce="[^"]*">([\s\S]*?)<\/script>/)[1];
  assert.doesNotThrow(() => new Function(script), 'the page script is valid JavaScript');
  assert.ok(!/\son(click|submit|change)=/.test(admin), 'no inline handlers (CSP)');
});

test('check-config reports a placeholder setup (the template) and exits non-zero', () => {
  let out = '', code = 0;
  try { out = execFileSync('node', ['scripts/check-config.mjs', '--config', 'wrangler.example.jsonc'], { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8', env: { PATH: process.env.PATH } }); }
  catch (e) { code = e.status; out = e.stdout; }
  assert.equal(code, 1);
  assert.match(out, /CF_API_TOKEN/); assert.match(out, /placeholder/);
  assert.ok(!/[A-Za-z0-9+/]{30,}={0,2}\s*$/m.test(out.replace(/MISSING [^\n]*/g, '')), 'prints names, never values');
});
