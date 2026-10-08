// test/newsroom-tags.test.js
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderNewsroomTagsPage, submitNewsroomMeta, submitNewsroomRelations } from '../worker/views/pages/newsroom-tags.js';

describe('newsroom-tags submit helpers — fail closed with no active tenant, no network involved', () => {
  test('submitNewsroomMeta returns no_active_tenant when admin.activeTenantId is null', async () => {
    const result = await submitNewsroomMeta({}, { activeTenantId: null }, 5, { article_type: 'news' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'no_active_tenant');
  });

  test('submitNewsroomRelations returns no_active_tenant when admin.activeTenantId is null', async () => {
    const result = await submitNewsroomRelations({}, { activeTenantId: null }, 5, { topic_ids: [] });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'no_active_tenant');
  });
});

describe('renderNewsroomTagsPage — no active tenant renders a notice, not a crash', () => {
  test('returns HTML (not a throw) when admin.activeTenantId is null', async () => {
    const { createTestDb, applyMigrations } = await import('./support/d1-shim.js');
    const db = createTestDb();
    applyMigrations(db);
    const env = { LUMMET_DB: db };
    const html = await renderNewsroomTagsPage(env, { role: 'super_admin', activeTenantId: null }, 'some-slug');
    assert.equal(typeof html, 'string');
    assert.match(html, /No active tenant/);
  });
});
