// Roadmap 2.5: the load-test harness itself is verified here against an in-process
// copy of the Worker (seed SQL -> HTTP server -> scenarios), so that when it is
// pointed at a real staging D1 the only unknown is the platform, not the tool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { buildSeedSql, buildCleanupSql, emailFor, SHARED_ORG } from '../scripts/loadtest-seed.mjs';
import { runLoad, assertTargetAllowed, percentile, summarize, SCENARIOS } from '../scripts/loadtest-lib.mjs';

const PASSWORD = 'load-test-password-123';
let server, base, env;

async function applySql(db, sql) {
  for (const stmt of sql.split('\n').filter((l) => l.trim() && !l.startsWith('--'))) await db.prepare(stmt).run();
}

before(async () => {
  const db = createTestDb(); applyMigrations(db);
  env = { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ALERT_CHECK_TOKEN: 'ops-token' };
  await applySql(db, await buildSeedSql({ users: 6, password: PASSWORD }));
  server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const r = await worker.fetch(new Request(`http://localhost:${server.address().port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body, redirect: 'manual' }), env, { waitUntil() {} });
    const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
    const setCookie = r.headers.get('set-cookie'); if (setCookie) headers['set-cookie'] = setCookie;
    res.writeHead(r.status, headers); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => new Promise((r) => server.close(r)));

test('percentile and summary maths', () => {
  const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(percentile(sorted, 50), 50); assert.equal(percentile(sorted, 95), 100); assert.equal(percentile([], 50), null);
  const s = summarize([{ status: 200, ms: 5, ok: true }, { status: 200, ms: 15, ok: true }, { status: 500, ms: 25, ok: false }, { status: 429, ms: 1, ok: false }, { status: 0, ms: 9, ok: false }, { status: 404, ms: 2, ok: false }], 1000);
  assert.equal(s.requests, 6); assert.equal(s.serverErrors, 2); assert.equal(s.rateLimited, 1); assert.equal(s.unexpected, 1);
  assert.equal(s.errorRate, +(3 / 6).toFixed(4));
  assert.deepEqual(s.statuses, { 200: 2, 500: 1, 429: 1, 0: 1, 404: 1 });
});

test('the harness refuses a non-local target unless the host is explicitly confirmed', () => {
  assert.throws(() => assertTargetAllowed('https://app.example.com'), /Refusing to run/);
  assert.throws(() => assertTargetAllowed('https://app.example.com', 'other.example.com'), /Refusing to run/);
  assert.equal(assertTargetAllowed('https://staging.example.com', 'staging.example.com'), 'staging.example.com');
  assert.equal(assertTargetAllowed('http://localhost:8787'), 'localhost');
});

test('seed SQL is idempotent, uses only load-test identifiers, and cleanup removes it all', async () => {
  const sql = await buildSeedSql({ users: 3, password: PASSWORD });
  assert.equal(sql.includes(PASSWORD), false, 'the plaintext password is never written to the SQL');
  assert.ok(sql.includes('loadtest.invalid'));
  const db = createTestDb(); applyMigrations(db);
  await applySql(db, sql); await applySql(db, sql);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM customer_users WHERE email LIKE '%@loadtest.invalid'`).first()).n, 3);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM organization_users WHERE organization_id = ?`).bind(SHARED_ORG).first()).n, 3);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM subscriptions WHERE status = 'active' AND id LIKE 'lt-sub-%'`).first()).n, 4);
  await applySql(db, buildCleanupSql());
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM customer_users WHERE email LIKE '%@loadtest.invalid'`).first()).n, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM organizations WHERE id LIKE 'lt-org-%'`).first()).n, 0);
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM subscriptions WHERE id LIKE 'lt-sub-%'`).first()).n, 0, 'subscriptions cascade with their organization');
  assert.equal((await db.prepare(`SELECT COUNT(*) n FROM organization_users`).first()).n, 0);
});

const run = (scenario, extra = {}) => runLoad({ base, scenario, users: 6, password: PASSWORD, concurrency: 4, durationSec: 1.5, maxRequests: 24, opsToken: 'ops-token', ...extra });

test('portal-read scenario: seeded users log in and every request succeeds', async () => {
  const r = await run('portal-read');
  assert.ok(r.requests >= 12, 'made requests: ' + r.requests);
  assert.deepEqual(Object.keys(r.statuses), ['200'], JSON.stringify(r.statuses));
  assert.equal(r.errorRate, 0); assert.ok(r.ms.p95 > 0);
});

test('write-own scenario creates and revokes keys without errors', async () => {
  const r = await run('write-own');
  assert.equal(r.errorRate, 0, JSON.stringify(r.statuses));
  assert.ok(r.statuses[200] >= 10, 'keys were really created and revoked: ' + JSON.stringify(r.statuses));
  const created = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM lummet_audit_logs WHERE resource = 'api_key' AND action = 'create' AND organization_id LIKE 'lt-org-%'`).first();
  assert.ok(created.n >= 6, 'creations are visible in the audit log: ' + created.n);
  const left = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM customer_api_keys WHERE organization_id LIKE 'lt-org-%' AND organization_id != ? AND status = 'active'`).bind(SHARED_ORG).first();
  assert.equal(left.n, 0, 'every created key was revoked again');
});

test('write-hot scenario: concurrent writers on ONE organization all succeed and nothing is lost', async () => {
  const before = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM customer_api_keys WHERE organization_id = ?`).bind(SHARED_ORG).first()).n;
  const r = await run('write-hot');
  assert.equal(r.errorRate, 0, JSON.stringify(r.statuses));
  assert.ok(r.statuses[200] >= 12, JSON.stringify(r.statuses));
  const after = (await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM customer_api_keys WHERE organization_id = ?`).bind(SHARED_ORG).first()).n;
  assert.equal(after - before, r.statuses[200], 'every 200 response corresponds to exactly one stored key');
});

test('login scenario measures sign-ins; ops-ping needs no users', async () => {
  assert.equal((await run('login')).errorRate, 0);
  const ping = await run('ops-ping', { users: 0 });
  assert.equal(ping.errorRate, 0, JSON.stringify(ping.statuses));
  const wrong = await runLoad({ base, scenario: 'ops-ping', users: 0, password: PASSWORD, concurrency: 1, durationSec: 0.5, maxRequests: 2, opsToken: 'wrong' });
  assert.equal(wrong.statuses[404], 2, 'a wrong token is reported, not hidden');
  assert.equal(wrong.unexpected, 2);
});

test('setup fails loudly when the seed was not applied or the password is wrong', async () => {
  await assert.rejects(() => runLoad({ base, scenario: 'portal-read', users: 2, password: 'not-the-password-123', concurrency: 1, durationSec: 1, maxRequests: 1 }), /Setup login failed/);
  await assert.rejects(() => runLoad({ base, scenario: 'portal-read', users: 40, password: PASSWORD, concurrency: 1, durationSec: 1, maxRequests: 1 }), /Setup login failed for lt-6/);
  await assert.rejects(() => runLoad({ base, scenario: 'nope', users: 1, password: PASSWORD, concurrency: 1, durationSec: 1 }), /Unknown scenario/);
  assert.ok(Object.keys(SCENARIOS).length >= 5);
  void emailFor;
});
