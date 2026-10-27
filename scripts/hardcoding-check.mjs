#!/usr/bin/env node
// Static hardcoding gate (release 2.6.0.17). Fails when:
//   - a known brand host appears anywhere under worker/ (the platform must not name a specific customer site in code),
//   - worker/public-brands.js exists again (the dead hardcoded brand list was removed),
//   - the tenant deployment TEMPLATE (lummet-tenant/wrangler.example.jsonc) is missing or holds a real-looking resource id.
// It is a denylist of names this codebase has already carried, not proof that no tenant-specific string exists anywhere.
//   node scripts/hardcoding-check.mjs
import { readdir, readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BRAND_PATTERN = /level\.casino|neuroodds|cluster\.casino|legendodds|brilliantodds|freewin\.xyz|freewin\.(com|net)\b/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const HEX32 = /\b[0-9a-f]{32}\b/i;

export function findBrandStrings(text) {
  const hits = [];
  text.split("\n").forEach((line, i) => { if (BRAND_PATTERN.test(line)) hits.push({ line: i + 1, text: line.trim().slice(0, 120) }); });
  return hits;
}
export function findRealLookingIds(text) {
  return text.split("\n").map((l, i) => ({ line: i + 1, text: l.trim() })).filter((x) => !x.text.startsWith("//") && (UUID.test(x.text) || HEX32.test(x.text)));
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out); else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}

export async function runHardcodingCheck() {
  const problems = [];
  for (const file of await walk(path.join(root, "worker"))) {
    for (const h of findBrandStrings(await readFile(file, "utf8"))) problems.push(`${path.relative(root, file)}:${h.line} names a specific brand: ${h.text}`);
  }
  try { await access(path.join(root, "worker/public-brands.js")); problems.push("worker/public-brands.js exists again (it was removed as dead code)"); } catch { /* absent is the expected state */ }
  const examplePath = path.resolve(root, "../lummet-tenant/wrangler.example.jsonc");
  let example = null;
  try { example = await readFile(examplePath, "utf8"); } catch { problems.push("lummet-tenant/wrangler.example.jsonc is missing"); }
  if (example !== null) {
    if (!example.includes("REPLACE_WITH_D1_DATABASE_ID")) problems.push("tenant template does not use a REPLACE_WITH_ placeholder for the D1 database id");
    for (const h of findRealLookingIds(example)) problems.push(`tenant template holds a real-looking resource id at line ${h.line}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = await runHardcodingCheck();
  if (problems.length) { console.error("HARDCODING CHECK FAILED:\n- " + problems.join("\n- ")); process.exit(1); }
  console.log("HARDCODING CHECK PASSED (STATIC REVIEW): no known brand host under worker/, no hardcoded brand list, tenant template uses placeholders.");
}
