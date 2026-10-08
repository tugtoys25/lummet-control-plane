#!/usr/bin/env node
// =====================================================
// BUILD + PUBLISH A TENANT RELEASE, INCLUDING STATIC ASSETS
//
// Run from the lummet-tenant repo root:
//   LUMMET_STAFF_COOKIE='session=...' node ../lummet-control-plane/scripts/publish-tenant-release.mjs \
//     --base https://your-control-plane.example.com --version 2026.10.04 [--notes "..."] [--dry-run]
//
// Steps: (1) build the Worker script + migrations with
// build-tenant-worker.mjs; (2) upload every file under the asset
// directories one at a time (the server recomputes each hash); (3)
// publish the release with the resulting manifest. The release becomes
// the active one for all NEW deployments.
//
// Authentication: a staff session cookie (log in to the staff console,
// copy the session cookie value into LUMMET_STAFF_COOKIE). Super-admin
// required. There is no API-token system for staff today.
//
// Asset directories default to en/static, en/templates, en/lummet:
// what the tenant Worker actually reads through its ASSETS binding.
// Source (en/worker), tests, migrations and docs are deliberately NOT
// published as assets. Override with --assets-root en --assets-dirs a,b,c
// =====================================================
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { assetHash, MAX_ASSET_FILES, MAX_ASSET_BYTES } from "../worker/asset-hash.js";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
const BASE = String(args.base || "").replace(/\/+$/, "");
const COOKIE = process.env.LUMMET_STAFF_COOKIE || "";
const ROOT = String(args["assets-root"] || "en");
const DIRS = String(args["assets-dirs"] || "static,templates,lummet").split(",").map((d) => d.trim()).filter(Boolean);
if (!args.version || (!args["dry-run"] && (!BASE || !COOKIE))) {
  console.error("Usage: LUMMET_STAFF_COOKIE=... node publish-tenant-release.mjs --base <url> --version <tag> [--notes ...] [--dry-run]");
  process.exit(2);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.startsWith(".") ? [] : [join(dir, e.name)]);
}

// 1. Build script + migrations
// --skip-build (dry runs only) counts the assets without needing wrangler.
let release = { scriptContent: "", migrations: [] };
if (!(args["dry-run"] && args["skip-build"])) {
  const tmp = mkdtempSync(join(tmpdir(), "lummet-release-"));
  const out = join(tmp, "release.json");
  const buildScript = join(dirname(fileURLToPath(import.meta.url)), "build-tenant-worker.mjs");
  execFileSync("node", [buildScript, "--version", String(args.version), "--out", out], { stdio: ["ignore", "inherit", "inherit"] });
  release = JSON.parse(readFileSync(out, "utf8"));
  rmSync(tmp, { recursive: true, force: true });
}

// 2. Collect assets
const files = DIRS.flatMap((d) => walk(join(ROOT, d)));
if (files.length > MAX_ASSET_FILES) { console.error(`${files.length} asset files exceeds the limit of ${MAX_ASSET_FILES}.`); process.exit(1); }
const manifest = {};
const uploads = [];
for (const file of files) {
  const bytes = new Uint8Array(readFileSync(file));
  if (bytes.length > MAX_ASSET_BYTES) { console.error(`${file} is larger than ${MAX_ASSET_BYTES} bytes.`); process.exit(1); }
  const urlPath = "/" + relative(ROOT, file).split(sep).join("/");
  const hash = await assetHash(bytes, urlPath);
  manifest[urlPath] = { hash, size: bytes.length };
  uploads.push({ urlPath, bytes, hash });
}
const totalKb = Math.round(files.reduce((n, f) => n + statSync(f).size, 0) / 1024);
console.error(`Script ${(release.scriptContent.length / 1024).toFixed(1)} KB, ${release.migrations.length} migrations, ${files.length} asset files (${totalKb} KB).`);
if (args["dry-run"]) { console.error("Dry run: nothing uploaded."); process.exit(0); }

// 3. Upload, 5 at a time, then publish
const headers = { Cookie: COOKIE };
let next = 0, failed = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (next < uploads.length) {
    const u = uploads[next++];
    const res = await fetch(`${BASE}/api/platform/saas/tenant-template/assets?path=${encodeURIComponent(u.urlPath)}`, { method: "PUT", headers, body: u.bytes });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || j.hash !== u.hash) { failed++; console.error(`FAILED ${u.urlPath}: HTTP ${res.status} ${j.error || ""} ${j.hash && j.hash !== u.hash ? "(hash mismatch)" : ""}`); }
  }
}));
if (failed) { console.error(`${failed} asset upload(s) failed; release NOT published.`); process.exit(1); }

const pub = await fetch(`${BASE}/api/platform/saas/tenant-template/publish`, {
  method: "POST", headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ version: String(args.version), scriptContent: release.scriptContent, migrations: release.migrations, assets: manifest, notes: args.notes || null })
});
const result = await pub.json().catch(() => ({}));
if (!pub.ok || result.success === false) { console.error("Publish failed:", JSON.stringify(result)); process.exit(1); }
console.error(`Published ${args.version} (${Object.keys(manifest).length} assets). It is now the active release.`);
