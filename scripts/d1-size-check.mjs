#!/usr/bin/env node
// D1 size check (Round 6.5C, release 2.6.0.14). READ ONLY: lists table names and counts rows. It never reads row
// contents, never writes, and never prints a key, a row or a message.
//
//   node scripts/d1-size-check.mjs --input snapshot.json                       report from a saved snapshot
//   node scripts/d1-size-check.mjs --collect <d1-db-name> --remote [--env staging]   collect with wrangler, then report
//
// Options: --policy <file> (default config/d1-size-policy.v1.json), --json, --fail-on warn|critical (default critical),
//          --require-known, --limit-bytes N, --database-bytes N, --save-snapshot <file>
// Exit: 0 ok (or only unknown), 1 at or above --fail-on, 2 bad usage, 3 unknown with --require-known.
// What this does NOT do: move any table. The plan is docs/D1_SIZE_AND_TABLE_MOVE_PLAN.md.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPORT_FORMAT = "lummet-d1-size-check/1";
export const PLAN_PATH = "docs/D1_SIZE_AND_TABLE_MOVE_PLAN.md";
const GROUPS = ["request_errors", "audit", "email_history"];
const RANK = { ok: 0, warn: 1, critical: 2 };
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const posInt = (v) => Number.isInteger(v) && v > 0;

export async function loadPolicy(file) {
  let p;
  try { p = JSON.parse(await readFile(file, "utf8")); } catch (e) { throw new Error(`Cannot read policy ${file}: ${e.message}`); }
  return validatePolicy(p);
}

export function validatePolicy(p) {
  if (!p || p.version !== 1) throw new Error("Policy: version must be 1");
  if (typeof p.confirmed !== "boolean") throw new Error("Policy: confirmed must be true or false");
  if (!(p.warnPercent > 0 && p.criticalPercent <= 100 && p.warnPercent < p.criticalPercent)) throw new Error("Policy: need 0 < warnPercent < criticalPercent <= 100");
  if (p.limitBytes !== null && !posInt(p.limitBytes)) throw new Error("Policy: limitBytes must be null (unknown) or a positive integer");
  for (const [t, v] of Object.entries(p.highVolume || {})) {
    if (!IDENT.test(t)) throw new Error(`Policy: bad table name ${t}`);
    if (!GROUPS.includes(v.group)) throw new Error(`Policy: ${t}.group must be one of ${GROUPS.join(", ")}`);
    for (const k of ["warnRows", "criticalRows"]) if (v[k] !== null && !posInt(v[k])) throw new Error(`Policy: ${t}.${k} must be null or a positive integer`);
    if (v.warnRows !== null && v.criticalRows !== null && v.warnRows >= v.criticalRows) throw new Error(`Policy: ${t}.warnRows must be below criticalRows`);
  }
  return p;
}

// `runner(sql)` returns an array of row objects. Only a table listing and COUNT(*) statements are ever issued.
export async function collectSnapshot(runner, { databaseName = null, databaseBytes = null } = {}) {
  const names = (await runner(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`)).map((r) => r.name);
  const tables = []; let skipped = 0;
  for (const name of names) {
    if (!IDENT.test(String(name))) { skipped += 1; continue; }     // never interpolate anything but a plain identifier
    const rows = await runner(`SELECT COUNT(*) AS n FROM "${name}"`);
    tables.push({ name, rows: Number(rows[0]?.n ?? 0) });
  }
  return { databaseName, databaseBytes, tables, skippedTables: skipped };
}

function dbStatus(percent, p) { return percent === null ? "unknown" : percent >= p.criticalPercent ? "critical" : percent >= p.warnPercent ? "warn" : "ok"; }
function tableStatus(rows, hv) {
  if (!hv) return "not_graded";
  if (hv.warnRows === null && hv.criticalRows === null) return "unknown";
  if (hv.criticalRows !== null && rows >= hv.criticalRows) return "critical";
  if (hv.warnRows !== null && rows >= hv.warnRows) return "warn";
  return "ok";
}

export function buildReport(snapshot, policy, { now = new Date(), limitBytes } = {}) {
  const limit = limitBytes ?? policy.limitBytes;
  const bytes = Number.isFinite(snapshot.databaseBytes) ? snapshot.databaseBytes : null;
  const percent = bytes !== null && limit ? +((bytes / limit) * 100).toFixed(1) : null;
  const total = snapshot.tables.reduce((a, t) => a + t.rows, 0);
  const tables = snapshot.tables.map((t) => {
    const hv = policy.highVolume?.[t.name];
    return { name: t.name, rows: t.rows, sharePercent: total ? +((t.rows / total) * 100).toFixed(1) : 0, highVolume: !!hv, group: hv ? hv.group : null, status: tableStatus(t.rows, hv) };
  }).sort((a, b) => b.rows - a.rows || a.name.localeCompare(b.name));
  const database = { name: snapshot.databaseName ?? null, bytes, limitBytes: limit ?? null, usedPercent: percent, status: dbStatus(percent, policy) };
  const hot = tables.filter((t) => t.highVolume && (t.status === "warn" || t.status === "critical")).map((t) => t.name);
  const hvTables = tables.filter((t) => t.highVolume);
  const allKnownOk = database.status === "ok" && hvTables.length > 0 && hvTables.every((t) => t.status === "ok");
  const moveNeeded = hot.length || database.status === "warn" || database.status === "critical" ? "yes" : allKnownOk ? "no" : "unknown";
  const labels = ["NOT VERIFIED: counts come from the snapshot supplied; no live Cloudflare D1 run is attached to this report"];
  if (!policy.confirmed) labels.unshift("UNCONFIRMED [OPEN]: thresholds and limits are placeholders, not owner-approved");
  const missing = Object.keys(policy.highVolume || {}).filter((n) => !snapshot.tables.some((t) => t.name === n));
  if (missing.length) labels.push(`NOTE: policy tables not found in the snapshot: ${missing.join(", ")}`);
  if (snapshot.skippedTables) labels.push(`NOTE: ${snapshot.skippedTables} table name(s) skipped (not a plain identifier)`);
  return {
    format: REPORT_FORMAT, generatedAt: now.toISOString(), policyConfirmed: policy.confirmed, database,
    thresholds: { warnPercent: policy.warnPercent, criticalPercent: policy.criticalPercent },
    totals: { tables: tables.length, rows: total }, tables,
    recommendation: { moveNeeded, tables: hot, plan: PLAN_PATH }, labels
  };
}

export function formatText(r) {
  const d = r.database, up = (s) => s.toUpperCase();
  const L = [
    `D1 SIZE CHECK (${r.format})`,
    `generated: ${r.generatedAt}`,
    `database: ${d.name ?? "(unnamed)"}  size: ${d.bytes === null ? "unknown" : d.bytes + " bytes"}  limit: ${d.limitBytes === null ? "unknown" : d.limitBytes + " bytes"}  used: ${d.usedPercent === null ? "unknown" : d.usedPercent + "%"}  status: ${up(d.status)}`,
    `thresholds: warn ${r.thresholds.warnPercent}%  critical ${r.thresholds.criticalPercent}%${r.policyConfirmed ? "" : "  (UNCONFIRMED [OPEN])"}`,
    `tables: ${r.totals.tables}  rows: ${r.totals.rows}`,
    "HIGH-VOLUME TABLES"
  ];
  for (const t of r.tables.filter((x) => x.highVolume)) L.push(`  ${t.name}  group=${t.group}  rows=${t.rows}  share=${t.sharePercent}%  status=${up(t.status)}`);
  const rec = r.recommendation;
  const why = rec.tables.length ? rec.tables.join(", ") : "database size";
  L.push(rec.moveNeeded === "yes" ? `MOVE NEEDED: yes (${why})  plan: ${rec.plan}` : `MOVE NEEDED: ${rec.moveNeeded}  plan: ${rec.plan}`);
  for (const l of r.labels) L.push(`LABEL: ${l}`);
  return L.join("\n");
}

// ---- collection through wrangler (read-only statements; NOT VERIFIED against a live D1 from the build environment) ----
const exec = promisify(execFile);
function wranglerRunner(db, { env, remote }) {
  const base = ["wrangler", "d1", "execute", db, "--json", ...(remote ? ["--remote"] : []), ...(env ? ["--env", env] : [])];
  return async (sql) => {
    const { stdout } = await exec("npx", [...base, "--command", sql], { maxBuffer: 32 * 1024 * 1024 });
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed[0]?.results : parsed.results) || [];
  };
}
async function wranglerBytes(db, { env }) {
  try {
    const { stdout } = await exec("npx", ["wrangler", "d1", "info", db, "--json", ...(env ? ["--env", env] : [])], { maxBuffer: 4 * 1024 * 1024 });
    const info = JSON.parse(stdout);
    const v = info.file_size ?? info.database_size ?? info.size;
    return Number.isFinite(Number(v)) && v !== null ? Number(v) : null;
  } catch { return null; }          // size stays unknown; the report says so
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const usage = (m) => { console.error(`${m ? m + "\n" : ""}Usage: node scripts/d1-size-check.mjs (--input <snapshot.json> | --collect <db-name> [--remote] [--env <name>]) [--policy <file>] [--json] [--fail-on warn|critical] [--require-known] [--limit-bytes N] [--database-bytes N] [--save-snapshot <file>]`); process.exit(2); };
  const failOn = opt("fail-on", "critical");
  if (!["warn", "critical"].includes(failOn)) usage(`Bad --fail-on ${failOn}`);
  if (!opt("input") && !opt("collect")) usage("Give --input or --collect.");
  let policy, snapshot;
  try { policy = await loadPolicy(opt("policy", path.join(root, "config/d1-size-policy.v1.json"))); } catch (e) { usage(e.message); }
  const num = (n) => { const v = opt(n); if (v === undefined) return undefined; if (!/^\d+$/.test(v)) usage(`--${n} must be a whole number`); return Number(v); };
  const limitBytes = num("limit-bytes"), bytesOverride = num("database-bytes");
  try {
    if (opt("input")) snapshot = JSON.parse(await readFile(opt("input"), "utf8"));
    else {
      const db = opt("collect"), o = { env: opt("env"), remote: args.includes("--remote") };
      snapshot = await collectSnapshot(wranglerRunner(db, o), { databaseName: db, databaseBytes: await wranglerBytes(db, o) });
      if (opt("save-snapshot")) await writeFile(opt("save-snapshot"), JSON.stringify(snapshot, null, 2) + "\n");
    }
  } catch (e) { console.error(`Cannot build snapshot: ${e.message}`); process.exit(2); }
  if (bytesOverride !== undefined) snapshot.databaseBytes = bytesOverride;
  if (!Array.isArray(snapshot.tables)) usage("Snapshot has no tables array.");
  const report = buildReport(snapshot, policy, { limitBytes });
  console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatText(report));
  const worst = Math.max(RANK[report.database.status] ?? 0, ...report.tables.map((t) => RANK[t.status] ?? 0));
  if (worst >= RANK[failOn]) process.exit(1);
  const unknown = report.database.status === "unknown" || report.tables.some((t) => t.highVolume && t.status === "unknown");
  if (args.includes("--require-known") && unknown) process.exit(3);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
