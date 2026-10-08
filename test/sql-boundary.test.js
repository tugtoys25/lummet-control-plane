// Roadmap 2.6: the repository boundary. SQL may only move INTO worker/repositories/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { countSql } from '../scripts/sql-ratchet.mjs';

const baseline = JSON.parse(await readFile(new URL('../docs/sql-baseline.json', import.meta.url), 'utf8'));

test('no file gains direct SQL, and no new file outside worker/repositories contains any', async () => {
  const now = await countSql();
  const problems = [];
  for (const [file, n] of Object.entries(now)) {
    const allowed = baseline.files[file] ?? 0;
    if (n > allowed) problems.push(`${file}: ${n} direct SQL calls (baseline ${allowed}). Put the query in worker/repositories/ instead.`);
  }
  assert.deepEqual(problems, []);
});

test('the baseline is not stale: after converting SQL, lower it with `node scripts/sql-ratchet.mjs --update`', async () => {
  const now = await countSql();
  const stale = Object.entries(baseline.files).filter(([f, n]) => (now[f] ?? 0) < n).map(([f, n]) => `${f}: baseline ${n}, now ${now[f] ?? 0}`);
  assert.deepEqual(stale, [], 'good news: you removed SQL. Record it so it cannot creep back.');
});

test('converted modules have no direct SQL left', async () => {
  const now = await countSql();
  for (const f of ['worker/alerts.js', 'worker/sso-domains.js']) assert.equal(now[f] ?? 0, 0, f);
});

test('repositories depend only on each other, never on business modules (the boundary points one way)', async () => {
  const dir = new URL('../worker/repositories/', import.meta.url);
  for (const f of (await readdir(dir)).filter((x) => x.endsWith('.js'))) {
    const src = await readFile(new URL(f, dir), 'utf8');
    for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
      assert.match(m[1], /^\.\/[a-z-]+\.js$/, `${f} imports ${m[1]}`);
    }
  }
});

test('repository functions return plain data, not statements', async () => {
  const coupons = await import('../worker/repositories/coupons.js');
  for (const name of ['findActiveByCode', 'list', 'insert', 'update', 'addRedemption']) assert.equal(typeof coupons[name], 'function', name);
});
