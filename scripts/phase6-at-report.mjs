#!/usr/bin/env node
// Round 6.G: runs blueprint section 15 acceptance tests AT-1 to AT-15 ONE AT AT A TIME on the fake provider and prints a
// per-AT result. It runs only the named tests (node --test --test-name-pattern on one file), never a suite.
//   node scripts/phase6-at-report.mjs            run and print
//   node scripts/phase6-at-report.mjs --list     print the map only (no run)
//   node scripts/phase6-at-report.mjs --json     machine-readable
// Stripe test-clock and live-mode runs are owner-run: every AT below carries `stripe: NOT VERIFIED` until evidence is attached.
// AT-15 (restore drill) is owner-run: the local tests prove the tooling; the AT itself stays NOT VERIFIED until a restore report exists.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const AT_MAP = [
  { at: 1, title: "trial expiry", file: "test/billing-lifecycle.test.js", pattern: "^AT-1:" },
  { at: 2, title: "subscribe mid-trial, no extra trial days", file: "test/billing-lifecycle.test.js", pattern: "^AT-2:" },
  { at: 3, title: "failed payment and recovery", file: "test/billing-lifecycle.test.js", pattern: "^AT-3:" },
  { at: 4, title: "unpaid, restricted, suspended and back", file: "test/billing-lifecycle.test.js", pattern: "^AT-4:" },
  { at: 5, title: "plan switch sync and unknown price alert", file: "test/phase6-gate-at-5-11-12-13.test.js", pattern: "^AT-5:" },
  { at: 6, title: "downgrade guard and audited override", file: "test/billing.test.js", pattern: "^AT-6 " },
  { at: 7, title: "invite beyond users.max", file: "test/billing-lifecycle.test.js", pattern: "^AT-7:" },
  { at: 8, title: "deletion during a Stripe outage", file: "test/billing-lifecycle.test.js", pattern: "^AT-8:" },
  { at: 9, title: "same webhook five times, one email", file: "test/billing-notifications.test.js", pattern: "^AT-9:" },
  { at: 10, title: "wrong livemode rejected", file: "test/billing-lifecycle.test.js", pattern: "^AT-10:" },
  { at: 11, title: "hand edit in Stripe raises drift", file: "test/phase6-gate-at-5-11-12-13.test.js", pattern: "^AT-11:" },
  { at: 12, title: "EU reverse charge (local half only)", file: "test/phase6-gate-at-5-11-12-13.test.js", pattern: "^AT-12 " },
  { at: 13, title: "refund and dispute", file: "test/phase6-gate-at-5-11-12-13.test.js", pattern: "^AT-13:" },
  { at: 14, title: "MRR within tolerance of the provider report", file: "test/revenue-job.test.js", pattern: "^AT-14:" },
  { at: 15, title: "restore drill (tooling only; the drill itself is owner-run)", file: "test/runbooks-restore-drill-6-5b.test.js", pattern: "^AT-B restore drill", ownerRun: true, evidence: "docs/RESTORE_DRILL_REPORT.md" }
];

function runOne(entry) {
  const r = spawnSync(process.execPath, ["--test", `--test-name-pattern=${entry.pattern}`, entry.file], { cwd: root, encoding: "utf8", timeout: 120000, maxBuffer: 1 << 26 });
  const out = `${r.stdout || ""}`;
  const num = (k) => Number((out.match(new RegExp(`^# ${k} (\\d+)`, "m")) || [])[1] || 0);
  // The name pattern also lets suites through as "skipped"; count only the tests that ran.
  const pass = num("pass"), fail = num("fail"), skipped = num("skipped");
  const ran = pass + fail;
  return { pass, fail, skipped, ran, status: r.status, timedOut: r.error?.code === "ETIMEDOUT" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const list = process.argv.includes("--list"), json = process.argv.includes("--json");
  const results = [];
  for (const e of AT_MAP) {
    if (list) { results.push({ ...e }); continue; }
    const r = runOne(e);
    const localPass = r.ran > 0 && r.fail === 0 && r.status === 0 && !r.timedOut;
    let label = localPass ? "TESTED LOCALLY (fake provider)" : "FAIL";
    if (localPass && e.ownerRun) label = existsSync(path.join(root, "..", e.evidence)) || existsSync(path.join(root, e.evidence)) ? "TESTED LOCALLY; restore report present, review it" : "TOOLING TESTED LOCALLY; drill NOT VERIFIED (no restore report)";
    results.push({ at: e.at, title: e.title, file: e.file, pattern: e.pattern, ...r, label, stripe: "NOT VERIFIED (owner-run Stripe test clocks, no evidence attached)" });
  }
  if (json) console.log(JSON.stringify(results, null, 2));
  else if (list) for (const e of results) console.log(`AT-${e.at}\t${e.file}\t${e.pattern}`);
  else {
    for (const r of results) console.log(`AT-${String(r.at).padEnd(2)} ${r.fail === 0 && r.ran > 0 ? (r.label.includes("NOT VERIFIED") ? "NOT VERIFIED" : "PASS") : "FAIL"}  ran=${r.ran} pass=${r.pass} fail=${r.fail}  ${r.label}  | ${r.title}`);
    const bad = results.filter((r) => !(r.fail === 0 && r.ran > 0));
    console.log(`\n${results.length - bad.length}/${results.length} ATs green on the fake provider (Node ${process.version}). Stripe test-clock runs: NOT VERIFIED.`);
    if (bad.length) process.exit(1);
  }
}
