// =====================================================
// STAFF CONSOLE: CUSTOM CLOUDFLARE HOSTING
//
//   GET  /platform/custom-hosting                                   page                                     (read)
//   GET  /api/platform/custom-hosting                               overview: switch, access list, sites, moves (read)
//   POST /api/platform/custom-hosting/switch                        { value: "on"|"off", reason }            (manage)
//   POST /api/platform/custom-hosting/access                        { organization, mode: allow|deny|default, note } (manage)
//   POST /api/platform/custom-hosting/transfers/:id/retry           re-run a failed move                     (manage)
//   POST /api/platform/custom-hosting/transfers/:id/remove-old-copy delete the Lummet copy a finished move kept (manage)
//
// Permission: area "platform", resource "custom_hosting" (read / update), through the existing RBAC; super admins pass.
// Nothing here shows or accepts a customer secret: accounts appear by label and Cloudflare account id only.
// =====================================================
import { hasPermission } from "./rbac.js";
import * as customHosting from "./custom-hosting.js";
import * as repo from "./repositories/custom-hosting.js";
import * as platformSettings from "./platform-settings.js";
import { hostingTransfers } from "./custom-hosting-transfer.js";
import { renderCustomHostingStaffPage } from "./views/pages/custom-hosting.js";

export const PERMISSION = { area: "platform", resource: "custom_hosting", read: "read", manage: "update" };

export async function handleCustomHostingRoute(ctx) {
  const { env, request, method, path, admin, requestId, ipHash, json, html, logAudit } = ctx;
  const isPage = method === "GET" && path === "/platform/custom-hosting";
  if (!isPage && path !== "/api/platform/custom-hosting" && !path.startsWith("/api/platform/custom-hosting/")) return null;
  const canRead = await hasPermission(env, admin, PERMISSION.area, PERMISSION.resource, PERMISSION.read);
  const canManage = await hasPermission(env, admin, PERMISSION.area, PERMISSION.resource, PERMISSION.manage);
  if (!(canRead || canManage)) return json({ success: false, error: "forbidden" }, 403);
  const needManage = () => (canManage ? null : json({ success: false, error: "forbidden" }, 403));
  const body = async () => (method === "GET" ? {} : await request.json().catch(() => ({})));
  const audit = (fields) => logAudit(env, { adminId: admin.id, endpoint: path, method, requestId, ipHash, ...fields });

  if (isPage) return html(await renderCustomHostingStaffPage(env, admin, { canManage, overview: await customHosting.staffOverview(env) }));

  if (path === "/api/platform/custom-hosting") {
    if (method !== "GET") return json({ success: false, error: "method_not_allowed" }, 405);
    return json({ success: true, data: await customHosting.staffOverview(env) });
  }

  if (path === "/api/platform/custom-hosting/switch") {
    if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
    const g = needManage(); if (g) return g;
    const b = await body();
    const value = b.value === "on" ? "on" : b.value === "off" ? "off" : null;
    if (!value) return json({ success: false, error: "invalid_value" }, 422);
    // Switching off only stops NEW accounts, sites and moves; sites already in customer accounts keep deploying.
    const r = await platformSettings.setSetting(env, { key: customHosting.SETTING_KEY, value, actorId: `staff:${admin.id}`, reason: b.reason });
    await audit({ resource: "platform_setting", resourceId: customHosting.SETTING_KEY, action: `custom_hosting_${value}`, reason: String(b.reason || "").slice(0, 1000), success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
    if (!r.ok) return json({ success: false, error: r.error }, r.status || 400);
    return json({ success: true, value });
  }

  if (path === "/api/platform/custom-hosting/access") {
    if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
    const g = needManage(); if (g) return g;
    const b = await body();
    const r = await customHosting.setOrganizationAccess(env, { organization: b.organization, mode: b.mode, note: b.note, actorId: `staff:${admin.id}` });
    await audit({ resource: "organization", resourceId: r.ok ? r.organization.id : null, organizationId: r.ok ? r.organization.id : null, action: `custom_hosting_access_${b.mode}`, reason: String(b.note || "").slice(0, 1000), success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
    if (!r.ok) return json({ success: false, error: r.error }, r.status || 400);
    return json({ success: true, organization: r.organization, mode: r.mode });
  }

  const m = path.match(/^\/api\/platform\/custom-hosting\/transfers\/([A-Za-z0-9-]{1,64})\/(retry|remove-old-copy)$/);
  if (m) {
    if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
    const g = needManage(); if (g) return g;
    const [, id, action] = m;
    const t = await repo.getTransfer(env, id);
    if (!t) return json({ success: false, error: "not_found" }, 404);
    let r;
    if (action === "retry") {
      if (t.status !== "failed" || !t.job_id) r = { ok: false, status: 409, error: "transfer_not_failed" };
      else { await ctx.dispatchJob(t.job_id); r = { ok: true }; }
    } else {
      r = await hostingTransfers.removeOldCopy(env, { siteId: t.site_id });
    }
    await audit({ resource: "site", resourceId: t.site_id, organizationId: t.organization_id, action: `custom_hosting_transfer_${action.replace(/-/g, "_")}`, success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
    if (!r.ok) return json({ success: false, error: r.error, ...(r.message ? { message: r.message } : {}) }, r.status || 400);
    return json({ success: true });
  }
  return json({ success: false, error: "not_found" }, 404);
}
