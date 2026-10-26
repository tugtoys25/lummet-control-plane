import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function fixture(owner, codeowners = '/worker/billing.js @OWNER\n', placeholders = '# Placeholders\n') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lummet-owner-gate-'));
  await mkdir(path.join(root, 'docs'), { recursive: true }); await mkdir(path.join(root, '.github'), { recursive: true });
  await writeFile(path.join(root, 'docs/release-owner.json'), JSON.stringify({ owner, sourceOfTruth: 'docs/release-owner.json', status: owner ? 'CONFIGURED' : 'OWNER_INPUT_REQUIRED' }));
  await writeFile(path.join(root, 'docs/PLACEHOLDERS.md'), placeholders);
  await writeFile(path.join(root, '.github/CODEOWNERS'), codeowners);
  return root;
}
function run(root, ...args) { return spawnSync(process.execPath, [path.join(repo, 'scripts/check-release-owner.mjs'), '--root', root, ...args], { encoding: 'utf8' }); }
test('release owner gate rejects missing owner with an actionable message', async (t) => {
  const root = await fixture(''); t.after(() => rm(root, { recursive: true, force: true }));
  const r = run(root, '--owner-only'); assert.notEqual(r.status, 0); assert.match(r.stderr, /owner is empty or invalid/);
});
test('valid owner generates and passes static CODEOWNERS validation without inventing an identity', async (t) => {
  const root = await fixture('@acme/platform'); t.after(() => rm(root, { recursive: true, force: true }));
  const generated = run(root, '--generate'); assert.equal(generated.status, 0, generated.stderr);
  const codeowners = await readFile(path.join(root, '.github/CODEOWNERS'), 'utf8'); assert.match(codeowners, /@acme\/platform/); assert.doesNotMatch(codeowners, /@OWNER/);
  const checked = run(root, '--owner-only'); assert.equal(checked.status, 0, checked.stderr);
});
test('full release gate still blocks when any launch placeholder remains open', async (t) => {
  const root = await fixture('@acme/platform', '/worker/billing.js @acme/platform\n', '# Placeholders\n- [OPEN] Legal review\n'); t.after(() => rm(root, { recursive: true, force: true }));
  const r = run(root); assert.notEqual(r.status, 0); assert.match(r.stderr, /\[OPEN\] launch placeholder/);
});
