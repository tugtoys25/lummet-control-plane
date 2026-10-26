// Phase 0.1: no error may be silently discarded on a money or access path. A swallowed Stripe failure is how an
// organization used to keep being billed after deleting itself. The ratchet starts at zero allowed entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const dir = new URL('../worker/', import.meta.url);
const PATHS = (await readdir(dir)).filter((f) => /^(billing.*|organizations|entitlements|access|plans|erasure|scheduler)\.js$/.test(f));
const SWALLOW = [/\.catch\(\s*\(\s*_?\w*\s*\)\s*=>\s*\{\s*\}\s*\)/, /\.catch\(\s*\(\s*_?\w*\s*\)\s*=>\s*null\s*\)/, /catch\s*(\(\s*_?\w*\s*\))?\s*\{\s*\}/];

test('money and access modules never swallow an error', async () => {
  assert.ok(PATHS.includes('billing.js') && PATHS.includes('access.js') && PATHS.includes('organizations.js'));
  const offenders = [];
  for (const f of PATHS) {
    const lines = (await readFile(new URL(f, dir), 'utf8')).split('\n');
    lines.forEach((l, i) => { if (!l.trim().startsWith('//') && SWALLOW.some((re) => re.test(l))) offenders.push(`worker/${f}:${i + 1}: ${l.trim()}`); });
  }
  assert.deepEqual(offenders, [], 'log it, queue it for retry, or let it fail: never discard it');
});
