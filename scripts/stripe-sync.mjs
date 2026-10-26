#!/usr/bin/env node
// =====================================================
// STRIPE CATALOG SYNC (Phase 3, sprint 3.1)
//
// Makes Stripe and the control-plane database agree with catalog/plans.v1.json. Finds or creates products (by a fixed
// id) and prices (by lookup key), never edits a price, and records the result in plan_prices.
//
//   node scripts/stripe-sync.mjs --offline                         validate the catalog only (no keys, no network)
//   node scripts/stripe-sync.mjs --mode test --db <d1-name> [--remote]            DRY RUN: read Stripe and the database, change nothing
//   node scripts/stripe-sync.mjs --mode test --db <d1-name> [--remote] --apply    create in Stripe, then write plan_prices
//   options: --catalog <file> (default catalog/plans.v1.json)   --sql-out <file> (keep the SQL it ran)
//
// The Stripe key is read from STRIPE_SECRET_KEY (never from the command line). --mode must equal the key's mode
// (sk_test_/rk_test_ = test, sk_live_/rk_live_ = live), otherwise the script refuses before any call.
// Exit code: 0 clean, 1 conflicts or failure, 2 usage error.
// =====================================================
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSync, modeOfKey } from "./stripe-sync-lib.mjs";
import { validateCatalog, catalogPrices } from "../worker/catalog.js";
import { stripeRequest } from "../worker/billing-stripe.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (k) => argv.includes(`--${k}`);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null; };
const usage = (m) => { console.error(`${m}\nUsage: node scripts/stripe-sync.mjs (--offline | --mode test|live --db <d1-name> [--remote] [--apply] [--sql-out file]) [--catalog file]`); process.exit(2); };

const catalogPath = resolve(root, opt("catalog") || "catalog/plans.v1.json");
let catalog;
try { catalog = JSON.parse(readFileSync(catalogPath, "utf8")); } catch (e) { usage(`cannot read the catalog ${catalogPath}: ${e.message}`); }

const problems = validateCatalog(catalog);
if (problems.length) { console.error(`CATALOG INVALID (${problems.length}):\n - ${problems.join("\n - ")}`); process.exit(1); }
const prices = catalogPrices(catalog);

if (flag("offline")) {
  console.log(`Catalog v${catalog.catalog_version} is valid: ${catalog.products.length} products, ${catalog.plans.length} plans, ${prices.length} prices (${prices.filter((p) => p.active).length} active).`);
  process.exit(0);
}

const mode = opt("mode");
if (!["test", "live"].includes(mode)) usage("--mode test|live is required");
const keyMode = modeOfKey(process.env.STRIPE_SECRET_KEY);
if (!keyMode) usage("STRIPE_SECRET_KEY is not set to an sk_/rk_ test or live key");
if (keyMode !== mode) { console.error(`REFUSED: --mode ${mode} but STRIPE_SECRET_KEY is a ${keyMode}-mode key.`); process.exit(1); }
const dbName = opt("db");
if (!dbName) usage("--db <d1-database-name> is required (existing prices are read first so a price in use is adopted, never duplicated)");
const remote = flag("remote");
const apply = flag("apply");

function d1Query(sql) {
  const out = execFileSync("wrangler", ["d1", "execute", dbName, "--command", sql, "--json", remote ? "--remote" : "--local"], { encoding: "utf8" });
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return parsed[0]?.results || [];
}
function d1Exec(sql) {
  const dir = mkdtempSync(join(tmpdir(), "stripe-sync-"));
  try {
    const f = join(dir, "sync.sql");
    writeFileSync(f, sql);
    execFileSync("wrangler", ["d1", "execute", dbName, "--file", f, remote ? "--remote" : "--local"], { stdio: "inherit" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const env = { STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY, STRIPE_API_VERSION: process.env.STRIPE_API_VERSION, STRIPE_RETRY_BASE_MS: process.env.STRIPE_RETRY_BASE_MS };
const stripe = (method, path, params, o) => stripeRequest(env, method, path, params, o);

const result = await runSync({
  catalog, mode, stripe, apply,
  db: { query: async (sql) => d1Query(sql), exec: async (sql) => d1Exec(sql) },
  operator: process.env.GITHUB_ACTOR || process.env.USER || "unknown"
}).catch((e) => ({ ok: false, stage: "error", problems: [e?.message || String(e)] }));

const plan = result.plan;
if (plan) {
  const tally = {};
  for (const a of plan.actions) tally[a.kind] = (tally[a.kind] || 0) + 1;
  console.log(`${apply ? "APPLIED" : "DRY RUN"} (${mode}, catalog v${catalog.catalog_version}):`, JSON.stringify(tally));
  for (const a of plan.actions.filter((x) => x.kind !== "ok" && x.kind !== "skip_inactive")) console.log(`  ${a.kind}: ${a.lookupKey || a.stripeProductId}${a.replaces ? ` (replaces never-used ${a.replaces})` : ""}`);
}
if (result.problems) console.error(`FAILED at ${result.stage}:\n - ${result.problems.join("\n - ")}`);
if (plan?.conflicts?.length) {
  console.error(`CONFLICTS (${plan.conflicts.length}); nothing was written:`);
  for (const c of plan.conflicts) console.error(`  [${c.kind}] ${c.lookupKey}: ${c.message}`);
}
if (result.sql && opt("sql-out")) { writeFileSync(resolve(opt("sql-out")), result.sql); console.log(`SQL written to ${opt("sql-out")}`); }
if (!result.ok) process.exit(1);
if (!apply) console.log("Dry run only. Nothing was changed in Stripe or the database. Re-run with --apply to proceed.");
