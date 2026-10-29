#!/usr/bin/env node
// Post-deploy smoke: /api/health must be 200 and / must not be a 5xx. A freshly deployed Worker can answer its very first
// requests slowly or with a 5xx while isolates warm up, so each URL gets a few attempts before the deploy is failed.
const base = process.env.STAGING_BASE_URL;
if (!base) { console.error("STAGING_BASE_URL is required"); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function check(path) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    let status = 0;
    try { status = (await fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(15000) })).status; } catch { status = 0; }
    console.log(`${path} HTTP ${status} (attempt ${attempt})`);
    if (path === "/api/health" ? status === 200 : status > 0 && status < 500) return true;
    if (attempt < 4) await sleep(3000 * attempt);
  }
  return false;
}
let ok = true;
for (const path of ["/api/health", "/"]) ok = (await check(path)) && ok;
if (!ok) process.exitCode = 1;
