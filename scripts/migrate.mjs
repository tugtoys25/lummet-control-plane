#!/usr/bin/env node
// =====================================================
// MIGRATION RUNNER (master prompt section 22; roadmap 0.3)
//
// Applies migrations/*.sql in filename order against a D1 database,
// skipping any already recorded in schema_migrations. Safe to run
// repeatedly (CI runs it on every deploy) and safe to run against a
// database that already has some migrations applied by hand — it
// only ever adds rows it hasn't seen before.
//
// Usage:
//   node scripts/migrate.mjs --db lummet-control-plane-db [--remote] [--dry-run]
//
// This shells out to `wrangler d1 execute` rather than talking to D1
// directly, so it works the same locally and in CI with no extra
// dependency beyond wrangler (which every deploy already requires).
// =====================================================
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");
const LOCAL_WRANGLER = join(__dirname, "..", "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
const WRANGLER_BIN = existsSync(LOCAL_WRANGLER) && !process.env.FAKE_WRANGLER_DB_PATH ? LOCAL_WRANGLER : "wrangler";
const TRACKING_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TEXT DEFAULT CURRENT_TIMESTAMP
);`;

function parseArgs(argv) {
  const args = { db: null, remote: false, dryRun: false, bootstrap: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") args.db = argv[++i];
    else if (argv[i] === "--remote") args.remote = true;
    else if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--bootstrap") args.bootstrap = true;
  }
  if (!args.db) {
    console.error("Usage: node scripts/migrate.mjs --db <d1-database-name> [--remote] [--dry-run] [--bootstrap]");
    process.exit(2);
  }
  return args;
}

function runD1(db, sql, remote) {
  const wranglerArgs = ["d1", "execute", db, "--command", sql, "--json"];
  if (remote) wranglerArgs.push("--remote");
  else wranglerArgs.push("--local");
  const out = execFileSync(WRANGLER_BIN, wranglerArgs, { encoding: "utf8" });
  try {
    return JSON.parse(out);
  } catch {
    return out; // wrangler sometimes prints non-JSON status lines; caller doesn't need them
  }
}

function runD1File(db, filePath, remote) {
  const wranglerArgs = ["d1", "execute", db, "--file", filePath];
  if (remote) wranglerArgs.push("--remote");
  else wranglerArgs.push("--local");
  execFileSync(WRANGLER_BIN, wranglerArgs, { stdio: "inherit" });
}

function getAppliedMigrations(db, remote) {
  const result = runD1(db, "SELECT filename FROM schema_migrations ORDER BY filename;", remote);
  if (!Array.isArray(result)) return new Set();
  const rows = result[0]?.results || [];
  return new Set(rows.map((r) => r.filename));
}

function recordMigration(db, filename, remote) {
  // Escaped defensively even though filenames come from our own directory listing, not user input.
  const safe = filename.replace(/'/g, "''");
  runD1(db, `INSERT INTO schema_migrations (filename) VALUES ('${safe}');`, remote);
}

function main() {
  const { db, remote, dryRun, bootstrap } = parseArgs(process.argv.slice(2));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (!files.length) {
    console.log("No migration files found in", MIGRATIONS_DIR);
    return;
  }

  console.log(`Ensuring schema_migrations tracking table exists on "${db}" (${remote ? "remote" : "local"})...`);
  if (!dryRun) runD1(db, TRACKING_TABLE_SQL, remote);

  if (bootstrap) {
    // For a database where every migration up to today was already applied
    // by hand, per the old DEPLOYMENT.md instructions, before this runner
    // existed. Marks them as applied WITHOUT re-running them — several
    // early migrations use non-idempotent `ALTER TABLE ... ADD COLUMN`,
    // which fails on a second run. Run this exactly once per database,
    // then use the normal (no-flag) mode for every migration after.
    const applied = dryRun ? new Set() : getAppliedMigrations(db, remote);
    const toMark = files.filter((f) => !applied.has(f));
    if (!toMark.length) {
      console.log("Nothing to bootstrap — schema_migrations already covers every migration file.");
      return;
    }
    console.log(`--bootstrap: marking ${toMark.length} migration(s) as already applied, without running them:`);
    toMark.forEach((f) => console.log("  -", f));
    if (dryRun) { console.log("\n--dry-run: not writing anything."); return; }
    for (const filename of toMark) recordMigration(db, filename, remote);
    console.log(`\nDone. ${toMark.length} migration(s) marked applied. Future runs (without --bootstrap) will only apply new files.`);
    return;
  }

  const applied = dryRun ? new Set() : getAppliedMigrations(db, remote);
  const pending = files.filter((f) => !applied.has(f));

  if (!pending.length) {
    console.log(`All ${files.length} migrations already applied. Nothing to do.`);
    return;
  }

  console.log(`${pending.length} pending migration(s) out of ${files.length} total:`);
  pending.forEach((f) => console.log("  -", f));

  if (dryRun) {
    console.log("\n--dry-run: not applying anything.");
    return;
  }

  for (const filename of pending) {
    const filePath = join(MIGRATIONS_DIR, filename);
    console.log(`\nApplying ${filename}...`);
    runD1File(db, filePath, remote);
    recordMigration(db, filename, remote);
    console.log(`  recorded ${filename} as applied.`);
  }

  console.log(`\nDone. Applied ${pending.length} migration(s).`);
}

main();
