// Drift check: every NOT NULL, no-DEFAULT column the tenant's casinos table
// requires on INSERT must be marked required in resources.js. Without this,
// the control plane accepts a create the tenant's D1 then rejects
// (this exact bug: casinos.website_url).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RESOURCES } from '../worker/resources.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(__dirname, '..', '..', 'lummet-tenant', 'en', 'migrations', 'schema.sql');
const AVAILABLE = existsSync(SCHEMA);

describe('casinos required fields vs tenant schema', { skip: !AVAILABLE && 'sibling lummet-tenant repo not found' }, () => {
  test('every NOT NULL column without a DEFAULT (except id) is required in resources.js', () => {
    const sql = readFileSync(SCHEMA, 'utf-8');
    const block = sql.match(/CREATE TABLE casinos \(([\s\S]*?)\n\);/)[1];
    const mustHave = block
      .split('\n')
      .map((l) => l.trim().replace(/,$/, ''))
      .filter((l) => /NOT NULL/i.test(l) && !/DEFAULT/i.test(l) && !/PRIMARY KEY/i.test(l))
      .map((l) => l.split(/\s+/)[0]);
    assert.ok(mustHave.includes('website_url'), 'sanity: parser found website_url');
    const required = new Set(RESOURCES.casinos.fields.filter((f) => f.required).map((f) => f.name));
    for (const col of mustHave) {
      assert.ok(required.has(col), `casinos.${col} is NOT NULL on the tenant but not required in resources.js`);
    }
  });
});

describe('casinos create without website_url is refused at preview time', () => {
  test('website_url is required', () => {
    assert.equal(RESOURCES.casinos.fields.find((f) => f.name === 'website_url').required, true);
  });
});
