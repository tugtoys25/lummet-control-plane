#!/usr/bin/env node
/** Verify complete, package-consistent npm lockfiles. This never writes lockfiles. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const targets = [['lummet-control-plane', path.join(root, 'package.json'), path.join(root, 'package-lock.json')]];
let failed = false;
for (const [label, pkgPath, lockPath] of targets) {
  let pkg, lock;
  try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')); lock = JSON.parse(await readFile(lockPath, 'utf8')); }
  catch (e) { console.error(`LOCKFILE FAIL ${label}: cannot read package/lockfile (${e.message})`); failed = true; continue; }
  const problems = [];
  if (pkg.name !== lock.name) problems.push(`name mismatch (${pkg.name} vs ${lock.name})`);
  if (pkg.version !== lock.version || pkg.version !== lock.packages?.['']?.version) problems.push(`version drift (package=${pkg.version}, lock=${lock.version}, root=${lock.packages?.['']?.version})`);
  if (lock.lockfileVersion !== 3) problems.push(`lockfileVersion must be 3, got ${lock.lockfileVersion}`);
  const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
  const entries = lock.packages || {};
  for (const [name, version] of Object.entries(declared)) {
    const entry = entries[`node_modules/${name}`];
    if (!entry) { problems.push(`declared dependency ${name}@${version} is missing from packages graph`); continue; }
    if (entry.version !== version && !String(version).startsWith('^') && !String(version).startsWith('~')) problems.push(`${name} version mismatch (package=${version}, lock=${entry.version})`);
    if (!entry.resolved && !entry.link) problems.push(`${name} has no resolved artifact URL; lockfile graph is incomplete`);
  }
  if (Object.keys(declared).length && Object.keys(entries).length <= 1) problems.push('stub lockfile: packages graph contains only the root package');
  if (problems.length) { console.error(`LOCKFILE FAIL ${label}:\n- ${problems.join('\n- ')}`); failed = true; }
  else console.log(`LOCKFILE PASS ${label}: package metadata and declared dependency graph are consistent (${Object.keys(entries).length} package entries).`);
}
if (failed) {
  console.error('Run `node scripts/regenerate-lockfiles.mjs` with npm registry access, then rerun this gate and `npm ci` in this package root. Do not hand-write lockfiles.');
  process.exit(1);
}
