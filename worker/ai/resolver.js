// =====================================================
// AI RESOLVER
// Where the AI layer's actual authorization happens. The
// model's intent (intent.js) is a PROPOSAL; every field
// used here is re-derived server-side from data the admin
// is already authorized to see -- exactly the same
// registry/RBAC calls the ordinary dashboard routes in
// index.js use (registry.listTenants, rbac.canAccessTenant,
// rbac.hasPermission). A tenant id or permission grant is
// never taken from the model's output.
// =====================================================

import * as registry from "../registry.js";
import { canAccessTenant, hasPermission, listAccessibleTenants, isSuperAdmin } from "../rbac.js";
import { isKnownResource, getSchema, listResourceKeys } from "./schema.js";

const OPERATION_TO_ACTION = {
  read: "read",
  schema: "read",
  create: "create",
  update: "update",
  delete: "delete"
};

/**
 * Resolves which tenant this request applies to, from a hint string
 * (or none) plus the admin's real, server-known access -- never
 * from a tenant id the model produced. Matching is done only
 * against tenants `listAccessibleTenants` already says this admin
 * may use, and the chosen tenant is re-checked with
 * `canAccessTenant` before being returned, so a bug in the
 * accessible-tenants filter can never silently widen access here.
 */
export async function resolveTenant(env, admin, tenantHint) {
  const allTenants = await registry.listTenants(env);
  const accessible = await listAccessibleTenants(env, admin, allTenants);

  if (!tenantHint) {
    if (!admin.activeTenantId) {
      return { ok: false, error: "no_active_tenant", message: "No tenant is currently active. Switch to a tenant first." };
    }
    const tenant = accessible.find((t) => t.id === admin.activeTenantId);
    if (!tenant) {
      return { ok: false, error: "active_tenant_not_authorized", message: "The active tenant is no longer authorized for this account." };
    }
    const reverified = await canAccessTenant(env, admin, tenant.id);
    if (!reverified) {
      return { ok: false, error: "active_tenant_not_authorized", message: "The active tenant is no longer authorized for this account." };
    }
    return { ok: true, tenant };
  }

  const needle = tenantHint.trim().toLowerCase();
  const matches = accessible.filter(
    (t) => t.name.toLowerCase().includes(needle) || t.host.toLowerCase().includes(needle)
  );

  if (matches.length === 0) {
    return {
      ok: false,
      error: "tenant_not_found_or_unauthorized",
      message: `No tenant matching "${tenantHint}" among the tenants you're authorized for.`
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: "tenant_ambiguous",
      message: `"${tenantHint}" matches more than one tenant.`,
      candidates: matches.map((t) => ({ id: t.id, name: t.name, host: t.host }))
    };
  }

  const tenant = matches[0];
  // Explicit re-verification -- this is the actual authorization
  // decision, not the substring match above, which is only a lookup.
  const authorized = await canAccessTenant(env, admin, tenant.id);
  if (!authorized) {
    return { ok: false, error: "tenant_not_found_or_unauthorized", message: `No tenant matching "${tenantHint}" among the tenants you're authorized for.` };
  }
  return { ok: true, tenant };
}

export function resolveResource(resourceKey) {
  if (!resourceKey) {
    return { ok: false, error: "resource_required", message: "Which resource is this about?", available: listResourceKeys() };
  }
  if (!isKnownResource(resourceKey)) {
    return {
      ok: false,
      error: "unknown_resource",
      message: `"${resourceKey}" is not a resource this system manages.`,
      available: listResourceKeys()
    };
  }
  return { ok: true, resourceKey, config: getSchema(resourceKey) };
}

/** area is always "tenant" here -- the AI chat only ever operates on
 * tenant-managed resources in this phase (see schema.js). */
export async function checkPermission(env, admin, resourceKey, operation) {
  const action = OPERATION_TO_ACTION[operation];
  if (!action) {
    return { ok: false, error: "unsupported_operation", message: `"${operation}" is not a supported operation.` };
  }
  const allowed = await hasPermission(env, admin, "tenant", resourceKey, action);
  if (!allowed) {
    return { ok: false, error: "forbidden", message: `You don't have ${action} permission for ${resourceKey}.` };
  }
  return { ok: true, action };
}

/**
 * Ties tenant + resource + permission resolution together into one
 * call. Returns either { ok:false, error, message, ... } (safe to
 * show directly to the admin -- never leaks another tenant's data
 * or existence) or { ok:true, tenant, resourceKey, config, action }.
 */
export async function resolveAction(env, admin, intent) {
  const resourceResult = resolveResource(intent.resource);
  if (!resourceResult.ok) return resourceResult;

  const tenantResult = await resolveTenant(env, admin, intent.tenantHint);
  if (!tenantResult.ok) return tenantResult;

  const permissionResult = await checkPermission(env, admin, resourceResult.resourceKey, intent.operation);
  if (!permissionResult.ok) return permissionResult;

  if (intent.operation === "delete" && !resourceResult.config.supportsDelete) {
    return {
      ok: false,
      error: "delete_not_supported",
      message: `${resourceResult.config.label} does not support delete -- this is an intentional platform restriction, not a missing feature.`
    };
  }
  if (intent.operation === "create" && !resourceResult.config.supportsCreate) {
    return {
      ok: false,
      error: "create_not_supported",
      message: `${resourceResult.config.label} does not support create through this interface.`
    };
  }

  return {
    ok: true,
    tenant: tenantResult.tenant,
    resourceKey: resourceResult.resourceKey,
    config: resourceResult.config,
    action: permissionResult.action,
    isSuperAdmin: isSuperAdmin(admin)
  };
}
