#!/usr/bin/env node
// Builds a release package: the WHOLE project at the end of a phase, plus a manifest, checksums and a report.
//
//   node scripts/package-phase.mjs --phase 1 --version 2.1.0 [--out dist] [--skip-tests] [--update-baseline]
//
// Gates (a failure stops the package, except --skip-tests which stamps it NOT RELEASABLE):
//   1. the test suite passes (counts and Node version are recorded in the manifest)
//   2. no shipped migration was modified or deleted (compared with docs/phase-baseline.json), and new migrations are
//      numbered consecutively after the highest baseline migration
//   3. no secret-looking file or string is packaged
//   4. package.json "version" equals --version
// Output: dist/phase-<N>/lummet-control-plane-phase<N>-v<version>.zip, MANIFEST.json, SHA256SUMS, REPORT.md
import { readFile, writeFile, readdir, mkdir, stat, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (k, d = null) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true) : d; };
const phase = String(arg("phase", ""));
const version = String(arg("version", ""));
const outRoot = path.resolve(root, String(arg("out", "dist")));
const skipTests = !!arg("skip-tests");
const developmentCheck = !!arg("development-check");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const fail = (m) => { console.error("PACKAGE REFUSED: " + m); process.exit(1); };

if (!/^\d+$/.test(phase) || !/^\d+\.\d+\.\d+$/.test(version)) fail("usage: --phase <N> --version <x.y.z>");

// ---- gather files (never .git, node_modules, dist, env files)
const EXCLUDE = [/^\.git(\/|$)/, /^\.wrangler(\/|$)/, /^node_modules(\/|$)/, /^dist(\/|$)/, /(^|\/)\.dev\.vars$/, /(^|\/)\.env(\..*)?$/, /\.zip$/];
async function walk(dir, rel = "") {
  const out = [];
  for (const e of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (EXCLUDE.some((re) => re.test(r) && !/\.dev\.vars\.example$/.test(r))) continue;
    if (e.isDirectory()) out.push(...await walk(dir, r)); else out.push(r);
  }
  return out;
}
const files = (await walk(root)).sort();

// ---- gate 4: version
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (pkg.version !== version) fail(`package.json version is ${pkg.version}, requested ${version}`);
// Release packages require a complete dependency graph and explicit release ownership.
// --development-check is only for PR/local static packaging; it never marks a package releasable.
if (!developmentCheck) {
  const lockCheck = spawnSync(process.execPath, ["scripts/lockfile-check.mjs"], { cwd: root, encoding: "utf8", timeout: 30000 });
  if (lockCheck.status !== 0) fail(`lockfile validation failed:\n${lockCheck.stdout || ""}${lockCheck.stderr || ""}`);
  const ownerCheck = spawnSync(process.execPath, ["scripts/check-release-owner.mjs"], { cwd: root, encoding: "utf8", timeout: 30000 });
  if (ownerCheck.status !== 0) fail(`release ownership/placeholder validation failed:\n${ownerCheck.stdout || ""}${ownerCheck.stderr || ""}`);
}

// ---- gate 2: migrations
const migDir = path.join(root, "migrations");
const migs = {};
for (const f of (await readdir(migDir)).filter((x) => x.endsWith(".sql")).sort()) migs[f] = sha(await readFile(path.join(migDir, f)));
let baseline = { migrations: {} };
try { baseline = JSON.parse(await readFile(path.join(root, "docs/phase-baseline.json"), "utf8")); } catch { fail("docs/phase-baseline.json is missing"); }
for (const [f, h] of Object.entries(baseline.migrations)) {
  if (!(f in migs)) fail(`shipped migration ${f} was deleted`);
  if (migs[f] !== h) fail(`shipped migration ${f} was modified (never edit a shipped migration; add a new one)`);
}
const nums = Object.keys(migs).map((f) => Number(f.slice(0, 4)));
const baseMax = Math.max(...Object.keys(baseline.migrations).map((f) => Number(f.slice(0, 4))));
const added = nums.filter((n) => n > baseMax).sort((a, b) => a - b);
added.forEach((n, i) => { if (n !== baseMax + 1 + i) fail(`new migrations must be consecutive after ${String(baseMax).padStart(4, "0")}; found ${String(n).padStart(4, "0")}`); });

// ---- gate 3: secrets
const SECRET = [/sk_live_[A-Za-z0-9]{24,}/, /whsec_[A-Za-z0-9]{16,}/, /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/, /re_[A-Za-z0-9]{20,}/];
const hits = [];
for (const f of files) {
  if (!/\.(js|mjs|json|jsonc|md|sql|html|css|yml|yaml|txt|example)$/.test(f) && !f.endsWith(".dev.vars.example")) continue;
  const text = await readFile(path.join(root, f), "utf8").catch(() => "");
  if (SECRET.some((re) => re.test(text))) hits.push(f);
}
if (hits.length) fail(`secret-looking content in: ${hits.join(", ")}`);

// ---- gate 1: tests
let test = { ran: false, node: process.version, tests: null, pass: null, fail: null, skipped: null, todo: null, cancelled: null, files: null, failedFiles: null, forcedExit: null };
if (!skipTests) {
  // Use the repository's serial per-file harness. A globbed node --test invocation can hang on
  // Worker tests that intentionally retain handles and does not provide reliable per-file evidence.
  const r = spawnSync(process.execPath, ["scripts/test-by-file.mjs"], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28, timeout: 300000 });
  const summary = (r.stdout || "").match(/SUMMARY files=(\d+) tests=(\d+) forced_exit=(\d+) failed=(\d+) passed=(\d+) failed_tests=(\d+) skipped=(\d+) todo=(\d+) cancelled=(\d+)/);
  test = summary
    ? { ran: true, node: process.version, files: Number(summary[1]), tests: Number(summary[2]), forcedExit: Number(summary[3]), failedFiles: Number(summary[4]), pass: Number(summary[5]), fail: Number(summary[6]), skipped: Number(summary[7]), todo: Number(summary[8]), cancelled: Number(summary[9]) }
    : { ran: true, node: process.version, files: null, tests: null, pass: null, fail: null, skipped: null, todo: null, cancelled: null, forcedExit: null, failedFiles: null };
  if (r.status !== 0 || !summary || test.failedFiles !== 0 || test.fail !== 0) fail(`test suite failed or incomplete (failed tests=${test.fail}; failing files=${test.failedFiles}; forced exits=${test.forcedExit}; summary=${!!summary})`);
}
const releasable = test.ran && !developmentCheck;

// ---- build
const dir = path.join(outRoot, `phase-${phase}`);
await rm(dir, { recursive: true, force: true }); await mkdir(dir, { recursive: true });
const zipName = `lummet-control-plane-phase${phase}-v${version}.zip`;
const z = spawnSync("zip", ["-q", "-X", path.join(dir, zipName), ...files], { cwd: root });
if (z.status !== 0) fail("zip failed: " + z.stderr);
const zipBuf = await readFile(path.join(dir, zipName));
const manifest = {
  phase: Number(phase), version, releasable, builtAt: new Date().toISOString(), node: process.version,
  fileCount: files.length, zip: { name: zipName, bytes: (await stat(path.join(dir, zipName))).size, sha256: sha(zipBuf) },
  migrations: migs, newMigrations: Object.keys(migs).filter((f) => Number(f.slice(0, 4)) > baseMax), tests: test
};
await writeFile(path.join(dir, "MANIFEST.json"), JSON.stringify(manifest, null, 2) + "\n");
await writeFile(path.join(dir, "SHA256SUMS"), `${manifest.zip.sha256}  ${zipName}\n${sha(await readFile(path.join(dir, "MANIFEST.json")))}  MANIFEST.json\n`);
await writeFile(path.join(dir, "REPORT.md"), [
  `# Phase ${phase} package, v${version}`, "", releasable ? "**Releasable**: tests passed." : "**NOT RELEASABLE**: built with --skip-tests.", "",
  `- Files: ${files.length}`, `- New migrations: ${manifest.newMigrations.join(", ") || "none"}`, `- Release ownership/placeholder gate: ${developmentCheck ? "skipped for development-only build; not releasable" : "passed"}`,
  `- Tests: ${test.ran ? `${test.pass} passed / ${test.tests} top-level tests across ${test.files} files on Node ${test.node}; failed tests: ${test.fail}; skipped: ${test.skipped}; todo: ${test.todo}; cancelled: ${test.cancelled}; failing files: ${test.failedFiles}; forced-exit files: ${test.forcedExit}` : "not run"}`, `- Zip SHA-256: ${manifest.zip.sha256}`, "",
  "Approval is a human step: review docs/CHANGES_PHASE_*.md, run the staging verification, then approve before the next phase.", ""
].join("\n"));
if (arg("update-baseline")) await writeFile(path.join(root, "docs/phase-baseline.json"), JSON.stringify({ phase: `phase ${phase} v${version}`, migrations: migs }, null, 1) + "\n");
console.log(`${releasable ? "OK" : "BUILT (NOT RELEASABLE)"}: ${path.join(dir, zipName)}`);
