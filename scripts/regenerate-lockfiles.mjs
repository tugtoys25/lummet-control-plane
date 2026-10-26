#!/usr/bin/env node
/** Regenerate lockfiles using npm itself; never synthesize dependency records. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [root, path.resolve(root, '../lummet-tenant'), path.resolve(root, '../lummet-tenant/en')];
for (const cwd of targets) {
  console.log(`\n==> npm install --package-lock-only --ignore-scripts --no-audit --no-fund (${path.relative(root, cwd) || '.'})`);
  const result = spawnSync('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd, stdio: 'inherit', timeout: 180000 });
  if (result.error || result.status !== 0) {
    console.error(`LOCKFILE REGENERATION FAILED in ${cwd}: ${result.error?.message || `npm exited ${result.status}`}`);
    console.error('Do not hand-edit or fake package-lock.json. Restore network/registry access, rerun this script, then run lockfile-check and npm ci in all three roots.');
    process.exit(1);
  }
}
const check = spawnSync(process.execPath, [path.join(root, 'scripts/lockfile-check.mjs')], { cwd: root, stdio: 'inherit' });
if (check.status !== 0) process.exit(check.status || 1);
console.log('\nLockfiles regenerated and structurally verified. Next run `npm ci` in each package root.');
