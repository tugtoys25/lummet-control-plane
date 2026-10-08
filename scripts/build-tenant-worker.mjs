#!/usr/bin/env node
// =====================================================
// BUILD THE TENANT TEMPLATE RELEASE (roadmap 0.1)
//
// Produces the JSON payload the "/platform/saas/releases" page (or
// POST /api/platform/saas/tenant-template/publish) expects:
//   { version, scriptContent, migrations: [{name, sql}], notes }
//
// Run this from the lummet-tenant repo root:
//   node ../lummet-control-plane/scripts/build-tenant-worker.mjs \
//     --version 2024.06.01 --notes "describe what changed" > release.json
//
// This captures the Worker SCRIPT ("en/worker/index.js") and every
// file under "migrations/" only. Static assets (en/static,
// en/templates, en/lummet) are handled by publish-tenant-release.mjs,
// which calls this script and then uploads the assets and publishes the
// release in one step. Use that for real releases; a release published
// from this script's output alone has NO assets, and the tenant Worker
// cannot render pages without them.
//
// Requires `wrangler` to already be installed (same requirement as
// deploying the tenant manually today) — this script does not bundle
// anything itself; it asks wrangler to do a dry-run build and reads
// the result, so it always produces exactly what a real
// `wrangler deploy` from this same checkout would have deployed.
// =====================================================
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function parseArgs(argv) {
  const args = { version: null, notes: null, migrationsDir: "migrations", out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") args.version = argv[++i];
    else if (argv[i] === "--notes") args.notes = argv[++i];
    else if (argv[i] === "--migrations-dir") args.migrationsDir = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  if (!args.version) {
    console.error("Usage: node build-tenant-worker.mjs --version <tag> [--notes \"...\"] [--migrations-dir migrations] [--out release.json]");
    console.error("Run from the lummet-tenant repo root (where wrangler.jsonc lives).");
    process.exit(2);
  }
  return args;
}

function findEntryPoint() {
  if (!existsSync("wrangler.jsonc") && !existsSync("wrangler.toml") && !existsSync("wrangler.json")) {
    console.error("No wrangler config found in the current directory. Run this from the lummet-tenant repo root.");
    process.exit(2);
  }
  // wrangler itself resolves "main" from whichever config file is
  // present; we don't need to parse it ourselves for the dry-run build
  // below — wrangler does that. We only need the entry filename for
  // locating wrangler's dry-run output afterward.
  const raw = existsSync("wrangler.jsonc") ? readFileSync("wrangler.jsonc", "utf8") : readFileSync("wrangler.toml", "utf8");
  const match = raw.match(/"main"\s*:\s*"([^"]+)"|main\s*=\s*"([^"]+)"/);
  if (!match) { console.error('Could not find "main" in the wrangler config.'); process.exit(2); }
  return match[1] || match[2];
}

function buildScript() {
  const entry = findEntryPoint();
  const outdir = mkdtempSync(join(tmpdir(), "lummet-tenant-build-"));
  try {
    console.error(`Running wrangler dry-run build (entry: ${entry})...`);
    execFileSync("wrangler", ["deploy", "--dry-run", "--outdir", outdir], { stdio: ["ignore", "ignore", "inherit"] });
    const files = readdirSync(outdir).filter((f) => f.endsWith(".js"));
    if (!files.length) { console.error(`wrangler dry-run produced no .js file in ${outdir}`); process.exit(1); }
    // The bundled entry is typically the largest .js file wrangler emits
    // (worker-adjacent helper chunks, if any, are smaller) — take the
    // largest rather than guessing a fixed filename, since wrangler's
    // exact output naming isn't a stable public contract.
    const biggest = files
      .map((f) => ({ f, size: statSync(join(outdir, f)).size }))
      .sort((a, b) => b.size - a.size)[0].f;
    return readFileSync(join(outdir, biggest), "utf8");
  } finally {
    rmSync(outdir, { recursive: true, force: true });
  }
}

function collectMigrations(dir) {
  if (!existsSync(dir)) { console.error(`Migrations directory "${dir}" not found — continuing with zero migrations.`); return []; }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), "utf8") }));
}

function main() {
  const { version, notes, migrationsDir, out } = parseArgs(process.argv.slice(2));
  const scriptContent = buildScript();
  const migrations = collectMigrations(migrationsDir);
  console.error(`Built script: ${(scriptContent.length / 1024).toFixed(1)} KB. Migrations: ${migrations.length}.`);
  const payload = JSON.stringify({ version, scriptContent, migrations, notes: notes || null });
  if (out) {
    writeFileSync(out, payload);
    console.error(`Wrote ${out}`);
  } else {
    process.stdout.write(payload + "\n");
  }
}

main();
