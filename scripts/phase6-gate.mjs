#!/usr/bin/env node
// Round 6.G (release 2.6.0.15): static checks for every Phase 6 deliverable, rounds 6.1A to 6.5C, in the style of
// phase5-gate.mjs. These are STATIC REVIEW checks: they prove a deliverable is present and wired the way the round
// documents say, not that it works live. Nothing here contacts Stripe, Cloudflare, GitHub or any staging system.
//   node scripts/phase6-gate.mjs            exit 1 if any static check fails
// It also prints the Phase 6 done-conditions. Those are owner/evidence items and never turn the exit code green on their own:
// the release stays "production candidate" until every one holds.
import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(root, "..");
const read = (f) => readFile(path.join(root, f), "utf8");
const readRepo = (f) => readFile(path.join(repo, f), "utf8");
const exists = async (f, base = root) => { try { await access(path.join(base, f)); return true; } catch { return false; } };
const checks = [];
async function check(round, name, fn) { try { await fn(); checks.push([round, name, true, ""]); } catch (e) { checks.push([round, name, false, e.message]); } }
const has = (s, x) => { if (!s.includes(x)) throw new Error(`missing ${x}`); };
const files = async (...fs) => { for (const f of fs) if (!(await exists(f))) throw new Error(`missing file ${f}`); };
const json = async (f) => JSON.parse(await read(f));
const wrangler = await read("wrangler.jsonc");
const varDefault = (name) => { const m = wrangler.match(new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`)); if (!m) throw new Error(`${name} not declared in wrangler.jsonc`); return m[1]; };
const defaultsTo = (name, ...ok) => { const v = varDefault(name); if (!ok.includes(v)) throw new Error(`${name} defaults to "${v}", expected ${ok.join("|")}`); };

// A flag the Worker reads with an in-code default may be absent from wrangler.jsonc; if it IS declared at the top level it must be the safe value.
const notOverridden = (name, ...ok) => { const m = wrangler.match(new RegExp(`^\\s*"${name}"\\s*:\\s*"([^"]*)"`, "m")); if (m && !ok.includes(m[1])) throw new Error(`${name} is set to "${m[1]}" at the top level of wrangler.jsonc`); };

// ---- release basics
await check("6.G", "package.json is 2.6.0 and RELEASE_ID is 4-part", async () => { const p = await json("package.json"); if (p.version !== "2.6.0") throw new Error(`package.json ${p.version}`); if (!/^2\.6\.0\.\d+$/.test((await readRepo("RELEASE_ID")).trim())) throw new Error("RELEASE_ID"); });
await check("6.G", "migrations 0071 and 0072 exist and nothing above 0072 was added in Phase 6", async () => { const n = (await readdir(path.join(root, "migrations"))).filter((x) => /^007[1-9]_/.test(x)).sort(); if (n.length !== 2 || !n[0].startsWith("0071_") || !n[1].startsWith("0072_")) throw new Error(n.join(",")); });
await check("6.G", "safe defaults unchanged: BILLING_ENFORCE off, BILLING_SUSPEND_SITES off, STRIPE_TAX_ENABLED false, FOUNDER_LICENSE_ENABLED off", async () => { defaultsTo("BILLING_ENFORCE", "off"); notOverridden("BILLING_SUSPEND_SITES", "off"); notOverridden("STRIPE_TAX_ENABLED", "false"); notOverridden("FOUNDER_LICENSE_ENABLED", "off"); has(await read("worker/commercial.js"), "FOUNDER_LICENSE_ENABLED||'off'"); has(await read("worker/billing.js"), 'STRIPE_TAX_ENABLED === "true"'); const bc = await read("worker/billing-config.js"); has(bc, "BILLING_SUSPEND_SITES"); });

// ---- 6.1A / 6.1B / 6.1C revenue
await check("6.1A", "revenue schema has idempotent unique keys and movements derive from state changes", async () => { const m = await read("migrations/0071_revenue.sql"); has(m, "revenue_snapshots"); has(m, "subscription_movements"); has(m, "PRIMARY KEY"); has(m, "IF NOT EXISTS"); await files("worker/repositories/revenue.js", "worker/revenue.js"); });
await check("6.1A", "revenue rollout flag defaults to shadow", async () => defaultsTo("REVENUE_METRICS", "shadow"));
await check("6.1B", "daily job computes MRR (annual/12, trials excluded) and compares to a provider report within a tolerance", async () => { const s = await read("worker/revenue-job.js"); has(s, "mrrCents"); has(s, "mrrWithinTolerance"); has(await read("worker/billing-config.js"), "REVENUE_REPORTING_CURRENCY"); const w = await read("worker/index.js"); has(w, "revenue-job.js"); });
await check("6.1B", "mixed currencies are flagged, never silently summed", async () => { const s = await read("worker/revenue-job.js"); if (!/mixed/i.test(s)) throw new Error("no mixed-currency handling"); });
await check("6.1C", "cohorts, funnel, gross margin and deferred revenue exist; unit costs unset means unknown", async () => { const s = await read("worker/revenue-analytics.js"); for (const x of ["monthlyCohorts", "funnelSummary", "grossMarginByTier", "deferredRevenueSummary", "financeUnitCosts", "unknown"]) has(s, x); });
await check("6.1C", "CSV export is formula-injection safe and the staff routes are audited", async () => { const s = await read("worker/revenue-analytics.js"); has(s, "formula injection"); has(s, "csvCell"); const w = await read("worker/index.js"); if (!/revenue[-_]?analytics|revenue\.csv|analytics\/revenue/i.test(w)) throw new Error("no revenue analytics route in index.js"); });
await check("6.1C", "naive SUM(price_cents) MRR is gone from the staff overview", async () => { const s = await read("worker/staff-saas.js"); if (/SUM\(\s*(\w+\.)?price_cents\s*\)/i.test(s)) throw new Error("naive MRR still present"); });

// ---- 6.2A / 6.2B trust and legal
await check("6.2A", "public trust routes: /status /security /changelog /contact-sales /docs and security.txt", async () => { const s = await read("worker/public-site/router.js"); for (const x of ['"/status"', '"/security"', '"/changelog"', '"/contact-sales"', '"/docs"', "/.well-known/security.txt"]) has(s, x); await files("public/templates/pages/trust.html"); });
await check("6.2A", "trust pages are off by default and security.txt fails closed when unconfigured", async () => { defaultsTo("PUBLIC_TRUST_PAGES", "off", "shadow"); has(await read("worker/public-site/router.js"), "security.txt is not configured"); });
await check("6.2B", "legal routes exist and legal pages default to draft or unpublished", async () => { const s = await read("worker/public-site/router.js"); has(s, '"/legal/:slug"'); const v = varDefault("PUBLIC_LEGAL_PAGES"); if (!["off", "draft"].includes(v)) throw new Error(`PUBLIC_LEGAL_PAGES defaults to ${v}`); });
await check("6.2B", "OpenAPI validator script and /openapi.json route exist", async () => { await files("scripts/validate-openapi.mjs"); has(await read("worker/public-site/router.js"), "openapi.json"); });
await check("6.2B", "alerts: trial_expired_still_live, reconcile_drift and webhook_lag exist", async () => { const a = await read("worker/alerts.js"); for (const k of ["trial_expired_still_live", "reconcile_drift", "webhook_lag"]) has(a, k); });

// ---- 6.3A / 6.3B / 6.3C edge security
await check("6.3A", "WAF rate-limit config is versioned, apply script is dry-run by default, 429 carries Retry-After", async () => { await json("config/cloudflare-waf-rate-limits.v1.json"); await files("scripts/cloudflare-waf-rate-limit-config.mjs", "scripts/lib/waf-rate-limits.mjs", "docs/WAF_RATE_LIMITS.md"); const s = await read("scripts/cloudflare-waf-rate-limit-config.mjs"); if (!/--apply/.test(s) || !/dry/i.test(s)) throw new Error("no dry-run/apply split"); has(await read("worker/rate-limit-response.js"), "Retry-After"); });
await check("6.3A", "WAF thresholds are unconfirmed by default", async () => defaultsTo("WAF_THRESHOLDS_CONFIRMED", "no"));
await check("6.3B", "Cloudflare Access JWT verifier and policy config exist and are wired in index.js", async () => { await files("worker/cloudflare-access-jwt.js", "scripts/cloudflare-access-config.mjs", "docs/CLOUDFLARE_ACCESS.md"); await json("config/cloudflare-access-policy.v1.json"); has(await read("worker/index.js"), "cloudflare-access-jwt.js"); has(await read("worker/config-check.js"), "CF_ACCESS_AUD"); });
await check("6.3C", "HSTS preload check, CSP report review, Logpush config and error tracking exist", async () => { await files("scripts/hsts-preload-check.mjs", "scripts/csp-report-review.mjs", "scripts/logpush-config.mjs", "config/logpush-policy.v1.json", "worker/error-tracking.js", "worker/audit-stream.js", "docs/LOGPUSH.md", "docs/ERROR_TRACKING.md"); if (!(await exists("lummet-tenant/docs/TENANT_CSP.md", repo))) throw new Error("missing file lummet-tenant/docs/TENANT_CSP.md"); });
await check("6.3C", "CSP_MODE default is not flipped to enforce; error tracking defaults off", async () => { notOverridden("CSP_MODE", "report-only", ""); has(await read("worker/csp.js"), '"report-only"'); defaultsTo("ERROR_TRACKING", "off"); defaultsTo("ERROR_TRACKING_APPROVED", "no"); });
await check("6.3C", "tenant repo: Turnstile and CSP tests exist", async () => { for (const f of ["lummet-tenant/en/test/tenant-csp.test.js", "lummet-tenant/en/test/tenant-turnstile.test.js"]) if (!(await exists(f, repo))) throw new Error(`missing file ${f}`); });

// ---- 6.4A / 6.4B / 6.4C customer security controls
await check("6.4A", "org security policy table and org-wide 2FA enforcement; flag off", async () => { const m = await read("migrations/0072_org_security_policy.sql"); for (const x of ["organization_security_policies", "require_2fa", "require_sso", "ip_allowlist_json"]) has(m, x); has(await read("worker/customer-auth.js"), "org-security-policy"); defaultsTo("ORG_SECURITY_POLICY", "off"); });
await check("6.4B", "session list/revoke and org-scoped audit CSV exist; flags off", async () => { await files("worker/customer-sessions.js", "worker/customer-audit-csv.js", "worker/repositories/customer-sessions.js", "worker/repositories/org-audit-log.js"); defaultsTo("CUSTOMER_SESSION_ADMIN", "off"); defaultsTo("CUSTOMER_AUDIT_CSV", "off"); has(await read("worker/customer-audit-csv.js"), "csvCell"); });
await check("6.4C", "IP allowlist goes through entitlements, has lockout protection, SSO requirement is a stub; flags off", async () => { has(await read("worker/org-security-policy.js"), "security.ip_allowlist.enabled"); const s = await read("worker/org-security-policy.js"); if (!/lockout/i.test(s)) throw new Error("no lockout protection"); await files("worker/ip-allowlist.js"); defaultsTo("ORG_IP_ALLOWLIST", "off"); defaultsTo("ORG_SSO_REQUIREMENT", "off"); has(await read("worker/entitlements.js"), "security.ip_allowlist.enabled"); });

// ---- 6.5A / 6.5B / 6.5C resilience
await check("6.5A", "synthetic monitors (sign-in, checkout, canary site, domain attach) use alert-state; default off", async () => { const s = await read("worker/synthetic-monitors.js"); for (const x of ["signin", "checkout", "canary", "domain"]) if (!new RegExp(x, "i").test(s)) throw new Error(`no ${x} monitor`); await files("worker/repositories/synthetic-monitors.js", "docs/SYNTHETIC_MONITORS.md"); defaultsTo("SYNTHETIC_MONITORS", "off"); });
await check("6.5B", "six runbooks plus index, restore drill tool and report template exist", async () => { await files("docs/RUNBOOKS.md", "docs/runbooks/webhook-backlog.md", "docs/runbooks/stripe-outage.md", "docs/runbooks/d1-incident.md", "docs/runbooks/cloudflare-incident.md", "docs/runbooks/mass-email-failure.md", "docs/runbooks/mistaken-suspension.md", "docs/runbooks/restore-drill.md", "scripts/restore-drill.mjs", "docs/RESTORE_DRILL_REPORT_TEMPLATE.md"); });
await check("6.5B", "restore drill refuses production and defaults to a dry run", async () => { const s = await read("scripts/restore-drill.mjs"); if (!/production/i.test(s)) throw new Error("no production refusal"); has(s, "NOT VERIFIED"); });
await check("6.5C", "load thresholds file is valid and still unconfirmed; nightly workflow is off unless LOADTEST_NIGHTLY=on", async () => { const t = await json("config/loadtest-thresholds.v1.json"); if (t.confirmed !== false) throw new Error("thresholds confirmed flag is not false"); const w = await read(".github/workflows/nightly-loadtest.yml"); has(w, "vars.LOADTEST_NIGHTLY == 'on'"); await files("scripts/loadtest-thresholds.mjs"); });
await check("6.5C", "D1 size policy and table-move plan exist", async () => { await json("config/d1-size-policy.v1.json"); await files("scripts/d1-size-check.mjs", "docs/D1_SIZE_AND_TABLE_MOVE_PLAN.md"); });
await check("6.5C", "SOC 2 policy drafts are all labelled Draft, not approved (four now; the rest are Round 7.4A)", async () => { const dir = path.join(root, "docs/compliance/policies"); const f = (await readdir(dir)).filter((x) => x.endsWith(".md")); if (f.length !== 4) throw new Error(`expected 4 drafts, found ${f.length}`); for (const x of f) if (!(await readFile(path.join(dir, x), "utf8")).includes("Draft, not approved")) throw new Error(`${x} lacks the Draft label`); });
await check("6.5C", "pen test is registered as an open owner task", async () => { const p = await readRepo("PLACEHOLDERS.md"); if (!/\[OPEN\].*penetration/i.test(p)) throw new Error("no [OPEN] penetration test entry"); });

// ---- launch blockers stay visible
await check("6.G", "[OPEN] placeholders are still registered (the release gate must keep blocking production)", async () => { const p = await readRepo("PLACEHOLDERS.md"); if ((p.match(/\[OPEN\]/g) || []).length < 10) throw new Error("fewer [OPEN] entries than expected"); });
await check("6.G", "each Phase 6 AT label still exists in its test file (AT-1..AT-15 map)", async () => { const { AT_MAP } = await import("./phase6-at-report.mjs"); for (const e of AT_MAP) { const src = await read(e.file); const lit = e.pattern.replace(/^\^/, ""); if (!src.includes(lit)) throw new Error(`AT-${e.at}: "${lit}" not found in ${e.file}`); } });

let lastRound = "";
for (const [round, name, ok, msg] of checks) { if (round !== lastRound) { console.log(`\n[${round}]`); lastRound = round; } console.log(`${ok ? "PASS" : "FAIL"} ${name}${msg ? ": " + msg : ""}`); }
const failed = checks.filter((x) => !x[2]).length;
console.log(`\n${checks.length - failed}/${checks.length} Phase 6 static checks passed (STATIC REVIEW).`);
console.log(`\nPhase 6 done-conditions (Playbook 6.G). The release stays "production candidate" until ALL hold:
  [ ] every sprint accepted by the owner
  [ ] full suites pass on Node 22 and Node 24 (NOT RUN in this round: owner rule)
  [ ] AT-1..AT-15 green (fake provider: see scripts/phase6-at-report.mjs; Stripe test clocks and AT-15 drill are owner-run, NOT VERIFIED)
  [ ] restore report exists (docs/RESTORE_DRILL_REPORT.md): ${(await exists("docs/RESTORE_DRILL_REPORT.md")) ? "present" : "ABSENT"}
  [ ] owner has closed every blueprint section 1.3 external item
Label: PRODUCTION CANDIDATE.`);
if (failed) process.exit(1);
