// =====================================================
// CUSTOMER API FOR CUSTOM CLOUDFLARE HOSTING (/api/organizations/:id/cloud-hosting/*, /api/organizations/:id/sites/:id/hosting/*)
//
// index.js matches the paths (so the route census and the isolation matrix see them) and hands the request here, after the
// membership, IP allowlist, suspension and billing gates have run. Rules for every route:
//   - not enabled for the organization AND nothing in use -> 404 (the feature does not exist for it)
//   - reading needs membership; anything that changes something needs admin
//   - every change is audited; no answer ever contains a token, an R2 secret key or an email API key
//   - input is validated before any call to Cloudflare
// =====================================================
import * as customHosting from "./custom-hosting.js";
import * as repo from "./repositories/custom-hosting.js";
import * as sites from "./sites.js";
import { hostingTransfers, hostingInfra } from "./custom-hosting-transfer.js";

const ID = /^[A-Za-z0-9-]{1,64}$/;
const ACCOUNTS = /^\/cloud-hosting\/accounts(?:\/([^/]+))?(?:\/(verify|subdomain|zones))?(?:\/([^/]+)\/check)?$/;
const SITE = /^\/sites\/([^/]+)\/hosting(?:\/(domain|variables|transfer|transfer\/cancel|transfer\/confirm-skipped|transfer\/remove-old-copy))?$/;

export function isCustomHostingPath(subPath) {
  return subPath === "/cloud-hosting" || ACCOUNTS.test(subPath) || SITE.test(subPath);
}

/**
 * c: { env, ctx, request, method, path, organizationId, customer, requireOrgRole, audit, json, dispatchJob, redeploy }
 *   audit(fields)       logAudit with the request's actor, ids and ip hash filled in
 *   dispatchJob(jobId)  jobRunner.dispatchJob(env, ctx, jobId)
 *   redeploy(siteId)    starts a redeploy of the site's current release (makeDomainRedeploy)
 */
export async function handleCustomHostingRoute(c) {
  const { env, method, organizationId, json } = c;
  // The part after /api/organizations/:org (index.js's org route block), derived from the path.
  const subPath = (String(c.path || "").match(/^\/api\/organizations\/[^/]+(\/.*)?$/) || [])[1] || "";
  const access = await customHosting.accessFor(env, organizationId);
  if (!access.enabled && !access.inUse) return json({ success: false, error: "not_found" }, 404);
  const fail = (r) => json({ success: false, error: r.error, ...(r.message ? { message: r.message } : {}), ...(r.errors ? { errors: r.errors } : {}), ...(r.sites ? { sites: r.sites } : {}), ...(r.failures ? { failures: r.failures } : {}), ...(r.missing ? { missing: r.missing } : {}) }, r.status || 400);
  const admin = async () => c.requireOrgRole(organizationId, "admin");
  const body = async () => (method === "GET" || method === "DELETE") ? {} : await c.request.json().catch(() => ({}));
  const guarded = async (fn) => {
    try { return await fn(); }
    catch (e) {
      if (e instanceof customHosting.HostingError) return fail({ status: e.status, error: e.code, message: e.message });
      throw e;
    }
  };
  const accessView = { enabled: access.enabled, reason: access.reason, accounts: access.accounts, sites: access.sites };

  if (subPath === "/cloud-hosting") {
    if (method !== "GET") return json({ success: false, error: "method_not_allowed" }, 405);
    const hosted = await repo.listSiteHostingForOrg(env, organizationId);
    const siteViews = [];
    for (const h of hosted) siteViews.push({ siteId: h.site_id, name: h.site_name || null, ...(await customHosting.siteHostingView(env, h.site_id)), transfer: await hostingTransfers.transferView(env, h.site_id) });
    return json({ success: true, data: { access: accessView, accounts: await customHosting.listAccounts(env, organizationId), sites: siteViews } });
  }

  const a = subPath.match(ACCOUNTS);
  if (a) {
    const [, id, action, zoneId] = a;
    if (id && !ID.test(id)) return json({ success: false, error: "not_found" }, 404);
    if (zoneId && action !== "zones") return json({ success: false, error: "not_found" }, 404);
    if (!id) {
      if (action) return json({ success: false, error: "not_found" }, 404);
      if (method === "GET") return json({ success: true, data: await customHosting.listAccounts(env, organizationId) });
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const input = await body();
      return guarded(async () => {
        const r = await customHosting.addAccount(env, { organizationId, actorUserId: c.customer.id, input, infra: hostingInfra });
        await c.audit({ resource: "cloud_hosting_account", resourceId: r.ok ? r.account.id : null, action: "create", success: r.ok, statusCode: r.ok ? 201 : r.status, errorMessage: r.ok ? null : r.error });
        if (!r.ok) return fail(r);
        return json({ success: true, data: r.account, check: r.check }, 201);
      });
    }
    // Every id-bearing route answers 404 for an id that is not this organization's (no hint that it exists elsewhere).
    if (!(await repo.getAccount(env, organizationId, id))) return json({ success: false, error: "not_found" }, 404);
    if (!action) {
      if (method === "GET") return json({ success: true, data: await customHosting.getAccountView(env, organizationId, id) });
      if (method === "PATCH" || method === "PUT") {
        const g = await admin(); if (g) return g;
        const input = await body();
        const r = await customHosting.updateAccount(env, { organizationId, id, input, infra: hostingInfra });
        await c.audit({ resource: "cloud_hosting_account", resourceId: id, action: "update", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
        if (!r.ok) return fail(r);
        // New email or R2 settings reach the sites on this account with their next deploy; start it now.
        if (r.redeployNeeded) for (const s of await repo.sitesUsingAccount(env, id)) await c.redeploy(s.id).catch(() => {});
        return json({ success: true, data: r.account, check: r.check, redeployed: !!r.redeployNeeded });
      }
      if (method === "DELETE") {
        const g = await admin(); if (g) return g;
        const r = await customHosting.removeAccount(env, { organizationId, id });
        await c.audit({ resource: "cloud_hosting_account", resourceId: id, action: "delete", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
        if (!r.ok) return fail(r);
        return json({ success: true });
      }
      return json({ success: false, error: "method_not_allowed" }, 405);
    }
    if (action === "verify" && !zoneId) {
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const r = await customHosting.verifyAccount(env, organizationId, id, { infra: hostingInfra });
      await c.audit({ resource: "cloud_hosting_account", resourceId: id, action: "verify", success: r.ok, statusCode: r.ok ? 200 : r.status });
      if (!r.ok) return fail(r);
      return json({ success: true, data: r.account, check: r.check });
    }
    if (action === "subdomain" && !zoneId) {
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const input = await body();
      const r = await customHosting.claimWorkersSubdomain(env, { organizationId, id, subdomain: input.subdomain, infra: hostingInfra });
      await c.audit({ resource: "cloud_hosting_account", resourceId: id, action: "claim_workers_subdomain", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
      if (!r.ok) return fail(r);
      // The subdomain was the last thing missing for many new accounts: check again so the status can become verified.
      const check = await customHosting.verifyAccount(env, organizationId, id, { infra: hostingInfra }).catch(() => null);
      return json({ success: true, subdomain: r.subdomain, data: check?.account || null });
    }
    if (action === "zones" && !zoneId) {
      if (method === "GET") {
        const r = await customHosting.listZones(env, { organizationId, id, infra: hostingInfra });
        if (!r.ok) return fail(r);
        return json({ success: true, data: r.zones });
      }
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const input = await body();
      return guarded(async () => {
        const r = await customHosting.addZone(env, { organizationId, id, domain: input.domain, infra: hostingInfra });
        await c.audit({ resource: "cloud_hosting_zone", resourceId: r.ok ? r.zone.id : null, action: "create", success: r.ok, statusCode: r.ok ? 201 : r.status, errorMessage: r.ok ? null : r.error });
        if (!r.ok) return fail(r);
        return json({ success: true, data: r.zone }, 201);
      });
    }
    if (action === "zones" && zoneId) {
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      if (!/^[a-f0-9]{32}$/i.test(zoneId)) return json({ success: false, error: "not_found" }, 404);
      const r = await customHosting.checkZone(env, { organizationId, id, zoneId, infra: hostingInfra }).catch((e) => ({ ok: false, status: 502, error: "cloudflare_error", message: String(e?.message || "").slice(0, 200) }));
      if (!r.ok) return fail(r);
      return json({ success: true, data: r.zone });
    }
    return json({ success: false, error: "not_found" }, 404);
  }

  const s = subPath.match(SITE);
  if (s) {
    const [, siteId, action] = s;
    if (!ID.test(siteId)) return json({ success: false, error: "not_found" }, 404);
    const site = await sites.getSite(env, siteId);
    if (!site || site.organization_id !== organizationId) return json({ success: false, error: "not_found" }, 404);

    if (!action) {
      if (method !== "GET") return json({ success: false, error: "method_not_allowed" }, 405);
      return json({ success: true, data: { ...(await customHosting.siteHostingView(env, siteId)), transfer: await hostingTransfers.transferView(env, siteId), canMove: access.enabled } });
    }
    if (action === "domain") {
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const input = await body();
      const r = await customHosting.changeSiteDomain(env, { organizationId, siteId, choice: input, infra: hostingInfra });
      await c.audit({ resource: "site_hosting", resourceId: siteId, action: "change_domain", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
      if (!r.ok) return fail(r);
      if (!r.unchanged) { await customHosting.applyHostChange(env, site, r.host); await c.redeploy(siteId).catch(() => {}); }
      return json({ success: true, host: r.host, redeployed: !r.unchanged });
    }
    if (action === "variables") {
      if (method !== "POST" && method !== "PUT") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const input = await body();
      const r = await customHosting.setSiteVariables(env, { organizationId, siteId, variables: input.variables });
      await c.audit({ resource: "site_hosting", resourceId: siteId, action: "set_variables", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
      if (!r.ok) return fail(r);
      if (input.redeploy !== false) await c.redeploy(siteId).catch(() => {});
      return json({ success: true, data: await customHosting.siteHostingView(env, siteId) });
    }
    if (action === "transfer") {
      if (method === "GET") {
        const view = await hostingTransfers.transferView(env, siteId);
        // A move that paused between slices continues when someone looks at it (the queue or the sweep would also pick it up).
        if (view?.paused && view.jobId) await c.dispatchJob(view.jobId).catch(() => {});
        return json({ success: true, data: view });
      }
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const input = await body();
      const r = await hostingTransfers.startTransfer(env, { organizationId, siteId, choice: input, actorUserId: c.customer.id });
      await c.audit({ resource: "site_hosting", resourceId: siteId, action: "transfer_start", success: r.ok, statusCode: r.ok ? 202 : r.status, errorMessage: r.ok ? null : r.error });
      if (!r.ok) return fail(r);
      await c.dispatchJob(r.jobId);
      return json({ success: true, transferId: r.transferId, jobId: r.jobId }, 202);
    }
    if (action === "transfer/confirm-skipped") {
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const r = await hostingTransfers.confirmSkipped(env, { organizationId, siteId });
      await c.audit({ resource: "site_hosting", resourceId: siteId, action: "transfer_confirm_skipped", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
      if (!r.ok) return fail(r);
      if (r.jobId) await c.dispatchJob(r.jobId).catch(() => {});
      return json({ success: true });
    }
    if (action === "transfer/cancel") {
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const r = await hostingTransfers.cancelTransfer(env, { organizationId, siteId });
      await c.audit({ resource: "site_hosting", resourceId: siteId, action: "transfer_cancel", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
      if (!r.ok) return fail(r);
      return json({ success: true });
    }
    if (action === "transfer/remove-old-copy") {
      if (method !== "POST") return json({ success: false, error: "method_not_allowed" }, 405);
      const g = await admin(); if (g) return g;
      const r = await hostingTransfers.removeOldCopy(env, { organizationId, siteId });
      await c.audit({ resource: "site_hosting", resourceId: siteId, action: "transfer_remove_old_copy", success: r.ok, statusCode: r.ok ? 200 : r.status, errorMessage: r.ok ? null : r.error });
      if (!r.ok) return fail(r);
      return json({ success: true });
    }
  }
  return json({ success: false, error: "not_found" }, 404);
}
