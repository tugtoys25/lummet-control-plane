// Moving a site to another platform domain: ordering, resumability, rollback, custom primary domain, redirect and sweep.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createSiteDomainMoveService, redirectResponseFor } from '../worker/site-domain-moves.js';
import { handlePlatformDomainsRoute } from '../worker/platform-domains-routes.js';
import { setPermission } from '../worker/rbac.js';
import * as pd from '../worker/platform-domains.js';
import * as repo from '../worker/repositories/platform-domains.js';
import * as movesRepo from '../worker/repositories/site-domain-moves.js';
import * as siteResources from '../worker/repositories/site-resources.js';

const q = (env, sql, ...a) => env.LUMMET_DB.prepare(sql).bind(...a).first();

async function setup({ primary = 'default', status = 'active' } = {}) {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default', CF_SELF_WORKER_NAME: 'control-plane' };
  const def = await pd.getDefaultDomain(env);
  await repo.insert(env, { id: 'dom-b', hostname: 'b.com', label: 'B', cfZoneId: 'zone-b', status: 'active', sortOrder: 1 });
  await db.prepare(`INSERT INTO organizations (id, name, slug, status) VALUES ('o1','Org','org','active')`).run();
  const prod = await q(env, `SELECT id FROM products LIMIT 1`);
  await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES ('t1','Brand','brand.lummet.app','https://brand.lummet.app')`).run();
  const primaryDomain = primary === 'default' ? 'brand.lummet.app' : primary;
  await db.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, tenant_id, primary_domain, platform_domain_id) VALUES ('s1','o1',?,'Brand','brand',?,'t1',?,?)`).bind(prod.id, status, primaryDomain, def.id).run();
  await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES ('s1','fake-cloudflare','worker','w-brand','lummet-tenant-brand')`).run();
  await siteResources.saveRoute(env, { siteId: 's1', provider: 'fake-cloudflare', routeId: 'old-route', pattern: 'brand.lummet.app/*', zoneId: null });
  const infra = createFakeInfraProvider();
  const redeployed = [];
  const redeploy = async (_e, siteId) => { redeployed.push(siteId); return redeploy.result || { ok: true }; };
  const svc = createSiteDomainMoveService({ infra, redeploy });
  const state = async () => ({
    tenant: await q(env, `SELECT host, api_base_url FROM tenants WHERE id = 't1'`),
    site: await q(env, `SELECT primary_domain, platform_domain_id FROM sites WHERE id = 's1'`),
    route: await siteResources.findActiveResource(env, 's1', 'route'),
    redirect: await q(env, `SELECT * FROM site_host_redirects WHERE old_host = 'brand.lummet.app'`)
  });
  return { env, infra, svc, redeployed, redeploy, def, state };
}
const go = (t, extra = {}) => t.svc.start(t.env, { siteId: 's1', targetDomainId: 'dom-b', confirmHostname: 'brand.b.com', actorId: 'staff:1', ...extra });
const calls = (t, method) => t.infra._calls.filter((c) => c.method === method);

test('preview: new host, effects, and every blocker', async () => {
  const t = await setup();
  const p = await t.svc.preview(t.env, 's1', 'dom-b');
  assert.deepEqual([p.ok, p.oldHost, p.newHost, p.blockers, p.redirectDays, p.customPrimary], [true, 'brand.lummet.app', 'brand.b.com', [], 30, false]);
  assert.match(p.effects.join(' '), /brand\.lummet\.app to brand\.b\.com/);
  assert.match(p.effects.join(' '), /redirects to brand\.b\.com for 30 days/);
  assert.match((await t.svc.preview(t.env, 's1', t.def.id)).blockers.join(' '), /already on that domain/);
  await repo.update(t.env, 'dom-b', { status: 'disabled' });
  assert.match((await t.svc.preview(t.env, 's1', 'dom-b')).blockers.join(' '), /disabled; it must be active/);
  assert.match((await t.svc.preview(t.env, 's1', 'dom-b', { redirectDays: 400 })).blockers.join(' '), /0 to 365/);
  assert.equal((await t.svc.preview(t.env, 'nope', 'dom-b')).error, 'site_not_found');
  const sus = await setup({ status: 'suspended' });
  assert.match((await sus.svc.preview(sus.env, 's1', 'dom-b')).blockers.join(' '), /suspended; only an active site/);
});

test('custom primary domain is described in the preview', async () => {
  const t = await setup({ primary: 'shop.customer.com' });
  const p = await t.svc.preview(t.env, 's1', 'dom-b');
  assert.equal(p.customPrimary, true);
  assert.match(p.effects.join(' '), /custom domain and is NOT changed/);
});

test('happy path: correct order, everything switched in one go, redirect live, old route kept (repointed), audit-ready result', async () => {
  const t = await setup();
  const r = await go(t);
  assert.deepEqual([r.ok, r.state], [true, 'redirecting']);
  const order = t.infra._calls.map((c) => `${c.method}:${c.pattern || c.url || c.routeId || ''}`).filter((x) => /ensureWorkerRoute|checkHealth|deleteWorkerRoute/.test(x));
  assert.deepEqual(order, ['ensureWorkerRoute:brand.b.com/*', 'checkHealth:https://brand.b.com/', 'ensureWorkerRoute:brand.lummet.app/*'], 'new route, then health, then old host repointed; nothing deleted');
  const [newRoute, oldRoute] = calls(t, 'ensureWorkerRoute');
  assert.deepEqual([newRoute.workerName, newRoute.zoneId], ['lummet-tenant-brand', 'zone-b']);
  assert.equal(oldRoute.workerName, 'control-plane', 'old host now answered by the control plane');
  assert.equal(oldRoute.zoneId, 'zone-default', 'in the zone the old route lives in');
  assert.equal(calls(t, 'deleteWorkerRoute').length, 0);
  const s = await t.state();
  assert.deepEqual({ ...s.tenant }, { host: 'brand.b.com', api_base_url: 'https://brand.b.com' });
  assert.deepEqual([s.site.primary_domain, s.site.platform_domain_id], ['brand.b.com', 'dom-b']);
  assert.equal(s.route.resource_name, 'brand.b.com/*');
  assert.equal(siteResources.routeZoneId(s.route), 'zone-b');
  assert.equal(s.redirect.new_host, 'brand.b.com');
  const days = (Date.parse(s.redirect.expires_at) - Date.now()) / 86400000;
  assert.ok(days > 29.9 && days <= 30);
  assert.deepEqual(t.redeployed, ['s1']);
  const move = await movesRepo.getMove(t.env, r.moveId);
  assert.deepEqual(Object.keys(move.steps), ['new_route', 'check_new_host', 'switch', 'redeploy', 'redirect']);
  assert.equal(move.requested_by, 'staff:1');
});

test('typed confirmation is required and nothing happens without it', async () => {
  const t = await setup();
  const r = await go(t, { confirmHostname: 'brand.lummet.app' });
  assert.deepEqual([r.ok, r.error], [false, 'confirmation_required']);
  assert.equal(t.infra._calls.filter((c) => /Route|Health/.test(c.method)).length, 0);
  assert.equal((await t.state()).tenant.host, 'brand.lummet.app');
  assert.equal((await movesRepo.listMovesForSite(t.env, 's1')).length, 0);
});

test('a custom primary domain is never overwritten; the platform host still moves; no redeploy needed', async () => {
  const t = await setup({ primary: 'shop.customer.com' });
  const r = await go(t);
  assert.equal(r.state, 'redirecting');
  const s = await t.state();
  assert.equal(s.site.primary_domain, 'shop.customer.com');
  assert.deepEqual([s.tenant.host, s.site.platform_domain_id], ['brand.b.com', 'dom-b']);
  assert.equal(t.redeployed.length, 0);
});

test('new route fails: nothing changed, old route untouched; resume completes', async () => {
  const t = await setup();
  t.infra._routeFailByPattern.set('brand.b.com/*', 'Cloudflare says no (zone permissions)');
  const r = await go(t);
  assert.deepEqual([r.ok, r.step, r.state], [false, 'new_route', 'failed']);
  assert.match(r.detail, /zone permissions/);
  let s = await t.state();
  assert.deepEqual([s.tenant.host, s.site.primary_domain, s.route.resource_id, s.redirect], ['brand.lummet.app', 'brand.lummet.app', 'old-route', null]);
  assert.equal(calls(t, 'deleteWorkerRoute').length, 0);
  t.infra._routeFailByPattern.clear();
  const again = await t.svc.resume(t.env, r.moveId);
  assert.deepEqual([again.ok, again.state], [true, 'redirecting']);
  assert.equal((await t.state()).tenant.host, 'brand.b.com');
});

test('new host does not answer: nothing switched; resume skips the finished route step', async () => {
  const t = await setup();
  t.infra._healthByUrl.set('https://brand.b.com/', { ok: false, statusCode: 525 });
  const r = await go(t);
  assert.deepEqual([r.ok, r.step], [false, 'check_new_host']);
  assert.match(r.detail, /did not answer \(status 525\). Nothing was switched/);
  const s = await t.state();
  assert.deepEqual([s.tenant.host, s.site.platform_domain_id === t.def.id, s.route.resource_id], ['brand.lummet.app', true, 'old-route']);
  t.infra._healthByUrl.clear();
  const again = await t.svc.resume(t.env, r.moveId);
  assert.equal(again.ok, true);
  assert.equal(calls(t, 'ensureWorkerRoute').filter((c) => c.pattern === 'brand.b.com/*').length, 1, 'route step not repeated');
});

test('redeploy fails: switched and live on the new host, old host still serves the site; resume finishes', async () => {
  const t = await setup();
  t.redeploy.result = { ok: false, error: 'no_release' };
  const r = await go(t);
  assert.deepEqual([r.ok, r.step, r.state], [false, 'redeploy', 'failed']);
  const s = await t.state();
  assert.equal(s.tenant.host, 'brand.b.com');
  assert.equal(s.redirect, null, 'old route not repointed yet: it still serves the tenant Worker');
  assert.equal(calls(t, 'ensureWorkerRoute').filter((c) => c.pattern === 'brand.lummet.app/*').length, 0);
  t.redeploy.result = { ok: true };
  assert.equal((await t.svc.resume(t.env, r.moveId)).state, 'redirecting');
  assert.equal(t.redeployed.length, 2);
  assert.equal(calls(t, 'ensureWorkerRoute').filter((c) => c.pattern === 'brand.b.com/*').length, 1, 'earlier steps not repeated');
});

test('redirect step fails: site stays reachable at both hosts; resume repairs', async () => {
  const t = await setup();
  t.infra._routeFailByPattern.set('brand.lummet.app/*', 'Cloudflare timeout');
  const r = await go(t);
  assert.deepEqual([r.ok, r.step], [false, 'redirect']);
  assert.equal(calls(t, 'deleteWorkerRoute').length, 0);
  assert.equal((await t.state()).redirect, null);
  t.infra._routeFailByPattern.clear();
  assert.equal((await t.svc.resume(t.env, r.moveId)).state, 'redirecting');
  assert.ok((await t.state()).redirect);
});

test('only one unfinished move per site; resume only from failed', async () => {
  const t = await setup();
  t.infra._healthByUrl.set('https://brand.b.com/', { ok: false, statusCode: 502 });
  const first = await go(t);
  const second = await go(t);
  assert.deepEqual([second.ok, second.error], [false, 'move_blocked']);
  assert.match(second.blockers.join(' '), /unfinished/);
  t.infra._healthByUrl.clear();
  assert.equal((await t.svc.resume(t.env, first.moveId)).ok, true);
  assert.equal((await t.svc.resume(t.env, first.moveId)).error, 'not_resumable');
});

test('rollback after a finished move restores everything and removes the new route last', async () => {
  const t = await setup();
  const r = await go(t);
  t.infra._calls.length = 0;
  const rb = await t.svc.rollback(t.env, r.moveId);
  assert.deepEqual([rb.ok, rb.state], [true, 'rolled_back']);
  const s = await t.state();
  assert.deepEqual({ ...s.tenant }, { host: 'brand.lummet.app', api_base_url: 'https://brand.lummet.app' });
  assert.deepEqual([s.site.primary_domain, s.site.platform_domain_id], ['brand.lummet.app', t.def.id]);
  assert.equal(s.route.resource_name, 'brand.lummet.app/*');
  assert.equal(s.redirect, null);
  const seq = t.infra._calls.filter((c) => /ensureWorkerRoute|deleteWorkerRoute/.test(c.method)).map((c) => `${c.method}:${c.pattern || c.routeId}`);
  assert.equal(seq[0], 'ensureWorkerRoute:brand.lummet.app/*', 'old host serves the site again first');
  assert.match(seq[1], /^deleteWorkerRoute:fake-route-/, 'new route removed only afterwards');
  assert.equal(calls(t, 'ensureWorkerRoute')[0].workerName, 'lummet-tenant-brand');
  assert.equal(t.redeployed.length, 2, 'redeployed again so the Worker knows the original URL');
  assert.equal((await t.svc.rollback(t.env, r.moveId)).error, 'not_rollbackable');
});

test('rollback of a move that failed before the switch only removes the new route', async () => {
  const t = await setup();
  t.infra._healthByUrl.set('https://brand.b.com/', { ok: false, statusCode: 525 });
  const r = await go(t);
  t.infra._calls.length = 0;
  const rb = await t.svc.rollback(t.env, r.moveId);
  assert.equal(rb.state, 'rolled_back');
  assert.deepEqual(t.infra._calls.map((c) => c.method), ['deleteWorkerRoute']);
  assert.equal((await t.state()).tenant.host, 'brand.lummet.app');
  assert.equal(t.redeployed.length, 0);
});

test('rollback failing to restore the old route stops before touching the database', async () => {
  const t = await setup();
  const r = await go(t);
  t.infra._routeFailByPattern.set('brand.lummet.app/*', 'Cloudflare down');
  const rb = await t.svc.rollback(t.env, r.moveId);
  assert.deepEqual([rb.ok, rb.error], [false, 'rollback_incomplete']);
  assert.equal((await t.state()).tenant.host, 'brand.b.com', 'still on the new host: nothing half-reverted');
  assert.equal((await movesRepo.getMove(t.env, r.moveId)).state, 'redirecting');
});

test('0 redirect days: old route removed at once, no redirect row, move completed', async () => {
  const t = await setup();
  const r = await go(t, { redirectDays: 0 });
  assert.equal(r.state, 'completed');
  assert.deepEqual(calls(t, 'deleteWorkerRoute').map((c) => c.routeId), ['old-route']);
  assert.equal((await t.state()).redirect, null);
});

test('sweep removes expired redirects only; a failed delete is retried next time', async () => {
  const t = await setup();
  const r = await go(t);
  assert.deepEqual(await t.svc.sweepExpiredRedirects(t.env), { removed: 0, failed: [] }, 'not expired yet');
  await t.env.LUMMET_DB.prepare(`UPDATE site_host_redirects SET expires_at = ?`).bind(new Date(Date.now() - 1000).toISOString()).run();
  t.infra._deleteFailures.set('deleteWorkerRoute', 'Cloudflare 500');
  const bad = await t.svc.sweepExpiredRedirects(t.env);
  assert.deepEqual([bad.removed, bad.failed.length], [0, 1]);
  assert.ok((await t.state()).redirect, 'kept for retry');
  t.infra._deleteFailures.clear();
  assert.equal((await t.svc.sweepExpiredRedirects(t.env)).removed, 1);
  assert.equal((await t.state()).redirect, null);
  assert.equal((await movesRepo.getMove(t.env, r.moveId)).state, 'completed');
});

test('redirect response: exact host, path and query kept, 301 for GET and 308 for POST, target from the table, expired ignored', async () => {
  const t = await setup();
  await go(t);
  const get = await redirectResponseFor(t.env, new Request('https://brand.lummet.app/news/a?x=1&y=2'));
  assert.deepEqual([get.status, get.headers.get('Location')], [301, 'https://brand.b.com/news/a?x=1&y=2']);
  const post = await redirectResponseFor(t.env, new Request('https://brand.lummet.app/api/hook', { method: 'POST', body: '{}' }));
  assert.deepEqual([post.status, post.headers.get('Location')], [308, 'https://brand.b.com/api/hook']);
  assert.equal(await redirectResponseFor(t.env, new Request('https://other.lummet.app/')), null);
  assert.equal(await redirectResponseFor(t.env, new Request('https://evil.com/', { headers: { Host: 'brand.lummet.app' } })), null, 'the request Host header never picks the target');
  await t.env.LUMMET_DB.prepare(`UPDATE site_host_redirects SET expires_at = ?`).bind(new Date(Date.now() - 1000).toISOString()).run();
  assert.equal(await redirectResponseFor(t.env, new Request('https://brand.lummet.app/')), null);
});

test('staff API: preview needs read, move/resume/rollback need manage, each write is audited', async () => {
  const t = await setup();
  const audits = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const call = async (admin, method, path, body) => {
    const request = new Request(`https://portal.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlePlatformDomainsRoute({ env: t.env, request, url: new URL(request.url), method, path: new URL(request.url).pathname, admin, requestId: 'r', ipHash: 'ip', json, html: (c) => new Response(c), logAudit: async (_e, a) => { audits.push(a); } }, { moveService: t.svc });
    return { status: res.status, body: await res.json() };
  };
  const mk = async (name, actions) => {
    const r = await t.env.LUMMET_DB.prepare(`INSERT INTO lummet_admins (email, password_hash, role) VALUES (?, 'x', 'admin')`).bind(`${name}@x.test`).run();
    for (const a of actions) await setPermission(t.env, Number(r.meta.last_row_id), 'platform', 'platform_domains', a, true);
    return { id: Number(r.meta.last_row_id), role: 'admin' };
  };
  const reader = await mk('reader', ['read']); const manager = await mk('manager', ['update']); const nobody = await mk('nobody', []);
  assert.equal((await call(nobody, 'GET', '/api/platform/sites/s1/move/preview?targetDomainId=dom-b')).status, 403);
  const prev = await call(reader, 'GET', '/api/platform/sites/s1/move/preview?targetDomainId=dom-b');
  assert.deepEqual([prev.status, prev.body.data.newHost], [200, 'brand.b.com']);
  const opts = await call(reader, 'GET', '/api/platform/sites/s1/move');
  assert.deepEqual(opts.body.data.targets.map((x) => x.hostname).sort(), ['b.com', 'lummet.app']);
  assert.equal((await call(reader, 'POST', '/api/platform/sites/s1/move', { targetDomainId: 'dom-b', confirmHostname: 'brand.b.com' })).status, 403);
  const wrong = await call(manager, 'POST', '/api/platform/sites/s1/move', { targetDomainId: 'dom-b', confirmHostname: 'nope' });
  assert.deepEqual([wrong.status, wrong.body.error], [422, 'confirmation_required']);
  const ok = await call(manager, 'POST', '/api/platform/sites/s1/move', { targetDomainId: 'dom-b', confirmHostname: 'brand.b.com' });
  assert.deepEqual([ok.status, ok.body.state], [200, 'redirecting']);
  assert.equal((await call(reader, 'POST', `/api/platform/site-moves/${ok.body.moveId}/rollback`, {})).status, 403);
  const rb = await call(manager, 'POST', `/api/platform/site-moves/${ok.body.moveId}/rollback`, {});
  assert.equal(rb.body.state, 'rolled_back');
  assert.deepEqual(audits.map((a) => `${a.resource}:${a.action}:${a.success}`), ['site:move_domain:false', 'site:move_domain:true', 'site:move_rollback:true']);
  assert.ok(audits.every((a) => a.resourceId === 's1'));
});
