// Round 6.5B: runbooks and restore drill tooling.
//
// Acceptance tests, written before the implementation:
//   AT-A  Bulk-reactivation path audited (the mistaken-suspension escape hatch): staff only, a reason is required, every
//         outcome (success, partial, refused) writes ONE audit row that names the sites, and every site transition
//         records the staff actor and the reason.
//   AT-B  Restore tooling dry-run (AT-15 tooling): the default run restores nothing, needs no wrangler, validates the
//         backup, writes a report labelled NOT VERIFIED, and never prints a key or a row.
//   AT-C  Runbook links valid: every runbook exists, is indexed, and every link, file, route and setting it names is real.
// Plus: the drill refuses production and corrupted backups, apply needs explicit confirmation, a missing objective or
// missing manual timing is "unknown" (never zero), and the report carries no secret or customer data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, chmod, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as cp from '../worker/cp-backup.js';
import worker from '../worker/index.js';

const root = path.resolve(import.meta.dirname, '..');
const read = (f) => readFile(path.join(root, f), 'utf8');
const KEK = btoa('k'.repeat(32));
const PW = 'Correct-Horse-Battery-9';
const ctx = { waitUntil(p) { Promise.resolve(p).catch(() => {}); } };

// ---------------------------------------------------------------------------------------------------------------------
// AT-A: bulk reactivation is audited
// ---------------------------------------------------------------------------------------------------------------------
function cpEnv(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, CREDENTIAL_KEK: KEK, ENVIRONMENT: 'production', ...extra }; }
let ipn = 1;
async function call(e, method, p, { body, cookie } = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.' + (ipn++ % 250 + 1) });
  if (cookie) h.set('Cookie', cookie);
  let payload;
  if (body !== undefined) { h.set('Content-Type', 'application/json'); payload = JSON.stringify(body); }
  const res = await worker.fetch(new Request('https://cp.test' + p, { method, headers: h, body: payload, redirect: 'manual' }), e, ctx);
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}
async function staffCookie(e) {
  assert.equal((await call(e, 'POST', '/api/auth/bootstrap', { body: { email: 'root@example.com', password: PW } })).status, 200);
  return (await call(e, 'POST', '/api/auth/login', { body: { email: 'root@example.com', password: PW } })).cookie;
}
async function seedSites(e, defs) {
  await e.LUMMET_DB.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('org1', 'Acme', 'acme')`).run();
  for (const [id, status] of defs) {
    await e.LUMMET_DB.prepare(`INSERT INTO sites (id, organization_id, name, slug, product_id, status) VALUES (?, 'org1', ?, ?, 'prod_casino_news', ?)`).bind(id, 'Site ' + id, 'slug-' + id, status).run();
  }
}
const auditRows = async (e) => (await e.LUMMET_DB.prepare(`SELECT * FROM lummet_audit_logs WHERE action = 'bulk_reactivate' ORDER BY id`).all()).results;
const events = async (e, id) => (await e.LUMMET_DB.prepare(`SELECT * FROM site_status_events WHERE site_id = ? ORDER BY id`).bind(id).all()).results;
const BULK = '/api/platform/saas/sites/reactivate-bulk';

test('AT-A bulk reactivation: signed-out callers are refused and nothing is written', async () => {
  const e = cpEnv(); await seedSites(e, [['s1', 'suspended']]);
  const r = await call(e, 'POST', BULK, { body: { siteIds: ['s1'], reason: 'mistaken suspension' } });
  assert.equal(r.status, 401);
  assert.equal((await auditRows(e)).length, 0);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT status FROM sites WHERE id='s1'`).first()).status, 'suspended');
});

test('AT-A bulk reactivation: success writes one audit row naming the sites, and a status event per site with actor and reason', async () => {
  const e = cpEnv(); await seedSites(e, [['s1', 'suspended'], ['s2', 'suspended']]);
  const cookie = await staffCookie(e);
  const r = await call(e, 'POST', BULK, { cookie, body: { siteIds: ['s2', 's1', 's1'], reason: 'Stripe outage mis-suspended these' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.reactivated, 2);
  const rows = await auditRows(e);
  assert.equal(rows.length, 1);
  const a = rows[0];
  assert.equal(a.success, 1);
  assert.equal(a.status_code, 200);
  assert.equal(a.reason, 'Stripe outage mis-suspended these');
  assert.ok(a.admin_id, 'the staff member is recorded');
  assert.equal(a.resource, 'site');
  assert.deepEqual(String(a.resource_id).split(','), ['s1', 's2'], 'sorted, de-duplicated, one entry per site');
  for (const id of ['s1', 's2']) {
    const ev = (await events(e, id)).at(-1);
    assert.equal(ev.from_status, 'suspended');
    assert.equal(ev.to_status, 'active');
    assert.equal(ev.actor_type, 'lummet_admin');
    assert.equal(Number(ev.actor_id), Number(a.admin_id), 'the same staff member as the audit row');
    assert.ok(Number.isFinite(Number(ev.actor_id)) && Number(ev.actor_id) > 0);
    assert.match(ev.reason, /Stripe outage mis-suspended these/);
    assert.equal((await e.LUMMET_DB.prepare(`SELECT status FROM sites WHERE id=?`).bind(id).first()).status, 'active');
  }
});

test('AT-A bulk reactivation: a partial result is audited as a failure with the partial_failure code, and only the suspended site changes', async () => {
  const e = cpEnv(); await seedSites(e, [['s1', 'suspended'], ['s2', 'active']]);
  const cookie = await staffCookie(e);
  const r = await call(e, 'POST', BULK, { cookie, body: { siteIds: ['s1', 's2'], reason: 'confirmed with the customer' } });
  assert.equal(r.status, 207);
  assert.equal(r.json.reactivated, 1);
  assert.equal(r.json.failed, 1);
  const [a] = await auditRows(e);
  assert.equal(a.success, 0);
  assert.equal(a.status_code, 207);
  assert.equal(a.error_message, 'partial_failure');
  assert.deepEqual(String(a.resource_id).split(','), ['s1', 's2']);
  assert.equal((await events(e, 's2')).length, 0, 'an active site is untouched');
});

test('AT-A bulk reactivation: a missing reason, an empty list and an oversize list are refused and each refusal is audited', async () => {
  const e = cpEnv(); await seedSites(e, [['s1', 'suspended']]);
  const cookie = await staffCookie(e);
  assert.equal((await call(e, 'POST', BULK, { cookie, body: { siteIds: ['s1'], reason: '   ' } })).status, 422);
  assert.equal((await call(e, 'POST', BULK, { cookie, body: { siteIds: [], reason: 'because' } })).status, 422);
  const many = Array.from({ length: 101 }, (_, i) => 'x' + i);
  assert.equal((await call(e, 'POST', BULK, { cookie, body: { siteIds: many, reason: 'too many at once' } })).status, 422);
  const rows = await auditRows(e);
  assert.equal(rows.length, 3, 'a refusal is never silent');
  assert.ok(rows.every((x) => x.success === 0));
  assert.deepEqual(rows.map((x) => x.error_message), ['reason_required', 'invalid_site_ids', 'invalid_site_ids']);
  assert.ok(String(rows[2].resource_id).length <= 1000, 'the audit detail is bounded');
  assert.equal((await e.LUMMET_DB.prepare(`SELECT status FROM sites WHERE id='s1'`).first()).status, 'suspended');
});

// ---------------------------------------------------------------------------------------------------------------------
// AT-B: restore tooling dry-run
// ---------------------------------------------------------------------------------------------------------------------
function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; }, async delete(k) { m.delete(k); } };
}
async function makeBackupDir() {
  const e = cpEnv({ BACKUPS: fakeR2() });
  await e.LUMMET_DB.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('org1', 'Acme O''Brien', 'acme')`).run();
  await e.LUMMET_DB.prepare(`INSERT INTO customer_users (id, email, password_hash) VALUES ('u1', 'secret.person@example.com', 'hash-should-not-leak')`).run();
  await e.LUMMET_DB.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES ('org1', 'u1', 'owner')`).run();
  const b = await cp.createControlPlaneBackup(e);
  assert.equal(b.ok, true);
  const dir = await mkdtemp(path.join(tmpdir(), 'drill-bk-'));
  for (const [k, v] of e.BACKUPS.m) await writeFile(path.join(dir, path.basename(k)), v);
  return { dir, backup: b };
}
const DRILL = ['scripts/restore-drill.mjs'];
function drill(args, env = {}) {
  const r = spawnSync(process.execPath, [...DRILL, ...args], { cwd: root, env: { ...process.env, CREDENTIAL_KEK: KEK, ...env }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}
async function outFiles(dir) { return (await readdir(dir)).sort(); }

test('AT-B restore drill dry-run: default restores nothing, calls no wrangler, validates the backup and labels the report NOT VERIFIED', async () => {
  const { dir, backup } = await makeBackupDir();
  const outDir = await mkdtemp(path.join(tmpdir(), 'drill-out-'));
  const marker = path.join(outDir, 'wrangler-was-called');
  const spy = path.join(outDir, 'spy-wrangler.sh');
  await writeFile(spy, `#!/bin/sh\ntouch "${marker}"\nexit 9\n`); await chmod(spy, 0o755);
  const r = drill(['--backup-dir', dir, '--target-db', 'lummet-control-plane-staging-db', '--out-dir', outDir, '--drill-id', 'drill-test-1', '--wrangler-bin', spy]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.equal(existsSync(marker), false, 'a dry run never runs wrangler');
  const report = JSON.parse(await read(path.relative(root, path.join(outDir, 'restore-drill-report.json'))));
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.status, 'DRY RUN');
  assert.equal(report.evidenceLabel, 'NOT VERIFIED');
  assert.equal(report.backup.backupId, backup.backupId);
  assert.equal(report.backup.tables > 10, true);
  assert.equal(report.sqlCheck.ok, true);
  assert.equal(report.sqlCheck.statements, Object.values(report.backup.rowCounts).reduce((a, b) => a + b, 0), 'one INSERT per backed-up row');
  assert.equal(report.steps.find((s) => s.name === 'generate_restore_sql').ok, true);
  assert.equal(report.steps.find((s) => s.name === 'apply_restore_sql').status, 'skipped');
  assert.equal(report.steps.find((s) => s.name === 'verify_row_counts').status, 'skipped');
  assert.equal(report.rto.objectiveMinutes, 'unknown');
  assert.equal(report.rto.evaluation, 'not evaluated (dry run)');
  assert.equal(report.recoveryTime.totalMinutes, 'unknown', 'a dry run has no recovery time; it is never printed as 0');
  const md = await readFile(path.join(outDir, 'restore-drill-report.md'), 'utf8');
  assert.match(md, /NOT VERIFIED/);
  assert.equal(/\{\{[A-Z_]+\}\}/.test(md), false, 'every template placeholder is filled');
});

test('AT-B restore drill dry-run: no key, no row content and no restore.sql is left behind', async () => {
  const { dir } = await makeBackupDir();
  const outDir = await mkdtemp(path.join(tmpdir(), 'drill-out-'));
  const r = drill(['--backup-dir', dir, '--target-db', 'lummet-control-plane-staging-db', '--out-dir', outDir]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual((await outFiles(outDir)).filter((f) => f.endsWith('.sql')), [], 'restore.sql holds decrypted customer rows and is deleted unless --keep-sql');
  for (const f of await outFiles(outDir)) {
    const t = await readFile(path.join(outDir, f), 'utf8');
    for (const secret of [KEK, 'secret.person@example.com', 'hash-should-not-leak', "O'Brien"]) assert.equal(t.includes(secret), false, `${f} must not contain ${secret.slice(0, 8)}...`);
  }
  for (const secret of [KEK, 'secret.person@example.com']) assert.equal((r.out + r.err).includes(secret), false, 'stdout and stderr stay clean');
});

test('AT-B restore drill: --keep-sql keeps the file, owner-readable only', async () => {
  const { dir } = await makeBackupDir();
  const outDir = await mkdtemp(path.join(tmpdir(), 'drill-out-'));
  const r = drill(['--backup-dir', dir, '--target-db', 'lummet-control-plane-staging-db', '--out-dir', outDir, '--keep-sql']);
  assert.equal(r.code, 0, r.err);
  const sql = path.join(outDir, 'restore.sql');
  assert.equal(existsSync(sql), true);
  assert.equal((await stat(sql)).mode & 0o077, 0, 'mode 0600');
});

test('AT-B restore drill refuses production, an unrelated name, a missing key, a corrupted backup and an unsafe table name', async () => {
  const { dir } = await makeBackupDir();
  const outDir = await mkdtemp(path.join(tmpdir(), 'drill-out-'));
  const base = ['--backup-dir', dir, '--out-dir', outDir];
  // production database name comes from wrangler.jsonc, never from a constant in the script
  const prod = JSON.parse((await read('wrangler.jsonc')).replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')).d1_databases[0].database_name;
  let r = drill([...base, '--target-db', prod]);
  assert.equal(r.code, 2); assert.match(r.err, /production/i);
  r = drill([...base, '--target-db', 'my-scratch-db']);
  assert.equal(r.code, 2); assert.match(r.err, /staging/);
  r = drill([...base, '--target-db', 'x; DROP TABLE users-staging']);
  assert.equal(r.code, 2);
  r = drill([...base, '--target-db', 'lummet-control-plane-staging-db'], { CREDENTIAL_KEK: '' });
  assert.equal(r.code, 2); assert.match(r.err, /CREDENTIAL_KEK/);
  const part = (await readdir(dir)).find((f) => f.startsWith('part-'));
  await writeFile(path.join(dir, part), (await readFile(path.join(dir, part), 'utf8')) + ' ');
  r = drill([...base, '--target-db', 'lummet-control-plane-staging-db']);
  assert.notEqual(r.code, 0);
  const report = JSON.parse(await readFile(path.join(outDir, 'restore-drill-report.json'), 'utf8'));
  assert.equal(report.status, 'FAILED');
  assert.equal(report.evidenceLabel, 'NOT VERIFIED');
  assert.equal(report.steps.find((s) => s.name === 'generate_restore_sql').ok, false);
  assert.match(report.steps.find((s) => s.name === 'generate_restore_sql').detail, /Hash mismatch/);
});

test('AT-B restore drill: --apply needs the exact target name as --confirm and is refused otherwise', async () => {
  const { dir } = await makeBackupDir();
  const outDir = await mkdtemp(path.join(tmpdir(), 'drill-out-'));
  const base = ['--backup-dir', dir, '--target-db', 'lummet-control-plane-staging-db', '--out-dir', outDir, '--wrangler-bin', '/nonexistent/wrangler'];
  let r = drill([...base, '--apply']);
  assert.equal(r.code, 2); assert.match(r.err, /--confirm/);
  r = drill([...base, '--apply', '--confirm', 'something-else']);
  assert.equal(r.code, 2); assert.match(r.err, /--confirm/);
});

test('AT-B restore drill apply end to end against a stand-in database: restores, verifies counts, records timings and an unknown objective as unknown', async () => {
  const { dir } = await makeBackupDir();
  const work = await mkdtemp(path.join(tmpdir(), 'drill-apply-'));
  const binDir = path.join(work, 'bin'); await mkdir(binDir);
  const shim = path.join(binDir, 'wrangler');
  await writeFile(shim, `#!/usr/bin/env node\nimport('${path.join(root, 'test/support/fake-wrangler.mjs').replace(/\\/g, '/')}');\n`); await chmod(shim, 0o755);
  const dbPath = path.join(work, 'staging.sqlite');
  const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_WRANGLER_DB_PATH: dbPath };
  execFileSync(process.execPath, ['scripts/migrate.mjs', '--db', 'lummet-control-plane-staging-db'], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  const outDir = path.join(work, 'out');
  const r = drill(['--backup-dir', dir, '--target-db', 'lummet-control-plane-staging-db', '--out-dir', outDir, '--apply', '--confirm', 'lummet-control-plane-staging-db', '--wrangler-bin', shim], env);
  assert.equal(r.code, 0, r.err + r.out);
  const report = JSON.parse(await readFile(path.join(outDir, 'restore-drill-report.json'), 'utf8'));
  assert.equal(report.mode, 'apply');
  assert.equal(report.status, 'APPLIED, PENDING OWNER REVIEW');
  assert.equal(report.evidenceLabel, 'NOT VERIFIED', 'the tool never grants itself VERIFIED IN STAGING');
  assert.equal(report.verify.ok, true);
  assert.equal(report.verify.mismatches.length, 0);
  assert.equal(report.rto.objectiveMinutes, 'unknown');
  assert.equal(report.rto.evaluation, 'no objective supplied');
  assert.equal(report.recoveryTime.complete, false, 'manual steps were not supplied');
  assert.equal(report.recoveryTime.totalMinutes, 'unknown');
  for (const s of ['generate_restore_sql', 'apply_restore_sql', 'verify_row_counts']) {
    const st = report.steps.find((x) => x.name === s);
    assert.equal(st.ok, true, s);
    assert.equal(typeof st.seconds, 'number');
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare(`SELECT name FROM organizations WHERE id='org1'`).get().name, "Acme O'Brien");
  assert.deepEqual((await outFiles(outDir)).filter((f) => f.endsWith('.sql')), []);
});

test('AT-B restore drill apply: complete manual timings give a total, and the objective is evaluated; a count mismatch fails the drill', async () => {
  const { dir } = await makeBackupDir();
  const work = await mkdtemp(path.join(tmpdir(), 'drill-apply-'));
  const binDir = path.join(work, 'bin'); await mkdir(binDir);
  const shim = path.join(binDir, 'wrangler');
  await writeFile(shim, `#!/usr/bin/env node\nimport('${path.join(root, 'test/support/fake-wrangler.mjs').replace(/\\/g, '/')}');\n`); await chmod(shim, 0o755);
  const dbPath = path.join(work, 'staging.sqlite');
  const env = { PATH: `${binDir}:${process.env.PATH}`, FAKE_WRANGLER_DB_PATH: dbPath };
  execFileSync(process.execPath, ['scripts/migrate.mjs', '--db', 'lummet-control-plane-staging-db'], { cwd: root, env: { ...process.env, ...env }, stdio: 'pipe' });
  const args = (outDir, extra = []) => ['--backup-dir', dir, '--target-db', 'lummet-control-plane-staging-db', '--out-dir', outDir, '--apply', '--confirm', 'lummet-control-plane-staging-db', '--wrangler-bin', shim, '--rto-minutes', '90', '--manual', 'download=12', '--manual', 'create_db=2', '--manual', 'migrate=6', '--manual', 'repoint=3', ...extra];
  const out1 = path.join(work, 'o1');
  let r = drill(args(out1), env);
  assert.equal(r.code, 0, r.err + r.out);
  let report = JSON.parse(await readFile(path.join(out1, 'restore-drill-report.json'), 'utf8'));
  assert.equal(report.recoveryTime.complete, true);
  assert.equal(typeof report.recoveryTime.totalMinutes, 'number');
  assert.ok(report.recoveryTime.totalMinutes >= 23);
  assert.equal(report.rto.objectiveMinutes, 90);
  assert.equal(report.rto.evaluation, 'within objective (measurement only; not evidence until owner-reviewed)');
  const r2 = drill(args(path.join(work, 'o2'), ['--rto-minutes', '5']), env);
  report = JSON.parse(await readFile(path.join(work, 'o2', 'restore-drill-report.json'), 'utf8'));
  assert.equal(report.rto.objectiveMinutes, 5);
  assert.equal(report.rto.evaluation, 'objective exceeded');
  // a row the backup does not contain makes the staging copy differ: the drill must say so, not pass
  const { DatabaseSync } = await import('node:sqlite');
  new DatabaseSync(dbPath).exec(`INSERT INTO organizations (id, name, slug) VALUES ('extra', 'Extra', 'extra')`);
  const r3 = drill(args(path.join(work, 'o3')), env);
  assert.notEqual(r3.code, 0);
  report = JSON.parse(await readFile(path.join(work, 'o3', 'restore-drill-report.json'), 'utf8'));
  assert.equal(report.status, 'FAILED');
  assert.equal(report.verify.ok, false);
  assert.deepEqual(report.verify.mismatches.map((m) => m.table), ['organizations']);
  assert.equal(r2.code, 0);
});

test('AT-B restore drill: bad manual or objective values are refused, never coerced to zero', async () => {
  const { dir } = await makeBackupDir();
  const outDir = await mkdtemp(path.join(tmpdir(), 'drill-out-'));
  const base = ['--backup-dir', dir, '--target-db', 'lummet-control-plane-staging-db', '--out-dir', outDir];
  for (const bad of [['--rto-minutes', '0'], ['--rto-minutes', 'soon'], ['--rto-minutes', '-5'], ['--manual', 'download=abc'], ['--manual', 'coffee=5'], ['--manual', 'download=-1']]) {
    const r = drill([...base, ...bad]);
    assert.equal(r.code, 2, bad.join(' '));
  }
});

test('AT-B the report template has no placeholder the tool cannot fill, and says the drill is owner-run and NOT VERIFIED until evidence is attached', async () => {
  const t = await read('docs/RESTORE_DRILL_REPORT_TEMPLATE.md');
  assert.match(t, /NOT VERIFIED/);
  assert.match(t, /owner-run/i);
  const script = await read('scripts/restore-drill.mjs');
  for (const m of t.matchAll(/\{\{([A-Z_]+)\}\}/g)) assert.ok(script.includes(m[1]), `script fills {{${m[1]}}}`);
  assert.match(t, /\[OPEN\]/, 'owner-supplied values are registered placeholders');
});

// ---------------------------------------------------------------------------------------------------------------------
// AT-C: runbook links valid
// ---------------------------------------------------------------------------------------------------------------------
const RUNBOOKS = [
  'webhook-backlog', 'stripe-outage', 'd1-incident', 'cloudflare-incident', 'mass-email-failure', 'mistaken-suspension', 'restore-drill',
];
const slug = (h) => h.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9 _-]/g, '').trim().replace(/ /g, '-');
async function headingsOf(file) { return new Set([...(await readFile(file, 'utf8')).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1]))); }
const stripFences = (s) => s.replace(/```[\s\S]*?```/g, '');

test('AT-C runbooks: the index lists every runbook and every runbook file exists', async () => {
  const idx = await read('docs/RUNBOOKS.md');
  for (const r of RUNBOOKS) {
    assert.ok(existsSync(path.join(root, 'docs/runbooks', r + '.md')), `docs/runbooks/${r}.md exists`);
    assert.ok(idx.includes(`runbooks/${r}.md`), `index links ${r}`);
  }
  const onDisk = (await readdir(path.join(root, 'docs/runbooks'))).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort();
  assert.deepEqual(onDisk, [...RUNBOOKS].sort(), 'no unindexed runbook');
  assert.match(idx, /NOT VERIFIED/);
});

test('AT-C runbooks: every relative link resolves, anchors included', async () => {
  const files = ['docs/RUNBOOKS.md', 'docs/RESTORE_DRILL_REPORT_TEMPLATE.md', ...RUNBOOKS.map((r) => `docs/runbooks/${r}.md`)];
  let checked = 0;
  for (const f of files) {
    const abs = path.join(root, f);
    const text = stripFences(await readFile(abs, 'utf8'));
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [rel, anchor] = href.split('#');
      const target = rel ? path.resolve(path.dirname(abs), rel) : abs;
      assert.ok(existsSync(target), `${f}: broken link ${href}`);
      if (anchor && target.endsWith('.md')) assert.ok((await headingsOf(target)).has(anchor), `${f}: missing anchor ${href}`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `expected the runbooks to cross-link (got ${checked})`);
});


// Route shapes declared in worker/index.js, compared segment by segment (a parameter is ':p'). Three declaration styles exist:
// an exact `path === "/api/..."`, `matchPath("/api/.../:id/...", path)`, and a regex literal such as the webhook replay route.
function routeShapesOf(src) {
  const shapes = new Set();
  const norm = (r) => r.replace(/\/$/, '').split('/').map((seg) => (seg.startsWith(':') ? ':p' : seg)).join('/');
  for (const m of src.matchAll(/"(\/api\/platform\/saas\/[A-Za-z0-9\-/:_]+)"/g)) shapes.add(norm(m[1]));
  for (const m of src.matchAll(/\/\^((?:\\\/[A-Za-z0-9_-]+|\\\/\([^)]*\))+)\$\//g)) {
    const lit = m[1].replace(/\\\//g, '/');
    if (lit.startsWith('/api/platform/saas/')) shapes.add(lit.replace(/\([^)]*\)/g, ':p'));
  }
  return shapes;
}
function docRouteShape(route) {
  return route.replace(/[.,;:)]+$/, '').replace(/\/$/, '').split('/').map((seg) => (/^(:[A-Za-z]+|<[^>]+>|\{[^}]+\}|evt_[A-Za-z0-9_]*)$/.test(seg) ? ':p' : seg)).join('/');
}
let ROUTE_SHAPES = new Set();

test('AT-C runbooks: every file, script, route and setting a runbook names is real', async () => {
  ROUTE_SHAPES = routeShapesOf(await read('worker/index.js'));
  const files = ['docs/RUNBOOKS.md', ...RUNBOOKS.map((r) => `docs/runbooks/${r}.md`)];
  const indexJs = await read('worker/index.js');
  const haystack = [indexJs, await read('docs/CONFIGURATION.md'), await read('wrangler.jsonc'), await read('worker/config-check.js'), await read('worker/alerts.js'), await read('docs/ALERTING.md')].join('\n');
  const workerFiles = (await readdir(path.join(root, 'worker'))).filter((f) => f.endsWith('.js'));
  for (const f of workerFiles) { const t = await read('worker/' + f); if (/\b[A-Z][A-Z0-9_]{5,}\b/.test(t)) { /* settings are searched lazily below */ } }
  const allWorker = (await Promise.all(workerFiles.map((f) => read('worker/' + f)))).join('\n');
  const scripts = (await Promise.all((await readdir(path.join(root, 'scripts'))).filter((f) => f.endsWith('.mjs')).map((f) => read('scripts/' + f)))).join('\n');
  for (const f of files) {
    const text = stripFences(await readFile(path.join(root, f), 'utf8')) + '\n' + [...(await readFile(path.join(root, f), 'utf8')).matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join('\n');
    for (const m of text.matchAll(/(?<![\w/.-])((?:scripts|docs|worker|config|migrations|test)\/[A-Za-z0-9_./-]+\.(?:mjs|js|md|json|sql))\b/g)) {
      assert.ok(existsSync(path.join(root, m[1])), `${f}: ${m[1]} does not exist`);
    }
    for (const m of text.matchAll(/(\/api\/platform\/saas\/[A-Za-z0-9\-/:_<>{}]+)/g)) {
      const shape = docRouteShape(m[1]);
      assert.ok(ROUTE_SHAPES.has(shape), `${f}: route ${m[1]} (as ${shape}) is not a route in worker/index.js`);
    }
    for (const m of text.matchAll(/`([A-Z][A-Z0-9_]{5,})`/g)) {
      const name = m[1];
      if (['NOT_VERIFIED'].includes(name)) continue;
      assert.ok(haystack.includes(name) || allWorker.includes(name) || scripts.includes(name), `${f}: setting ${name} is not defined anywhere`);
    }
  }
});

test('AT-C runbooks: each has the sections an on-call person needs, names no secret value, and states its evidence label', async () => {
  const required = [/^## Trigger/m, /^## First 15 minutes/m, /^## Do not/m, /^## Recovery and verification/m, /^## Record the incident/m, /^## Who and how \(placeholders\)/m, /^## Evidence status/m];
  for (const r of RUNBOOKS) {
    const t = await read(`docs/runbooks/${r}.md`);
    for (const re of required) assert.match(t, re, `${r} has ${re}`);
    assert.match(t, /NOT VERIFIED/, `${r} is labelled NOT VERIFIED`);
    assert.match(t, /\[OPEN\]/, `${r} registers owner-supplied values as [OPEN]`);
    assert.equal(/\b(sk_live_|sk_test_|rk_live_|whsec_)[A-Za-z0-9]{6,}/.test(t), false, `${r} contains no secret value`);
    assert.equal(/Bearer [A-Za-z0-9._-]{20,}/.test(t), false);
    assert.ok(t.split('\n').length >= 40, `${r} is substantive`);
  }
});

test('AT-C runbooks: the rules the blueprint sets are written down where they apply', async () => {
  const stripe = await read('docs/runbooks/stripe-outage.md');
  assert.match(stripe, /never fake success/i);
  assert.match(stripe, /queue/i); assert.match(stripe, /retry/i);
  assert.match(stripe, /BILLING_SUSPEND_SITES/);
  const susp = await read('docs/runbooks/mistaken-suspension.md');
  assert.match(susp, /\/api\/platform\/saas\/sites\/reactivate-bulk/);
  assert.match(susp, /reason/i); assert.match(susp, /audit/i);
  assert.match(susp, /site_status_events/);
  assert.match(susp, /100/);
  const drillDoc = await read('docs/runbooks/restore-drill.md');
  assert.match(drillDoc, /scripts\/restore-drill\.mjs/);
  assert.match(drillDoc, /restore-time objective/i);
  assert.match(drillDoc, /AT-15/);
  const d1 = await read('docs/runbooks/d1-incident.md');
  assert.match(d1, /Time Travel/);
  const mail = await read('docs/runbooks/mass-email-failure.md');
  assert.match(mail, /email_outbox/);
  const hook = await read('docs/runbooks/webhook-backlog.md');
  assert.match(hook, /billing_webhook_events/);
  assert.match(hook, /\/api\/platform\/saas\/webhooks\/failed/);
});

test('AT-C the runbooks are linked from the places an operator starts, and the placeholders are registered', async () => {
  assert.match(await read('docs/GO_LIVE_CHECKLIST.md'), /RUNBOOKS\.md/);
  assert.match(await read('docs/ALERTING.md'), /RUNBOOKS\.md/);
  assert.match(await read('docs/CONTROL_PLANE_BACKUP.md'), /restore-drill\.md/);
  const ph = await read('docs/PLACEHOLDERS.md');
  assert.match(ph, /\[OPEN\] Round 6\.5B/);
  assert.match(await read('../PLACEHOLDERS.md'), /\[OPEN\] Round 6\.5B/);
  assert.match(await read('docs/CONFIGURATION.md'), /restore-drill|RESTORE_RTO/);
});
