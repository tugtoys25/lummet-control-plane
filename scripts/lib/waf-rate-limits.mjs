// Pure helpers for the WAF rate-limit config (no network, no env access). Used by the apply script and the tests.
import { readFileSync } from "node:fs";

export const CONFIG_URL = new URL("../../config/cloudflare-waf-rate-limits.v1.json", import.meta.url);
export const loadConfig = () => JSON.parse(readFileSync(CONFIG_URL, "utf8"));

const q = (s) => JSON.stringify(String(s));
const SAFE_PATH = /^\/[A-Za-z0-9/_.\-]*$/;

/** True when the request is covered by one path pattern of a rule match. */
export function pathMatches(p, path) {
  if (p.exact !== undefined) return path === p.exact;
  const prefixOk = p.prefix === undefined || path.startsWith(p.prefix);
  const suffixOk = p.suffix === undefined || path.endsWith(p.suffix);
  const containsOk = p.contains === undefined || path.slice((p.prefix || "").length).includes(p.contains);
  return prefixOk && suffixOk && containsOk;
}
export const ruleMatches = (rule, method, path) => rule.match.methods.includes(String(method).toUpperCase()) && rule.match.paths.some((p) => pathMatches(p, path));

function pathExpr(p) {
  if (p.exact !== undefined) return `http.request.uri.path eq ${q(p.exact)}`;
  const parts = [];
  if (p.prefix !== undefined) parts.push(`starts_with(http.request.uri.path, ${q(p.prefix)})`);
  if (p.suffix !== undefined) parts.push(`ends_with(http.request.uri.path, ${q(p.suffix)})`);
  if (p.contains !== undefined) parts.push(`http.request.uri.path contains ${q(p.contains)}`);
  return parts.length > 1 ? `(${parts.join(" and ")})` : parts[0];
}

/** Cloudflare ruleset expression for one rule. */
export function compileExpression(rule) {
  const methods = `http.request.method in {${rule.match.methods.map(q).join(" ")}}`;
  return `(${methods} and (${rule.match.paths.map(pathExpr).join(" or ")}))`;
}

/** Structural checks on the config file itself. Returns a list of problems. */
export function validateConfig(config) {
  const errors = []; const keys = new Set();
  if (config.version !== 1 || config.phase !== "http_ratelimit" || !/^[a-z0-9-]+$/.test(config.refPrefix || "")) errors.push("version, phase or refPrefix is wrong");
  if (!Array.isArray(config.rules) || !config.rules.length) errors.push("rules must not be empty");
  for (const r of config.rules || []) {
    if (!/^[a-z0-9-]+$/.test(r.key || "") || keys.has(r.key)) errors.push(`rule key invalid or duplicate: ${r.key}`); keys.add(r.key);
    if (!r.match?.methods?.length || r.match.methods.some((m) => !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m))) errors.push(`${r.key}: bad methods`);
    if (!r.match?.paths?.length) errors.push(`${r.key}: no paths`);
    for (const p of r.match?.paths || []) {
      const vals = [p.exact, p.prefix, p.suffix, p.contains].filter((v) => v !== undefined);
      if (!vals.length || vals.some((v) => typeof v !== "string" || !v || /["\\\s]/.test(v))) errors.push(`${r.key}: unsafe or empty path pattern`);
      if (p.exact !== undefined && !SAFE_PATH.test(p.exact)) errors.push(`${r.key}: exact path ${p.exact} is not a plain path`);
    }
    for (const f of ["requests", "period", "timeout"]) if (!Number.isInteger(r[f]) || r[f] < 1) errors.push(`${r.key}: ${f} must be a positive integer`);
    // A rule must never rate-limit a provider callback or the CSP report endpoint.
    for (const never of config.neverRateLimit || []) for (const m of r.match?.methods || []) if (ruleMatches(r, m, never)) errors.push(`${r.key} would match protected path ${never}`);
  }
  return errors;
}

/** Applies WAF_RATE_LIMIT_THRESHOLDS ({"<key>":{"requests":n,"period":s,"timeout":s}}) over the file defaults. */
export function applyThresholds(config, raw) {
  const errors = []; let overrides = {};
  if (raw && String(raw).trim()) {
    try { overrides = JSON.parse(raw); } catch { return { rules: config.rules, errors: ["WAF_RATE_LIMIT_THRESHOLDS is not valid JSON"] }; }
    if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return { rules: config.rules, errors: ["WAF_RATE_LIMIT_THRESHOLDS must be a JSON object"] };
  }
  const known = new Set(config.rules.map((r) => r.key));
  for (const k of Object.keys(overrides)) if (!known.has(k)) errors.push(`WAF_RATE_LIMIT_THRESHOLDS names unknown rule ${k}`);
  const rules = config.rules.map((r) => {
    const o = overrides[r.key] || {};
    for (const f of Object.keys(o)) if (!["requests", "period", "timeout"].includes(f)) errors.push(`${r.key}: unknown field ${f}`);
    const merged = { ...r, requests: o.requests ?? r.requests, period: o.period ?? r.period, timeout: o.timeout ?? r.timeout };
    for (const f of ["requests", "period", "timeout"]) if (!Number.isInteger(merged[f]) || merged[f] < 1 || merged[f] > 1000000) errors.push(`${r.key}: ${f} must be a positive integer`);
    return merged;
  });
  return { rules, errors };
}

/** The Cloudflare rule objects this config owns. */
export function buildManagedRules(config, rules = config.rules) {
  return rules.map((r) => ({
    ref: `${config.refPrefix}${r.key}`,
    description: `Lummet ${r.description}`.slice(0, 200),
    expression: compileExpression(r),
    action: "block",
    enabled: true,
    ratelimit: { characteristics: ["ip.src"], period: r.period, requests_per_period: r.requests, mitigation_timeout: r.timeout }
  }));
}

/** Plan limits come from the owner (CF_WAF_MAX_RULES, CF_WAF_ALLOWED_PERIODS, CF_WAF_MAX_TIMEOUT). Returns {limits, missing}. */
export function readPlanLimits(env) {
  const maxRules = Number(env.CF_WAF_MAX_RULES);
  const periods = String(env.CF_WAF_ALLOWED_PERIODS || "").split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const maxTimeout = Number(env.CF_WAF_MAX_TIMEOUT);
  const missing = [];
  if (!Number.isInteger(maxRules) || maxRules < 1) missing.push("CF_WAF_MAX_RULES");
  if (!periods.length) missing.push("CF_WAF_ALLOWED_PERIODS");
  if (!Number.isInteger(maxTimeout) || maxTimeout < 1) missing.push("CF_WAF_MAX_TIMEOUT");
  return { limits: { maxRules, periods, maxTimeout }, missing };
}

export function checkAgainstPlan(rules, foreignCount, limits) {
  const errors = [];
  if (rules.length + foreignCount > limits.maxRules) errors.push(`plan allows ${limits.maxRules} rate-limit rule(s); this config needs ${rules.length} plus ${foreignCount} existing unmanaged`);
  for (const r of rules) {
    if (!limits.periods.includes(r.period)) errors.push(`${r.key}: period ${r.period}s is not allowed on this plan (allowed: ${limits.periods.join(", ")})`);
    if (r.timeout > limits.maxTimeout) errors.push(`${r.key}: mitigation timeout ${r.timeout}s exceeds the plan maximum ${limits.maxTimeout}s`);
  }
  return errors;
}
