#!/usr/bin/env node
// Fails when public/static/css or public/static/js changed but worker/perf/asset-version.js was not bumped.
// Those files are served "immutable" under /static/css|js/<file>?v=<ASSET_VERSION>, so an unchanged token would leave
// browsers on the old copy for up to a year. `--write` records the current state after you bumped the token.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = join(ROOT, "config", "asset-version.lock.json");

export function currentState() {
  const h = createHash("sha256");
  for (const dir of ["css", "js"]) {
    const base = join(ROOT, "public", "static", dir);
    for (const f of readdirSync(base).sort()) {
      h.update(`${dir}/${f}\0`);
      h.update(readFileSync(join(base, f)));
      h.update("\0");
    }
  }
  const src = readFileSync(join(ROOT, "worker", "perf", "asset-version.js"), "utf8");
  const version = (src.match(/ASSET_VERSION\s*=\s*"([^"]+)"/) || [])[1] || "";
  return { version, hash: h.digest("hex").slice(0, 16) };
}

export function verify() {
  const now = currentState();
  if (!existsSync(LOCK)) return { ok: false, now, message: "config/asset-version.lock.json is missing (run with --write)" };
  const lock = JSON.parse(readFileSync(LOCK, "utf8"));
  if (lock.hash === now.hash) return { ok: true, now };
  if (lock.version !== now.version) return { ok: false, now, message: "static css/js changed and ASSET_VERSION was bumped: run with --write to record it" };
  return { ok: false, now, message: "public/static css/js changed but worker/perf/asset-version.js ASSET_VERSION was not bumped" };
}

if (process.argv[1] && process.argv[1].endsWith("check-asset-version.mjs")) {
  if (process.argv.includes("--write")) {
    writeFileSync(LOCK, JSON.stringify(currentState(), null, 2) + "\n");
    console.log("recorded", currentState());
  } else {
    const r = verify();
    console.log(r.ok ? `asset version ok (${r.now.version})` : `FAIL: ${r.message}`);
    process.exit(r.ok ? 0 : 1);
  }
}
