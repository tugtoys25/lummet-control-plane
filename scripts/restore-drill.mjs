#!/usr/bin/env node
// Restore drill tooling (Round 6.5B, AT-15). Owner-run. See docs/runbooks/restore-drill.md.
//
//   Dry run (default). Restores NOTHING and never runs wrangler. It proves the downloaded backup is complete,
//   uncorrupted and decryptable with the key you hold, and that it turns into one INSERT per backed-up row:
//     CREDENTIAL_KEK=<key> node scripts/restore-drill.mjs --backup-dir ./restore-in --target-db <staging-db>
//
//   Apply (writes to the STAGING database only):
//     CREDENTIAL_KEK=<key> node scripts/restore-drill.mjs --backup-dir ./restore-in --target-db <staging-db> \
//       --apply --confirm <staging-db> --rto-minutes <n> --manual download=<min> --manual create_db=<min> \
//       --manual migrate=<min> --manual repoint=<min>
//
// What it does: runs scripts/restore-control-plane.mjs (the existing, tested converter) with timing, checks the generated
// SQL against the manifest, optionally applies it with `wrangler d1 execute --remote`, then compares per-table row counts in
// the target with the manifest. It writes restore-drill-report.json and restore-drill-report.md (from
// docs/RESTORE_DRILL_REPORT_TEMPLATE.md).
//
// What it will NOT do: touch the production database (the name comes from wrangler.jsonc, never from this file), run
// without a staging-named target, apply without --confirm, print a key or a row, keep the decrypted SQL unless --keep-sql,
// or call anything VERIFIED. The evidence label stays NOT VERIFIED until the owner reviews the report and attaches it.
// Missing or unparseable values are "unknown", never 0.
import { spawnSync } from "node:child_process";
import { createReadStream, existsSync, openSync, closeSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const MANUAL_STEPS = ["download", "create_db", "migrate", "repoint"];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{2,62}$/;
const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_FIELDS = [process.env.CREDENTIAL_KEK, process.env.CREDENTIAL_KEK_PREVIOUS].filter((x) => x && x.length > 4);

function usage(message, code = 2) {
  if (message) console.error(message);
  console.error("Usage: CREDENTIAL_KEK=<key> node scripts/restore-drill.mjs --backup-dir <dir> --target-db <staging-db> [--out-dir <dir>] [--drill-id <id>]\n" +
    "         [--apply --confirm <staging-db>] [--rto-minutes <n>] [--manual download|create_db|migrate|repoint=<minutes> ...] [--keep-sql] [--wrangler-bin <path>] [--wrangler-config <path>]");
  process.exit(code);
}
const redact = (text) => SECRET_FIELDS.reduce((t, s) => t.split(s).join("[redacted]"), String(text ?? "")).slice(0, 600);

function parseArgs(argv) {
  const a = { manual: {}, apply: false, keepSql: false };
  const takes = new Set(["--backup-dir", "--target-db", "--out-dir", "--drill-id", "--confirm", "--wrangler-bin", "--wrangler-config", "--rto-minutes", "--manual"]);
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--apply") a.apply = true;
    else if (k === "--keep-sql") a.keepSql = true;
    else if (takes.has(k)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${k} needs a value`);
      if (k === "--manual") {
        const m = /^([a-z_]+)=(.+)$/.exec(v);
        if (!m || !MANUAL_STEPS.includes(m[1])) usage(`--manual expects one of ${MANUAL_STEPS.join(", ")} as name=minutes`);
        const n = Number(m[2]);
        if (!Number.isFinite(n) || n < 0 || n > 10080) usage(`--manual ${m[1]} must be a number of minutes between 0 and 10080`);
        a.manual[m[1]] = n;
      } else a[k.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
    } else usage(`Unknown argument: ${k}`);
  }
  return a;
}

// Minimal string-aware JSONC reader, enough for wrangler.jsonc (comments, trailing commas).
function parseJsonc(text) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i += 1; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}
function productionDatabaseNames() {
  const file = path.join(root, "wrangler.jsonc");
  if (!existsSync(file)) usage("Refusing to run: wrangler.jsonc was not found, so the production database name cannot be checked.");
  let cfg;
  try { cfg = parseJsonc(readFileSync(file, "utf8")); } catch (e) { usage(`Refusing to run: wrangler.jsonc could not be read (${e.message}), so the production database name cannot be checked.`); }
  const names = (cfg.d1_databases || []).map((d) => d.database_name).filter(Boolean);
  if (!names.length) usage("Refusing to run: no production D1 database found in wrangler.jsonc to compare against.");
  return names;
}

const args = parseArgs(process.argv.slice(2));
if (!args.backupDir) usage("--backup-dir is required");
if (!args.targetDb) usage("--target-db is required");
if (!process.env.CREDENTIAL_KEK) usage("CREDENTIAL_KEK is required (the key the backup was encrypted with; keep a copy outside Cloudflare).");
if (!NAME_RE.test(args.targetDb)) usage("--target-db is not a valid database name.");
if (productionDatabaseNames().includes(args.targetDb)) usage(`Refusing to run: ${args.targetDb} is the production database named in wrangler.jsonc. A drill restores into STAGING only.`);
if (!/staging/i.test(args.targetDb)) usage("Refusing to run: the target database name must contain 'staging'.");
if (args.apply && args.confirm !== args.targetDb) usage("Refusing to apply: pass --confirm <the exact target database name> to write into it.");
const rtoRaw = args.rtoMinutes ?? process.env.RESTORE_RTO_MINUTES;
let rtoObjective = "unknown";
if (rtoRaw !== undefined && rtoRaw !== "") {
  const n = Number(rtoRaw);
  if (!Number.isFinite(n) || n <= 0 || n > 10080) usage("--rto-minutes (or RESTORE_RTO_MINUTES) must be a positive number of minutes. Leave it unset while the objective is [OPEN].");
  rtoObjective = n;
}

const startedAt = new Date();
const drillId = args.drillId || `drill-${startedAt.toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-")}`;
if (!/^[A-Za-z0-9._-]{3,80}$/.test(drillId)) usage("--drill-id may contain only letters, digits, dot, dash and underscore.");
const outDir = path.resolve(args.outDir || `restore-drill-${drillId}`);
mkdirSync(outDir, { recursive: true, mode: 0o700 });
const sqlPath = path.join(outDir, "restore.sql");
const releaseFile = path.join(root, "..", "RELEASE_ID");
const report = {
  drillId, mode: args.apply ? "apply" : "dry-run", startedAt: startedAt.toISOString(), finishedAt: null,
  releaseId: existsSync(releaseFile) ? readFileSync(releaseFile, "utf8").trim() : "unknown",
  targetDb: args.targetDb, status: "FAILED", evidenceLabel: "NOT VERIFIED",
  backup: { backupId: "unknown", createdAt: "unknown", ageHoursAtDrillStart: "unknown", tables: 0, parts: 0, rowCounts: {} },
  steps: [], sqlCheck: { ok: false, statements: 0, mismatches: [] }, verify: { ok: null, checked: 0, mismatches: [] },
  recoveryTime: { complete: false, totalMinutes: "unknown", scriptSeconds: 0, manualMinutes: {}, missingManual: [...MANUAL_STEPS] },
  rto: { objectiveMinutes: rtoObjective, evaluation: "not evaluated" },
};

function stepRun(name, fn) {
  const t0 = performance.now();
  let status = "ok", detail = "";
  try { detail = fn() || ""; } catch (e) { status = "failed"; detail = redact(e.message); }
  const seconds = Math.round((performance.now() - t0)) / 1000;
  const step = { name, status, ok: status === "ok", seconds, detail };
  report.steps.push(step);
  return step;
}
function skip(name, why) { report.steps.push({ name, status: "skipped", ok: false, seconds: 0, detail: why }); }

let failed = false;
try {
  // 1. manifest
  const manifestStep = stepRun("read_manifest", () => {
    const manifest = JSON.parse(readFileSync(path.join(args.backupDir, "manifest.json"), "utf8"));
    if (!Array.isArray(manifest.tables) || !manifest.rowCounts || !Array.isArray(manifest.parts)) throw new Error("manifest.json is not a control-plane backup manifest");
    for (const t of manifest.tables) if (!TABLE_RE.test(t)) throw new Error("manifest lists a table name that is not a plain identifier; refusing");
    const created = Date.parse(manifest.createdAt);
    report.backup = {
      backupId: String(manifest.backupId || "unknown"), createdAt: String(manifest.createdAt || "unknown"),
      ageHoursAtDrillStart: Number.isFinite(created) ? Math.round(((startedAt.getTime() - created) / 3600000) * 10) / 10 : "unknown",
      tables: manifest.tables.length, parts: manifest.parts.length, rowCounts: Object.fromEntries(manifest.tables.map((t) => [t, Number(manifest.rowCounts[t])])),
    };
    return `${manifest.tables.length} tables, ${manifest.parts.length} parts`;
  });
  if (!manifestStep.ok) throw new Error("stop");

  // 2. decrypt and convert, using the existing tested script (it checks every part hash and every row count)
  const gen = stepRun("generate_restore_sql", () => {
    const fd = openSync(sqlPath, "w", 0o600);
    let r;
    try { r = spawnSync(process.execPath, [path.join(here, "restore-control-plane.mjs"), args.backupDir], { env: process.env, stdio: ["ignore", fd, "pipe"], encoding: "utf8" }); } finally { closeSync(fd); }
    chmodSync(sqlPath, 0o600);
    if (r.status !== 0) throw new Error(String(r.stderr || `restore-control-plane.mjs exited ${r.status}`).trim().split("\n")[0]);
    return "decrypted and converted";
  });
  if (!gen.ok) throw new Error("stop");

  // 3. the SQL must contain exactly one INSERT per backed-up row, per table
  const counts = new Map();
  await new Promise((resolve, reject) => {
    const rl = createInterface({ input: createReadStream(sqlPath, "utf8"), crlfDelay: Infinity });
    rl.on("line", (line) => { const m = /^INSERT OR REPLACE INTO "([^"]+)"/.exec(line); if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1); });
    rl.on("close", resolve); rl.on("error", reject);
  });
  const check = stepRun("check_restore_sql", () => {
    const mismatches = [];
    for (const [t, expected] of Object.entries(report.backup.rowCounts)) if ((counts.get(t) || 0) !== expected) mismatches.push({ table: t, expected, actual: counts.get(t) || 0 });
    for (const t of counts.keys()) if (!(t in report.backup.rowCounts)) mismatches.push({ table: t, expected: 0, actual: counts.get(t) });
    report.sqlCheck = { ok: mismatches.length === 0, statements: [...counts.values()].reduce((a, b) => a + b, 0), mismatches };
    if (mismatches.length) throw new Error(`generated SQL differs from the manifest for: ${mismatches.map((m) => m.table).join(", ")}`);
    return `${report.sqlCheck.statements} statements match the manifest`;
  });
  if (!check.ok) throw new Error("stop");

  if (!args.apply) {
    skip("apply_restore_sql", "dry run: nothing was written anywhere");
    skip("verify_row_counts", "dry run: there is no restored database to count");
  } else {
    const bin = args.wranglerBin || (existsSync(path.join(root, "node_modules", ".bin", "wrangler")) ? path.join(root, "node_modules", ".bin", "wrangler") : "wrangler");
    const cfg = args.wranglerConfig ? ["--config", args.wranglerConfig] : [];
    const wr = (extra) => spawnSync(bin, ["d1", "execute", args.targetDb, "--remote", ...cfg, ...extra], { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
    const apply = stepRun("apply_restore_sql", () => {
      const r = wr(["--file", sqlPath]);
      if (r.error) throw new Error(`could not run wrangler: ${r.error.code || r.error.message}`);
      if (r.status !== 0) throw new Error(String(r.stderr || r.stdout || `wrangler exited ${r.status}`).trim().split("\n").slice(-3).join(" | "));
      return "wrangler d1 execute --remote --file completed";
    });
    if (!apply.ok) throw new Error("stop");
    const verify = stepRun("verify_row_counts", () => {
      const tables = Object.keys(report.backup.rowCounts);
      const actual = new Map();
      for (let i = 0; i < tables.length; i += 40) {
        const sql = tables.slice(i, i + 40).map((t) => `SELECT '${t}' AS t, COUNT(*) AS n FROM "${t}"`).join(" UNION ALL ");
        const r = wr(["--json", "--command", sql]);
        if (r.error || r.status !== 0) throw new Error(`count query failed: ${redact(r.error?.message || r.stderr || r.stdout).split("\n")[0]}`);
        const raw = String(r.stdout);
        const parsed = JSON.parse(raw.slice(raw.indexOf("[")));
        for (const part of parsed) for (const row of part.results || []) actual.set(String(row.t), Number(row.n));
      }
      const mismatches = [];
      for (const t of tables) { const a = actual.has(t) ? actual.get(t) : null; if (a !== report.backup.rowCounts[t]) mismatches.push({ table: t, expected: report.backup.rowCounts[t], actual: a }); }
      report.verify = { ok: mismatches.length === 0, checked: tables.length, mismatches };
      if (mismatches.length) throw new Error(`row counts differ from the backup for: ${mismatches.map((m) => m.table).join(", ")}`);
      return `${tables.length} tables match the manifest`;
    });
    if (!verify.ok) { if (report.verify.ok === null) report.verify.ok = false; throw new Error("stop"); }
  }
  report.status = args.apply ? "APPLIED, PENDING OWNER REVIEW" : "DRY RUN";
} catch (e) {
  if (e.message !== "stop") report.steps.push({ name: "unexpected_error", status: "failed", ok: false, seconds: 0, detail: redact(e.message) });
  failed = true;
  report.status = "FAILED";
} finally {
  if (!args.keepSql && existsSync(sqlPath)) rmSync(sqlPath, { force: true });
}

// Recovery time: the script times only what it runs; the manual steps are the owner's stopwatch. Anything missing means
// the total is unknown, not a smaller number.
const scriptSeconds = report.steps.filter((s) => ["generate_restore_sql", "check_restore_sql", "apply_restore_sql", "verify_row_counts"].includes(s.name)).reduce((a, s) => a + s.seconds, 0);
const missing = MANUAL_STEPS.filter((s) => args.manual[s] === undefined);
const complete = args.apply && !failed && missing.length === 0;
report.recoveryTime = {
  complete, scriptSeconds: Math.round(scriptSeconds * 10) / 10, manualMinutes: { ...args.manual }, missingManual: missing,
  totalMinutes: complete ? Math.round((MANUAL_STEPS.reduce((a, s) => a + args.manual[s], 0) + scriptSeconds / 60) * 10) / 10 : "unknown",
};
if (!args.apply) report.rto.evaluation = "not evaluated (dry run)";
else if (failed) report.rto.evaluation = "not evaluated (drill failed)";
else if (rtoObjective === "unknown") report.rto.evaluation = "no objective supplied";
else if (!complete) report.rto.evaluation = "not evaluated (manual timings incomplete)";
else report.rto.evaluation = report.recoveryTime.totalMinutes <= rtoObjective ? "within objective (measurement only; not evidence until owner-reviewed)" : "objective exceeded";
report.finishedAt = new Date().toISOString();
report.sqlRetained = Boolean(args.keepSql && existsSync(sqlPath));

const cell = (v) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
const fill = {
  DRILL_ID: drillId, RELEASE_ID: report.releaseId, GENERATED_AT: report.finishedAt, MODE: report.mode, STATUS: report.status, EVIDENCE_LABEL: report.evidenceLabel,
  TARGET_DB: args.targetDb, BACKUP_ID: report.backup.backupId, BACKUP_CREATED_AT: report.backup.createdAt, BACKUP_AGE_HOURS: report.backup.ageHoursAtDrillStart,
  TABLE_COUNT: report.backup.tables, ROW_TOTAL: Object.values(report.backup.rowCounts).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0),
  STEP_TABLE: report.steps.map((s) => `| ${cell(s.name)} | ${cell(s.status)} | ${s.seconds} | ${cell(s.detail)} |`).join("\n"),
  MANUAL_TABLE: MANUAL_STEPS.map((s) => `| ${s} | ${args.manual[s] === undefined ? "unknown (not supplied)" : args.manual[s]} |`).join("\n"),
  SCRIPT_SECONDS: report.recoveryTime.scriptSeconds, TOTAL_RECOVERY: report.recoveryTime.totalMinutes === "unknown" ? "unknown" : `${report.recoveryTime.totalMinutes} minutes`,
  RTO_OBJECTIVE: rtoObjective === "unknown" ? "unknown ([OPEN] owner decision)" : `${rtoObjective} minutes`, RTO_EVALUATION: report.rto.evaluation,
  VERIFY_RESULT: report.verify.ok === null ? "not run" : report.verify.ok ? `${report.verify.checked} tables match the manifest` : `MISMATCH: ${report.verify.mismatches.map((m) => `${m.table} (expected ${m.expected}, actual ${m.actual})`).join("; ") || "see steps"}`,
  SQL_RETAINED: report.sqlRetained ? "kept (owner-readable only; delete it after review)" : "removed",
};
const templateFile = path.join(root, "docs", "RESTORE_DRILL_REPORT_TEMPLATE.md");
if (!existsSync(templateFile)) { console.error("docs/RESTORE_DRILL_REPORT_TEMPLATE.md is missing; the JSON report was still written."); failed = true; }
writeFileSync(path.join(outDir, "restore-drill-report.json"), JSON.stringify(report, null, 2) + "\n");
if (existsSync(templateFile)) writeFileSync(path.join(outDir, "restore-drill-report.md"), readFileSync(templateFile, "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in fill ? String(fill[k]) : m)));

console.log(`Restore drill ${drillId}: ${report.status} (evidence label: ${report.evidenceLabel})`);
for (const s of report.steps) console.log(`  ${s.status.padEnd(7)} ${s.name} ${s.seconds}s ${s.detail ? "- " + s.detail : ""}`);
console.log(`  recovery time: ${report.recoveryTime.totalMinutes === "unknown" ? "unknown" : report.recoveryTime.totalMinutes + " minutes"}; objective: ${rtoObjective === "unknown" ? "unknown" : rtoObjective + " minutes"}; ${report.rto.evaluation}`);
console.log(`  report: ${path.join(outDir, "restore-drill-report.md")}`);
if (!args.apply && !failed) console.log("  dry run only: nothing was restored. Run with --apply --confirm <staging-db> for the real drill.");
process.exit(failed ? 1 : 0);
