// =====================================================
// LUMMET ADMIN RBAC
//
// One place all permission checks route through — both
// route handlers (server-side enforcement, the only check
// that actually matters) and layout.js (nav filtering, so
// an admin never sees a link to a screen they can't use).
//
// A super admin (role === "super_admin" or the legacy
// "master_admin" value from before this migration) always
// passes every check here — exactly like the tenant's own
// `admin` role bypasses its permissions table.
// =====================================================

export const AREAS = { TENANT: "tenant", CMS: "cms", PLATFORM: "platform" };
export const ACTIONS = ["create", "read", "update", "delete"];

export function isSuperAdmin(admin) {
  return !!admin && (admin.role === "super_admin" || admin.role === "master_admin");
}

export async function getAdminTenantIds(env, adminId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT tenant_id FROM lummet_admin_tenant_access WHERE admin_id = ?`
  ).bind(adminId).all();
  return (result.results || []).map((r) => r.tenant_id);
}

export async function canAccessTenant(env, admin, tenantId) {
  if (!tenantId) return true; // "no active tenant" state is always fine to be in
  if (isSuperAdmin(admin)) return true;
  const row = await env.LUMMET_DB.prepare(
    `SELECT 1 FROM lummet_admin_tenant_access WHERE admin_id = ? AND tenant_id = ?`
  ).bind(admin.id, tenantId).first();
  return !!row;
}

/**
 * Filters a list of {id,...} tenant rows down to the ones this
 * admin may see/switch to. Super admins see all of them.
 */
export async function listAccessibleTenants(env, admin, allTenants) {
  if (isSuperAdmin(admin)) return allTenants;
  const ids = new Set(await getAdminTenantIds(env, admin.id));
  return allTenants.filter((t) => ids.has(t.id));
}

export async function hasPermission(env, admin, area, resource, action) {
  if (isSuperAdmin(admin)) return true;
  if (!admin) return false;
  const row = await env.LUMMET_DB.prepare(
    `SELECT allowed FROM lummet_admin_permissions WHERE admin_id = ? AND area = ? AND resource = ? AND action = ?`
  ).bind(admin.id, area, resource, action).first();
  return !!(row && row.allowed === 1);
}

/**
 * True if this admin has ANY allowed grant in an area — used to
 * decide whether to show a whole nav section (e.g. "Content") at
 * all, without checking every individual resource.
 */
export async function hasAnyPermissionInArea(env, admin, area) {
  if (isSuperAdmin(admin)) return true;
  if (!admin) return false;
  const row = await env.LUMMET_DB.prepare(
    `SELECT 1 FROM lummet_admin_permissions WHERE admin_id = ? AND area = ? AND allowed = 1 LIMIT 1`
  ).bind(admin.id, area).first();
  return !!row;
}

/**
 * Full permission map for this admin, shaped like
 * { [area]: { [resource]: { [action]: true } } } — fetched once
 * per request so layout.js can filter the whole nav without one
 * D1 round trip per link.
 */
export async function loadPermissionMap(env, admin) {
  if (!admin || isSuperAdmin(admin)) return null; // null = "everything allowed"
  const result = await env.LUMMET_DB.prepare(
    `SELECT area, resource, action FROM lummet_admin_permissions WHERE admin_id = ? AND allowed = 1`
  ).bind(admin.id).all();
  const map = {};
  for (const row of result.results || []) {
    map[row.area] ??= {};
    map[row.area][row.resource] ??= {};
    map[row.area][row.resource][row.action] = true;
  }
  return map;
}

export function mapAllows(map, area, resource, action) {
  if (map === null) return true; // super admin sentinel from loadPermissionMap
  return !!map?.[area]?.[resource]?.[action];
}

export function mapAllowsAnyInArea(map, area) {
  if (map === null) return true;
  return !!map?.[area] && Object.keys(map[area]).length > 0;
}

export async function setPermission(env, adminId, area, resource, action, allowed) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO lummet_admin_permissions (admin_id, area, resource, action, allowed)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(admin_id, area, resource, action) DO UPDATE SET allowed = excluded.allowed`
  ).bind(adminId, area, resource, action, allowed ? 1 : 0).run();
}

export async function setTenantAccess(env, adminId, tenantId, allowed) {
  if (allowed) {
    await env.LUMMET_DB.prepare(
      `INSERT INTO lummet_admin_tenant_access (admin_id, tenant_id) VALUES (?, ?)
       ON CONFLICT(admin_id, tenant_id) DO NOTHING`
    ).bind(adminId, tenantId).run();
  } else {
    await env.LUMMET_DB.prepare(
      `DELETE FROM lummet_admin_tenant_access WHERE admin_id = ? AND tenant_id = ?`
    ).bind(adminId, tenantId).run();
  }
}
