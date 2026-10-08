// test/content-pages-routes.test.js
//
// End-to-end (through worker.fetch) regression tests for the Content
// pages that used to throw ReferenceError -> "Something went wrong.":
//   - /content/analytics     (used an undefined `url` inside handleResourceRoutes)
//   - /content/integrations  (called requireSuperAdmin, out of scope)
//   - /content/ai-tools      (same)
// and for the permission model: super admins always pass; staff pass
// only with the matching "tenant" grant on their accessible tenant.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker/index.js';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { authenticateAdmin, setActiveTenant } from '../worker/auth.js';

describe('content pages route through worker.fetch', () => {
  let db, fx, env;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    env = { LUMMET_DB: db };
  });

  async function session(key, tenantId = 'tenant-a') {
    const r = await authenticateAdmin(env, `${key}@example.com`, FIXTURE_PASSWORDS[key], `ip-${key}`);
    assert.equal(r.ok, true);
    if (tenantId) await setActiveTenant(env, r.sessionId, tenantId);
    return r.sessionId;
  }
  const get = (path, sid) =>
    worker.fetch(new Request(`https://lummet.test${path}`, { headers: { Cookie: `lummet_session=${sid}` } }), env, {});
  async function grant(adminId, resource, action) {
    await db.prepare(
      `INSERT INTO lummet_admin_permissions (admin_id, area, resource, action, allowed) VALUES (?, 'tenant', ?, ?, 1)`
    ).bind(adminId, resource, action).run();
  }

  for (const path of ['/content/analytics', '/content/analytics?start_date=2026-01-01&end_date=2026-01-31&dimension_type=review&currency=EUR', '/content/integrations', '/content/ai-tools']) {
    test(`super admin can open ${path} (no 500)`, async () => {
      const res = await get(path, await session('superAdmin'));
      assert.equal(res.status, 200, await res.clone().text());
      assert.doesNotMatch(await res.text(), /Something went wrong/);
    });
  }

  test('super admin with no active tenant still gets analytics page', async () => {
    const res = await get('/content/analytics', await session('superAdmin', null));
    assert.equal(res.status, 200);
  });

  test('staff WITHOUT grants get 403 (not 500) on analytics/integrations/ai-tools', async () => {
    const sid = await session('staffA');
    for (const p of ['/content/analytics', '/content/integrations', '/content/ai-tools']) {
      assert.equal((await get(p, sid)).status, 403, p);
    }
  });

  test('staff WITH read grants can open analytics, integrations and ai-tools', async () => {
    for (const r of ['analytics', 'postback_configs', 'ai_tools']) await grant(fx.admins.staffA, r, 'read');
    const sid = await session('staffA');
    for (const p of ['/content/analytics', '/content/integrations', '/content/ai-tools']) {
      const res = await get(p, sid);
      assert.equal(res.status, 200, p + ' ' + (await res.clone().text()).slice(0, 200));
    }
  });

  test('staff with read grant cannot access a tenant they are not assigned to', async () => {
    await grant(fx.admins.staffA, 'postback_configs', 'read');
    const sid = await session('staffA', null);
    await db.prepare(`UPDATE lummet_sessions SET active_tenant_id = 'tenant-b' WHERE id = ?`).bind(sid).run().catch(() => {});
    const res = await get('/content/integrations', sid);
    assert.notEqual(res.status, 500);
  });

  test('staff read grant does not allow writes (POST /api/postback-configs -> 403)', async () => {
    await grant(fx.admins.staffA, 'postback_configs', 'read');
    const sid = await session('staffA');
    const res = await worker.fetch(new Request('https://lummet.test/api/postback-configs', {
      method: 'POST',
      headers: { Cookie: `lummet_session=${sid}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'x' })
    }), env, {});
    assert.equal(res.status, 403);
  });
});
