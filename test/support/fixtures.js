// test/support/fixtures.js
//
// Seeds a fresh shim DB with a small, deliberately-adversarial fixture
// set for the security/RBAC suite:
//
//   tenants:      tenant-a, tenant-b
//   admins:       superAdmin   (role: super_admin, bypasses everything)
//                 staffA       (regular admin, access to tenant-a ONLY,
//                               granted tenant/casinos/read+update, but
//                               NOT tenant/casinos/delete, and NOT
//                               tenant/users/read)
//                 staffNone    (regular admin, zero tenant access, zero
//                               permission grants)
//                 disabledAdmin (status: disabled)
//
// Uses the real hashPassword() from worker/auth.js so authentication
// tests exercise the actual PBKDF2 + constant-time-compare path, not
// a stand-in.

import { hashPassword } from '../../worker/auth.js';

export const FIXTURE_PASSWORDS = {
  superAdmin: 'Sup3r-Admin-Passw0rd!',
  staffA: 'Staff-A-Passw0rd!',
  staffNone: 'Staff-None-Passw0rd!',
  disabledAdmin: 'Disabled-Passw0rd!'
};

export async function seedFixtures(db) {
  const now = new Date().toISOString();

  await db.prepare(
    `INSERT INTO tenants (id, name, host, api_base_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).bind('tenant-a', 'Tenant A', 'tenant-a.example.com', 'https://tenant-a.example.com', now, now).run();

  await db.prepare(
    `INSERT INTO tenants (id, name, host, api_base_url, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  ).bind('tenant-b', 'Tenant B', 'tenant-b.example.com', 'https://tenant-b.example.com', now, now).run();

  const admins = {};

  async function createAdmin(key, { role, status = 'active' }) {
    const passwordHash = await hashPassword(FIXTURE_PASSWORDS[key]);
    const row = await db.prepare(
      `INSERT INTO lummet_admins (email, password_hash, role, status) VALUES (?, ?, ?, ?) RETURNING id`
    ).bind(`${key}@example.com`, passwordHash, role, status).first();
    admins[key] = row.id;
  }

  await createAdmin('superAdmin', { role: 'super_admin' });
  await createAdmin('staffA', { role: 'staff' });
  await createAdmin('staffNone', { role: 'staff' });
  await createAdmin('disabledAdmin', { role: 'staff', status: 'disabled' });

  // staffA may only ever act on tenant-a.
  await db.prepare(
    `INSERT INTO lummet_admin_tenant_access (admin_id, tenant_id) VALUES (?, ?)`
  ).bind(admins.staffA, 'tenant-a').run();

  // staffA's grants: casinos read+update, explicitly NOT delete, and
  // NOT users at all — used to prove "unrelated permission does not
  // grant access" and "missing permission is rejected".
  for (const action of ['read', 'update']) {
    await db.prepare(
      `INSERT INTO lummet_admin_permissions (admin_id, area, resource, action, allowed) VALUES (?, 'tenant', 'casinos', ?, 1)`
    ).bind(admins.staffA, action).run();
  }

  // A fake credential row for tenant-a, used only to verify the
  // credentials list page never surfaces the secret material.
  await db.prepare(
    `INSERT INTO tenant_api_credentials (tenant_id, credential_id, encrypted_secret, secret_iv, status, created_at)
     VALUES (?, ?, ?, ?, 'active', ?)`
  ).bind('tenant-a', 'cred_tenant_a_001', 'ENCRYPTED_SECRET_SHOULD_NEVER_LEAK', 'fake_iv_should_never_leak', now).run();

  return { admins };
}
