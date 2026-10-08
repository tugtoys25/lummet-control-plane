// test/tenant-switching.test.js
//
// TENANT SWITCHING
// - authorized tenant switch succeeds
// - unauthorized tenant switch fails
// - super-admin switching remains functional
// - failed switch does not alter the active tenant session
//
// Mirrors the actual route logic in index.js's POST /api/tenants/:id/switch
// handler: `const guard = await requireTenantParamAccess(id); if (guard)
// return guard; ... await auth.setActiveTenant(...)` — i.e. setActiveTenant
// is only ever reached after canAccessTenant has already passed.

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, applyMigrations } from './support/d1-shim.js';
import { seedFixtures, FIXTURE_PASSWORDS } from './support/fixtures.js';
import { canAccessTenant } from '../worker/rbac.js';
import { authenticateAdmin, setActiveTenant, getCurrentAdmin } from '../worker/auth.js';

function fakeCookieRequest(sessionId) {
  return { headers: { get: (name) => (name === 'Cookie' ? `lummet_session=${sessionId}` : null) } };
}

// Same-shape helper as index.js's local `requireTenantParamAccess` /
// `checkResourcePermission` closures — deliberately reproduced here
// rather than imported, since those are private closures inside the
// big fetch handler, not exported. Kept identical to index.js's own
// one-liner so this test tracks the real gating logic.
async function attemptSwitch(env, admin, targetTenantId) {
  const allowed = await canAccessTenant(env, admin, targetTenantId);
  if (!allowed) return { ok: false, status: 403 };
  await setActiveTenant(env, admin.sessionId, targetTenantId);
  return { ok: true };
}

describe('tenant switching', () => {
  let db, fx, env;

  beforeEach(async () => {
    db = createTestDb();
    applyMigrations(db);
    fx = await seedFixtures(db);
    env = { LUMMET_DB: db };
  });

  async function loginAs(key) {
    const result = await authenticateAdmin(env, `${key}@example.com`, FIXTURE_PASSWORDS[key], `ip-${key}`);
    assert.equal(result.ok, true, `expected ${key} login to succeed`);
    const admin = await getCurrentAdmin(fakeCookieRequest(result.sessionId), env);
    assert.ok(admin, `expected getCurrentAdmin to resolve a session for ${key}`);
    return admin;
  }

  test('authorized tenant switch succeeds and persists', async () => {
    const staffA = await loginAs('staffA');
    const result = await attemptSwitch(env, staffA, 'tenant-a');
    assert.equal(result.ok, true);

    const refreshed = await getCurrentAdmin(fakeCookieRequest(staffA.sessionId), env);
    assert.equal(refreshed.activeTenantId, 'tenant-a');
  });

  test('unauthorized tenant switch fails (staffA has no access to tenant-b)', async () => {
    const staffA = await loginAs('staffA');
    const result = await attemptSwitch(env, staffA, 'tenant-b');
    assert.equal(result.ok, false);
    assert.equal(result.status, 403);
  });

  test('failed switch does not alter the active tenant session', async () => {
    const staffA = await loginAs('staffA');

    // Establish a known-good active tenant first.
    await attemptSwitch(env, staffA, 'tenant-a');
    let refreshed = await getCurrentAdmin(fakeCookieRequest(staffA.sessionId), env);
    assert.equal(refreshed.activeTenantId, 'tenant-a');

    // Now attempt (and fail) a switch to tenant-b.
    const failedSwitch = await attemptSwitch(env, refreshed, 'tenant-b');
    assert.equal(failedSwitch.ok, false);

    // The session's active tenant must be untouched by the failed attempt.
    refreshed = await getCurrentAdmin(fakeCookieRequest(staffA.sessionId), env);
    assert.equal(refreshed.activeTenantId, 'tenant-a', 'a rejected switch must not change the persisted active tenant');
  });

  test('super-admin switching remains functional across any tenant, with no access rows needed', async () => {
    const superAdmin = await loginAs('superAdmin');
    assert.equal((await attemptSwitch(env, superAdmin, 'tenant-a')).ok, true);
    assert.equal((await attemptSwitch(env, superAdmin, 'tenant-b')).ok, true);
  });

  test('an admin with zero tenant access rows can never switch to a real tenant', async () => {
    const staffNone = await loginAs('staffNone');
    assert.equal((await attemptSwitch(env, staffNone, 'tenant-a')).ok, false);
    assert.equal((await attemptSwitch(env, staffNone, 'tenant-b')).ok, false);
  });

  test('clearing the active tenant (DELETE /api/session/active-tenant) always succeeds — it never widens access', async () => {
    const staffA = await loginAs('staffA');
    await attemptSwitch(env, staffA, 'tenant-a');
    await setActiveTenant(env, staffA.sessionId, null);
    const refreshed = await getCurrentAdmin(fakeCookieRequest(staffA.sessionId), env);
    assert.equal(refreshed.activeTenantId, null);
  });
});
