#!/usr/bin/env node
/** Build, diff or safely apply the Cloudflare WAF rate-limit rules in config/cloudflare-waf-rate-limits.v1.json.
 *  Dry-run is the default and never calls Cloudflare. Style follows scripts/stripe-webhook-config.mjs.
 *    node scripts/cloudflare-waf-rate-limit-config.mjs [--mode staging|production] [--diff] [--apply] [--rollback] [--allow-production] [--out file]
 *  --diff      read-only: GET the zone's current rate-limit ruleset and show what would change (needs CF_API_TOKEN, CF_WAF_ZONE_ID).
 *  --apply     create or update ONLY the rules this config owns (ref prefix lummet-v1-); other rules are preserved.
 *  --rollback  with --apply: remove only the rules this config owns.
 *  Live changes are owner-run. See docs/WAF_RATE_LIMITS.md. */
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { loadConfig, validateConfig, applyThresholds, buildManagedRules, readPlanLimits, checkAgainstPlan } from "./lib/waf-rate-limits.mjs";

const API = "https://api.cloudflare.com/client/v4";

export async function main(argv, env, fetchImpl, io = { log: console.log, error: console.error }) {
  const has = (x) => argv.includes(`--${x}`);
  const opt = (x) => { const i = argv.indexOf(`--${x}`); return i >= 0 ? argv[i + 1] : null; };
  const refuse = (msg) => { io.error(`REFUSED: ${msg}`); return 2; };
  const mode = opt("mode") || "staging";
  if (!["staging", "production"].includes(mode)) { io.error("Usage: node scripts/cloudflare-waf-rate-limit-config.mjs [--mode staging|production] [--diff] [--apply] [--rollback] [--allow-production] [--out file]"); return 2; }
  if (has("rollback") && !has("apply")) return refuse("--rollback only works together with --apply.");

  const config = loadConfig();
  const configErrors = validateConfig(config);
  if (configErrors.length) return refuse(`config file is invalid: ${configErrors.join("; ")}`);
  const { rules, errors: thresholdErrors } = applyThresholds(config, env.WAF_RATE_LIMIT_THRESHOLDS);
  if (thresholdErrors.length) return refuse(thresholdErrors.join("; "));
  const managed = has("rollback") ? [] : buildManagedRules(config, rules);
  const { limits, missing } = readPlanLimits(env);
  const zone = String(env.CF_WAF_ZONE_ID || "");
  const zoneOk = /^[0-9a-f]{32}$/i.test(zone);

  // ---- dry run (default): no network, no mutation
  if (!has("apply") && !has("diff")) {
    const blockers = [];
    if (!zoneOk) blockers.push("CF_WAF_ZONE_ID is missing or not a 32-character zone id");
    if (missing.length) blockers.push(`plan limits unknown: ${missing.join(", ")}`);
    if (String(env.WAF_THRESHOLDS_CONFIRMED || "") !== "yes") blockers.push("thresholds are not confirmed (WAF_THRESHOLDS_CONFIRMED=yes) [OPEN]");
    io.log(JSON.stringify({ mode, operation: "set Cloudflare WAF rate-limit rules", dryRun: true, mutates: false, zone: zoneOk ? zone : "(set CF_WAF_ZONE_ID)", rules: managed, applyBlockedBy: blockers }, null, 2));
    return 0;
  }

  // ---- shared guards for --diff and --apply
  if (!zoneOk) return refuse("CF_WAF_ZONE_ID must be a 32-character zone id.");
  if (!env.CF_API_TOKEN) return refuse("CF_API_TOKEN is required.");
  if (String(env.CF_WAF_ENVIRONMENT || "") !== mode) return refuse(`requested ${mode} mode but CF_WAF_ENVIRONMENT is ${env.CF_WAF_ENVIRONMENT || "unset"}; it must name the environment the zone belongs to.`);
  const headers = { Authorization: `Bearer ${env.CF_API_TOKEN}`, "Content-Type": "application/json" };
  const url = `${API}/zones/${zone}/rulesets/phases/${config.phase}/entrypoint`;

  const current = await fetchImpl(url, { method: "GET", headers });
  let foreign = [], mine = [];
  if (current.status === 404) { /* no entrypoint ruleset yet */ }
  else {
    const body = await current.json().catch(() => ({}));
    if (!current.ok || body.success === false) { io.error(`Cloudflare read failed: HTTP ${current.status}`); return 1; }
    for (const r of body.result?.rules || []) (String(r.ref || "").startsWith(config.refPrefix) ? mine : foreign).push(r);
  }
  const desiredRefs = new Set(managed.map((r) => r.ref));
  const plan = {
    add: managed.filter((r) => !mine.some((m) => m.ref === r.ref)).map((r) => r.ref),
    update: managed.filter((r) => mine.some((m) => m.ref === r.ref)).map((r) => r.ref),
    remove: mine.filter((m) => !desiredRefs.has(m.ref)).map((m) => m.ref),
    preservedUnmanaged: foreign.length
  };
  if (!has("apply")) { io.log(JSON.stringify({ mode, operation: "diff", dryRun: true, mutates: false, plan }, null, 2)); return 0; }

  // ---- apply guards
  if (missing.length) return refuse(`plan limits unknown (BLOCKED): set ${missing.join(", ")} from the zone's Cloudflare plan.`);
  const planErrors = checkAgainstPlan(rules.filter(() => !has("rollback")), foreign.length, limits);
  if (planErrors.length) return refuse(planErrors.join("; "));
  if (String(env.WAF_THRESHOLDS_CONFIRMED || "") !== "yes" && !has("rollback")) return refuse("thresholds are placeholders until the owner sets WAF_THRESHOLDS_CONFIRMED=yes.");
  if (mode === "production" && !(has("allow-production") && env.CF_WAF_CHANGES_APPROVED === "true")) return refuse("production changes require --allow-production and CF_WAF_CHANGES_APPROVED=true.");

  const put = await fetchImpl(url, { method: "PUT", headers, body: JSON.stringify({ rules: [...foreign, ...managed] }) });
  const result = await put.json().catch(() => ({}));
  if (!put.ok || result.success === false) { io.error(`Cloudflare update failed: HTTP ${put.status}; ${result.errors?.[0]?.message || "no message"}`); return 1; }
  const out = { mode, zone, applied: has("rollback") ? "rollback (managed rules removed)" : "managed rules set", plan, tokenPrinted: false, next: "Verify in the Cloudflare dashboard (Security > WAF > Rate limiting rules) and watch for legitimate users being blocked." };
  const outFile = opt("out");
  if (outFile) { await writeFile(outFile, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 }); io.log(`Evidence written to ${outFile}`); } else io.log(JSON.stringify(out, null, 2));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2), process.env, fetch));
