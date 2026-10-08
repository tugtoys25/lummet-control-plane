// test/newsroom-taxonomy-resources.test.js
//
// Structural checks for the four new Newsroom Taxonomy resource
// configs added to resources.js, plus a cross-repo drift check
// against the tenant's actual worker/database/newsroom-taxonomy.js
// KINDS map (imported directly, same sibling-repo convention as
// test/super-api-hmac.test.js — skips gracefully if the tenant repo
// isn't checked out alongside this one).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getResourceConfig } from '../worker/resources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOURCE_KEYS = ['newsroom-sections', 'newsroom-topics', 'newsroom-entities', 'newsroom-series'];

describe('Newsroom Taxonomy resource configs — structural', () => {
  for (const key of RESOURCE_KEYS) {
    test(`${key}: config exists, has a name field, and only fields with a type`, () => {
      const config = getResourceConfig(key);
      assert.ok(config, `expected a RESOURCES entry for "${key}"`);
      assert.equal(config.idField, 'id');
      assert.equal(config.supportsCreate, true);
      assert.ok(config.fields.some(f => f.name === 'name' && f.required === true));
      for (const field of config.fields) {
        assert.ok(field.type, `field "${field.name}" on ${key} is missing a type`);
      }
    });
  }

  test('supportsDelete is true for all four (DELETE archives rather than hard-deleting on the tenant side)', () => {
    for (const key of RESOURCE_KEYS) {
      assert.equal(getResourceConfig(key).supportsDelete, true);
    }
  });
});

const TENANT_TAXONOMY_PATH = join(__dirname, '..', '..', 'lummet-tenant', 'en', 'worker', 'database', 'newsroom-taxonomy.js');
const TENANT_AVAILABLE = existsSync(TENANT_TAXONOMY_PATH);

describe('Newsroom Taxonomy resource configs — drift check against the tenant\'s real KINDS map', { skip: !TENANT_AVAILABLE && 'sibling lummet-tenant repo not found' }, () => {
  const KEY_TO_KIND = {
    'newsroom-sections': 'sections',
    'newsroom-topics': 'topics',
    'newsroom-entities': 'entities',
    'newsroom-series': 'series'
  };

  // Fields this resource config intentionally exposes beyond the
  // tenant's raw sanitizer map (slug is handled specially by
  // saveTaxonomyItem itself — auto-generated from name — not listed
  // in KINDS[kind].fields, but is a real, settable column).
  const EXTRA_ALLOWED = new Set(['slug']);

  test('every editable field in resources.js exists in the tenant\'s KINDS sanitizer map for that kind', async () => {
    const { TAXONOMY_KINDS } = await import(TENANT_TAXONOMY_PATH);
    assert.deepEqual(new Set(TAXONOMY_KINDS), new Set(Object.values(KEY_TO_KIND)), 'tenant added/removed a taxonomy kind — resources.js needs a matching update');

    // Re-derive the tenant's per-kind field set the same way
    // newsroom-taxonomy.js's own module scope does, by reading the
    // module's source for the KINDS block (it isn't exported
    // directly). This is intentionally a light source-level check,
    // not a reimplementation of the sanitizers themselves.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(TENANT_TAXONOMY_PATH, 'utf-8');

    for (const [resourceKey, kind] of Object.entries(KEY_TO_KIND)) {
      const config = getResourceConfig(resourceKey);
      const configFieldNames = config.fields.map(f => f.name).filter(n => !EXTRA_ALLOWED.has(n));
      for (const fieldName of configFieldNames) {
        assert.match(
          src,
          new RegExp(`\\b${fieldName}\\s*:`),
          `resources.js's "${resourceKey}" config has a "${fieldName}" field not found anywhere in newsroom-taxonomy.js — check it's still a real column for kind "${kind}"`
        );
      }
    }
  });
});
