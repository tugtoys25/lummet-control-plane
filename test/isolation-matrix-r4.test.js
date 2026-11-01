// Round R.4: cross-organization isolation matrix (blueprint I-26). Tests only; no product code changes.
//
// The route list is NOT hand-written. test/support/route-census.js reads the organization route block of worker/index.js and
// returns every route it finds; the matrix below is run for each of them, so a route added tomorrow is covered the day it is written,
// and a route written in a form the census cannot read fails the gate in the first test.
//
// For every discovered route and every HTTP method:
//   1. outsider      an owner of a DIFFERENT organization asks for organization A's route           -> 403 (and nothing in the body)
//   2. anonymous     no session                                                                      -> 401
//   3. forged id     a real owner of A puts one of organization B's resource ids into A's route      -> never 2xx, never 5xx,
//                    nothing of B's in the response, and no row mentioning B changed
//   4. leak sweep    every route A can read answers without any of B's names, emails or urls
// plus: organization-id enumeration (a real and a made-up id look the same), and session operations against B's people.
// Not covered here (separate rounds): tenant-side API keys against /api/v1, and background jobs, which need the tenant worker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import * as customerAuth from '../worker/customer-auth.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { censusOrgRoutes, resourceKindFor } from './support/route-census.js';

const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };
const PW = 'Correct-Horse-Battery-9';
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
let n = 0;
const nextIp = () => { n += 1; return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`; };

async function call(e, method, path, body, cookie) {
  const h = new Headers({ 'CF-Connecting-IP': nextIp() });
  if (cookie) h.set('Cookie', cookie);
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody) h.set('Content-Type', 'application/json');
  const response = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: hasBody ? JSON.stringify(body ?? {}) : undefined, redirect: 'manual' }), e, ctx);
  return { status: response.status, text: await response.text(), location: response.headers.get('Location') };
}

async function signup(e, email, orgName) {
  const r = await call(e, 'POST', '/api/customer/signup', { email, password: PW, organizationName: orgName });
  assert.equal(r.status, 200, r.text);
  const userId = (await e.LUMMET_DB.prepare('SELECT id FROM customer_users WHERE email = ?').bind(email).first()).id;
  const organizationId = JSON.parse(r.text).organizationId;
  const s = await customerAuth.createSession(e, userId, organizationId);
  return { userId, organizationId, cookie: s.cookie.split(';')[0], sessionId: s.sessionId };
}

// Names that exist only in organization B, so any appearance in an answer to A is a leak.
const MARK = { org: 'ZZB-ORG-MARKER', site: 'zzb-site-marker', hook: 'https://zzb-hook-marker.example.com/h', email: 'zzb-member-marker@example.test', domain: 'zzb-domain-marker.example.com' };
const LEAK = [MARK.org, MARK.site, MARK.hook, MARK.email, MARK.domain, 'zzb-'];

const B = { site: 'zzb-site-1', dom: 'zzb-dom-1', zone: 'zzb-zone-1', dep: 'zzb-dep-1', bk: 'zzb-bk-1', hook: 'zzb-hook-1', del: 'zzb-del-1', key: 'zzb-key-1',
  inv: 'zzb-inv-1', rule: 'zzb-rule-1', cr: 'zzb-cr-1', job: 'zzb-job-1', quote: 'zzb-quote-1', rec: 'zzb-rec-1', sub: 'zzb-sub-1', alert: 'zzb-alert-1', report: 'zzb-report-1' };

async function world() {
  const db = createTestDb(); applyMigrations(db);
  const e = { LUMMET_DB: db, CREDENTIAL_KEK: btoa(String.fromCharCode(...Array.from({ length: 32 }, (_, i) => (i * 37 + 11 + (i * i) % 251) % 256))),
    CUSTOMER_SESSION_ADMIN: 'on', PORTAL_BASE_URL: 'https://app.example.test',
    EMAIL_FETCH: async () => new Response(JSON.stringify({ id: 'fake-email' }), { status: 200 }) };
  const a = await signup(e, 'owner-a@example.test', 'Org A');
  const b = await signup(e, 'owner-b@example.test', MARK.org);
  const c = await signup(e, 'owner-c@example.test', 'Org C');
  const b2 = await signup(e, MARK.email, 'Org B2 personal');
  await db.prepare('INSERT INTO organization_users (organization_id, user_id, role) VALUES (?, ?, ?)').bind(b.organizationId, b2.userId, 'editor').run();
  const b2s = await customerAuth.createSession(e, b2.userId, b.organizationId);
  b2.cookie = b2s.cookie.split(';')[0]; b2.sessionId = b2s.sessionId;

  const run = (sql, ...args) => db.prepare(sql).bind(...args).run();
  await run(`INSERT INTO products (id, key, name, category) VALUES ('zzb-prod', 'zzb-prod', 'ZZB product', 'test')`);
  await run(`INSERT INTO sites (id, organization_id, name, slug, product_id) VALUES (?, ?, ?, 'zzb-slug', 'zzb-prod')`, B.site, b.organizationId, MARK.site);
  await run(`INSERT INTO domains (id, site_id, hostname, verification_token) VALUES (?, ?, ?, 'zzb-token')`, B.dom, B.site, MARK.domain);
  await run(`INSERT INTO domain_zones (id, site_id, zone_name) VALUES (?, ?, ?)`, B.zone, B.site, 'zzb-zone-marker.example.com');
  await run(`INSERT INTO deployments (id, site_id, version) VALUES (?, ?, '9.9.9')`, B.dep, B.site);
  await run(`INSERT INTO site_backups (id, organization_id, site_id) VALUES (?, ?, ?)`, B.bk, b.organizationId, B.site);
  await run(`INSERT INTO webhooks (id, organization_id, url, encrypted_secret, secret_iv, event_types) VALUES (?, ?, ?, 'x', 'y', '[]')`, B.hook, b.organizationId, MARK.hook);
  await run(`INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload) VALUES (?, ?, 'site.created', '{}')`, B.del, B.hook);
  await run(`INSERT INTO customer_api_keys (id, organization_id, name, key_prefix, key_hash, scopes) VALUES (?, ?, 'zzb-key', 'zzbpfx', 'zzbhash', '[]')`, B.key, b.organizationId);
  await run(`INSERT INTO organization_invitations (id, organization_id, email, token_hash, expires_at) VALUES (?, ?, ?, 'zzbtok', '2099-01-01T00:00:00Z')`, B.inv, b.organizationId, 'zzb-invitee-marker@example.test');
  await run(`INSERT INTO automation_rules (id, organization_id, name, trigger_event, actions) VALUES (?, ?, 'zzb-rule', 'site.created', '[]')`, B.rule, b.organizationId);
  await run(`INSERT INTO change_requests (id, organization_id, type, resource_id) VALUES (?, ?, 'site_delete', ?)`, B.cr, b.organizationId, B.site);
  await run(`INSERT INTO jobs (id, type, organization_id, site_id) VALUES (?, 'provision', ?, ?)`, B.job, b.organizationId, B.site);
  await run(`INSERT INTO quotes (id, organization_id, contact_name, contact_email) VALUES (?, ?, 'zzb-contact', 'zzb-quote-marker@example.test')`, B.quote, b.organizationId);
  return { e, a, b, c, b2 };
}

const KIND_TO_ID = (w) => ({ sites: B.site, domains: B.dom, 'domain-zones': B.zone, deployments: B.dep, backups: B.bk, webhooks: B.hook, deliveries: B.del,
  'api-keys': B.key, invitations: B.inv, automations: B.rule, 'change-requests': B.cr, jobs: B.job, quotes: B.quote, records: B.rec, check: B.rec, subdomains: B.sub,
  alerts: B.alert, reports: B.report, members: w.b2.userId });
function materialize(route, ids) {
  let i = 0;
  return route.replace(/:id/g, () => { const kind = resourceKindFor(route, i); i += 1; return encodeURIComponent(ids[kind] || 'zzb-forged'); });
}

// Everything that mentions one of B's tokens, across all tables, except logs that legitimately grow when a request is refused.
const SKIP_TABLES = /audit|request_errors|attempt|rate|email_outbox|sqlite_|scheduler|job_logs/i;
async function fingerprintB(w) {
  const tokens = [w.b.organizationId, w.b.userId, w.b2.userId, ...Object.values(B), MARK.org, MARK.email];
  const tables = (await w.e.LUMMET_DB.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all()).results.map((r) => r.name).filter((t) => !SKIP_TABLES.test(t));
  const out = [];
  for (const t of tables) {
    const rows = (await w.e.LUMMET_DB.prepare(`SELECT * FROM ${t}`).all()).results;
    for (const r of rows) { const j = JSON.stringify(r); if (tokens.some((x) => j.includes(x))) out.push(`${t}:${j}`); }
  }
  return out.sort().join('\n');
}
const leaks = (text) => LEAK.filter((m) => text.includes(m));

// ------------------------------------------------------------------ gate

test('R.4 gate: the census reads the organization route block and understands every use of subPath', () => {
  const { routes, unparsed } = censusOrgRoutes();
  assert.ok(routes.length >= 90, `expected the real route surface (found ${routes.length})`);
  for (const must of ['/sites/:id/provision', '/webhooks/:id/rotate-secret', '/members/:id/role', '/sessions/revoke', '/export', '/audit-log.csv', '/api-keys/:id', '/backups/:id/restore']) {
    assert.ok(routes.includes(must), `census missed ${must}`);
  }
  assert.deepEqual(unparsed, [], 'a new way of matching subPath appeared: teach test/support/route-census.js to read it so the matrix still covers every route');
});

// ------------------------------------------------------------------ outsider and anonymous

test('R.4 outsider: an owner of another organization gets 403 on every organization A route, for every method', async () => {
  const w = await world(); const { routes } = censusOrgRoutes();
  const failures = [];
  for (const route of routes) {
    for (const method of METHODS) {
      const r = await call(w.e, method, `/api/organizations/${w.a.organizationId}${materialize(route, {})}`, {}, w.c.cookie);
      if (r.status !== 403) failures.push(`${method} ${route} -> ${r.status}`);
      else if (leaks(r.text).length || r.text.includes(w.a.organizationId)) failures.push(`${method} ${route} body mentions something it should not`);
    }
  }
  assert.deepEqual(failures, []);
});

test('R.4 anonymous: no session gets 401 on every organization route, for every method', async () => {
  const w = await world(); const { routes } = censusOrgRoutes();
  const failures = [];
  for (const route of routes) {
    for (const method of METHODS) {
      const r = await call(w.e, method, `/api/organizations/${w.a.organizationId}${materialize(route, {})}`, {});
      if (r.status !== 401) failures.push(`${method} ${route} -> ${r.status}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('R.4 enumeration: a real organization id and a made-up one are indistinguishable to an outsider', async () => {
  const w = await world(); const { routes } = censusOrgRoutes();
  const sample = routes.filter((_, i) => i % 5 === 0);
  for (const route of sample) {
    for (const method of ['GET', 'POST']) {
      const real = await call(w.e, method, `/api/organizations/${w.b.organizationId}${materialize(route, {})}`, {}, w.a.cookie);
      const fake = await call(w.e, method, `/api/organizations/00000000-0000-4000-8000-000000000000${materialize(route, {})}`, {}, w.a.cookie);
      assert.deepEqual({ status: real.status, body: real.text }, { status: fake.status, body: fake.text }, `${method} ${route}`);
    }
  }
});

// ------------------------------------------------------------------ forged ids inside the caller's own organization

test('R.4 forged id: A\'s owner using B\'s resource ids on A\'s routes is never served, never changes B, never leaks B', async () => {
  const w = await world(); const { routes } = censusOrgRoutes();
  const ids = KIND_TO_ID(w);
  const withIds = routes.filter((r) => r.includes(':id'));
  assert.ok(withIds.length >= 40, `expected many id-bearing routes (found ${withIds.length})`);
  const failures = [];
  for (const route of withIds) {
    const path = `/api/organizations/${w.a.organizationId}${materialize(route, ids)}`;
    const before = await fingerprintB(w);
    for (const method of METHODS) {
      const r = await call(w.e, method, path, { reason: 'forged id attempt', role: 'viewer', userId: w.b2.userId }, w.a.cookie);
      if (r.status >= 500) failures.push(`${method} ${route} -> ${r.status} (server error)`);
      else if (r.status >= 200 && r.status < 300) failures.push(`${method} ${route} -> ${r.status} (served)`);
      if (leaks(r.text).length) failures.push(`${method} ${route} leaked ${leaks(r.text).join(',')}`);
    }
    if (await fingerprintB(w) !== before) failures.push(`${route}: a row belonging to B changed`);
  }
  assert.deepEqual(failures, []);
});

test('R.4 forged id on the single-site route: /api/sites/:id answers 404/403 for another organization\'s site', async () => {
  const w = await world();
  const r = await call(w.e, 'GET', `/api/sites/${B.site}`, null, w.a.cookie);
  assert.ok([403, 404].includes(r.status), `got ${r.status}`);
  assert.deepEqual(leaks(r.text), []);
  const own = await call(w.e, 'GET', `/api/sites/${B.site}`, null, w.b.cookie);
  assert.equal(own.status, 200, 'control: B itself can read its site');
});

// ------------------------------------------------------------------ leak sweep and session operations

test('R.4 leak sweep: nothing A can read (exports, search, audit log, lists) contains B\'s names, emails or urls', async () => {
  const w = await world(); const { routes } = censusOrgRoutes();
  const readable = routes.filter((r) => !r.includes(':id'));
  const failures = [];
  for (const route of readable) {
    for (const method of ['GET', 'POST']) {
      const r = await call(w.e, method, `/api/organizations/${w.a.organizationId}${route}${route === '/search' ? '?q=zzb' : ''}`, { q: 'zzb' }, w.a.cookie);
      if (r.status >= 500) failures.push(`${method} ${route} -> ${r.status} (server error)`);
      if (leaks(r.text).length) failures.push(`${method} ${route} leaked ${leaks(r.text).join(',')}`);
    }
  }
  assert.deepEqual(failures, []);
});

test('R.4 session operations: A\'s owner cannot list, end or touch B\'s people or sessions, by user id or by forged handle', async () => {
  const w = await world();
  const base = `/api/organizations/${w.a.organizationId}`;
  const sessionRows = async () => (await w.e.LUMMET_DB.prepare('SELECT COUNT(*) n FROM customer_sessions WHERE user_id = ?').bind(w.b2.userId).first()).n;
  const before = await sessionRows();
  assert.ok(before >= 1);
  const list = await call(w.e, 'GET', `${base}/sessions`, null, w.a.cookie);
  assert.equal(list.status, 200); assert.deepEqual(leaks(list.text), []);
  assert.ok(!list.text.includes(w.b2.userId) && !list.text.includes(w.b2.sessionId));
  for (const body of [{ userId: w.b2.userId, reason: 'forged user id' }, { handle: w.b2.sessionId, reason: 'forged handle' }, { handle: 'zzb-forged', reason: 'unknown handle' }]) {
    const r = await call(w.e, 'POST', `${base}/sessions/revoke`, body, w.a.cookie);
    assert.ok(r.status >= 400 && r.status < 500, `${JSON.stringify(Object.keys(body))} -> ${r.status}`);
  }
  assert.equal(await sessionRows(), before, 'B\'s person is still signed in');
  assert.equal((await call(w.e, 'GET', '/api/organizations', null, w.b2.cookie)).status, 200);
  // B's owner cannot reach A's session list either.
  assert.equal((await call(w.e, 'GET', `${base}/sessions`, null, w.b.cookie)).status, 403);
});
