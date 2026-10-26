import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function run(script, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, ...env }
  });
}
test('webhook planner is dry-run by default and declares the blueprint event set', () => {
  const r = run('scripts/stripe-webhook-config.mjs', ['--mode', 'test']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dryRun, true);
  assert.equal(j.eventCount, 24);
  assert.ok(j.events.includes('invoice.payment_failed'));
  assert.ok(j.events.includes('charge.dispute.closed'));
});
test('webhook endpoint verifier refuses unknown or mismatched mode before network access', () => {
  const r = run('scripts/stripe-config-verify.mjs', ['--mode', 'live'], { STRIPE_SECRET_KEY: 'sk_test_placeholder' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /REFUSED/);
});
test('clock suite is a no-network dry run unless --execute is explicit', () => {
  const r = run('scripts/stripe-clock-suite.mjs');
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dryRun, true);
  assert.equal(j.network, false);
  assert.equal(j.mutations, false);
  assert.equal(j.scenarios.length, 11);
});
test('phase 4 static gate passes without claiming staging/live verification', () => {
  const r = run('scripts/phase4-gate.mjs');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Staging and live evidence NOT checked/);
});
test('go-live evidence evaluator never promotes an unchecked record', () => {
  const r = run('scripts/go-live-evidence.mjs');
  assert.equal(r.status, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.status, 'NOT APPROVED');
  assert.ok(j.open > 0);
  assert.equal(j.authorization, 'This script never approves or authorizes live charges.');
});
test('production hygiene is disabled by default and can be explicitly enabled', () => {
  const r = run('scripts/production-hygiene.mjs', [], { ENFORCE_PRODUCTION_HYGIENE: 'off' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SKIP production hygiene/);
});
test('enabled production hygiene flags unresolved CODEOWNERS placeholder', () => {
  const r = run('scripts/production-hygiene.mjs', [], { ENFORCE_PRODUCTION_HYGIENE: 'on' });
  assert.equal(r.status, 1);
  assert.match(r.stdout + r.stderr, /CODEOWNERS/);
});
test('code owner file explicitly identifies its placeholder', () => {
  const s = readFileSync(path.join(root, '.github/CODEOWNERS'), 'utf8');
  assert.match(s, /TEMPLATE ONLY/);
  assert.match(s, /@OWNER/);
});
