// =====================================================
// CUSTOMER ORGANIZATION RBAC
//
// Roles are ordered from least to most privileged. Unlike
// Lummet's staff RBAC (fine-grained per-resource grants —
// see rbac.js), organization roles are a fixed hierarchy:
// every role at or above a given rank implies everything
// the ranks below it can do. This matches master prompt
// section 7 (Owner > Admin > Editor > Analyst > Viewer).
//
// This module holds no data access — it's pure role-order
// logic, used by organizations.js and by index.js route
// guards.
// =====================================================

export const ORG_ROLES = ["viewer", "analyst", "editor", "admin", "owner"];

export function roleRank(role) {
  const i = ORG_ROLES.indexOf(role);
  return i === -1 ? -1 : i;
}

export function roleAtLeast(role, required) {
  return roleRank(role) >= roleRank(required);
}

export function isValidRole(role) {
  return ORG_ROLES.includes(role);
}
