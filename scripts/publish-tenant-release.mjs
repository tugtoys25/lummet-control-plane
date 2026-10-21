#!/usr/bin/env node
// =====================================================
// BUILD + PUBLISH A TENANT RELEASE, AND (OPTIONALLY) ROLL IT OUT TO EVERY SITE
//
// Run from the lummet-tenant repo root:
//   LUMMET_STAFF_TOKEN=lmst_... node <path>/publish-tenant-release.mjs \
//     --base https://your-control-plane.example.com --version 2026.10.20 [--notes "..."] \
//     [--rollout [--wait] [--sites id1,id2]] [--allow-existing] [--dry-run]
//
// Steps: (1) build the Worker script + migrations with build-tenant-worker.mjs; (2) upload every file under the
// asset directories one at a time (the server recomputes each hash); (3) publish the release with the resulting
// manifest. The release becomes the active one for all NEW deployments. Publishing changes NO existing site.
// (4) with --rollout: start a rollout (deploy the release to every live site, one at a time, stopping at the
// first failure); with --wait the script drives it and exits non-zero if it fails, so a CI job turns red.
//
// Authentication (first one found):
//   LUMMET_STAFF_TOKEN   a staff API token (staff console > Tenant template releases > Staff API tokens).
//                        Unattended, scoped (release:publish, rollout:run), revocable. Use this in CI.
//   LUMMET_STAFF_COOKIE  a staff session cookie (log in, copy the session cookie). Expires; for manual use.
//
// Flags:
//   --allow-existing     the version is already published: carry on (use it so a CI re-run is harmless)
//   --rollout            after publishing, roll the release out to every live site
//   --wait               keep going until the rollout ends (exit 1 if it failed or was cancelled)
//   --sites a,b          limit the rollout to these site ids (a canary)
//   --timeout-minutes N  give up waiting after N minutes (default 90; the rollout itself keeps going)
//   --release-file f     use a release already built into f ({ scriptContent, migrations }) instead of building
//
// Asset directories default to en/static, en/templates, en/lummet: what the tenant Worker actually reads through
// its ASSETS binding. Source (en/worker), tests, migrations and docs are deliberately NOT published as assets.
// Override with --assets-root en --assets-dirs a,b,c
// =====================================================
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// In the control-plane repo asset-hash.js is in ../worker; the copy vendored into the tenant repo keeps it beside this file.
const { assetHash, MAX_ASSET_FILES, MAX_ASSET_BYTES } = await import("../worker/asset-hash.js").catch(() => import("./asset-hash.js"));

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
  return acc;
}, []));
const BASE = String(args.base || "").replace(/\/+$/, "");
const TOKEN = process.env.LUMMET_STAFF_TOKEN || "";
const COOKIE = process.env.LUMMET_STAFF_COOKIE || "";
const ROOT = String(args["assets-root"] || "en");
const DIRS = String(args["assets-dirs"] || "static,templates,lummet").split(",").map((d) => d.trim()).filter(Boolean);
const TIMEOUT_MS = Math.max(1, Number(args["timeout-minutes"]) || 90) * 60000;
if (!args.version || args.version === true || (!args["dry-run"] && (!BASE || !(TOKEN || COOKIE)))) {
  console.error("Usage: LUMMET_STAFF_TOKEN=... node publish-tenant-release.mjs --base <url> --version <tag> [--notes ...] [--rollout [--wait] [--sites a,b]] [--allow-existing] [--dry-run]");
  console.error("(LUMMET_STAFF_COOKIE=... still works instead of a token, for manual runs.)");
  process.exit(2);
}
if (!/^[a-zA-Z0-9._-]{1,64}$/.test(String(args.version))) { console.error("--version may only contain letters, digits, dot, dash and underscore (max 64)."); process.exit(2); }

// The token API and the session API have the same shape under different paths.
const API = TOKEN
  ? { assets: "/api/ci/tenant-release/assets", publish: "/api/ci/tenant-release/publish", rollouts: "/api/ci/tenant-release/rollouts" }
  : { assets: "/api/platform/saas/tenant-template/assets", publish: "/api/platform/saas/tenant-template/publish", rollouts: "/api/platform/saas/rollouts" };
const authHeaders = TOKEN ? { Authorization: `Bearer ${TOKEN}` } : { Cookie: COOKIE };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch with a few retries for network errors and 502/503/504. Returns { res, json }. */
async function api(method, path, { body, json, retries = 3 } = {}) {
  const headers = { ...authHeaders, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) };
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : body });
      if ([502, 503, 504].includes(res.status) && attempt < retries) { await sleep(1500 * attempt); continue; }
      return { res, json: await res.json().catch(() => ({})) };
    } catch (error) {
      if (attempt >= retries) throw error;
      await sleep(1500 * attempt);
    }
  }
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.startsWith(".") ? [] : [join(dir, e.name)]);
}

// 1. Build script + migrations
// --skip-build (dry runs only) counts the assets without needing wrangler.
let release = { scriptContent: "", migrations: [] };
if (typeof args["release-file"] === "string") {
  release = JSON.parse(readFileSync(args["release-file"], "utf8")); // a release built earlier: { scriptContent, migrations }
} else if (!(args["dry-run"] && args["skip-build"])) {
  const tmp = mkdtempSync(join(tmpdir(), "lummet-release-"));
  const out = join(tmp, "release.json");
  const buildScript = join(dirname(fileURLToPath(import.meta.url)), "build-tenant-worker.mjs");
  execFileSync("node", [buildScript, "--version", String(args.version), "--migrations-dir", String(args["migrations-dir"] || `${ROOT}/migrations`), "--out", out], { stdio: ["ignore", "inherit", "inherit"] });
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
console.error(`Authenticating with a ${TOKEN ? "staff API token" : "session cookie"}.`);

// 3. Upload, 5 at a time, then publish
let next = 0, failed = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (next < uploads.length) {
    const u = uploads[next++];
    const { res, json } = await api("PUT", `${API.assets}?path=${encodeURIComponent(u.urlPath)}`, { body: u.bytes });
    if (!res.ok || json.hash !== u.hash) { failed++; console.error(`FAILED ${u.urlPath}: HTTP ${res.status} ${json.error || ""} ${json.hash && json.hash !== u.hash ? "(hash mismatch)" : ""}`); }
  }
}));
if (failed) { console.error(`${failed} asset upload(s) failed; release NOT published.`); process.exit(1); }

const pub = await api("POST", API.publish, { json: { version: String(args.version), scriptContent: release.scriptContent, migrations: release.migrations, assets: manifest, notes: args.notes && args.notes !== true ? args.notes : null }, retries: 2 });
if (pub.res.status === 409 && pub.json.error === "version_already_exists" && args["allow-existing"]) {
  console.error(`Version ${args.version} is already published; continuing (--allow-existing).`);
} else if (!pub.res.ok || pub.json.success === false) {
  console.error("Publish failed:", JSON.stringify(pub.json));
  process.exit(1);
} else {
  console.error(`Published ${args.version} (${Object.keys(manifest).length} assets). It is now the active release. No existing site was changed.`);
}

// 4. Optional rollout
if (!args.rollout) {
  console.error("Not rolling out. Deploy it to the sites from the staff console (Deployments > Roll out), or re-run with --rollout.");
  process.exit(0);
}
const siteIds = typeof args.sites === "string" ? args.sites.split(",").map((s) => s.trim()).filter(Boolean) : null;
const started = await api("POST", API.rollouts, { json: { version: String(args.version), siteIds, notes: args.notes && args.notes !== true ? args.notes : null }, retries: 2 });
if (!started.res.ok || started.json.success === false) {
  console.error("Could not start the rollout:", JSON.stringify(started.json));
  process.exit(1);
}
const rolloutId = started.json.rolloutId;
console.error(`Rollout ${rolloutId} started: ${started.json.progress}.`);
if (started.json.done) { console.error(`Rollout ${started.json.status}${started.json.nothingToDo ? " (every live site is already on this release)" : ""}.`); process.exit(0); }
if (!args.wait) { console.error("Not waiting. It continues from the staff Deployments page and from the maintenance tick."); process.exit(0); }

const deadline = Date.now() + TIMEOUT_MS;
let lastProgress = started.json.progress;
while (Date.now() < deadline) {
  const step = await api("POST", `${API.rollouts}/${rolloutId}/advance`, { json: {} });
  if (!step.res.ok || step.json.success === false) {
    console.error(`Advance failed (${step.res.status} ${step.json.error || ""}); retrying.`);
    await sleep(10000);
    continue;
  }
  const r = step.json;
  if (r.progress !== lastProgress) { console.error(`  ${r.progress}`); lastProgress = r.progress; }
  if (r.done) {
    if (r.status === "completed") { console.error(`Rollout completed: ${r.progress}.`); process.exit(0); }
    const detail = await api("GET", `${API.rollouts}/${rolloutId}`);
    for (const i of detail.json.items || []) if (i.status === "failed") console.error(`  FAILED ${i.site_slug || i.site_id}: ${i.detail || ""}`);
    console.error(`Rollout ${r.status}: ${r.error || ""} The remaining sites were not touched. Fix the cause, then Resume it in the staff console (Deployments).`);
    process.exit(1);
  }
  await sleep(r.busy ? 6000 : 2500);
}
console.error(`Gave up waiting after ${TIMEOUT_MS / 60000} minutes. The rollout is still running on the server (${lastProgress}); follow it in the staff console.`);
process.exit(1);
