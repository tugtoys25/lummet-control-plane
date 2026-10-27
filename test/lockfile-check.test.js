import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A root-only lockfile, as in releases before real lockfiles were committed.
function stubSandbox() {
  const d = mkdtempSync(path.join(tmpdir(), 'lock-'));
  mkdirSync(path.join(d, 'scripts'));
  cpSync(path.join(root, 'scripts/lockfile-check.mjs'), path.join(d, 'scripts/lockfile-check.mjs'));
  cpSync(path.join(root, 'package.json'), path.join(d, 'package.json'));
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version, devDependencies: pkg.devDependencies } } }, null, 2));
  return d;
}

test('lockfile gate clearly rejects a stub lockfile rather than treating it as complete', () => {
  const d = stubSandbox();
  try {
    const r = spawnSync(process.execPath, ['scripts/lockfile-check.mjs'], { cwd: d, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'an incomplete dependency graph must block release');
    assert.match(r.stderr, /stub lockfile|missing from packages graph/);
    assert.match(r.stderr, /regenerate-lockfiles\.mjs/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('lockfile gate accepts the checked-in lockfile', () => {
  const r = spawnSync(process.execPath, ['scripts/lockfile-check.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
