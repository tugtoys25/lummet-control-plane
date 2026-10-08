// test/rbac.test.js
//
// RBAC
// - permitted action succeeds
// - missing permission is rejected
// - unrelated permission does not grant access
// - super-admin bypass remains functional
// - UI permission hiding must NOT be treated as the security boundary;
//   these tests exercise hasPermission()/canAccessTenant() directly —
//   the same functions every server-side route guard calls — not the
//   nav-filtering path in layout.js, which is presentation only.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures } from './support/fixtures.js';
import {
  hasPermission,
  hasAnyPermissionInArea,
  canAccessTenant,
  isSuperAdmin,
  listAccessibleTenants,
  loadPermissionMap,
  mapAllows
} from '../worker/rbac.js';

describe('hasPermission', () => {
  let db, fx, staffA, superAdmin, staffNone;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    staffA = { id: fx.admins.staffA, role: 'staff' };
    superAdmin = { id: fx.admins.superAdmin, role: 'super_admin' };
    staffNone = { id: fx.admins.staffNone, role: 'staff' };
  });

  test('permitted action succeeds (staffA was granted casinos.read)', async () => {
    assert.equal(await hasPermission(db && { LUMMET_DB: db }, staffA, 'tenant', 'casinos', 'read'), true);
  });

  test('permitted action succeeds (staffA was granted casinos.update)', async () => {
    assert.equal(await hasPermission({ LUMMET_DB: db }, staffA, 'tenant', 'casinos', 'update'), true);
  });

  test('missing permission is rejected (staffA was NOT granted casinos.delete)', async () => {
    assert.equal(await hasPermission({ LUMMET_DB: db }, staffA, 'tenant', 'casinos', 'delete'), false);
  });

  test('unrelated permission does not grant access (staffA has casinos grants, not users)', async () => {
    assert.equal(await hasPermission({ LUMMET_DB: db }, staffA, 'tenant', 'users', 'read'), false);
  });

  test('unrelated AREA does not grant access (casinos grant is area="tenant", not "cms" or "platform")', async () => {
    assert.equal(await hasPermission({ LUMMET_DB: db }, staffA, 'cms', 'casinos', 'read'), false);
    assert.equal(await hasPermission({ LUMMET_DB: db }, staffA, 'platform', 'casinos', 'read'), false);
  });

  test('an admin with zero grants is rejected for everything', async () => {
    assert.equal(await hasPermission({ LUMMET_DB: db }, staffNone, 'tenant', 'casinos', 'read'), false);
  });

  test('super-admin bypasses every check, granted or not', async () => {
    assert.equal(await hasPermission({ LUMMET_DB: db }, superAdmin, 'tenant', 'casinos', 'delete'), true);
    assert.equal(await hasPermission({ LUMMET_DB: db }, superAdmin, 'platform', 'anything', 'delete'), true);
  });

  test('legacy "master_admin" role value also bypasses every check (back-compat)', async () => {
    const legacy = { id: 999, role: 'master_admin' };
    assert.equal(await hasPermission({ LUMMET_DB: db }, legacy, 'tenant', 'casinos', 'delete'), true);
  });

  test('no admin at all is always rejected', async () => {
    assert.equal(await hasPermission({ LUMMET_DB: db }, null, 'tenant', 'casinos', 'read'), false);
  });

  test('hasAnyPermissionInArea true for staffA on "tenant" (has casinos grants there)', async () => {
    assert.equal(await hasAnyPermissionInArea({ LUMMET_DB: db }, staffA, 'tenant'), true);
  });

  test('hasAnyPermissionInArea false for staffA on "platform" (no grants there)', async () => {
    assert.equal(await hasAnyPermissionInArea({ LUMMET_DB: db }, staffA, 'platform'), false);
  });

  test('hasAnyPermissionInArea true for super admin on any area', async () => {
    assert.equal(await hasAnyPermissionInArea({ LUMMET_DB: db }, superAdmin, 'platform'), true);
  });
});

describe('loadPermissionMap / mapAllows (nav-filtering data source — NOT itself the security boundary)', () => {
  let db, fx, staffA, superAdmin;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    staffA = { id: fx.admins.staffA, role: 'staff' };
    superAdmin = { id: fx.admins.superAdmin, role: 'super_admin' };
  });

  test('super admin gets the null sentinel meaning "everything allowed"', async () => {
    const map = await loadPermissionMap({ LUMMET_DB: db }, superAdmin);
    assert.equal(map, null);
    assert.equal(mapAllows(map, 'platform', 'anything', 'delete'), true);
  });

  test('regular admin gets exactly their grants, nothing more', async () => {
    const map = await loadPermissionMap({ LUMMET_DB: db }, staffA);
    assert.equal(mapAllows(map, 'tenant', 'casinos', 'read'), true);
    assert.equal(mapAllows(map, 'tenant', 'casinos', 'delete'), false);
    assert.equal(mapAllows(map, 'tenant', 'users', 'read'), false);
  });

  test('this map is a rendering convenience, not enforcement: the server-side guard on every route calls hasPermission() (D1-backed) directly, independent of whatever this map says', async () => {
    // Regression guard against the exact failure mode named in the
    // task: hiding a nav link is not a security boundary. Prove the
    // two code paths are independent functions with independent D1
    // reads, so a bug in nav-filtering can never widen server-side
    // enforcement.
    assert.notEqual(hasPermission, loadPermissionMap);
    const map = await loadPermissionMap({ LUMMET_DB: db }, staffA);
    const mapSaysNo = mapAllows(map, 'tenant', 'casinos', 'delete') === false;
    const serverSaysNo = (await hasPermission({ LUMMET_DB: db }, staffA, 'tenant', 'casinos', 'delete')) === false;
    assert.equal(mapSaysNo, true);
    assert.equal(serverSaysNo, true);
  });
});

describe('canAccessTenant / isSuperAdmin / listAccessibleTenants', () => {
  let db, fx, staffA, superAdmin, staffNone;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    staffA = { id: fx.admins.staffA, role: 'staff' };
    superAdmin = { id: fx.admins.superAdmin, role: 'super_admin' };
    staffNone = { id: fx.admins.staffNone, role: 'staff' };
  });

  test('isSuperAdmin recognizes both "super_admin" and legacy "master_admin"', () => {
    assert.equal(isSuperAdmin({ role: 'super_admin' }), true);
    assert.equal(isSuperAdmin({ role: 'master_admin' }), true);
    assert.equal(isSuperAdmin({ role: 'staff' }), false);
    assert.equal(isSuperAdmin(null), false);
  });

  test('admin assigned to tenant-a CAN access tenant-a', async () => {
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, 'tenant-a'), true);
  });

  test('admin assigned to tenant-a CANNOT access tenant-b', async () => {
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, 'tenant-b'), false);
  });

  test('admin with no tenant assignments cannot access any real tenant', async () => {
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffNone, 'tenant-a'), false);
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffNone, 'tenant-b'), false);
  });

  test('super admin can access every tenant without an access row', async () => {
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, superAdmin, 'tenant-a'), true);
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, superAdmin, 'tenant-b'), true);
  });

  test('a nonexistent/fabricated tenant id is rejected for a non-super-admin (no row = no access)', async () => {
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, 'tenant-does-not-exist'), false);
  });

  test('missing/null tenant id is treated as the safe "no active tenant" state, not a bypass', async () => {
    // canAccessTenant(..., null/undefined) intentionally returns true —
    // this models "no tenant is currently selected", which every
    // tenant-scoped route in index.js only reaches AFTER this same
    // check has already gated entry with the real admin.activeTenantId.
    // It is never used to grant access to a specific tenant's data.
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, null), true);
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, undefined), true);
    assert.equal(await canAccessTenant({ LUMMET_DB: db }, staffA, ''), true);
  });

  test('listAccessibleTenants filters to only assigned tenants for a regular admin', async () => {
    const all = [{ id: 'tenant-a' }, { id: 'tenant-b' }];
    const visible = await listAccessibleTenants({ LUMMET_DB: db }, staffA, all);
    assert.deepEqual(visible.map(t => t.id), ['tenant-a']);
  });

  test('listAccessibleTenants returns everything for a super admin', async () => {
    const all = [{ id: 'tenant-a' }, { id: 'tenant-b' }];
    const visible = await listAccessibleTenants({ LUMMET_DB: db }, superAdmin, all);
    assert.deepEqual(visible.map(t => t.id), ['tenant-a', 'tenant-b']);
  });

  test('listAccessibleTenants returns nothing for an admin assigned to no tenants', async () => {
    const all = [{ id: 'tenant-a' }, { id: 'tenant-b' }];
    const visible = await listAccessibleTenants({ LUMMET_DB: db }, staffNone, all);
    assert.deepEqual(visible, []);
  });
});
