// Round 6.5C: load test thresholds, D1 size check, SOC 2 policy drafts, pen-test owner task.
//
// Acceptance tests, written before the implementation:
//   AT-A  Load test fails below threshold: every threshold dimension fails the run on its own; a run that sent nothing
//         never passes; a threshold left unset is "not evaluated", never a silent pass; the nightly CLI exits 1 when a
//         scenario misses its thresholds and 0 when every scenario meets them.
//   AT-B  D1 size check output format: a fixed snapshot gives an exact JSON shape and an exact text layout; an unknown
//         size limit is reported as unknown (never "ok"); collection reads table names and counts only.
//   AT-C  Policies labeled Draft, not approved: every policy file says so at the top, names no approver or effective
//         date, makes no SOC 2 compliance claim, and every repository path it cites exists.
// Plus: the pen-test task is an owner task in OPEN_ITEMS with vendor and date as [OPEN]; the nightly workflow is off by
// default and holds no secret; the table-move plan names real tables.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import worker from '../worker/index.js';
import { buildSeedSql } from '../scripts/loadtest-seed.mjs';
import { SCENARIOS } from '../scripts/loadtest-lib.mjs';
import { evaluateThresholds, loadThresholds, runNightly, EXIT } from '../scripts/loadtest-thresholds.mjs';
import { collectSnapshot, buildReport, formatText, loadPolicy, REPORT_FORMAT } from '../scripts/d1-size-check.mjs';

const root = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(root, '..');
const read = (f) => readFile(path.join(root, f), 'utf8');
const run = (args, opts = {}) => new Promise((resolve) => execFile(process.execPath, args, { cwd: root, timeout: 60000, ...opts }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr })));

// ---------------------------------------------------------------------------------------------------------------------
// AT-A: load test fails below threshold
// ---------------------------------------------------------------------------------------------------------------------
const good = { requests: 1000, seconds: 30, requestsPerSecond: 33.3, statuses: { 200: 1000 }, serverErrors: 0, rateLimited: 0, unexpected: 0, errorRate: 0, ms: { p50: 40, p95: 120, p99: 200, max: 400 } };
const T = { minRequests: 100, maxErrorRate: 0.01, maxServerErrors: 0, p95Ms: 500, p99Ms: 900, minRequestsPerSecond: 10, maxRateLimitedRate: 0.1 };
const failedChecks = (e) => e.checks.filter((c) => c.status === 'fail').map((c) => c.name);

test('AT-A a run inside every threshold passes and lists each check it evaluated', () => {
  const e = evaluateThresholds(good, T);
  assert.equal(e.verdict, 'pass');
  assert.deepEqual(failedChecks(e), []);
  assert.deepEqual(e.checks.map((c) => c.name).sort(), ['maxErrorRate', 'maxRateLimitedRate', 'maxServerErrors', 'minRequests', 'minRequestsPerSecond', 'p95Ms', 'p99Ms']);
  for (const c of e.checks) assert.ok('actual' in c && 'limit' in c, 'each check reports the measured value and the limit');
});

test('AT-A each threshold dimension fails the run on its own', () => {
  const cases = [
    [{ ...good, errorRate: 0.02 }, 'maxErrorRate'],
    [{ ...good, serverErrors: 1 }, 'maxServerErrors'],
    [{ ...good, ms: { ...good.ms, p95: 501 } }, 'p95Ms'],
    [{ ...good, ms: { ...good.ms, p99: 901 } }, 'p99Ms'],
    [{ ...good, requestsPerSecond: 9.9 }, 'minRequestsPerSecond'],
    [{ ...good, requests: 99 }, 'minRequests'],
    [{ ...good, rateLimited: 200 }, 'maxRateLimitedRate']
  ];
  for (const [result, name] of cases) {
    const e = evaluateThresholds(result, T);
    assert.equal(e.verdict, 'fail', name);
    assert.ok(failedChecks(e).includes(name), `${name} should fail, got ${failedChecks(e)}`);
  }
});

test('AT-A the limits are inclusive: exactly at the threshold passes', () => {
  const e = evaluateThresholds({ ...good, errorRate: 0.01, ms: { ...good.ms, p95: 500 }, requestsPerSecond: 10, requests: 100 }, T);
  assert.equal(e.verdict, 'pass');
});

test('AT-A a run that sent nothing never passes, even with no errors', () => {
  const none = { requests: 0, seconds: 30, requestsPerSecond: 0, statuses: {}, serverErrors: 0, rateLimited: 0, unexpected: 0, errorRate: 0, ms: { p50: null, p95: null, p99: null, max: null } };
  assert.equal(evaluateThresholds(none, T).verdict, 'fail');
  // even when the owner left every other threshold unset
  assert.equal(evaluateThresholds(none, { minRequests: 1 }).verdict, 'fail');
  // a missing latency (no successful response) cannot satisfy a latency limit
  const noLatency = { ...good, ms: { p50: null, p95: null, p99: null, max: null } };
  assert.ok(failedChecks(evaluateThresholds(noLatency, T)).includes('p95Ms'));
});

test('AT-A an unset threshold is not evaluated; a scenario with nothing to evaluate is unknown, never pass', () => {
  const partial = evaluateThresholds(good, { minRequests: 100, p95Ms: null, maxErrorRate: null });
  assert.equal(partial.verdict, 'pass');
  assert.deepEqual(partial.checks.filter((c) => c.status === 'not_evaluated').map((c) => c.name).sort(), ['maxErrorRate', 'p95Ms']);
  const nothing = evaluateThresholds(good, { p95Ms: null, maxErrorRate: null, minRequests: null });
  assert.equal(nothing.verdict, 'unknown');
  assert.equal(evaluateThresholds(good, {}).verdict, 'unknown');
  assert.equal(evaluateThresholds(good, undefined).verdict, 'unknown');
});

test('AT-A an invalid threshold value is a configuration error, not a pass', () => {
  assert.throws(() => evaluateThresholds(good, { p95Ms: -1 }), /p95Ms/);
  assert.throws(() => evaluateThresholds(good, { maxErrorRate: 2 }), /maxErrorRate/);
  assert.throws(() => evaluateThresholds(good, { p95Ms: '500' }), /p95Ms/);
  assert.throws(() => evaluateThresholds(good, { p95Ms: 0 }), /p95Ms/, 'zero is never an acceptable placeholder');
  assert.throws(() => evaluateThresholds(good, { madeUpCheck: 1 }), /madeUpCheck/);
});

test('AT-A the shipped thresholds file is valid, unconfirmed, and covers real scenarios', async () => {
  const cfg = await loadThresholds(path.join(root, 'config/loadtest-thresholds.v1.json'));
  assert.equal(cfg.confirmed, false, 'values are [OPEN] placeholders until the owner confirms them');
  assert.ok(Object.keys(cfg.scenarios).length >= 3);
  for (const [name, s] of Object.entries(cfg.scenarios)) {
    assert.ok(SCENARIOS[name], `${name} is a real scenario`);
    assert.notEqual(name, 'ops-ping', 'ops-ping needs a token and is not part of the nightly set');
    assert.equal(evaluateThresholds(good, s.thresholds).verdict === 'unknown', false, `${name} has at least one evaluable threshold`);
    assert.ok(Number.isInteger(s.users) && Number.isInteger(s.concurrency) && Number.isInteger(s.durationSec));
  }
  const raw = await read('config/loadtest-thresholds.v1.json');
  assert.match(raw, /\[OPEN\]/);
  assert.doesNotMatch(raw, /https?:\/\//, 'no host is baked into the config');
});

// ---- the nightly runner against an in-process copy of the Worker ----
const PASSWORD = 'load-test-password-123';
let server, base, env, tmp;
async function applySql(db, sql) { for (const stmt of sql.split('\n').filter((l) => l.trim() && !l.startsWith('--'))) await db.prepare(stmt).run(); }
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'lt65c-'));
  const db = createTestDb(); applyMigrations(db);
  env = { LUMMET_DB: db, CREDENTIAL_KEK: btoa('k'.repeat(32)), ENVIRONMENT: 'production', ALERT_CHECK_TOKEN: 'ops-token' };
  await applySql(db, await buildSeedSql({ users: 4, password: PASSWORD }));
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

const profile = (thresholds) => ({ version: 1, confirmed: false, scenarios: { 'portal-read': { users: 4, concurrency: 2, durationSec: 5, maxRequests: 12, thresholds } } });

test('AT-A nightly run: a scenario inside its thresholds passes and the report names the unconfirmed state', async () => {
  const r = await runNightly({ base, password: PASSWORD, profile: profile({ minRequests: 5, maxErrorRate: 0.5, p95Ms: 60000 }) });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.exitCode, EXIT.PASS);
  assert.equal(r.scenarios.length, 1);
  assert.equal(r.scenarios[0].name, 'portal-read');
  assert.ok(r.scenarios[0].result.requests >= 5);
  assert.ok(r.labels.some((l) => /UNCONFIRMED/.test(l)), 'placeholder thresholds are labelled');
});

test('AT-A nightly run: missing a threshold fails the run (below-threshold throughput)', async () => {
  const r = await runNightly({ base, password: PASSWORD, profile: profile({ minRequests: 5, minRequestsPerSecond: 1e9 }) });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.exitCode, EXIT.FAIL);
  assert.ok(r.scenarios[0].evaluation.checks.some((c) => c.name === 'minRequestsPerSecond' && c.status === 'fail'));
});

test('AT-A nightly run: one failing scenario fails the whole run', async () => {
  const p = profile({ minRequests: 5 });
  p.scenarios['write-own'] = { users: 4, concurrency: 2, durationSec: 5, maxRequests: 6, thresholds: { minRequests: 1000000 } };
  const r = await runNightly({ base, password: PASSWORD, profile: p });
  assert.equal(r.verdict, 'fail');
  assert.deepEqual(r.scenarios.map((s) => s.evaluation.verdict), ['pass', 'fail']);
});

test('AT-A nightly run: a scenario with no evaluable threshold is unknown and does not exit 0', async () => {
  const r = await runNightly({ base, password: PASSWORD, profile: profile({ p95Ms: null }) });
  assert.equal(r.verdict, 'unknown');
  assert.equal(r.exitCode, EXIT.UNKNOWN);
  assert.notEqual(r.exitCode, 0);
});

test('AT-A nightly run: a setup failure (wrong password) is a failure, not a pass', async () => {
  await assert.rejects(runNightly({ base, password: 'wrong-password-123', profile: profile({ minRequests: 1 }) }), /Setup login failed/);
});

test('AT-A nightly CLI: exit 1 below threshold, exit 0 within, exit 2 on bad usage, report file written', async () => {
  const cfgFail = path.join(tmp, 'fail.json'), cfgPass = path.join(tmp, 'pass.json'), out = path.join(tmp, 'report.json');
  await writeFile(cfgFail, JSON.stringify(profile({ minRequests: 5, minRequestsPerSecond: 1e9 })));
  await writeFile(cfgPass, JSON.stringify(profile({ minRequests: 5, maxErrorRate: 0.5, p95Ms: 60000 })));
  const env2 = { ...process.env, LOADTEST_PASSWORD: PASSWORD };
  const args = (cfg) => ['scripts/loadtest.mjs', '--nightly', '--thresholds', cfg, '--base', base, '--allow-host', 'localhost', '--report', out];
  const failed = await run(args(cfgFail), { env: env2 });
  assert.equal(failed.code, 1, failed.stderr);
  assert.match(failed.stderr, /FAIL portal-read/);
  const report = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(report.verdict, 'fail');
  assert.equal(report.base, undefined, 'the report does not echo the target URL');
  const passed = await run(args(cfgPass), { env: env2 });
  assert.equal(passed.code, 0, passed.stderr);
  assert.equal(JSON.parse(await readFile(out, 'utf8')).verdict, 'pass');
  const noFile = await run(['scripts/loadtest.mjs', '--nightly', '--base', base, '--allow-host', 'localhost'], { env: env2 });
  assert.equal(noFile.code, 2, 'nightly without --thresholds is a usage error');
  const wrongHost = await run(['scripts/loadtest.mjs', '--nightly', '--thresholds', cfgPass, '--base', 'https://app.example.com'], { env: env2 });
  assert.equal(wrongHost.code, 2, 'a non-local host needs --allow-host');
});

test('AT-A the single-scenario CLI behaves as before (explicit flags still gate the exit code)', async () => {
  const env2 = { ...process.env, LOADTEST_PASSWORD: PASSWORD };
  const ok = await run(['scripts/loadtest.mjs', '--base', base, '--allow-host', 'localhost', '--scenario', 'portal-read', '--users', '4', '--concurrency', '2', '--requests', '8', '--p95-ms', '60000'], { env: env2 });
  assert.equal(ok.code, 0, ok.stderr);
  const bad = await run(['scripts/loadtest.mjs', '--base', base, '--allow-host', 'localhost', '--scenario', 'portal-read', '--users', '4', '--concurrency', '2', '--requests', '8', '--p95-ms', '0.0001'], { env: env2 });
  assert.equal(bad.code, 1);
});

test('AT-A the nightly workflow is off by default, schedule-only, staging-secret driven and holds no secret value', async () => {
  const y = await read('.github/workflows/nightly-loadtest.yml');
  assert.match(y, /schedule:\s*\n\s*- cron:/);
  assert.match(y, /vars\.LOADTEST_NIGHTLY == 'on'/, 'gated by a repository variable that is unset by default');
  assert.match(y, /node scripts\/loadtest\.mjs --nightly --thresholds config\/loadtest-thresholds\.v1\.json/);
  for (const s of ['LOADTEST_BASE_URL', 'LOADTEST_ALLOW_HOST', 'LOADTEST_PASSWORD']) assert.match(y, new RegExp(`secrets\\.${s}`), s);
  assert.doesNotMatch(y, /https?:\/\/(?!github\.com|cloudflare)[a-z0-9.-]+\.(workers\.dev|com|net|io)/i, 'no URL is baked in');
  assert.doesNotMatch(y, /wrangler|deploy|CLOUDFLARE_API_TOKEN/i, 'the nightly job deploys and changes nothing');
  assert.match(y, /upload-artifact/);
});

// ---------------------------------------------------------------------------------------------------------------------
// AT-B: D1 size check output format
// ---------------------------------------------------------------------------------------------------------------------
const policy = {
  version: 1, confirmed: false,
  warnPercent: 70, criticalPercent: 85, limitBytes: null,
  highVolume: {
    request_errors: { group: 'request_errors', warnRows: null, criticalRows: null },
    lummet_audit_logs: { group: 'audit', warnRows: 1000, criticalRows: 5000 },
    email_outbox: { group: 'email_history', warnRows: null, criticalRows: null },
    email_webhook_events: { group: 'email_history', warnRows: null, criticalRows: null }
  }
};
const snapshot = {
  databaseName: 'lummet-staging', databaseBytes: 800, tables: [
    { name: 'organizations', rows: 10 }, { name: 'lummet_audit_logs', rows: 4000 }, { name: 'request_errors', rows: 50 },
    { name: 'email_outbox', rows: 900 }, { name: 'email_webhook_events', rows: 40 }
  ]
};
const NOW = new Date('2026-10-25T03:00:00.000Z');

test('AT-B report JSON has exactly the documented shape', () => {
  const r = buildReport(snapshot, { ...policy, limitBytes: 1000 }, { now: NOW });
  assert.deepEqual(Object.keys(r), ['format', 'generatedAt', 'policyConfirmed', 'database', 'thresholds', 'totals', 'tables', 'recommendation', 'labels']);
  assert.equal(r.format, 'lummet-d1-size-check/1');
  assert.equal(r.format, REPORT_FORMAT);
  assert.equal(r.generatedAt, '2026-10-25T03:00:00.000Z');
  assert.equal(r.policyConfirmed, false);
  assert.deepEqual(r.database, { name: 'lummet-staging', bytes: 800, limitBytes: 1000, usedPercent: 80, status: 'warn' });
  assert.deepEqual(r.thresholds, { warnPercent: 70, criticalPercent: 85 });
  assert.deepEqual(r.totals, { tables: 5, rows: 5000 });
  assert.deepEqual(Object.keys(r.tables[0]), ['name', 'rows', 'sharePercent', 'highVolume', 'group', 'status']);
  assert.deepEqual(Object.keys(r.recommendation), ['moveNeeded', 'tables', 'plan']);
  assert.ok(Array.isArray(r.labels) && r.labels.every((l) => typeof l === 'string'));
});

test('AT-B tables are sorted by rows (largest first), high-volume tables are flagged and graded', () => {
  const r = buildReport(snapshot, policy, { now: NOW });
  assert.deepEqual(r.tables.map((t) => t.name), ['lummet_audit_logs', 'email_outbox', 'request_errors', 'email_webhook_events', 'organizations']);
  const by = Object.fromEntries(r.tables.map((t) => [t.name, t]));
  assert.equal(by.lummet_audit_logs.highVolume, true);
  assert.equal(by.lummet_audit_logs.group, 'audit');
  assert.equal(by.lummet_audit_logs.status, 'warn', '4000 rows is between warnRows 1000 and criticalRows 5000');
  assert.equal(by.lummet_audit_logs.sharePercent, 80);
  assert.equal(by.organizations.highVolume, false);
  assert.equal(by.organizations.group, null);
  assert.equal(by.organizations.status, 'not_graded', 'a table outside the high-volume list is not graded, never reported ok');
  assert.equal(by.request_errors.status, 'unknown', 'no row limits supplied for this table: unknown, never ok');
  assert.deepEqual(r.recommendation.tables, ['lummet_audit_logs']);
  assert.equal(r.recommendation.moveNeeded, 'yes');
  assert.equal(r.recommendation.plan, 'docs/D1_SIZE_AND_TABLE_MOVE_PLAN.md');
});

test('AT-B an unknown size limit is reported as unknown, never ok, and the plan answer is unknown', () => {
  const r = buildReport({ ...snapshot, tables: snapshot.tables.filter((t) => t.name !== 'lummet_audit_logs') }, policy, { now: NOW });
  assert.deepEqual(r.database, { name: 'lummet-staging', bytes: 800, limitBytes: null, usedPercent: null, status: 'unknown' });
  assert.equal(r.recommendation.moveNeeded, 'unknown');
  assert.ok(r.labels.some((l) => /NOT VERIFIED/.test(l)));
  assert.ok(r.labels.some((l) => /UNCONFIRMED/.test(l)), 'placeholder policy is labelled');
  const noBytes = buildReport({ ...snapshot, databaseBytes: null }, { ...policy, limitBytes: 1000 }, { now: NOW });
  assert.equal(noBytes.database.status, 'unknown');
  assert.equal(noBytes.database.usedPercent, null);
});

test('AT-B status bands: ok below warn, warn, critical; boundaries are inclusive', () => {
  const at = (bytes) => buildReport({ ...snapshot, databaseBytes: bytes, tables: [{ name: 'organizations', rows: 1 }] }, { ...policy, limitBytes: 1000 }, { now: NOW }).database;
  assert.equal(at(699).status, 'ok');
  assert.equal(at(700).status, 'warn');
  assert.equal(at(849).status, 'warn');
  assert.equal(at(850).status, 'critical');
  assert.equal(at(1000).usedPercent, 100);
});

test('AT-B an ok database with every high-volume table graded ok says no move is needed', () => {
  const p = { ...policy, limitBytes: 1000, highVolume: Object.fromEntries(Object.entries(policy.highVolume).map(([k, v]) => [k, { ...v, warnRows: 100000, criticalRows: 200000 }])) };
  const r = buildReport({ ...snapshot, databaseBytes: 100 }, p, { now: NOW });
  assert.equal(r.recommendation.moveNeeded, 'no');
  assert.deepEqual(r.recommendation.tables, []);
});

test('AT-B text layout is fixed', () => {
  const text = formatText(buildReport(snapshot, { ...policy, limitBytes: 1000 }, { now: NOW }));
  const lines = text.split('\n');
  assert.equal(lines[0], 'D1 SIZE CHECK (lummet-d1-size-check/1)');
  assert.equal(lines[1], 'generated: 2026-10-25T03:00:00.000Z');
  assert.equal(lines[2], 'database: lummet-staging  size: 800 bytes  limit: 1000 bytes  used: 80%  status: WARN');
  assert.equal(lines[3], 'thresholds: warn 70%  critical 85%  (UNCONFIRMED [OPEN])');
  assert.equal(lines[4], 'tables: 5  rows: 5000');
  assert.ok(lines.includes('HIGH-VOLUME TABLES'));
  assert.ok(lines.includes('  lummet_audit_logs  group=audit  rows=4000  share=80%  status=WARN'));
  assert.ok(lines.includes('  request_errors  group=request_errors  rows=50  share=1%  status=UNKNOWN'));
  assert.ok(lines.includes('MOVE NEEDED: yes (lummet_audit_logs)  plan: docs/D1_SIZE_AND_TABLE_MOVE_PLAN.md'));
  assert.ok(lines.some((l) => l.startsWith('LABEL: NOT VERIFIED')));
  const unknown = formatText(buildReport(snapshot, policy, { now: NOW }));
  assert.match(unknown, /limit: unknown  used: unknown  status: UNKNOWN/);
});

test('AT-B collection reads table names and counts only, never row contents', async () => {
  const db = createTestDb(); applyMigrations(db);
  await db.prepare(`INSERT INTO request_errors (request_id, method, route, status, message) VALUES ('r1', 'GET', '/x', 500, 'secret-looking-message')`).run();
  await db.prepare(`INSERT INTO request_errors (request_id, method, route, status, message) VALUES ('r2', 'GET', '/x', 500, 'another')`).run();
  const seen = [];
  const runner = async (sql) => { seen.push(sql); return (await db.prepare(sql).all()).results; };
  const snap = await collectSnapshot(runner, { databaseName: 'x', databaseBytes: 123 });
  assert.equal(snap.tables.find((t) => t.name === 'request_errors').rows, 2);
  assert.ok(snap.tables.length > 50, 'every table is counted');
  assert.ok(!snap.tables.some((t) => t.name.startsWith('sqlite_')));
  assert.equal(snap.databaseBytes, 123);
  assert.ok(seen.every((s) => /^SELECT (name FROM sqlite_master|COUNT\(\*\) AS n FROM "[A-Za-z0-9_]+")/.test(s)), 'only table listing and COUNT(*) statements are issued');
  assert.ok(seen.every((s) => !/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|PRAGMA)\b/i.test(s)));
  assert.doesNotMatch(JSON.stringify(snap), /secret-looking-message/);
});

test('AT-B a table name that is not a plain identifier is skipped and reported, never interpolated', async () => {
  const runner = async (sql) => /sqlite_master/.test(sql) ? [{ name: 'good_table' }, { name: 'bad"; DROP TABLE x; --' }] : [{ n: 3 }];
  const snap = await collectSnapshot(runner, {});
  assert.deepEqual(snap.tables, [{ name: 'good_table', rows: 3 }]);
  assert.deepEqual(snap.skippedTables, 1);
});

test('AT-B the shipped policy names tables that exist in the migrations and stays unconfirmed', async () => {
  const p = await loadPolicy(path.join(root, 'config/d1-size-policy.v1.json'));
  assert.equal(p.confirmed, false);
  assert.equal(p.limitBytes, null, 'the plan limit is an owner fact, not assumed');
  const sql = (await Promise.all((await readdir(path.join(root, 'migrations'))).filter((f) => f.endsWith('.sql')).map((f) => read('migrations/' + f)))).join('\n');
  for (const name of Object.keys(p.highVolume)) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${name}\\b`), name);
  const groups = new Set(Object.values(p.highVolume).map((v) => v.group));
  assert.deepEqual([...groups].sort(), ['audit', 'email_history', 'request_errors']);
  assert.match(await read('config/d1-size-policy.v1.json'), /\[OPEN\]/);
});

test('AT-B CLI: --input snapshot prints text or JSON, --fail-on controls the exit code, bad usage exits 2', async () => {
  const snap = path.join(tmp, 'snap.json'), pol = path.join(tmp, 'pol.json');
  await writeFile(snap, JSON.stringify(snapshot)); await writeFile(pol, JSON.stringify({ ...policy, limitBytes: 1000 }));
  const t = await run(['scripts/d1-size-check.mjs', '--input', snap, '--policy', pol]);
  assert.equal(t.code, 0, t.stderr);
  assert.match(t.stdout, /^D1 SIZE CHECK \(lummet-d1-size-check\/1\)/);
  const j = await run(['scripts/d1-size-check.mjs', '--input', snap, '--policy', pol, '--json']);
  assert.equal(JSON.parse(j.stdout).database.status, 'warn');
  assert.equal((await run(['scripts/d1-size-check.mjs', '--input', snap, '--policy', pol, '--fail-on', 'warn'])).code, 1);
  await writeFile(pol, JSON.stringify({ ...policy, limitBytes: 850 }));
  assert.equal((await run(['scripts/d1-size-check.mjs', '--input', snap, '--policy', pol])).code, 1, 'critical exits 1 by default');
  await writeFile(pol, JSON.stringify(policy));
  assert.equal((await run(['scripts/d1-size-check.mjs', '--input', snap, '--policy', pol, '--require-known'])).code, 3, 'unknown with --require-known');
  assert.equal((await run(['scripts/d1-size-check.mjs'])).code, 2, 'no source is a usage error');
  assert.equal((await run(['scripts/d1-size-check.mjs', '--input', snap, '--fail-on', 'nonsense'])).code, 2);
});

test('AT-B the table-move plan names real tables, states what exists today and builds nothing', async () => {
  const doc = await read('docs/D1_SIZE_AND_TABLE_MOVE_PLAN.md');
  for (const t of ['request_errors', 'lummet_audit_logs', 'email_outbox']) assert.match(doc, new RegExp(t));
  assert.match(doc, /NOT VERIFIED/);
  assert.match(doc, /nothing is moved/i);
  assert.match(doc, /Rollback|rollback/);
  for (const p of doc.match(/`((?:worker|scripts|config|docs|test)\/[A-Za-z0-9_./-]+\.[a-z]+)`/g) || []) {
    const rel = p.replaceAll('`', '');
    assert.ok(existsSync(path.join(root, rel)), `plan cites ${rel}`);
  }
  // the facts the plan states about existing retention must match the code
  assert.match(await read('worker/cron.js'), /AUDIT_LOG_RETENTION_DAYS = 180/);
  assert.match(doc, /180 days/);
  assert.match(doc, /14 days/);
});

// ---------------------------------------------------------------------------------------------------------------------
// AT-C: policies labeled Draft, not approved
// ---------------------------------------------------------------------------------------------------------------------
const POLICIES = ['information-security', 'access-control', 'change-management', 'incident-response'];

test('AT-C the policy set starts with four drafts and an index, not the full twelve (7.4A completes it)', async () => {
  const files = (await readdir(path.join(root, 'docs/compliance/policies'))).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(files, POLICIES.map((p) => p + '.md').sort());
  const idx = await read('docs/compliance/README.md');
  for (const p of POLICIES) assert.match(idx, new RegExp(`policies/${p}\\.md`));
  assert.match(idx, /Draft, not approved/);
  assert.match(idx, /7\.4/, 'names the round that completes the set');
});

for (const p of POLICIES) {
  test(`AT-C ${p}: labeled Draft, not approved, no approver, no effective date, no compliance claim`, async () => {
    const t = await read(`docs/compliance/policies/${p}.md`);
    const lines = t.split('\n');
    assert.match(lines[0], /^# .+/);
    assert.match(lines.slice(0, 6).join('\n'), /\*\*Status: Draft, not approved\*\*/, 'label is at the top');
    assert.match(t, /^Approved by: \[OPEN\]$/m);
    assert.match(t, /^Approval date: \[OPEN\]$/m);
    assert.match(t, /^Effective date: \[OPEN\]$/m);
    assert.match(t, /^Policy owner: \[OPEN\]$/m);
    assert.match(t, /^Review interval: \[OPEN\]$/m);
    assert.doesNotMatch(t, /Status:\s*(Approved|Effective|Active|Final)/i);
    assert.doesNotMatch(t, /\b(is|are|was|been) (SOC ?2|ISO ?27001)[- ]?(compliant|certified|attested)/i);
    assert.doesNotMatch(t, /\b(SOC ?2|ISO ?27001) (compliance|certification|attestation) (is|has been) (achieved|obtained|received|complete)/i);
    assert.doesNotMatch(t, /\bcomplies with\b/i);
    assert.match(t, /does not claim/i, 'states that it makes no compliance claim');
    assert.doesNotMatch(t, /\b\d+ (hours?|days?|minutes?|months?|years?)\b(?![^\n]*\[OPEN\])(?![^\n]*(existing|built|code|default|today|currently|retain|purge))/i, 'no invented time window outside an [OPEN] or a stated code fact');
    for (const m of t.match(/`((?:worker|scripts|config|docs|test|\.github)\/[A-Za-z0-9_./*-]+)`/g) || []) {
      const rel = m.replaceAll('`', '');
      if (rel.includes('*')) continue;
      assert.ok(existsSync(path.join(root, rel)), `${p} cites ${rel}`);
    }
  });
}

test('AT-C policy placeholders are registered and the pen-test task is an owner task', async () => {
  for (const f of [path.join(root, 'docs/PLACEHOLDERS.md'), path.join(repoRoot, 'PLACEHOLDERS.md')]) {
    const t = await readFile(f, 'utf8');
    assert.match(t, /Round 6\.5C \(2\.6\.0\.14\): load test thresholds/);
    assert.match(t, /Round 6\.5C \(2\.6\.0\.14\): D1 size/);
    assert.match(t, /Round 6\.5C \(2\.6\.0\.14\): SOC 2 policy drafts/);
    assert.match(t, /Round 6\.5C \(2\.6\.0\.14\): external penetration test/);
  }
  const open = await readFile(path.join(repoRoot, 'OPEN_ITEMS_v2.6.0.14.md'), 'utf8');
  assert.match(open, /External penetration test/);
  assert.match(open, /Vendor: \[OPEN\]/);
  assert.match(open, /Date: \[OPEN\]/);
  assert.match(open, /OWNER TASK/);
  assert.match(open, /BLOCKED/);
});
