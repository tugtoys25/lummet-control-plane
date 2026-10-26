#!/usr/bin/env node
// Checks the control plane's configuration BEFORE you deploy.
//
//   node scripts/check-config.mjs                 offline: wrangler.jsonc vars + .dev.vars + process environment
//   node scripts/check-config.mjs --config wrangler.example.jsonc   check another wrangler file
//   node scripts/check-config.mjs --online        also asks Cloudflare whether CF_API_TOKEN can do what custom domains need
//
// Prints NAMES of missing/invalid settings and what each would break, never values. Exit code 1 when anything that
// blocks production is missing.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configIssues } from "../worker/config-check.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const online = process.argv.includes("--online");
const staging = process.argv.includes("--staging");

function parseJsonc(text) {
  // strip // comments that are not inside strings
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { out += c; if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

async function readOptional(file) { try { return await readFile(path.join(root, file), "utf8"); } catch { return null; } }

const env = {};
// --config <file> checks another wrangler file (the tests check the template, wrangler.example.jsonc, so they do not
// depend on your real wrangler.jsonc).
const configFlag = process.argv.indexOf("--config");
const configFile = configFlag > -1 && process.argv[configFlag + 1] ? process.argv[configFlag + 1] : "wrangler.jsonc";
const wrangler = parseJsonc(await readFile(path.join(root, configFile), "utf8"));
Object.assign(env, staging ? (wrangler.env?.staging?.vars || {}) : (wrangler.vars || {}));
const devVars = await readOptional(".dev.vars");
if (devVars) for (const line of devVars.split("\n")) { const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/); if (m && m[2].trim()) env[m[1]] = m[2].trim(); }
for (const k of Object.keys(process.env)) if (/^[A-Z][A-Z0-9_]+$/.test(k) && process.env[k]) env[k] ??= process.env[k];

const problems = [];
const warn = [];
if (!staging) for (const i of configIssues({ ...env, ENVIRONMENT: "production" })) problems.push(`${i.key}: ${i.impact}`);
if (staging && wrangler.env?.staging?.d1_databases?.[0]?.database_id === "00000000-0000-0000-0000-000000000001") problems.push("STAGING_D1_DATABASE_ID is not configured; staging must use a separate D1 database");
if (staging && !/^sk_test_/.test(String(process.env.STAGING_STRIPE_SECRET_KEY || ""))) problems.push("STAGING_STRIPE_SECRET_KEY must be provided as a Stripe test-mode secret to CI");
if (staging && !/^whsec_/.test(String(process.env.STAGING_STRIPE_WEBHOOK_SECRET || ""))) problems.push("STAGING_STRIPE_WEBHOOK_SECRET must be provided as a Stripe test-mode webhook secret to CI");

const dbId = wrangler.d1_databases?.[0]?.database_id;
if (!dbId || /^0+(-0+)*$/.test(dbId) || /[<>]/.test(dbId)) problems.push("wrangler.jsonc d1_databases[0].database_id is still the placeholder: nothing can be stored");
for (const [key, label] of [["PORTAL_BASE_URL", "app.example.com"], ["PLATFORM_DOMAIN_SUFFIX", "example.com"], ["WEBAUTHN_RP_ID", "example.com"], ["EMAIL_FROM", "example.com"]]) {
  if (String(env[key] || "").includes(label)) problems.push(`${key} still has the sample value (${label}); replace it with your real one`);
}
if (!env.PLATFORM_DOMAIN_SUFFIX) problems.push("PLATFORM_DOMAIN_SUFFIX is not set: customer sites get the default sites.lummet.app address");
const portalHost = (() => { try { return new URL(env.PORTAL_BASE_URL).hostname; } catch { return ""; } })();
if (env.WEBAUTHN_RP_ID && portalHost && !portalHost.endsWith(env.WEBAUTHN_RP_ID)) problems.push("WEBAUTHN_RP_ID must be PORTAL_BASE_URL's host or a parent of it, or passkeys fail");
for (const k of ["DOMAIN_NS_PENDING_DAYS", "DOMAIN_NS_REMINDER_HOURS", "DOMAIN_ACTIVATION_CHECK_MINUTES", "DOMAIN_ATTACH_GIVE_UP_HOURS", "DOMAIN_MANUAL_CHECK_SECONDS"]) {
  if (env[k] !== undefined && !(Number(env[k]) > 0)) warn.push(`${k}=${env[k]} is not a positive number; the default is used`);
}

if (env.SUBDOMAIN_CNAME_FLOW && !["on", "off"].includes(String(env.SUBDOMAIN_CNAME_FLOW).toLowerCase())) warn.push("SUBDOMAIN_CNAME_FLOW should be \"on\" or \"off\"; anything else counts as on");
if (env.PLATFORM_CNAME_TARGET && !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(env.PLATFORM_CNAME_TARGET)) problems.push("PLATFORM_CNAME_TARGET must be a hostname such as customers.sites.example.com");

if (online) {
  const api = async (p) => {
    const r = await fetch(`https://api.cloudflare.com/client/v4${p}`, { headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` } });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  if (!env.CF_API_TOKEN) problems.push("--online needs CF_API_TOKEN");
  else {
    const v = await api("/user/tokens/verify");
    if (!v.body.success) problems.push("CF_API_TOKEN is not valid (Cloudflare rejected it)");
    else {
      const checks = [
        [`/zones/${env.CF_ZONE_ID}`, "read the platform zone (CF_ZONE_ID)"],
        [`/zones?account.id=${env.CF_ACCOUNT_ID}&per_page=1`, "list zones in the account (Zone: Read; needed to create customer zones)"],
        [`/accounts/${env.CF_ACCOUNT_ID}/workers/domains`, "list Workers custom domains (Account > Workers Scripts)"],
        [`/zones/${env.CF_ZONE_ID}/dns_records?per_page=1`, "read DNS records (Zone > DNS)"]
      ];
      for (const [p, what] of checks) { const r = await api(p); if (!r.body.success) problems.push(`token cannot ${what}: HTTP ${r.status}`); }
      const fo = await api(`/zones/${env.CF_ZONE_ID}/custom_hostnames/fallback_origin`);
      if (!fo.body.success) warn.push("Single subdomains need Cloudflare for SaaS and a fallback origin on the platform zone (node scripts/setup-custom-hostnames.mjs). Not available yet; adding a subdomain is refused until it is.");
      else if (fo.body.result?.status !== "active") warn.push(`The SaaS fallback origin is ${fo.body.result?.origin || "unset"} with status "${fo.body.result?.status}"; subdomains are refused until it is active.`);
      warn.push("Creating zones needs Zone > Zone: Edit; that permission cannot be tested without creating a zone. docs/CUSTOM_DOMAINS.md has the staging test.");
    }
  }
}

for (const w of warn) console.log(`note   ${w}`);
for (const p of problems) console.log(`MISSING ${p}`);
console.log(problems.length ? `\n${problems.length} problem(s) found.` : "\nConfiguration looks complete.");
process.exit(problems.length ? 1 : 0);
