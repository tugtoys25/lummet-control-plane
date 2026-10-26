#!/usr/bin/env node
/** Offline structural gate for Phase F; intentionally reports registry/owner dependencies as partial. */
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checks = [];
async function text(file) { return readFile(path.join(root, file), 'utf8'); }
async function check(name, fn) { try { const result = await fn(); checks.push({ name, ok: result === true, detail: result === true ? 'ok' : String(result) }); } catch (e) { checks.push({ name, ok: false, detail: e.message }); } }
await check('control-plane package version is 2.6.0', async () => JSON.parse(await text('package.json')).version === '2.6.0');
await check('lockfile checker rejects current stub and explains npm regeneration', async () => {
  const checker = await text('scripts/lockfile-check.mjs'); const regen = await text('scripts/regenerate-lockfiles.mjs');
  return checker.includes('stub lockfile') && checker.includes('Do not hand-write lockfiles') && regen.includes('npm') && regen.includes('--package-lock-only');
});
await check('test runner fails on forced exits unless allow-listed', async () => { const s = await text('scripts/test-by-file.mjs'); return s.includes('TEST_FORCE_EXIT_ALLOWLIST') && s.includes('!forced || allowlisted') && s.includes('FORCED_EXIT'); });
await check('email integration test uses a fake provider fetch', async () => (await text('test/email.test.js')).includes("EMAIL_FETCH: async () => new Response"));
await check('route integration tests cover invitation modes, tenant boundary, replay, provider/DB failure and rate limit', async () => {
  const s = await text('test/phase-f-route-integration.test.js');
  return ['BILLING_ENFORCE', 'shadow records', 'cross-organization', 'single-use', 'provider failure', 'database write failure', 'rate-limits', 'usage snapshot GET is read-only'].every(x => s.includes(x));
});
await check('usage GET is read-only and daily scheduler captures snapshots', async () => { const s = await text('worker/index.js'); return s.includes('GET is read-only') && s.includes('captureDailyUsageSnapshots(env)') && s.includes('usage_snapshots_completed'); });
await check('AT-1 through AT-15 evidence slots include Phase 6 AT-14/AT-15', async () => { const s = await text('docs/GO_LIVE_RECORD.md'); return Array.from({length:15},(_,i)=>i+1).every(n => new RegExp(`AT-${n}\\b`).test(s)) && /AT-14[^\n]*Phase 6/i.test(s) && /AT-15[^\n]*Phase 6/i.test(s); });
await check('release gate blocks owner and open placeholders', async () => { const s = await text('scripts/check-release-owner.mjs'); const pkg = await text('scripts/package-phase.mjs'); return s.includes('@OWNER') && s.includes('[OPEN]') && pkg.includes('check-release-owner.mjs'); });
await check('CI workflows declare Node 22/24 and npm ci', async () => {
  const cp = await text('.github/workflows/ci.yml'); const tenant = await readFile(path.resolve(root, '../lummet-tenant/.github/workflows/test.yml'), 'utf8');
  return cp.includes('node-version: [22, 24]') && tenant.includes('node-version: [22, 24]') && cp.includes('npm ci') && tenant.includes('npm ci');
});
await check('owner source exists and remains deliberately unconfigured', async () => { const c = JSON.parse(await text('docs/release-owner.json')); return c.owner === '' && c.status === 'OWNER_INPUT_REQUIRED'; });
let failed = 0;
for (const c of checks) { console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.ok ? '' : ` — ${c.detail}`}`); if (!c.ok) failed++; }
console.log(`PHASE_F_GATE checks=${checks.length} passed=${checks.length-failed} failed=${failed} status=${failed?'FAIL':'PASS_WITH_EXTERNAL_BLOCKERS'}`);
console.log('EXTERNAL_BLOCKERS: npm registry access is required for complete lockfiles; real GitHub owner/team and resolution of every [OPEN] placeholder are owner-dependent.');
if (failed) process.exit(1);
