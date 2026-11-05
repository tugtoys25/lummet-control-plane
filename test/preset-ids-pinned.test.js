// The tenant owns the presets (lummet-tenant en/worker/site-profile/registry.js PRESETS). This list is mirrored in worker/site-setup.js
// and anything else is refused before a tenant is called. The same pinned list is tested in the tenant repository
// (en/test/preset-ids-pinned.test.js), so a change on one side without the other fails a test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITE_PRESETS, SITE_PRESET_IDS, DEFAULT_PRESET_ID } from '../worker/site-setup.js';

const PINNED_PRESET_IDS = ['full', 'news', 'casino-list', 'casino-only', 'list-reviews', 'sportsbook', 'research', 'static'];

test('the control plane preset ids are exactly the pinned list the tenant registry is tested against', () => {
  assert.deepEqual([...SITE_PRESET_IDS].sort(), [...PINNED_PRESET_IDS].sort());
  assert.deepEqual(SITE_PRESETS.map((p) => p.id), SITE_PRESET_IDS);
  assert.ok(SITE_PRESET_IDS.includes(DEFAULT_PRESET_ID));
  for (const p of SITE_PRESETS) assert.ok(typeof p.label === 'string' && p.label.length > 0, p.id);
});
