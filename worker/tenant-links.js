// =====================================================
// ACTING ON A SITE'S TRACKING LINKS (v7H)
//
// One place that may switch tracking links off on a customer's site, used by the portal button and by the
// "disable the unhealthy link" automation action, so both obey the same rules:
//   * only links of a LIVE site that belongs to the organization (a site id from a request or an event is never trusted);
//   * the organization's plan must include affiliate tools;
//   * the only change ever made is status -> "disabled" (reversible on the site's own dashboard; never a delete);
//   * at most MAX_IDS links per call, one request to the site's Super API per link, each answered on its own.
// =====================================================
import * as sites from "./sites.js";
import * as entitlementsService from "./entitlements.js";
import * as client from "./client.js";

export const MAX_IDS = 50;
/** Health values worth acting on. 'unknown' (never checked), 'healthy' and 'disabled' are not problems. */
export const UNHEALTHY_STATUSES = ["warning", "broken", "restricted", "timeout"];

export async function disableTrackingLinks(env, { organizationId, siteId, ids }) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS) return { ok: false, status: 422, error: "invalid_ids" };
  const unique = [...new Set(ids.map((x) => Number(x)))];
  if (unique.some((n) => !Number.isInteger(n) || n < 1)) return { ok: false, status: 422, error: "invalid_ids" };

  const site = await sites.getSite(env, siteId);
  if (!site || site.organization_id !== organizationId) return { ok: false, status: 404, error: "not_found" };
  if (site.status !== "active" || !site.tenant_id) return { ok: false, status: 409, error: "site_not_live" };
  if (!(await entitlementsService.requireEntitlement(env, organizationId, "affiliate.enabled"))) {
    return { ok: false, status: 403, error: "not_entitled" };
  }

  const results = [];
  for (const id of unique) {
    const r = await client.requestTenant(env, site.tenant_id, { method: "PUT", path: `/en/api/super/tracking-links/${id}`, body: { status: "disabled" } });
    results.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.reason || "tenant_error" });
  }
  return { ok: true, results, disabled: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
