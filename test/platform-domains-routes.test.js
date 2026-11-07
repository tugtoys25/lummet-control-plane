// Staff API and page for Platform domains: RBAC (read vs manage), audit, confirmations, escaping.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createPlatformDomainAdmin } from '../worker/platform-domains-admin.js';
import { handlePlatformDomainsRoute } from '../worker/platform-domains-routes.js';
import { setPermission } from '../worker/rbac.js';
import * as repo from '../worker/repositories/platform-domains.js';

function setup() {
  const db = createTestDb(); applyMigrations(db);
  const env = { LUMMET_DB: db, PLATFORM_DOMAIN_SUFFIX: 'lummet.app', CF_ZONE_ID: 'zone-default' };
  const infra = createFakeInfraProvider();
  const fetcher = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  const service = createPlatformDomainAdmin({ infra, fetcher });
  const audits = [];
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const html = (content, status = 200) => new Response(content, { status, headers: { 'content-type': 'text/html' } });
  const logAudit = async (_env, entry) => { audits.push(entry); };
  const call = async (admin, method, path, body) => {
    const request = new Request(`https://portal.test${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await handlePlatformDomainsRoute({ env, request, url: new URL(request.url), method, path, admin, requestId: 'r1', ipHash: 'ip', json, html, logAudit }, { service });
    return res ? { status: res.status, body: res.headers.get('content-type').includes('json') ? await res.json() : await res.text() } : null;
  };
  return { env, infra, call, audits, service };
}
const SUPER = { id: 'root', role: 'super_admin' };

async function staff(env, name, actions) {
  const r = await env.LUMMET_DB.prepare(`INSERT INTO lummet_admins (email, password_hash, role) VALUES (?, 'x', 'admin')`).bind(`${name}@x.test`).run();
  const id = Number(r.meta.last_row_id);
  for (const a of actions) await setPermission(env, id, 'platform', 'platform_domains', a, true);
  return { id, role: 'admin' };
}

test('routes ignore other paths', async () => {
  const { call } = setup();
  assert.equal(await call(SUPER, 'GET', '/api/platform/saas/settings'), null);
  assert.equal(await call(SUPER, 'GET', '/dashboard'), null);
});

test('no permission: 403 on page and API; read-only: lists but cannot write; manage: can write', async () => {
  const { env, call } = setup();
  const nobody = await staff(env, 'nobody', []);
  assert.equal((await call(nobody, 'GET', '/api/platform/domains')).status, 403);
  assert.equal((await call(nobody, 'GET', '/platform/domains')).status, 403);

  const reader = await staff(env, 'reader', ['read']);
  const list = await call(reader, 'GET', '/api/platform/domains');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((d) => d.hostname), ['lummet.app']);
  for (const [m, p, b] of [['POST', '/api/platform/domains', { hostname: 'x.com' }], ['POST', '/api/platform/domains/reorder', { ids: [] }]]) {
    assert.equal((await call(reader, m, p, b)).status, 403, `${m} ${p}`);
  }
  const id = list.body.data[0].id;
  for (const [m, sub, b] of [['POST', '/verify', {}], ['POST', '/default', { confirm: true }], ['POST', '/disable'], ['PATCH', '', { label: 'x' }], ['DELETE', '', { confirmHostname: 'lummet.app' }]]) {
    assert.equal((await call(reader, m, `/api/platform/domains/${id}${sub}`, b)).status, 403, `${m} ${sub}`);
  }

  const manager = await staff(env, 'manager', ['update']);
  assert.equal((await call(manager, 'POST', '/api/platform/domains', { hostname: 'new-one.com', label: 'New' })).status, 200);
  assert.equal((await call(SUPER, 'POST', '/api/platform/domains', { hostname: 'another.com' })).status, 200);
});

test('add + verify through the API; every write is audited; wildcard needs confirmation', async () => {
  const { env, infra, call, audits } = setup();
  infra._seedZone('second.com');
  const added = await call(SUPER, 'POST', '/api/platform/domains', { hostname: 'second.com', label: 'Second' });
  assert.equal(added.status, 200);
  const id = added.body.data.id;
  const v1 = await call(SUPER, 'POST', `/api/platform/domains/${id}/verify`, {});
  assert.equal(v1.body.passed, false); assert.equal(v1.body.needsConfirmation, 'create_wildcard');
  const v2 = await call(SUPER, 'POST', `/api/platform/domains/${id}/verify`, { createWildcard: true });
  assert.equal(v2.body.passed, true); assert.equal(v2.body.data.status, 'active');
  assert.deepEqual(audits.map((a) => `${a.resource}:${a.action}:${a.success}`), ['platform_domain:add:true', 'platform_domain:verify:true', 'platform_domain:verify:true']);
  assert.equal(audits[2].reason, 'create_wildcard');
  assert.ok(audits.every((a) => a.adminId === 'root' && a.requestId === 'r1'));
  assert.equal(JSON.stringify(audits).includes('token'), false);
  assert.equal((await repo.get(env, id)).status, 'active');
});

test('set default needs confirm:true and an active domain; remove needs the typed name and refuses a used domain with a count', async () => {
  const { env, call, audits } = setup();
  const def = (await call(SUPER, 'GET', '/api/platform/domains')).body.data[0];
  const added = (await call(SUPER, 'POST', '/api/platform/domains', { hostname: 'third.com' })).body.data;
  assert.equal((await call(SUPER, 'POST', `/api/platform/domains/${added.id}/default`, {})).body.error, 'confirmation_required');
  assert.equal((await call(SUPER, 'POST', `/api/platform/domains/${added.id}/default`, { confirm: true })).body.error, 'domain_not_active');
  await repo.update(env, added.id, { status: 'active' });
  assert.equal((await call(SUPER, 'POST', `/api/platform/domains/${added.id}/default`, { confirm: true })).status, 200);
  assert.equal((await repo.getDefault(env)).id, added.id);

  assert.equal((await call(SUPER, 'DELETE', `/api/platform/domains/${def.id}`, { confirmHostname: 'wrong.com' })).body.error, 'confirmation_required');
  await env.LUMMET_DB.prepare(`INSERT OR IGNORE INTO organizations (id, name, slug, status) VALUES ('o1','O','o','active')`).run();
  const prod = await env.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first();
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status, platform_domain_id) VALUES ('s1','o1',?,'S','s','active',?)`).bind(prod.id, def.id).run();
  const refused = await call(SUPER, 'DELETE', `/api/platform/domains/${def.id}`, { confirmHostname: 'lummet.app' });
  assert.deepEqual([refused.status, refused.body.error, refused.body.sites], [409, 'domain_in_use', 1]);
  assert.ok(audits.some((a) => a.action === 'remove' && a.success === false));
});

test('sites panel API lists the sites on a domain; a NULL domain counts for the default', async () => {
  const { env, call } = setup();
  const def = (await call(SUPER, 'GET', '/api/platform/domains')).body.data[0];
  await env.LUMMET_DB.prepare(`INSERT OR IGNORE INTO organizations (id, name, slug, status) VALUES ('o1','Org One','o','active')`).run();
  const prod = await env.LUMMET_DB.prepare(`SELECT id FROM products LIMIT 1`).first();
  await env.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, product_id, name, slug, status) VALUES ('s1','o1',?,'Old','old','active')`).bind(prod.id).run();
  const r = await call(SUPER, 'GET', `/api/platform/domains/${def.id}/sites`);
  assert.deepEqual(r.body.data.map((s) => [s.slug, s.organization_name]), [['old', 'Org One']]);
  assert.equal((await call(SUPER, 'GET', '/api/platform/domains/does-not-exist-1/sites')).status, 404);
});

test('page: escapes data, hides write actions for read-only staff, shows them for managers', async () => {
  const { env, call } = setup();
  const evil = '<img src=x onerror=alert(1)>';
  await repo.insert(env, { id: 'evil-domain-id', hostname: 'evil.com', label: evil, status: 'active' });
  const manager = await staff(env, 'mgr', ['read', 'update']);
  const reader = await staff(env, 'rdr', ['read']);
  const m = await call(manager, 'GET', '/platform/domains');
  assert.equal(m.status, 200);
  assert.ok(!m.body.includes(evil) && m.body.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(m.body.includes('Add and run checks') && m.body.includes('pdVerify'));
  const r = await call(reader, 'GET', '/platform/domains');
  assert.ok(r.body.includes('read-only access') && !r.body.includes('Add and run checks') && !r.body.includes('data-onclick="pdRemove"'));
});
