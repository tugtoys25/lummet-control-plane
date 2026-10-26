import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
test('lockfile gate clearly rejects the checked-in stub rather than treating it as complete', () => {
  const r = spawnSync(process.execPath, ['scripts/lockfile-check.mjs'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'the known incomplete dependency graph must block release');
  assert.match(r.stderr, /stub lockfile|missing from packages graph/);
  assert.match(r.stderr, /regenerate-lockfiles\.mjs/);
});
