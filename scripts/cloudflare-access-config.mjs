#!/usr/bin/env node
/** Check and render the Cloudflare Access configuration in config/cloudflare-access-policy.v1.json.
 *    node scripts/cloudflare-access-config.mjs [--strict] [--out file]
 *  Offline only: this script never calls Cloudflare and never mutates anything. The owner creates the Access
 *  application and policy in the dashboard (or their own tooling) from the rendered plan; see docs/CLOUDFLARE_ACCESS.md.
 *  Exit 0: config valid (placeholders are listed, not fatal). --strict: exit 1 while any [OPEN] placeholder remains. Exit 2: invalid config. */
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { loadConfig, validateConfig, openPlaceholders, renderPlan } from "./lib/access-policy.mjs";

export async function main(argv, env, io = { log: console.log, error: console.error }) {
  const has = (flag) => argv.includes(`--${flag}`);
  const opt = (flag) => { const index = argv.indexOf(`--${flag}`); return index >= 0 ? argv[index + 1] : null; };
  const config = loadConfig();
  const errors = validateConfig(config);
  if (errors.length) { io.error(`REFUSED: config file is invalid: ${errors.join("; ")}`); return 2; }
  const open = openPlaceholders(config);
  const report = { dryRun: true, mutates: false, callsCloudflare: false, valid: true, openPlaceholders: open, plan: renderPlan(config, env), applyBlockedBy: open.length ? ["[OPEN] owner values above are not supplied"] : [] };
  const outFile = opt("out");
  if (outFile) { await writeFile(outFile, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 }); io.log(`Report written to ${outFile}`); }
  else io.log(JSON.stringify(report, null, 2));
  return has("strict") && open.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2), process.env));
