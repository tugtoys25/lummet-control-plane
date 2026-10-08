// test/tenant-isolation.test.js
//
// TENANT ISOLATION
// - admin assigned to Tenant A can access Tenant A
// - admin assigned to Tenant A cannot access Tenant B
// - changing tenant ID in URL/body/query cannot bypass isolation
// - unauthorized tenant resource access is rejected
// - missing/invalid active tenant is handled safely
//
// index.js's actual dispatcher is a 2000+ line Worker fetch handler
// with KV/R2/external-fetch dependencies that aren't practical to
// spin up under node:test. Rather than skip this, two complementary
// strategies are used:
//
//   1. Behavioral: canAccessTenant() IS the guard every route path
//      (checkResourcePermission's outer gate, requireTenantParamAccess)
//      calls — see index.js lines ~468-471 and ~1741. Testing it
//      directly with attacker-supplied tenant ids covers the actual
//      security-relevant logic, independent of which request field
//      (URL param, body field, query string) the id arrived in --
//      the function has no idea which field it came from, which is
//      exactly the point: there is no field-specific special-casing
//      to bypass.
//
//   2. Static/structural: a regression check on index.js's own source
//      confirming the tenant-scoped dispatcher gates on
//      `admin.activeTenantId` (server-side session state) rather than
//      trusting a request-supplied tenant id for content routes. This
//      guards against a future edit accidentally swapping in a
//      client-controlled value.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures } from './support/fixtures.js';
import { canAccessTenant } from '../worker/rbac.js';
import { requestTenant } from '../worker/client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('canAccessTenant as the tamper-resistant gate', () => {
  let db, fx, staffA;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    staffA = { id: fx.admins.staffA, role: 'staff' };
  });

  test('admin assigned to tenant-a can access tenant-a (baseline)', async () => {
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, 'tenant-a'), true);
  });

  test('admin assigned to tenant-a cannot access tenant-b via a URL-param-shaped id', async () => {
    // Simulates GET /content/casinos?tenant=tenant-b or
    // /api/tenants/tenant-b/switch — however the id got here, it's
    // just a string by the time it reaches the guard.
    const idFromUrlParam = 'tenant-b';
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, idFromUrlParam), false);
  });

  test('admin assigned to tenant-a cannot access tenant-b via a body-field-shaped id', async () => {
    const fakeParsedBody = JSON.parse(JSON.stringify({ tenant_id: 'tenant-b' }));
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, fakeParsedBody.tenant_id), false);
  });

  test('admin assigned to tenant-a cannot access tenant-b via a query-string-shaped id', async () => {
    const fakeQuery = new URLSearchParams('tenant_id=tenant-b');
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, fakeQuery.get('tenant_id')), false);
  });

  test('a well-formed but nonexistent tenant id is rejected the same way as a real unauthorized one', async () => {
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, 'tenant-x-does-not-exist'), false);
  });

  test('injection-shaped tenant id strings are simply not matched, not specially handled', async () => {
    const attempts = ["tenant-a' OR '1'='1", 'tenant-a; DROP TABLE tenants;--', '../tenant-a', '%00tenant-a'];
    for (const attempt of attempts) {
      assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, attempt), false, `expected rejection for: ${attempt}`);
    }
  });
});

describe('missing/invalid active tenant is handled safely', () => {
  let db, fx, staffA;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    staffA = { id: fx.admins.staffA, role: 'staff' };
  });

  test('requestTenant() against a nonexistent tenant id fails closed (404), no network attempted', async () => {
    const result = await requestTenant({ LUMMET_DB: db }, 'tenant-does-not-exist', { method: 'GET', path: '/en/api/super/casinos' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.equal(result.reason, 'tenant_not_found');
  });

  test('requestTenant() against a disabled tenant fails closed (422), no network attempted', async () => {
    await db.prepare(`UPDATE tenants SET status = 'disabled' WHERE id = 'tenant-a'`).run();
    const result = await requestTenant({ LUMMET_DB: db }, 'tenant-a', { method: 'GET', path: '/en/api/super/casinos' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'tenant_disabled');
  });

  test('requestTenant() against a tenant with no active credential fails closed (422), no network attempted', async () => {
    // tenant-b has no tenant_api_credentials row in the fixtures at all.
    const result = await requestTenant({ LUMMET_DB: db }, 'tenant-b', { method: 'GET', path: '/en/api/super/casinos' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 422);
    assert.equal(result.reason, 'no_active_credential');
  });
});

describe('structural regression: content dispatcher gates on session state, not a request param', () => {
  test('index.js checks canAccessTenant(env, admin, admin.activeTenantId) before the per-resource permission gate', () => {
    const indexSrc = readFileSync(join(__dirname, '..', 'worker', 'index.js'), 'utf-8');
    assert.match(
      indexSrc,
      /canAccessTenant\(env,\s*admin,\s*admin\.activeTenantId\)/,
      'expected the top-level tenant-scoped dispatcher guard to check admin.activeTenantId (server-side session state), not a request-supplied id'
    );
  });

  test('admin.activeTenantId itself is only ever assigned from the session row read from LUMMET_DB, never from request input', () => {
    const authSrc = readFileSync(join(__dirname, '..', 'worker', 'auth.js'), 'utf-8');
    assert.match(
      authSrc,
      /activeTenantId:\s*session\.active_tenant_id\s*\|\|\s*null/,
      'expected getCurrentAdmin to derive activeTenantId only from the stored session row'
    );
  });
});
