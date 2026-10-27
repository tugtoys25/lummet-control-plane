// The packaging script's refusal cases, run on a throwaway copy of the repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, appendFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repo = path.resolve(new URL('..', import.meta.url).pathname);
function sandbox() {
  const d = mkdtempSync(path.join(tmpdir(), 'pkg-'));
  for (const n of ['scripts', 'migrations', 'docs/phase-baseline.json', 'package.json', 'package-lock.json', 'worker']) { const dest = path.join(d, n); cpSync(path.join(repo, n), dest, { recursive: true }); }
  return d;
}
const run = (d, ...a) => spawnSync(process.execPath, ['scripts/package-phase.mjs', '--skip-tests', '--development-check', ...a], { cwd: d, encoding: 'utf8' });
const runRelease = (d, ...a) => spawnSync(process.execPath, ['scripts/package-phase.mjs', '--skip-tests', ...a], { cwd: d, encoding: 'utf8' });
const pkgVersion = () => JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version;

test('package-phase: builds, stamps a --skip-tests build NOT RELEASABLE, writes manifest and checksums', () => {
  const d = sandbox(); try {
    const r = run(d, '--phase', '1', '--version', pkgVersion());
    assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /NOT RELEASABLE/);
    const m = JSON.parse(readFileSync(path.join(d, 'dist/phase-1/MANIFEST.json'), 'utf8'));
    assert.equal(m.releasable, false); assert.deepEqual(m.newMigrations.slice(0, 3), ['0048_scheduler_heartbeat.sql', '0049_billing_lifecycle.sql', '0050_cancel_pending_and_trial_fingerprints.sql']);
    assert.ok(existsSync(path.join(d, 'dist/phase-1/SHA256SUMS')) && existsSync(path.join(d, 'dist/phase-1/REPORT.md')));
  } finally { rmSync(d, { recursive: true, force: true }); }
});
test('package-phase refuses: wrong version, modified shipped migration, deleted migration, non-consecutive migration, secret', () => {
  const d = sandbox(); try {
    assert.match(run(d, '--phase', '1', '--version', '9.9.9').stderr, /version/);
    appendFileSync(path.join(d, 'migrations/0001_control_plane.sql'), '\n-- tampered\n');
    assert.match(run(d, '--phase', '1', '--version', pkgVersion()).stderr, /modified/);
    rmSync(path.join(d, 'migrations/0001_control_plane.sql')); assert.match(run(d, '--phase', '1', '--version', pkgVersion()).stderr, /deleted/);
  } finally { rmSync(d, { recursive: true, force: true }); }
  const e = sandbox(); try {
    writeFileSync(path.join(e, 'migrations/0060_gap.sql'), 'SELECT 1;'); assert.match(run(e, '--phase', '1', '--version', pkgVersion()).stderr, /consecutive/);
    rmSync(path.join(e, 'migrations/0060_gap.sql'));
    writeFileSync(path.join(e, 'worker/leak.js'), 'const k = "sk_live_' + 'abcdefghijklmnopqrstuvwxyz0123";'); assert.match(run(e, '--phase', '1', '--version', pkgVersion()).stderr, /secret/);
  } finally { rmSync(e, { recursive: true, force: true }); }
});

test('package-phase never packages .wrangler (local cache with the Cloudflare account id and a built bundle)', () => {
  const d = sandbox();
  try {
    mkdirSync(path.join(d, '.wrangler/cache'), { recursive: true });
    writeFileSync(path.join(d, '.wrangler/cache/wrangler-account.json'), '{"account":{"id":"x","name":"y"}}');
    const r = run(d, '--phase', '1', '--version', pkgVersion()); assert.equal(r.status, 0, r.stderr);
    const m = JSON.parse(readFileSync(path.join(d, 'dist/phase-1/MANIFEST.json'), 'utf8'));
    const list = spawnSync('unzip', ['-Z1', path.join(d, 'dist/phase-1', m.zip.name)], { encoding: 'utf8' }).stdout;
    assert.ok(list.includes('package.json') && !/\.wrangler/.test(list));
  } finally { rmSync(d, { recursive: true, force: true }); }
});


test('release package gate refuses a root-only lockfile with actionable guidance', () => {
  const d = sandbox(); try {
    const pkg = JSON.parse(readFileSync(path.join(d, 'package.json'), 'utf8'));
    writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version, devDependencies: pkg.devDependencies } } }, null, 2));
    const r = runRelease(d, '--phase', '1', '--version', pkgVersion());
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /stub lockfile/);
    assert.match(r.stderr, /regenerate-lockfiles\.mjs/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
