// Round 6.G: the Phase 6 gate passes on the package as shipped, and it fails when a deliverable or a safe default is broken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const run = (cwd) => spawnSync(process.execPath, ['scripts/phase6-gate.mjs'], { cwd, encoding: 'utf8', timeout: 60000 });

test('phase6-gate passes on the shipped package and still labels the release a production candidate', () => {
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Phase 6 static checks passed \(STATIC REVIEW\)/);
  assert.match(r.stdout, /PRODUCTION CANDIDATE/);
});

test('phase6-gate fails when thresholds are marked confirmed, a policy loses its Draft label, or a deliverable is missing', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'p6gate-'));
  try {
    const cp = path.join(tmp, 'lummet-control-plane');
    for (const d of ['scripts', 'worker', 'config', 'docs', 'migrations', 'public', 'test', '.github']) cp_(root, cp, d);
    for (const f of ['package.json', 'wrangler.jsonc']) cpSync(path.join(root, f), path.join(cp, f));
    cpSync(path.join(root, '..', 'RELEASE_ID'), path.join(tmp, 'RELEASE_ID'));
    cpSync(path.join(root, '..', 'PLACEHOLDERS.md'), path.join(tmp, 'PLACEHOLDERS.md'));
    cpSync(path.join(root, '..', 'lummet-tenant', 'docs', 'TENANT_CSP.md'), path.join(tmp, 'lummet-tenant', 'docs', 'TENANT_CSP.md'), { recursive: true });
    for (const f of ['tenant-csp.test.js', 'tenant-turnstile.test.js']) cpSync(path.join(root, '..', 'lummet-tenant', 'en', 'test', f), path.join(tmp, 'lummet-tenant', 'en', 'test', f), { recursive: true });
    assert.equal(run(cp).status, 0, 'the copy passes before it is broken');

    const t = path.join(cp, 'config/loadtest-thresholds.v1.json');
    writeFileSync(t, readFileSync(t, 'utf8').replace('"confirmed": false', '"confirmed": true'));
    let r = run(cp); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL .*thresholds file is valid and still unconfirmed/);
    writeFileSync(t, readFileSync(t, 'utf8').replace('"confirmed": true', '"confirmed": false'));

    const pol = path.join(cp, 'docs/compliance/policies/access-control.md');
    writeFileSync(pol, readFileSync(pol, 'utf8').replaceAll('Draft, not approved', 'Approved'));
    r = run(cp); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL .*SOC 2 policy drafts/);
    writeFileSync(pol, readFileSync(pol, 'utf8').replaceAll('Approved', 'Draft, not approved'));

    rmSync(path.join(cp, 'worker/rate-limit-response.js'));
    r = run(cp); assert.equal(r.status, 1); assert.match(r.stdout, /FAIL .*WAF rate-limit config/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
function cp_(from, to, d) { cpSync(path.join(from, d), path.join(to, d), { recursive: true }); }
