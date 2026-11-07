// Staff routes for Platform domains: one page and a small JSON API. Handled in its own module (like the plan catalog),
// called from worker/index.js before the SaaS routes. Returns a Response, or null when the path is not ours.
//
//   GET    /platform/domains                     page (read)
//   GET    /api/platform/domains                 list with site counts (read)
//   POST   /api/platform/domains                 add { hostname, label }                          (manage)
//   POST   /api/platform/domains/reorder         { ids: [...] }                                   (manage)
//   GET    /api/platform/domains/:id             one domain with its last check (read)
//   GET    /api/platform/domains/:id/sites       sites on the domain (read)
//   POST   /api/platform/domains/:id/verify      { createWildcard? } re-runs the five checks      (manage)
//   POST   /api/platform/domains/:id/default     { confirm: true }                                (manage)
//   POST   /api/platform/domains/:id/disable | /enable                                            (manage)
//   PATCH  /api/platform/domains/:id             { label?, allowCustomerChoice?, entitlementKey? } (manage)
//   DELETE /api/platform/domains/:id             { confirmHostname }                              (manage)
//
// Moving a site (staff only, same permissions):
//   GET    /api/platform/sites/:siteId/move              options: current domain, targets, past moves, live redirects (read)
//   GET    /api/platform/sites/:siteId/move/preview?targetDomainId=&redirectDays=   new host, effects, blockers (read)
//   POST   /api/platform/sites/:siteId/move              { targetDomainId, confirmHostname, redirectDays? }       (manage)
//   POST   /api/platform/site-moves/:moveId/resume | /rollback                                                    (manage)
//
// Permissions: area "platform", resource "platform_domains": action "read" views, action "update" manages ("platform_domains.manage").
// Super admins pass every check (rbac.js). Every write goes through logAudit.
import * as cloudflareProvider from "./infra-cloudflare.js";
import { createPlatformDomainAdmin } from "./platform-domains-admin.js";
import { hasPermission } from "./rbac.js";
import * as repo from "./repositories/platform-domains.js";
import { renderPlatformDomainsPage } from "./views/pages/platform-domains.js";
import { createSiteDomainMoveService } from "./site-domain-moves.js";
import * as movesRepo from "./repositories/site-domain-moves.js";

export const PERMISSION = { area: "platform", resource: "platform_domains", read: "read", manage: "update" };

let defaultService = null;
const service = () => (defaultService ||= createPlatformDomainAdmin({ infra: cloudflareProvider }));

const ID = "([A-Za-z0-9_-]{1,64})";

export async function handlePlatformDomainsRoute(ctx, deps = {}) {
  const { env, request, url, method, path, admin, requestId, ipHash, json, html, logAudit } = ctx;
  const isPage = method === "GET" && path === "/platform/domains";
  const isMove = path.startsWith("/api/platform/sites/") || path.startsWith("/api/platform/site-moves/");
  if (!isPage && !isMove && !path.startsWith("/api/platform/domains")) return null;
  const svc = deps.service || service();
  const forbidden = () => json({ success: false, error: "forbidden" }, 403);
  const canRead = await hasPermission(env, admin, PERMISSION.area, PERMISSION.resource, PERMISSION.read);
  const canManage = await hasPermission(env, admin, PERMISSION.area, PERMISSION.resource, PERMISSION.manage);
  if (!(canRead || canManage)) return forbidden();

  const body = async () => (method === "GET" ? {} : await request.json().catch(() => ({})));
  if (isMove) {
    const moves = deps.moveService || createSiteDomainMoveService({ infra: cloudflareProvider, redeploy: ctx.redeploy || (async () => ({ ok: false, error: "redeploy_unavailable" })) });
    const needManage = () => (canManage ? null : forbidden());
    const auditMove = (siteId, action, result, reason = "") => logAudit(env, {
      adminId: admin.id, endpoint: path, method, resource: "site", resourceId: siteId, action,
      reason: String(reason).slice(0, 1000), success: !!result.ok, statusCode: result.ok ? 200 : result.status || 400,
      errorMessage: result.ok ? null : result.error, requestId, ipHash
    });
    const moveAnswer = (r) => (r.ok ? json({ success: true, state: r.state, moveId: r.moveId, warnings: r.warnings || [] }) : json({ success: false, error: r.error, detail: r.detail || null, step: r.step || null, blockers: r.blockers || null, moveId: r.moveId || null, state: r.state || null }, r.status || 400));
    let m = path.match(new RegExp(`^/api/platform/sites/${ID}/move(?:/(preview))?$`));
    if (m) {
      const [, siteId, sub] = m;
      if (method === "GET" && sub === "preview") {
        const p = await moves.preview(env, siteId, url.searchParams.get("targetDomainId") || "", { redirectDays: url.searchParams.get("redirectDays") ?? undefined });
        return p.ok ? json({ success: true, data: p }) : json({ success: false, error: p.error }, p.status || 400);
      }
      if (method === "GET" && !sub) {
        const site = await movesRepo.getSiteWithTenant(env, siteId);
        if (!site) return json({ success: false, error: "site_not_found" }, 404);
        const domains = await svc.listWithUsage(env);
        return json({ success: true, data: { site: { id: site.id, name: site.name, slug: site.slug, status: site.status }, targets: domains.filter((d) => d.status === "active").map((d) => ({ id: d.id, hostname: d.hostname, label: d.label, isDefault: d.is_default })), moves: await movesRepo.listMovesForSite(env, siteId), redirects: await movesRepo.listRedirectsForSite(env, siteId) } });
      }
      if (method === "POST" && !sub) {
        const g = needManage(); if (g) return g;
        const b = await body();
        const r = await moves.start(env, { siteId, targetDomainId: b.targetDomainId, confirmHostname: b.confirmHostname, redirectDays: b.redirectDays, actorId: `staff:${admin.id}` });
        await auditMove(siteId, "move_domain", r, `${b.targetDomainId || ""} ${r.ok ? "" : r.error || ""}`.trim());
        return moveAnswer(r);
      }
    }
    m = path.match(new RegExp(`^/api/platform/site-moves/${ID}/(resume|rollback)$`));
    if (m && method === "POST") {
      const g = needManage(); if (g) return g;
      const move = await movesRepo.getMove(env, m[1]);
      if (!move) return json({ success: false, error: "not_found" }, 404);
      const r = await moves[m[2]](env, m[1]);
      await auditMove(move.site_id, `move_${m[2]}`, r, move.id);
      return moveAnswer(r);
    }
    return json({ success: false, error: "not_found" }, 404);
  }

  if (isPage) return html(await renderPlatformDomainsPage(env, admin, { canManage, domains: await svc.listWithUsage(env) }));

  const audit = (resourceId, action, result, reason = "") => logAudit(env, {
    adminId: admin.id, endpoint: path, method, resource: "platform_domain", resourceId, action,
    reason: String(reason || "").slice(0, 1000), success: !!result.ok, statusCode: result.ok ? 200 : result.status || 400,
    errorMessage: result.ok ? null : result.error, requestId, ipHash
  });
  const answer = (result, extra = {}) => result.ok
    ? json({ success: true, ...extra, ...(result.unchanged ? { unchanged: true } : {}) })
    : json({ success: false, error: result.error, detail: result.detail || null, ...(result.sites != null ? { sites: result.sites } : {}) }, result.status || 400);

  if (method === "GET" && path === "/api/platform/domains") return json({ success: true, data: await svc.listWithUsage(env) });

  // everything below the reads needs the manage permission
  const needManage = () => (canManage ? null : forbidden());

  if (method === "POST" && path === "/api/platform/domains") {
    const g = needManage(); if (g) return g;
    const b = await body();
    const result = await svc.addDomain(env, { hostname: b.hostname, label: b.label, actorId: `staff:${admin.id}` });
    await audit(result.ok ? result.domain.id : null, "add", result, b.hostname);
    return answer(result, result.ok ? { data: result.domain } : {});
  }
  if (method === "POST" && path === "/api/platform/domains/reorder") {
    const g = needManage(); if (g) return g;
    const b = await body();
    const result = await svc.reorder(env, b.ids);
    await audit(null, "reorder", result);
    return answer(result);
  }

  const m = path.match(new RegExp(`^/api/platform/domains/${ID}(?:/(verify|default|disable|enable|sites))?$`));
  if (!m) return json({ success: false, error: "not_found" }, 404);
  const [, id, sub] = m;

  if (method === "GET" && !sub) {
    const d = await repo.get(env, id);
    return d ? json({ success: true, data: d }) : json({ success: false, error: "not_found" }, 404);
  }
  if (method === "GET" && sub === "sites") {
    const d = await repo.get(env, id);
    if (!d) return json({ success: false, error: "not_found" }, 404);
    return json({ success: true, data: await repo.listSites(env, id, { isDefault: d.is_default, limit: 100 }) });
  }

  const g = needManage(); if (g) return g;

  if (method === "POST" && sub === "verify") {
    const b = await body();
    const result = await svc.verify(env, id, { adminId: admin.id, createWildcard: b.createWildcard === true });
    await audit(id, "verify", result.ok ? { ok: true } : result, b.createWildcard === true ? "create_wildcard" : "");
    return result.ok ? json({ success: true, passed: result.passed, needsConfirmation: result.needsConfirmation, steps: result.steps, data: result.domain }) : answer(result);
  }
  if (method === "POST" && sub === "default") {
    const b = await body();
    if (b.confirm !== true) return json({ success: false, error: "confirmation_required" }, 422);
    const result = await svc.setDefault(env, id);
    await audit(id, "set_default", result);
    return answer(result);
  }
  if (method === "POST" && (sub === "disable" || sub === "enable")) {
    const result = await svc[sub](env, id);
    await audit(id, sub, result);
    return answer(result);
  }
  if (method === "PATCH" && !sub) {
    const b = await body();
    const fields = {};
    for (const k of ["label", "allowCustomerChoice", "entitlementKey"]) if (k in b) fields[k] = b[k];
    const result = await svc.update(env, id, fields);
    await audit(id, "update", result, Object.keys(fields).join(","));
    return answer(result, result.ok ? { data: result.domain } : {});
  }
  if (method === "DELETE" && !sub) {
    const b = await body();
    const d = await repo.get(env, id);
    if (d && String(b.confirmHostname || "").trim().toLowerCase() !== d.hostname) return json({ success: false, error: "confirmation_required", detail: "Type the domain name to confirm." }, 422);
    const result = await svc.remove(env, id);
    await audit(id, "remove", result, d?.hostname || "");
    return answer(result);
  }
  return json({ success: false, error: "not_found" }, 404);
}
