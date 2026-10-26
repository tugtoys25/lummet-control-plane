#!/usr/bin/env node
// Load test for the control plane. STAGING ONLY. See docs/LOAD_TESTING.md.
//
//   LOADTEST_PASSWORD='<same as seed>' node scripts/loadtest.mjs \
//     --base https://staging-cp.example.workers.dev --allow-host staging-cp.example.workers.dev \
//     --scenario portal-read --users 50 --concurrency 20 --duration 30
//
// Exit code 1 if --max-error-rate or --p95-ms is exceeded, so it can gate a release.
//
// Nightly mode (Round 6.5C): runs every scenario in a thresholds file and applies that file's explicit pass thresholds.
//
//   LOADTEST_PASSWORD=... node scripts/loadtest.mjs --nightly --thresholds config/loadtest-thresholds.v1.json \
//     --base https://<staging-host> --allow-host <staging-host> [--scenarios portal-read,login] [--report report.json]
//
// Exit codes (nightly): 0 every scenario met its thresholds, 1 a threshold was missed or setup failed,
// 2 bad usage or a refused target, 3 a scenario had no threshold to evaluate (unknown, never a pass).
import { runLoad, assertTargetAllowed, SCENARIOS } from "./loadtest-lib.mjs";
import { loadThresholds, runNightly, formatNightly, EXIT } from "./loadtest-thresholds.mjs";
import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };

const base = (opt("base") || "").replace(/\/$/, "");
const nightly = args.includes("--nightly");
const scenario = opt("scenario", "portal-read");
if (!base || args.includes("--help") || !process.env.LOADTEST_PASSWORD && scenario !== "ops-ping" || nightly && !opt("thresholds")) {
  console.error(`Usage: LOADTEST_PASSWORD=... node scripts/loadtest.mjs --base <url> --allow-host <host> [--scenario ${Object.keys(SCENARIOS).join("|")}]
       [--users 50] [--concurrency 20] [--duration 30] [--requests N] [--max-error-rate 0.01] [--p95-ms 1000]
       LOADTEST_PASSWORD=... node scripts/loadtest.mjs --nightly --thresholds <file> --base <url> --allow-host <host> [--scenarios a,b] [--report <file>]`);
  process.exit(EXIT.USAGE);
}
try { assertTargetAllowed(base, opt("allow-host")); } catch (e) { console.error(e.message); process.exit(EXIT.USAGE); }

if (nightly) {
  let profile;
  try { profile = await loadThresholds(opt("thresholds")); } catch (e) { console.error(e.message); process.exit(EXIT.USAGE); }
  const only = opt("scenarios") ? opt("scenarios").split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  let report;
  try {
    report = await runNightly({ base, password: process.env.LOADTEST_PASSWORD, profile, only, opsToken: process.env.ALERT_CHECK_TOKEN, log: (m) => console.error(m) });
  } catch (e) {
    console.error(`FAIL setup: ${e.message}`);       // a run that could not start is a failed run, never a pass
    process.exit(EXIT.FAIL);
  }
  if (opt("report")) await writeFile(opt("report"), JSON.stringify(report, null, 2) + "\n");
  console.error(formatNightly(report));
  process.exit(report.exitCode);
}

const result = await runLoad({
  base, scenario,
  users: Number(opt("users", 50)), password: process.env.LOADTEST_PASSWORD,
  concurrency: Number(opt("concurrency", 20)), durationSec: Number(opt("duration", 30)),
  maxRequests: opt("requests") ? Number(opt("requests")) : 0,
  opsToken: process.env.ALERT_CHECK_TOKEN, log: (m) => console.error(m)
});
console.log(JSON.stringify({ scenario, base, ...result }, null, 2));

const maxErr = opt("max-error-rate"), p95 = opt("p95-ms");
let failed = false;
if (maxErr !== undefined && result.errorRate > Number(maxErr)) { console.error(`FAIL: error rate ${result.errorRate} > ${maxErr}`); failed = true; }
if (p95 !== undefined && result.ms.p95 > Number(p95)) { console.error(`FAIL: p95 ${Math.round(result.ms.p95)}ms > ${p95}ms`); failed = true; }
process.exit(failed ? 1 : 0);
