// test/research-resources.test.js
//
// Structural checks for the new "research-sources" resource config,
// plus a cross-repo drift check against the tenant's actual
// research-sources.js create/update field handling — same pattern as
// test/newsroom-taxonomy-resources.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getResourceConfig } from '../worker/resources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('research-sources resource config — structural', () => {
  test('config exists, has a required organisation field, every field has a type', () => {
    const config = getResourceConfig('research-sources');
    assert.ok(config);
    assert.equal(config.idField, 'id');
    assert.equal(config.supportsCreate, true);
    assert.equal(config.supportsDelete, true);
    assert.ok(config.fields.some(f => f.name === 'organisation' && f.required === true));
    for (const field of config.fields) {
      assert.ok(field.type, `field "${field.name}" is missing a type`);
    }
  });
});

const TENANT_SOURCES_PATH = join(__dirname, '..', '..', 'lummet-tenant', 'en', 'worker', 'database', 'research-sources.js');
const TENANT_AVAILABLE = existsSync(TENANT_SOURCES_PATH);

describe('research-sources resource config — drift check against the tenant\'s real module', { skip: !TENANT_AVAILABLE && 'sibling lummet-tenant repo not found' }, () => {
  test('every editable field in resources.js exists in research-sources.js', () => {
    const src = readFileSync(TENANT_SOURCES_PATH, 'utf-8');
    const config = getResourceConfig('research-sources');
    for (const field of config.fields) {
      assert.match(
        src,
        new RegExp(`\\b${field.name}\\b`),
        `resources.js's "research-sources" config has a "${field.name}" field not found anywhere in research-sources.js — check it's still a real column`
      );
    }
  });

  test('the source_type options in resources.js match the tenant\'s SOURCE_TYPES exactly', async () => {
    const { SOURCE_TYPES } = await import(TENANT_SOURCES_PATH);
    const config = getResourceConfig('research-sources');
    const field = config.fields.find(f => f.name === 'source_type');
    assert.deepEqual(new Set(field.options), new Set(SOURCE_TYPES));
  });
});
