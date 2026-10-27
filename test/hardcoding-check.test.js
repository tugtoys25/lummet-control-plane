// Release 2.6.0.17: the hardcoding gate passes on the shipped tree and fails on injected breakage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runHardcodingCheck, findBrandStrings, findRealLookingIds } from '../scripts/hardcoding-check.mjs';

test('the shipped tree passes', async () => assert.deepEqual(await runHardcodingCheck(), []));
test('a brand host in code is flagged, a neutral host is not', () => {
  assert.equal(findBrandStrings('const u = "https://level.casino/en";').length, 1);
  assert.equal(findBrandStrings('tenant=freewin.xyz').length, 1);
  assert.equal(findBrandStrings('tenant=example.com').length, 0);
});
test('a real-looking resource id in the tenant template is flagged; placeholders and comments are not', () => {
  assert.equal(findRealLookingIds('"database_id": "4356b8a1-90f4-495c-ae6e-cbc8c30448d2"').length, 1);
  assert.equal(findRealLookingIds('"id": "d6b712aa06da49828e55a20f13ca106b"').length, 1);
  assert.equal(findRealLookingIds('"database_id": "REPLACE_WITH_D1_DATABASE_ID"').length, 0);
  assert.equal(findRealLookingIds('// example 4356b8a1-90f4-495c-ae6e-cbc8c30448d2').length, 0);
});
