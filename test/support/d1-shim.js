// test/support/d1-shim.js
//
// A minimal, D1-API-compatible wrapper around Node's built-in
// node:sqlite (Node 22+, no npm install required). Adapted from the
// tenant repo's test/support/d1-shim.js (same interface, same
// rationale) so that the CONTROL PLANE's own worker modules
// (auth.js, rbac.js, registry.js, data.js, audit.js, ...) can run
// against a real (in-memory) SQLite database through the exact same
// .prepare(sql).bind(...).all()/.first()/.run() interface they call
// in production against LUMMET_DB, without needing network access to
// install @cloudflare/vitest-pool-workers or any other package.
//
// Known limitations (documented, not hidden) — identical to the
// tenant repo's shim:
// - D1 is SQLite-based but not byte-for-byte identical to
//   node:sqlite's bundled SQLite. Every query exercised by this
//   suite (plain SELECT/INSERT/UPDATE/DELETE against the control
//   plane's own schema — no exotic SQL) was run and verified against
//   this shim as part of adding it.
// - No KV, R2, or Workers runtime globals beyond what's used here
//   (crypto.randomUUID / crypto.subtle ARE available in Node 22, so
//   those just work).
// - .run() returns { success: true, meta: { last_row_id, changes } },
//   matching D1's shape closely enough for the code under test.
//
// This is a testing aid, not a claim of byte-for-byte identical
// behavior to production D1 — it substantially reduces risk on the
// logic that matters most here (tenant isolation, permission checks,
// password verification, audit writes) without needing network
// access.

import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

function wrapStatement(sqliteDb, sql) {
  return {
    bind(...params) {
      const stmt = sqliteDb.prepare(sql);
      const boundParams = params.map(p => (p === undefined ? null : p));
      return {
        async all() {
          const rows = stmt.all(...boundParams);
          return { results: rows, success: true };
        },
        async first() {
          const row = stmt.get(...boundParams);
          return row === undefined ? null : row;
        },
        async run() {
          const result = stmt.run(...boundParams);
          return {
            success: true,
            meta: { last_row_id: Number(result.lastInsertRowid), changes: result.changes }
          };
        }
      };
    },
    async all() { return this.bind().all(); },
    async first() { return this.bind().first(); },
    async run() { return this.bind().run(); }
  };
}

export function createTestDb() {
  const sqliteDb = new DatabaseSync(':memory:');
  sqliteDb.exec('PRAGMA foreign_keys = OFF;'); // D1 doesn't enforce FKs by default either

  return {
    prepare(sql) {
      return wrapStatement(sqliteDb, sql);
    },
    // Mirrors the small subset of env.LUMMET_DB.batch([...]) usage in
    // registry.js (rotateCredential) — runs each already-bound
    // statement in sequence. Not a real transaction, but sufficient
    // for these tests (no concurrent writers).
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
    _exec(sql) {
      sqliteDb.exec(sql);
    },
    _raw: sqliteDb
  };
}


/**
 * Splits a migration file into statements the way SQLite would:
 * `--` line comments and `;` only count OUTSIDE single-quoted string
 * literals ('' is an escaped quote). This matters for seed files whose
 * text values legitimately contain semicolons and apostrophes.
 */
export function splitSqlStatements(rawSql) {
  const statements = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < rawSql.length; i++) {
    const ch = rawSql[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (rawSql[i + 1] === "'") { current += "'"; i++; } else { inString = false; }
      }
      continue;
    }
    if (ch === "'") { inString = true; current += ch; continue; }
    if (ch === '-' && rawSql[i + 1] === '-') {
      while (i < rawSql.length && rawSql[i] !== '\n') i++;
      current += '\n';
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Runs every migration file in /migrations, in filename order,
 * against a fresh test DB — so tests run against the REAL
 * control-plane schema, not a hand-maintained copy that could drift
 * from it.
 */
export function applyMigrations(testDb) {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .filter(f => !f.toLowerCase().includes('rollback'));

  const ordered = files.sort(); // zero-padded numeric prefixes (0001_, 0002_, ...) sort correctly lexically

  const tolerated = /duplicate column name|already exists/i;

  for (const file of ordered) {
    const rawSql = readFileSync(join(MIGRATIONS_DIR, file), 'utf-8');

    for (const statement of splitSqlStatements(rawSql)) {
      try {
        testDb._exec(statement + ';');
      } catch (e) {
        if (tolerated.test(e.message)) continue;
        throw new Error(`Migration ${file} failed against the test DB on statement:\n${statement}\n\n${e.message}`);
      }
    }
  }
}
