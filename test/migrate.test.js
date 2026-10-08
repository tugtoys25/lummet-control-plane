import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// Builds an isolated fake project: its own migrations/ dir, its own sqlite
// file standing in for a D1 database, and a fake `wrangler` shimmed onto
// PATH so scripts/migrate.mjs runs against real SQL with no network access
// and no real Cloudflare account.
function setup(migrationFiles) {
  const root = mkdtempSync(join(tmpdir(), 'lummet-migrate-test-'));
  const migrationsDir = join(root, 'migrations');
  mkdirSync(migrationsDir);
  for (const [name, sql] of Object.entries(migrationFiles)) writeFileSync(join(migrationsDir, name), sql);

  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  const wranglerShim = join(binDir, 'wrangler');
  writeFileSync(wranglerShim, `#!/usr/bin/env node\nimport('${join(__dirname, 'support', 'fake-wrangler.mjs').replace(/\\/g, '/')}');\n`);
  chmodSync(wranglerShim, 0o755);

  const dbPath = join(root, 'db.sqlite');
  const scriptPath = join(root, 'scripts', 'migrate.mjs');
  mkdirSync(join(root, 'scripts'));
  writeFileSync(scriptPath, readFileSync(join(REPO_ROOT, 'scripts', 'migrate.mjs'), 'utf8'));

  return { root, dbPath, scriptPath, binDir };
}

function runMigrate(ctx, extraArgs = []) {
  return execFileSync('node', [ctx.scriptPath, '--db', 'test-db', '--remote', ...extraArgs], {
    env: { ...process.env, PATH: `${ctx.binDir}:${process.env.PATH}`, FAKE_WRANGLER_DB_PATH: ctx.dbPath },
    encoding: 'utf8'
  });
}

function tableNames(dbPath) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  db.close();
  return rows.map((r) => r.name).sort();
}

function appliedFilenames(dbPath) {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare('SELECT filename FROM schema_migrations ORDER BY filename').all();
  db.close();
  return rows.map((r) => r.filename);
}

test('applies migrations in order and records each one', () => {
  const ctx = setup({
    '0001_a.sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);',
    '0002_b.sql': 'CREATE TABLE gadgets (id INTEGER PRIMARY KEY);'
  });
  const out = runMigrate(ctx);
  assert.match(out, /2 pending migration/);
  assert.deepEqual(tableNames(ctx.dbPath), ['gadgets', 'schema_migrations', 'widgets']);
  assert.deepEqual(appliedFilenames(ctx.dbPath), ['0001_a.sql', '0002_b.sql']);
  rmSync(ctx.root, { recursive: true, force: true });
});

test('re-running is a no-op: a non-idempotent statement is never executed twice', () => {
  const ctx = setup({ '0001_a.sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY); ALTER TABLE widgets ADD COLUMN name TEXT;' });
  runMigrate(ctx);
  // A second run must NOT re-run 0001 — if it did, this ALTER TABLE
  // (non-idempotent: no "IF NOT EXISTS" for ADD COLUMN in SQLite) would
  // throw "duplicate column name", proving the skip logic works.
  const out2 = runMigrate(ctx);
  assert.match(out2, /Nothing to do/);
  rmSync(ctx.root, { recursive: true, force: true });
});

test('only new, previously-unseen migrations are applied on a later run', () => {
  const ctx = setup({ '0001_a.sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);' });
  runMigrate(ctx);
  writeFileSync(join(ctx.root, 'migrations', '0002_b.sql'), 'CREATE TABLE gadgets (id INTEGER PRIMARY KEY);');
  const out = runMigrate(ctx);
  assert.match(out, /1 pending migration/);
  assert.deepEqual(appliedFilenames(ctx.dbPath), ['0001_a.sql', '0002_b.sql']);
  rmSync(ctx.root, { recursive: true, force: true });
});

test('--dry-run reports pending work without applying or recording anything', () => {
  const ctx = setup({ '0001_a.sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);' });
  const out = runMigrate(ctx, ['--dry-run']);
  assert.match(out, /1 pending migration/);
  assert.match(out, /not applying anything/);
  assert.deepEqual(tableNames(ctx.dbPath), []);
  rmSync(ctx.root, { recursive: true, force: true });
});

test('--bootstrap marks existing migrations applied WITHOUT running them (safe for an already-hand-migrated database)', () => {
  const ctx = setup({ '0001_a.sql': 'ALTER TABLE does_not_exist ADD COLUMN x TEXT;' }); // would throw if ever executed
  const out = runMigrate(ctx, ['--bootstrap']);
  assert.match(out, /marking 1 migration/);
  assert.deepEqual(appliedFilenames(ctx.dbPath), ['0001_a.sql']);
  assert.deepEqual(tableNames(ctx.dbPath), ['schema_migrations'], 'the bad ALTER TABLE must never have run');
  // Normal mode afterward sees nothing pending.
  const out2 = runMigrate(ctx);
  assert.match(out2, /Nothing to do/);
  rmSync(ctx.root, { recursive: true, force: true });
});

test('a failing migration stops the run and is not recorded as applied', () => {
  const ctx = setup({
    '0001_a.sql': 'CREATE TABLE widgets (id INTEGER PRIMARY KEY);',
    '0002_bad.sql': 'THIS IS NOT VALID SQL;'
  });
  assert.throws(() => runMigrate(ctx));
  assert.deepEqual(appliedFilenames(ctx.dbPath), ['0001_a.sql'], 'only the migration before the failure was recorded');
  rmSync(ctx.root, { recursive: true, force: true });
});

test('the real migrations/ directory in this repo applies cleanly end to end through the runner (not just via executescript in-memory)', () => {
  const ctx = mkdtempSync(join(tmpdir(), 'lummet-migrate-real-'));
  const binDir = join(ctx, 'bin');
  mkdirSync(binDir);
  const wranglerShim = join(binDir, 'wrangler');
  writeFileSync(wranglerShim, `#!/usr/bin/env node\nimport('${join(__dirname, 'support', 'fake-wrangler.mjs').replace(/\\/g, '/')}');\n`);
  chmodSync(wranglerShim, 0o755);
  const dbPath = join(ctx, 'db.sqlite');
  const out = execFileSync('node', [join(REPO_ROOT, 'scripts', 'migrate.mjs'), '--db', 'real', '--remote'], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, FAKE_WRANGLER_DB_PATH: dbPath },
    encoding: 'utf8'
  });
  assert.match(out, /Done\. Applied \d+ migration/);
  const tables = tableNames(dbPath);
  assert.ok(tables.includes('organizations') && tables.includes('subscriptions') && tables.includes('ai_credit_ledger'));
  rmSync(ctx, { recursive: true, force: true });
});
