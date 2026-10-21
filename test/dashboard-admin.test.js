// v7G: a customer sets the password of their own login to a live site's dashboard, from the portal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { createFakeInfraProvider } from './support/fake-infra-provider.js';
import { createTenantAdminService, hashTenantPassword } from '../worker/tenant-admin.js';
import worker from '../worker/index.js';
import * as sites from '../worker/sites.js';
import * as plans from '../worker/plans.js';

const TENANT_DIR = new URL('../../lummet-tenant/en/', import.meta.url);
const haveTenant = existsSync(new URL('worker/auth.js', TENANT_DIR));
const PW = 'correct-horse-battery-staple';

function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), CF_API_TOKEN: 'tok', CF_ACCOUNT_ID: 'acct', ...extra }; }
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (Math.floor(Math.random() * 200) + 1) });
  if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function org(e, email) {
  const s = await call(e, 'POST', '/api/customer/signup', { email, password: 'Correct-Horse-Battery-9', organizationName: 'Acme' });
  await plans.startTrialSubscription(e, s.json.organizationId, 'plan_casino_news_starter');
  return { id: s.json.organizationId, userId: s.json.userId, cookie: s.cookie, email };
}
async function liveSite(e, o, { status = 'active', tenant = true, d1 = true } = {}) {
  const s = await sites.createSite(e, { organizationId: o.id, name: 'Main', productId: 'prod_casino_news', actorUserId: o.userId });
  const db = e.LUMMET_DB;
  if (tenant) {
    const t = `t-${s.siteId}`;
    await db.prepare(`INSERT INTO tenants (id, name, host, api_base_url) VALUES (?, 'T', ?, ?)`).bind(t, t + '.x.test', 'https://' + t + '.x.test').run();
    await db.prepare(`UPDATE sites SET tenant_id = ?, primary_domain = 'main.example.com', status = ? WHERE id = ?`).bind(t, status, s.siteId).run();
  }
  if (d1) await db.prepare(`INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name) VALUES (?, 'cloudflare', 'd1', 'db-123', 'tenant-db')`).bind(s.siteId).run();
  return s.siteId;
}

test('hashTenantPassword produces the tenant\'s own format, and the tenant verifies it', { skip: !haveTenant }, async () => {
  const { verifyPassword } = await import(new URL('worker/auth.js', TENANT_DIR).href);
  const h = await hashTenantPassword(PW);
  assert.match(h, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(await verifyPassword(PW, h), true);
  assert.equal(await verifyPassword(PW + 'x', h), false);
  assert.notEqual(await hashTenantPassword(PW), h, 'a fresh salt each time');
});

test('the exact SQL works on the tenant\'s real schema: creates the admin, resets it, signs it out, case-insensitive login', { skip: !haveTenant }, async () => {
  const tenantShim = await import(new URL('test/support/d1-shim.js', TENANT_DIR).href);
  const { verifyPassword } = await import(new URL('worker/auth.js', TENANT_DIR).href);
  const { getUserByEmail } = await import(new URL('worker/database/users.js', TENANT_DIR).href);
  const tdb = tenantShim.createTestDb(); tenantShim.applyMigrations(tdb);
  // A fake infra that runs the statements against the tenant database, binding params exactly as D1 would.
  const infra = { runD1Query: async (_e, { sql, params }) => { await tdb.prepare(sql).bind(...(params || [])).run(); return { ok: true, results: [] }; } };
  const e = env(); const o = await org(e, 'Owner@Example.com'); const siteId = await liveSite(e, o);
  const svc = createTenantAdminService(infra);

  const first = await svc.setDashboardPassword(e, { siteId, organizationId: o.id, email: 'Owner@Example.com', password: PW });
  assert.deepEqual(first, { ok: true, email: 'owner@example.com' });
  let row = await getUserByEmail(tdb, 'OWNER@example.com');
  assert.ok(row, 'found however the address is typed'); assert.equal(row.role, 'admin');
  assert.equal(await verifyPassword(PW, row.password_hash), true);

  await tdb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', ?, '2999-01-01')`).bind(row.id).run();
  await tdb.prepare(`INSERT INTO users (email, password_hash, role) VALUES ('other@example.com', 'x:y', 'editor')`).run();
  const other = await getUserByEmail(tdb, 'other@example.com');
  await tdb.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('s2', ?, '2999-01-01')`).bind(other.id).run();

  const second = await svc.setDashboardPassword(e, { siteId, organizationId: o.id, email: 'owner@example.com', password: 'a-different-long-password' });
  assert.equal(second.ok, true);
  row = await getUserByEmail(tdb, 'owner@example.com');
  assert.equal(await verifyPassword('a-different-long-password', row.password_hash), true);
  assert.equal(await verifyPassword(PW, row.password_hash), false);
  assert.equal((await tdb.prepare(`SELECT COUNT(*) c FROM users WHERE email = 'owner@example.com'`).first()).c, 1, 'one row, replaced');
  assert.equal((await tdb.prepare(`SELECT COUNT(*) c FROM sessions WHERE id = 's1'`).first()).c, 0, 'the account is signed out');
  assert.equal((await tdb.prepare(`SELECT COUNT(*) c FROM sessions WHERE id = 's2'`).first()).c, 1, 'other users are not');
  // An existing non-admin login for the same email is promoted rather than duplicated.
  await svc.setDashboardPassword(e, { siteId, organizationId: o.id, email: 'other@example.com', password: PW });
  assert.equal((await getUserByEmail(tdb, 'other@example.com')).role, 'admin');
});

test('service: statements are parameterised, target the site\'s own database, and never contain the password', async () => {
  const infra = createFakeInfraProvider(); const e = env(); const o = await org(e, 'p@example.com'); const siteId = await liveSite(e, o);
  const r = await createTenantAdminService(infra).setDashboardPassword(e, { siteId, organizationId: o.id, email: "O'Brien+x@Example.com", password: PW });
  assert.equal(r.ok, true);
  const q = infra._calls.filter((c) => c.method === 'runD1Query');
  assert.equal(q.length, 2);
  for (const c of q) { assert.equal(c.databaseId, 'db-123'); assert.doesNotMatch(c.sql, /O'Brien|correct-horse|\$\{/); assert.match(c.sql, /\?/); }
  assert.equal(q[0].params[0], "o'brien+x@example.com"); assert.match(q[0].params[1], /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(q).includes(PW), false);
});

test('service refusals: bad password or email, other organization, site not live, no database, provider failure', async () => {
  const infra = createFakeInfraProvider(); const svc = createTenantAdminService(infra);
  const e = env(); const o = await org(e, 'r@example.com'); const other = await org(e, 'r2@example.com');
  const live = await liveSite(e, o), pending = await liveSite(e, o, { status: 'provisioning' }), noTenant = await liveSite(e, o, { tenant: false }), noDb = await liveSite(e, o, { d1: false });
  const go = (over) => svc.setDashboardPassword(e, { siteId: live, organizationId: o.id, email: 'r@example.com', password: PW, ...over });
  assert.deepEqual([(await go({ password: 'short' })).error, (await go({ password: 'x'.repeat(201) })).error, (await go({ password: undefined })).error], ['password_length', 'password_length', 'password_length']);
  assert.equal((await go({ email: 'not-an-email' })).error, 'invalid_email');
  assert.equal((await go({ organizationId: other.id })).status, 404, 'a site of another organization looks like it does not exist');
  assert.equal((await go({ siteId: 'nope' })).status, 404);
  for (const s of [pending, noTenant]) assert.deepEqual([(await go({ siteId: s })).status, (await go({ siteId: s })).error], [409, 'site_not_live']);
  assert.equal((await go({ siteId: noDb })).error, 'site_has_no_database');
  assert.equal(infra._calls.filter((c) => c.method === 'runD1Query').length, 0, 'nothing reached a database on any refusal');
});

test('service: a provider failure becomes a generic error for the customer and keeps the reason for the audit log', async () => {
  const svc = createTenantAdminService({ runD1Query: async () => { throw new Error('D1 error: no such table: users (sql: INSERT INTO users ...)'); } });
  const e = env(); const o = await org(e, 'f@example.com'); const siteId = await liveSite(e, o);
  const r = await svc.setDashboardPassword(e, { siteId, organizationId: o.id, email: 'f@example.com', password: PW });
  assert.equal(r.ok, false); assert.equal(r.status, 502); assert.equal(r.error, 'site_database_unavailable'); assert.match(r.detail, /no such table/);
});

// ---- the real route ----
function mockCloudflare() {
  const seen = []; const real = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => { seen.push({ url: String(url), body: opts.body ? JSON.parse(opts.body) : null, auth: opts.headers?.Authorization }); return new Response(JSON.stringify({ success: true, result: [{ success: true }] }), { status: 200 }); };
  return { seen, restore: () => { globalThis.fetch = real; } };
}

test('route: an organization admin sets the password; the Cloudflare call carries a hash and bound params, and the audit row carries no secret', async () => {
  const e = env(); const o = await org(e, 'owner@example.com'); const siteId = await liveSite(e, o); const cf = mockCloudflare();
  try {
    const r = await call(e, 'POST', `/api/organizations/${o.id}/sites/${siteId}/dashboard-admin`, { password: PW }, o.cookie);
    assert.equal(r.status, 200, r.text); assert.deepEqual(r.json, { success: true, email: 'owner@example.com' });
  } finally { cf.restore(); }
  assert.equal(cf.seen.length, 2);
  assert.ok(cf.seen.every((c) => c.url === 'https://api.cloudflare.com/client/v4/accounts/acct/d1/database/db-123/query' && c.auth === 'Bearer tok'));
  assert.equal(JSON.stringify(cf.seen).includes(PW), false);
  assert.match(cf.seen[0].body.params[1], /^[0-9a-f]{32}:[0-9a-f]{64}$/);
  const audit = await e.LUMMET_DB.prepare(`SELECT * FROM lummet_audit_logs WHERE resource = 'site_dashboard_admin'`).all();
  assert.equal(audit.results.length, 1); assert.equal(audit.results[0].success, 1);
  assert.equal(JSON.stringify(audit.results).includes(PW), false);
  assert.equal(JSON.stringify(audit.results).includes(cf.seen[0].body.params[1]), false, 'not even the hash');
});

test('route: below admin, other organizations, signed-out callers and a missing password are all refused without touching Cloudflare', async () => {
  const e = env(); const o = await org(e, 'o1@example.com'); const x = await org(e, 'o2@example.com'); const siteId = await liveSite(e, o); const cf = mockCloudflare();
  const url = `/api/organizations/${o.id}/sites/${siteId}/dashboard-admin`;
  try {
    assert.equal((await call(e, 'POST', url, { password: PW })).status, 401);
    assert.equal((await call(e, 'POST', url, { password: PW }, x.cookie)).status, 403, 'not a member');
    assert.equal((await call(e, 'POST', `/api/organizations/${x.id}/sites/${siteId}/dashboard-admin`, { password: PW }, x.cookie)).status, 404, 'a site of another organization');
    for (const role of ['editor', 'analyst', 'viewer']) {
      await e.LUMMET_DB.prepare(`UPDATE organization_users SET role = ? WHERE organization_id = ?`).bind(role, o.id).run();
      assert.equal((await call(e, 'POST', url, { password: PW }, o.cookie)).status, 403, role);
    }
    await e.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'admin' WHERE organization_id = ?`).bind(o.id).run();
    assert.equal((await call(e, 'POST', url, {}, o.cookie)).status, 422);
    assert.equal((await call(e, 'POST', url, { password: 'short' }, o.cookie)).status, 422);
  } finally { cf.restore(); }
  assert.equal(cf.seen.length, 0);
});

test('route: rate limited after 10 attempts from one address', async () => {
  const e = env(); const o = await org(e, 'rl@example.com'); const siteId = await liveSite(e, o); const cf = mockCloudflare();
  const url = `/api/organizations/${o.id}/sites/${siteId}/dashboard-admin`; let last;
  try {
    for (let i = 0; i < 12; i++) {
      const h = new Headers({ 'CF-Connecting-IP': '203.0.113.77', Cookie: o.cookie, 'Content-Type': 'application/json' });
      last = (await worker.fetch(new Request('https://cp.test' + url, { method: 'POST', headers: h, body: JSON.stringify({ password: 'short' }) }), e, ctx)).status;
    }
  } finally { cf.restore(); }
  assert.equal(last, 429);
});

test('Content page: admins get the password form for live sites only; others get an explanation; the password is never rendered', async () => {
  const e = env(); const o = await org(e, 'page@example.com'); await liveSite(e, o); await liveSite(e, o, { status: 'provisioning', tenant: false });
  const admin = await call(e, 'GET', '/app/content', null, o.cookie);
  assert.equal((admin.text.match(/class="dash-pw"/g) || []).length, 1);
  assert.match(admin.text, /data-onsubmit="lummetSetDashboardPassword"/); assert.match(admin.text, /type="password"[^>]*autocomplete="new-password"/);
  assert.match(admin.text, /<strong>page@example\.com<\/strong>/);
  assert.doesNotMatch(admin.text, /<script>/);
  await e.LUMMET_DB.prepare(`UPDATE organization_users SET role = 'editor' WHERE organization_id = ?`).bind(o.id).run();
  const editor = await call(e, 'GET', '/app/content', null, o.cookie);
  assert.doesNotMatch(editor.text, /dash-pw/); assert.match(editor.text, /Ask an organization admin/);
  assert.match(editor.text, /\/en\/dashboard/, 'the dashboard link itself is still there');
});
