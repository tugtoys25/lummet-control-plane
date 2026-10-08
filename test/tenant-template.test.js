import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import * as template from '../worker/tenant-template.js';

function fakeR2() {
  const m = new Map();
  return { m, async put(k, v) { m.set(k, v); }, async get(k) { return m.has(k) ? { async text() { return m.get(k); } } : null; }, async delete(k) { m.delete(k); } };
}
function env(extra = {}) { const db = createTestDb(); applyMigrations(db); return { LUMMET_DB: db, ...extra }; }
const migs = [{ name: '0001_x.sql', sql: 'CREATE TABLE x (id INTEGER);' }];

test('fails closed without a storage binding', async () => {
  const e = env();
  const r = await template.publishRelease(e, { version: '1.0.0', scriptContent: 'console.log(1)', migrations: migs });
  assert.equal(r.error, 'template_storage_not_configured');
});

test('validates version format, script content, and migration shape', async () => {
  const e = env({ TENANT_TEMPLATES: fakeR2() });
  assert.equal((await template.publishRelease(e, { version: 'bad version!', scriptContent: 'x', migrations: [] })).error, 'invalid_version');
  assert.equal((await template.publishRelease(e, { version: '1.0.0', scriptContent: '', migrations: [] })).error, 'script_content_required');
  assert.equal((await template.publishRelease(e, { version: '1.0.0', scriptContent: 'x', migrations: 'nope' })).error, 'migrations_must_be_array');
  assert.equal((await template.publishRelease(e, { version: '1.0.0', scriptContent: 'x', migrations: [{ name: '' }] })).error, 'each_migration_needs_name_and_sql');
  assert.equal((await template.publishRelease(e, { version: '1.0.0', scriptContent: 'x', migrations: [migs[0], migs[0]] })).error, 'duplicate_migration_names');
});

test('publish, retrieve, checksum verified, and superseding leaves the old artifact in place', async () => {
  const e = env({ TENANT_TEMPLATES: fakeR2() });
  const p1 = await template.publishRelease(e, { version: '1.0.0', scriptContent: 'console.log("v1")', migrations: migs, createdBy: 'staff-1' });
  assert.ok(p1.ok, JSON.stringify(p1));
  const cur1 = await template.getCurrentRelease(e);
  assert.equal(cur1.version, '1.0.0'); assert.match(cur1.scriptContent, /v1/);

  const p2 = await template.publishRelease(e, { version: '1.1.0', scriptContent: 'console.log("v2")', migrations: migs });
  assert.ok(p2.ok);
  const cur2 = await template.getCurrentRelease(e);
  assert.equal(cur2.version, '1.1.0');

  // old artifact still fetchable by explicit version (rollback path)
  const old = await template.getReleaseByVersion(e, '1.0.0');
  assert.match(old.scriptContent, /v1/);

  const list = await template.listReleases(e);
  assert.deepEqual(list.map((r) => [r.version, r.status]), [['1.1.0', 'active'], ['1.0.0', 'superseded']]);
});

test('cannot publish the same version twice', async () => {
  const e = env({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(e, { version: '1.0.0', scriptContent: 'x', migrations: [] });
  const dup = await template.publishRelease(e, { version: '1.0.0', scriptContent: 'y', migrations: [] });
  assert.equal(dup.error, 'version_already_exists');
});

test('no release published yet => getCurrentRelease fails clearly, not silently', async () => {
  const e = env({ TENANT_TEMPLATES: fakeR2() });
  const r = await template.getCurrentRelease(e);
  assert.equal(r.error, 'no_release_published');
});

test('tampering with the stored artifact is caught by checksum verification', async () => {
  const e = env({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(e, { version: '1.0.0', scriptContent: 'x', migrations: [] });
  for (const k of e.TENANT_TEMPLATES.m.keys()) e.TENANT_TEMPLATES.m.set(k, 'tampered');
  const r = await template.getCurrentRelease(e);
  assert.equal(r.error, 'checksum_mismatch');
});

test('activateRelease rolls back to an older, still-stored release', async () => {
  const e = env({ TENANT_TEMPLATES: fakeR2() });
  await template.publishRelease(e, { version: '1.0.0', scriptContent: 'v1', migrations: [] });
  await template.publishRelease(e, { version: '1.1.0', scriptContent: 'v2', migrations: [] });
  const back = await template.activateRelease(e, '1.0.0');
  assert.ok(back.ok);
  assert.equal((await template.getCurrentRelease(e)).version, '1.0.0');
  assert.equal((await template.activateRelease(e, 'nope')).error, 'release_not_found');
});
