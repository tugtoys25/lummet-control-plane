// Pass thresholds and the nightly runner for scripts/loadtest.mjs (Round 6.5C, release 2.6.0.14). STAGING ONLY.
//
// Rules this file enforces:
//   - A threshold that is unset is "not evaluated". It is never a silent pass.
//   - A scenario with nothing to evaluate is "unknown", and the run does not exit 0.
//   - A run that sent no requests never passes.
//   - A threshold value that is not a plausible number is a configuration error, not a pass. Zero is not a placeholder.
import { readFile } from "node:fs/promises";
import { runLoad, SCENARIOS } from "./loadtest-lib.mjs";

export const EXIT = Object.freeze({ PASS: 0, FAIL: 1, USAGE: 2, UNKNOWN: 3 });
export const NIGHTLY_FORMAT = "lummet-loadtest-nightly/1";

// name -> [kind, bound]. "max" checks actual <= limit, "min" checks actual >= limit.
const CHECKS = {
  minRequests: { dir: "min", actual: (r) => r.requests, valid: (v) => Number.isInteger(v) && v >= 1 },
  maxErrorRate: { dir: "max", actual: (r) => r.errorRate, valid: (v) => v >= 0 && v <= 1 },
  maxServerErrors: { dir: "max", actual: (r) => r.serverErrors, valid: (v) => Number.isInteger(v) && v >= 0 },
  p95Ms: { dir: "max", actual: (r) => r.ms?.p95 ?? null, valid: (v) => v > 0 },
  p99Ms: { dir: "max", actual: (r) => r.ms?.p99 ?? null, valid: (v) => v > 0 },
  minRequestsPerSecond: { dir: "min", actual: (r) => r.requestsPerSecond, valid: (v) => v > 0 },
  maxRateLimitedRate: { dir: "max", actual: (r) => (r.requests ? r.rateLimited / r.requests : 0), valid: (v) => v >= 0 && v <= 1 }
};

export function validateThresholds(t) {
  for (const [k, v] of Object.entries(t || {})) {
    const c = CHECKS[k];
    if (!c) throw new Error(`Unknown threshold "${k}". Known: ${Object.keys(CHECKS).join(", ")}`);
    if (v === null || v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || !c.valid(v)) throw new Error(`Invalid threshold ${k}=${JSON.stringify(v)}`);
  }
}

export function evaluateThresholds(result, thresholds) {
  validateThresholds(thresholds);
  const checks = [];
  for (const [name, c] of Object.entries(CHECKS)) {
    const limit = thresholds?.[name];
    if (limit === null || limit === undefined) {
      if (thresholds && name in thresholds) checks.push({ name, status: "not_evaluated", actual: c.actual(result), limit: null });
      continue;
    }
    const actual = c.actual(result);
    const ok = actual !== null && actual !== undefined && (c.dir === "max" ? actual <= limit : actual >= limit);
    checks.push({ name, status: ok ? "pass" : "fail", actual: actual ?? null, limit });
  }
  // A run that sent nothing proves nothing, whatever else was configured.
  if (!result.requests) checks.push({ name: "sentRequests", status: "fail", actual: 0, limit: 1 });
  const evaluated = checks.filter((c) => c.status !== "not_evaluated");
  const verdict = checks.some((c) => c.status === "fail") ? "fail" : evaluated.length ? "pass" : "unknown";
  return { verdict, checks };
}

export async function loadThresholds(file) {
  let cfg;
  try { cfg = JSON.parse(await readFile(file, "utf8")); } catch (e) { throw new Error(`Cannot read thresholds file ${file}: ${e.message}`); }
  return validateProfile(cfg);
}

export function validateProfile(cfg) {
  if (!cfg || cfg.version !== 1) throw new Error("Thresholds file: version must be 1");
  if (typeof cfg.confirmed !== "boolean") throw new Error("Thresholds file: confirmed must be true or false");
  if (!cfg.scenarios || typeof cfg.scenarios !== "object" || !Object.keys(cfg.scenarios).length) throw new Error("Thresholds file: scenarios is empty");
  for (const [name, s] of Object.entries(cfg.scenarios)) {
    if (!SCENARIOS[name]) throw new Error(`Thresholds file: unknown scenario "${name}"`);
    for (const k of ["users", "concurrency", "durationSec"]) if (!Number.isInteger(s[k]) || s[k] < 1) throw new Error(`Thresholds file: ${name}.${k} must be a positive integer`);
    if (s.maxRequests !== undefined && (!Number.isInteger(s.maxRequests) || s.maxRequests < 1)) throw new Error(`Thresholds file: ${name}.maxRequests must be a positive integer`);
    validateThresholds(s.thresholds);
  }
  return cfg;
}

// Runs each scenario in the profile one after another and evaluates it. Throws on a setup failure (for example the seed
// was not applied): the caller must treat that as a failed run. Never contacts anything but `base`.
export async function runNightly({ base, password, profile, opsToken, only, fetchImpl, log = () => {} }) {
  validateProfile(profile);
  const names = Object.keys(profile.scenarios).filter((n) => !only || only.includes(n));
  if (!names.length) throw new Error("No scenario selected");
  const scenarios = [];
  for (const name of names) {
    const s = profile.scenarios[name];
    log(`running ${name}: users=${s.users} concurrency=${s.concurrency} duration=${s.durationSec}s`);
    const result = await runLoad({ base, scenario: name, users: s.users, password, concurrency: s.concurrency, durationSec: s.durationSec, maxRequests: s.maxRequests || 0, opsToken, fetchImpl, log });
    scenarios.push({ name, users: s.users, concurrency: s.concurrency, durationSec: s.durationSec, result, evaluation: evaluateThresholds(result, s.thresholds) });
  }
  const verdicts = scenarios.map((s) => s.evaluation.verdict);
  const verdict = verdicts.includes("fail") ? "fail" : verdicts.includes("unknown") ? "unknown" : "pass";
  const labels = ["STAGING ONLY: measurements from this run against the target given; not evidence of production capacity", "NOT VERIFIED: no result from real Cloudflare D1 exists until the owner runs this against staging and attaches the report"];
  if (!profile.confirmed) labels.unshift("UNCONFIRMED [OPEN]: thresholds are placeholders, not owner-approved");
  return { format: NIGHTLY_FORMAT, generatedAt: new Date().toISOString(), verdict, exitCode: verdict === "pass" ? EXIT.PASS : verdict === "fail" ? EXIT.FAIL : EXIT.UNKNOWN, thresholdsConfirmed: profile.confirmed, scenarios, labels };
}

export function formatNightly(report) {
  const out = [];
  for (const s of report.scenarios) {
    const bad = s.evaluation.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.actual} vs limit ${c.limit}`);
    out.push(`${s.evaluation.verdict.toUpperCase()} ${s.name}${bad.length ? " (" + bad.join("; ") + ")" : ""}`);
  }
  out.push(`VERDICT ${report.verdict.toUpperCase()}`);
  for (const l of report.labels) out.push(`LABEL: ${l}`);
  return out.join("\n");
}
