#!/usr/bin/env node
// Keeps the copy of the release tools that lives in the lummet-tenant repo (tools/release/) identical to the ones here.
// The tenant repo needs its own copy so its GitHub Actions workflow can publish a release without checking out this repo.
//
//   node scripts/sync-release-tools.mjs            copy the three files into ../lummet-tenant/tools/release/
//   node scripts/sync-release-tools.mjs --check    exit 1 if the copies differ (the test suite runs this)
//   node scripts/sync-release-tools.mjs --to <dir> use another destination
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const args = process.argv.slice(2);
const dest = args.includes("--to") ? args[args.indexOf("--to") + 1] : join(root, "..", "lummet-tenant", "tools", "release");
const check = args.includes("--check");
const FILES = [["scripts/publish-tenant-release.mjs", "publish-tenant-release.mjs"], ["scripts/build-tenant-worker.mjs", "build-tenant-worker.mjs"], ["worker/asset-hash.js", "asset-hash.js"]];

let drift = 0;
for (const [from, to] of FILES) {
  const source = readFileSync(join(root, from), "utf8");
  const target = join(dest, to);
  const current = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (current === source) continue;
  drift++;
  if (check) { console.error(`DIFFERS: ${target}`); continue; }
  mkdirSync(dest, { recursive: true });
  writeFileSync(target, source);
  console.error(`updated ${target}`);
}
if (check && drift) { console.error("Run: node scripts/sync-release-tools.mjs"); process.exit(1); }
if (!check && !drift) console.error("already in sync");
