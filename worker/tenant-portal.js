// =====================================================
// TENANT PORTAL DATA (master prompt section 25: "Expand
// the control plane so customers can view analytics
// centrally through the tenant Super API.")
//
// This is deliberately a thin proxy, not a reimplementation.
// Every call here goes through client.js's requestTenant()
// (the ONLY place in this repo that constructs a raw fetch to
// a tenant — see client.js's own header comment) against the
// tenant's REAL, already-existing Super API v8/v9 endpoints —
// nothing here invents new tenant-side functionality.
//
// Two gates apply before any tenant call is made:
//  1. Entitlement — does this ORGANIZATION's plan include this
//     capability at all (analytics.level, reports.enabled,
//     campaigns via affiliate.enabled, alerts.enabled)?
//  2. Deployment — does this SITE actually have a tenant_id yet
//     (i.e. did it make it through Phase 3 provisioning)?
// Only if both pass does a real HTTP call happen. A site that
// fails either gate gets a clear, specific error — never a
// silent empty result that looks like "no data yet".
// =====================================================

import * as realClient from "./client.js";
import * as entitlementsService from "./entitlements.js";

function buildQuery(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== "");
  if (!entries.length) return "";
  return "?" + entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

async function hasAnalyticsAccess(env, organizationId) {
  const level = await entitlementsService.checkEntitlement(env, organizationId, "analytics.level");
  return !!level && level !== "none";
}

async function hasBooleanEntitlement(env, organizationId, key) {
  return (await entitlementsService.checkEntitlement(env, organizationId, key)) === true;
}

export function createTenantPortalService(client) {
  async function callTenant(env, site, path, { method = "GET", body } = {}) {
    if (!site.tenant_id) {
      return { ok: false, status: 409, reason: "site_not_deployed", message: "This site has not been deployed yet." };
    }
    return method === "GET"
      ? client.getFromTenant(env, site.tenant_id, path)
      : client.postToTenant(env, site.tenant_id, path, body ?? null);
  }

  // -----------------------------------------------------
  // Analytics (v8) — gated on entitlements["analytics.level"] != "none"
  // -----------------------------------------------------

  async function getAnalyticsOverview(env, site, { startDate, endDate, dimensionType, currency } = {}) {
    if (!(await hasAnalyticsAccess(env, site.organization_id))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Analytics is not included in this organization's plan." };
    }
    const qs = buildQuery({ start_date: startDate, end_date: endDate, dimension_type: dimensionType, currency });
    return callTenant(env, site, `/en/api/super/analytics-overview${qs}`);
  }

  async function getAnalyticsRevenue(env, site, { startDate, endDate, currency } = {}) {
    if (!(await hasAnalyticsAccess(env, site.organization_id))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Analytics is not included in this organization's plan." };
    }
    const qs = buildQuery({ start_date: startDate, end_date: endDate, currency });
    return callTenant(env, site, `/en/api/super/analytics-revenue${qs}`);
  }

  async function getTrackingHealth(env, site) {
    if (!(await hasAnalyticsAccess(env, site.organization_id))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Analytics is not included in this organization's plan." };
    }
    return callTenant(env, site, `/en/api/super/tracking-health`);
  }

  // -----------------------------------------------------
  // Reports (v9) — gated on entitlements["reports.enabled"]
  // -----------------------------------------------------

  async function listReports(env, site) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "reports.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Reports are not included in this organization's plan." };
    }
    return callTenant(env, site, `/en/api/super/reports`);
  }

  async function getReport(env, site, reportId) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "reports.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Reports are not included in this organization's plan." };
    }
    return callTenant(env, site, `/en/api/super/reports/${encodeURIComponent(reportId)}`);
  }

  async function runReport(env, site, reportId) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "reports.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Reports are not included in this organization's plan." };
    }
    return callTenant(env, site, `/en/api/super/reports/${encodeURIComponent(reportId)}/run`, { method: "POST" });
  }

  // -----------------------------------------------------
  // Campaigns (v9) — gated on entitlements["affiliate.enabled"]
  // (campaign metadata references offers/tracking links, both
  // part of this platform's affiliate system)
  // -----------------------------------------------------

  async function listCampaigns(env, site) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "affiliate.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Campaigns require the affiliate feature set." };
    }
    return callTenant(env, site, `/en/api/super/campaigns`);
  }

  async function getCampaign(env, site, campaignId) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "affiliate.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Campaigns require the affiliate feature set." };
    }
    return callTenant(env, site, `/en/api/super/campaigns/${encodeURIComponent(campaignId)}`);
  }

  async function createCampaign(env, site, payload) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "affiliate.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Campaigns require the affiliate feature set." };
    }
    return callTenant(env, site, `/en/api/super/campaigns`, { method: "POST", body: payload });
  }

  // -----------------------------------------------------
  // Alerts (v9) — gated on entitlements["alerts.enabled"]
  // -----------------------------------------------------

  async function listAlerts(env, site) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "alerts.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Alerts are not included in this organization's plan." };
    }
    return callTenant(env, site, `/en/api/super/alerts`);
  }

  async function acknowledgeAlert(env, site, alertId) {
    if (!(await hasBooleanEntitlement(env, site.organization_id, "alerts.enabled"))) {
      return { ok: false, status: 403, reason: "not_entitled", message: "Alerts are not included in this organization's plan." };
    }
    return callTenant(env, site, `/en/api/super/alerts/${encodeURIComponent(alertId)}/acknowledge`, { method: "POST" });
  }

  return {
    getAnalyticsOverview,
    getAnalyticsRevenue,
    getTrackingHealth,
    listReports,
    getReport,
    runReport,
    listCampaigns,
    getCampaign,
    createCampaign,
    listAlerts,
    acknowledgeAlert
  };
}

// Production singleton — used by index.js. Tests import
// createTenantPortalService directly with a fake client instead of
// this (test/support/fake-tenant-client.js).
export const tenantPortal = createTenantPortalService(realClient);
