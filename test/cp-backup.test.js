// Roadmap 2.3: control-plane database backup, verification, retention, restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createTestDb, applyMigrations, splitSqlStatements } from './support/d1-shim.js';
import * as cp from '../worker/cp-backup.js';
import { runAlertCheck } from '../worker/alerts.js';
import worker from '../worker/index.js';

function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; }, async delete(k) { m.delete(k); } };
}
const KEK = btoa('k'.repeat(32));
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, BACKUPS: fakeR2(), CREDENTIAL_KEK: KEK, ENVIRONMENT: 'production', ...extra }; }
async function seed(e) {
  const db = e.LUMMET_DB;
  await db.prepare(`INSERT INTO organizations (id, name, slug) VALUES ('org1', 'Acme O''Brien', 'acme')`).run();
  await db.prepare(`INSERT INTO customer_users (id, email, password_hash) VALUES ('u1', 'a@example.com', 'hash')`).run();
  await db.prepare(`INSERT INTO organization_users (organization_id, user_id, role) VALUES ('org1', 'u1', 'owner')`).run();
  await db.prepare(`INSERT INTO customer_sessions (id, user_id, expires_at) VALUES ('sess1', 'u1', '2099-01-01')`).run();
  await db.prepare(`INSERT INTO lummet_auth_attempts (ip_hash, action, created_at) VALUES ('h', 'login', '2026-01-01')`).run();
}
const dump = async (db, t) => (await db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).all()).results;

test('backup stores encrypted parts and a manifest; nothing readable without the key', async () => {
  const e = env(); await seed(e);
  const r = await cp.createControlPlaneBackup(e);
  assert.equal(r.ok, true);
  assert.ok(r.rowCounts.organizations === 1);
  const keys = [...e.BACKUPS.m.keys()];
  assert.ok(keys.some((k) => k.endsWith('manifest.json')));
  const partText = [...e.BACKUPS.m.entries()].filter(([k]) => k.includes('part-')).map(([, v]) => v).join('');
  assert.equal(partText.includes('a@example.com'), false, 'rows are encrypted at rest');
  assert.equal(partText.includes("O'Brien"), false);
});

test('short-lived and sensitive tables are not exported', async () => {
  const e = env(); await seed(e);
  const tables = await cp.listExportTables(e);
  for (const t of ['customer_sessions', 'lummet_sessions', 'lummet_auth_attempts', 'customer_password_resets', 'schema_migrations']) assert.equal(tables.includes(t), false, t);
  assert.ok(tables.includes('organizations') && tables.includes('subscriptions') && tables.includes('lummet_audit_logs'));
  assert.ok(tables.indexOf('organizations') < tables.indexOf('organization_users'), 'parents come before children');
  const r = await cp.createControlPlaneBackup(e);
  assert.equal(r.rowCounts.customer_sessions, undefined);
});

test('verify passes on an intact backup and detects tampering, deletion and wrong counts', async () => {
  const e = env(); await seed(e);
  const { backupId } = await cp.createControlPlaneBackup(e);
  assert.equal((await cp.verifyControlPlaneBackup(e, backupId)).ok, true);
  assert.equal((await e.LUMMET_DB.prepare(`SELECT verification_status s FROM control_plane_backups WHERE id=?`).bind(backupId).first()).s, 'ok');

  const partKey = [...e.BACKUPS.m.keys()].find((k) => k.includes('part-'));
  const original = e.BACKUPS.m.get(partKey);
  e.BACKUPS.m.set(partKey, original.replace(/.$/, (c) => (c === '}' ? ' }' : '}')));
  assert.equal((await cp.verifyControlPlaneBackup(e, backupId)).error, 'part_hash_mismatch');
  e.BACKUPS.m.delete(partKey);
  assert.equal((await cp.verifyControlPlaneBackup(e, backupId)).error, 'part_missing');
  e.BACKUPS.m.set(partKey, original);
  assert.equal((await cp.verifyControlPlaneBackup(e, backupId)).ok, true, 'restored original verifies again');

  const manKey = [...e.BACKUPS.m.keys()].find((k) => k.endsWith('manifest.json'));
  const man = JSON.parse(e.BACKUPS.m.get(manKey)); man.rowCounts.organizations = 99; e.BACKUPS.m.set(manKey, JSON.stringify(man));
  assert.equal((await cp.verifyControlPlaneBackup(e, backupId)).error, 'row_count_mismatch');
  assert.equal((await cp.verifyControlPlaneBackup(e, 'nope')).status, 404);
});

test('a backup made with a different key cannot be verified or read', async () => {
  const e = env(); await seed(e);
  const { backupId } = await cp.createControlPlaneBackup(e);
  const wrong = { ...e, CREDENTIAL_KEK: btoa('z'.repeat(32)) };
  assert.equal((await cp.verifyControlPlaneBackup(wrong, backupId)).error, 'part_not_decryptable');
});

test('large tables span several parts and pages and still round-trip exactly', async () => {
  const e = env(); await seed(e);
  const db = e.LUMMET_DB; const note = 'x'.repeat(700);
  await db.prepare('BEGIN').run().catch(() => {});
  for (let i = 0; i < 2500; i++) await db.prepare(`INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off, note) VALUES (?, ?, 'stripe', 'c', 10, ?)`).bind('cid' + i, 'CODE' + i, note).run();
  await db.prepare('COMMIT').run().catch(() => {});
  const r = await cp.createControlPlaneBackup(e);
  assert.equal(r.ok, true);
  assert.ok(r.parts >= 2, 'expected more than one part, got ' + r.parts);
  assert.equal(r.rowCounts.coupons, 2500);
  assert.equal((await cp.verifyControlPlaneBackup(e, r.backupId)).ok, true);
});

test('restoring the backup into a freshly migrated database reproduces the data', async () => {
  const e = env(); await seed(e);
  await e.LUMMET_DB.prepare(`INSERT INTO coupons (id, code, provider, provider_coupon_id, percent_off, note) VALUES ('c1','SAVE','stripe','p',10,'it''s "quoted"; ok')`).run();
  const { backupId } = await cp.createControlPlaneBackup(e);

  const fresh = createTestDb(); applyMigrations(fresh);
  for await (const { t, r } of cp.readBackupRows(e, backupId)) await fresh.prepare(cp.rowToSql(t, r)).run();

  for (const t of ['organizations', 'customer_users', 'organization_users', 'coupons', 'plans', 'plan_entitlements']) {
    assert.deepEqual(await dump(fresh, t), await dump(e.LUMMET_DB, t), t);
  }
  assert.equal((await dump(fresh, 'customer_sessions')).length, 0, 'sessions are not restored');
});

test('the offline restore script rebuilds the data from downloaded files and refuses corrupted ones', async () => {
  const e = env(); await seed(e);
  const { backupId } = await cp.createControlPlaneBackup(e);
  const dir = await mkdtemp(path.join(tmpdir(), 'cpb-'));
  for (const [k, v] of e.BACKUPS.m) await writeFile(path.join(dir, path.basename(k)), v);

  const sql = execFileSync('node', ['scripts/restore-control-plane.mjs', dir], { env: { ...process.env, CREDENTIAL_KEK: KEK }, encoding: 'utf8' });
  assert.match(sql, /INSERT OR REPLACE INTO "organizations"/);
  const fresh = createTestDb(); applyMigrations(fresh);
  for (const stmt of splitSqlStatements(sql).filter((l) => l.startsWith('INSERT'))) await fresh.prepare(stmt).run();
  assert.deepEqual(await dump(fresh, 'organizations'), await dump(e.LUMMET_DB, 'organizations'));
  assert.deepEqual(await dump(fresh, 'customer_users'), await dump(e.LUMMET_DB, 'customer_users'));

  const partFile = [...e.BACKUPS.m.keys()].find((k) => k.includes('part-'));
  await writeFile(path.join(dir, path.basename(partFile)), (await readFile(path.join(dir, path.basename(partFile)), 'utf8')) + ' ');
  assert.throws(() => execFileSync('node', ['scripts/restore-control-plane.mjs', dir], { env: { ...process.env, CREDENTIAL_KEK: KEK }, stdio: 'pipe' }), /Hash mismatch|Command failed/);
  assert.throws(() => execFileSync('node', ['scripts/restore-control-plane.mjs', dir], { env: { ...process.env, CREDENTIAL_KEK: '' }, stdio: 'pipe' }), /Command failed/);
});

test('without backup storage it fails closed, and a failure mid-export is recorded', async () => {
  const none = env({ BACKUPS: undefined });
  assert.equal((await cp.createControlPlaneBackup(none)).error, 'backup_storage_not_configured');
  assert.equal((await cp.runControlPlaneBackupIfDue(none)).ran, false);

  const e = env(); await seed(e);
  e.BACKUPS.put = async () => { throw new Error('r2 down'); };
  const r = await cp.createControlPlaneBackup(e);
  assert.equal(r.ok, false); assert.equal(r.error, 'backup_failed');
  const row = await e.LUMMET_DB.prepare(`SELECT status, error_message FROM control_plane_backups`).first();
  assert.equal(row.status, 'failed'); assert.match(row.error_message, /r2 down/);
});

test('runIfDue only backs up when none is recent or running, and keeps just the newest N', async () => {
  const e = env(); await seed(e);
  const t0 = Date.parse('2026-10-04T00:00:00Z');
  assert.equal((await cp.runControlPlaneBackupIfDue(e, { now: t0 })).ran, true);
  assert.equal((await cp.runControlPlaneBackupIfDue(e, { now: t0 + 3600e3 })).reason, 'not_due');
  await e.LUMMET_DB.prepare(`UPDATE control_plane_backups SET created_at = datetime('now','-1 hours')`).run();
  assert.equal((await cp.runControlPlaneBackupIfDue(e)).reason, 'not_due');
  await e.LUMMET_DB.prepare(`UPDATE control_plane_backups SET created_at = datetime('now','-2 days')`).run();
  assert.equal((await cp.runControlPlaneBackupIfDue(e)).ran, true);

  await e.LUMMET_DB.prepare(`INSERT INTO control_plane_backups (id, status, storage_prefix, created_at) VALUES ('stuck','running','p/stuck', datetime('now','-5 minutes'))`).run();
  await e.LUMMET_DB.prepare(`UPDATE control_plane_backups SET created_at = datetime('now','-3 days') WHERE id != 'stuck'`).run();
  assert.equal((await cp.runControlPlaneBackupIfDue(e)).reason, 'not_due', 'a run already in progress blocks a second one');

  const e2 = env(); await seed(e2);
  for (let i = 0; i < 17; i++) { await cp.createControlPlaneBackup(e2, { now: Date.parse('2026-09-01T00:00:00Z') + i * 86400e3 }); await e2.LUMMET_DB.prepare(`UPDATE control_plane_backups SET created_at = datetime('2026-09-01', '+${i} days') WHERE rowid = (SELECT MAX(rowid) FROM control_plane_backups)`).run(); }
  const before = e2.BACKUPS.m.size;
  assert.equal((await cp.purgeOldControlPlaneBackups(e2)).purged, 3);
  assert.ok(e2.BACKUPS.m.size < before);
  assert.equal((await e2.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM control_plane_backups WHERE status='complete'`).first()).n, 14);
  const newest = await e2.LUMMET_DB.prepare(`SELECT id FROM control_plane_backups WHERE status='expired' ORDER BY created_at DESC LIMIT 1`).first();
  assert.ok(newest, 'the OLDEST ones were expired');
});

test('stale-backup alert fires only when backup storage is configured', async () => {
  const hook = 'https://hooks.example.com/x'; const calls = []; const f = async (u, i) => { calls.push(JSON.parse(i.body)); return new Response('', { status: 200 }); };
  const noStorage = env({ BACKUPS: undefined, ALERT_WEBHOOK_URL: hook });
  const a = await runAlertCheck(noStorage, { fetchImpl: f });
  assert.equal(a.results.find((r) => r.key === 'backup_stale'), undefined);

  const e = env({ ALERT_WEBHOOK_URL: hook });
  const b = await runAlertCheck(e, { fetchImpl: f });
  assert.equal(b.results.find((r) => r.key === 'backup_stale').action, 'notified');
  assert.ok(calls.some((c) => /control-plane backup/.test(c.text)), 'the stale-backup message was sent (other alerts may be sent too)');
  await cp.createControlPlaneBackup(e);
  const c = await runAlertCheck(e, { fetchImpl: f });
  assert.equal(c.results.find((r) => r.key === 'backup_stale').action, 'resolved');
});

async function call(e, method, path, body, cookie, extra = {}) {
  const h = new Headers({ 'CF-Connecting-IP': '198.51.100.31', ...extra }); if (cookie) h.set('Cookie', cookie); if (body) h.set('Content-Type', 'application/json');
  const res = await worker.fetch(new Request('https://cp.test' + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' }), e, { waitUntil(p) { Promise.resolve(p).catch(() => {}); } });
  const t = await res.text(); let j = null; try { j = JSON.parse(t); } catch {}
  return { status: res.status, json: j, text: t, cookie: (res.headers.get('Set-Cookie') || '').split(';')[0] };
}

test('staff can create and verify a backup from the console; anonymous callers cannot; the pinger tick makes a due backup', async () => {
  const e = env({ ALERT_CHECK_TOKEN: 'tok-123' });
  assert.equal((await call(e, 'POST', '/api/platform/saas/cp-backups')).status, 401);
  assert.ok([301, 302, 303].includes((await call(e, 'GET', '/platform/saas/cp-backups')).status));
  await call(e, 'POST', '/api/auth/bootstrap', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' });
  const cookie = (await call(e, 'POST', '/api/auth/login', { email: 'root@example.com', password: 'Correct-Horse-Battery-9' })).cookie;

  const made = await call(e, 'POST', '/api/platform/saas/cp-backups', null, cookie);
  assert.equal(made.status, 200, made.text);
  const id = (await e.LUMMET_DB.prepare(`SELECT id FROM control_plane_backups`).first()).id;
  assert.equal((await call(e, 'POST', `/api/platform/saas/cp-backups/${id}/verify`, null, cookie)).status, 200);
  const page = await call(e, 'GET', '/platform/saas/cp-backups', null, cookie);
  assert.equal(page.status, 200); assert.match(page.text, /complete/); assert.match(page.text, /ok/);

  await e.LUMMET_DB.prepare(`UPDATE control_plane_backups SET created_at = datetime('now','-3 days')`).run();
  const tick = await call(e, 'POST', '/api/ops/alert-check', null, null, { Authorization: 'Bearer tok-123' });
  assert.equal(tick.status, 200);
  // The backup runs in the background (waitUntil); wait for it instead of guessing how long a loaded machine needs.
  let done = 0;
  for (let i = 0; i < 100 && done < 2; i++) {
    await new Promise((r) => setTimeout(r, 50));
    done = (await e.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM control_plane_backups WHERE status='complete'`).first()).n;
  }
  assert.equal(done, 2);
});
