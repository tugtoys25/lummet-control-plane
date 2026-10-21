// The tenant repo carries its own copy of the release tools (so its CI needs no second checkout). They must not drift.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('lummet-tenant/tools/release is an exact copy of the control plane release tools', (t) => {
  const tenantTools = join(root, '..', 'lummet-tenant', 'tools', 'release');
  if (!existsSync(tenantTools)) return t.skip('lummet-tenant is not checked out next to this repo');
  const r = spawnSync('node', ['scripts/sync-release-tools.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the publish script works with its own copy of asset-hash.js when the control plane is not next to it', async () => {
  const { mkdtempSync, cpSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'standalone-'));
  for (const f of ['publish-tenant-release.mjs', 'build-tenant-worker.mjs']) cpSync(join(root, 'scripts', f), join(dir, f));
  cpSync(join(root, 'worker', 'asset-hash.js'), join(dir, 'asset-hash.js'));
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  const r = spawnSync('node', [join(dir, 'publish-tenant-release.mjs'), '--version', '1.0.0', '--dry-run', '--skip-build', '--assets-root', join(root, 'public'), '--assets-dirs', '.'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /asset files/);
});
