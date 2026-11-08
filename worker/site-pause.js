// =====================================================
// PAUSE / RESUME A LIVE SITE (customer)
//
// A customer can take their own live site offline without deleting it, and put it back. It uses the same machinery as a staff
// suspension (status `suspended` plus a signed access state pushed to the tenant, so visitors stop being served), but the two are
// kept apart: the status history records who suspended the site, and a customer may only resume a site THEY paused. A site Lummet
// suspended (abuse, billing) stays suspended until staff reactivate it, so pausing can never be used to get around a suspension.
// =====================================================
import * as sites from "./sites.js";
import * as access from "./site-access.js";
import * as organizations from "./organizations.js";
import * as repo from "./repositories/site-pause.js";

export const PAUSE_ACTOR = "customer_user";

export async function pauseSite(env, { organizationId, siteId, actorUserId, reason = null }, { siteAccess = access } = {}) {
  const site = await sites.getSite(env, siteId);
  if (!site || site.organization_id !== organizationId) return { ok: false, status: 404, error: "site_not_found" };
  if (site.status === "suspended") return { ok: false, status: 409, error: "already_paused" };
  if (site.status !== "active") return { ok: false, status: 409, error: "site_not_live", currentStatus: site.status };
  const r = await siteAccess.suspendSite(env, siteId, { reason: String(reason || "paused by the customer").slice(0, 300), actorId: String(actorUserId || ""), actorType: PAUSE_ACTOR });
  return r.ok ? { ok: true } : r;
}

export async function resumeSite(env, { organizationId, siteId, actorUserId }, { siteAccess = access } = {}) {
  const site = await sites.getSite(env, siteId);
  if (!site || site.organization_id !== organizationId) return { ok: false, status: 404, error: "site_not_found" };
  if (site.status !== "suspended") return { ok: false, status: 409, error: "not_paused", currentStatus: site.status };
  // Only a pause the customer made can be undone by the customer.
  if ((await repo.lastSuspensionActor(env, siteId)) !== PAUSE_ACTOR) return { ok: false, status: 403, error: "suspended_by_lummet" };
  const org = await organizations.getOrganization(env, organizationId);
  if (!org || org.status !== "active") return { ok: false, status: 409, error: "organization_not_active" };
  const r = await siteAccess.reactivateSite(env, siteId, { reason: "resumed by the customer", actorId: String(actorUserId || ""), actorType: PAUSE_ACTOR });
  return r.ok ? { ok: true } : r;
}
