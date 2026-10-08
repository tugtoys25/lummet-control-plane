// =====================================================
// ANALYTICS
// Central view of a tenant's analytics, at parity with the tenant
// dashboard's own /dashboard/analytics page (Super API v15):
//   - System health   (analytics-health: scheduled-job status, the
//                      diagnosis for "the dashboard shows zero")
//   - Totals cards    (views / clicks / conversions / revenue / commission)
//   - Performance by dimension, with human-readable names (v15 adds
//                      `name` to analytics-overview rows) and formatted
//                      money / percentages
//   - Revenue time series
//   - GEO performance (analytics-geo)
//   - Open alerts     (alerts?status=open, linking to the Alerts page)
//   - Tracking-link health
//   - Manual runs     (aggregate / evaluate alerts / run due reports),
//                      shown only when the admin holds the permission;
//                      the server re-checks it on every POST.
//
// Read-only except the manual runs. Query-string driven
// (?start_date=&end_date=&dimension_type=&currency=), no client state.
//
// Graceful degradation: every section loads independently, so a tenant
// that hasn't redeployed with the v15 routes still gets the sections
// it supports, with a clear per-section message for the ones it doesn't.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { hasPermission } from "../../rbac.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";
const DIMENSION_TYPES = [
  "casino", "offer", "tracking_link", "partner", "program",
  "account", "campaign", "review", "news", "page"
];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- pure helpers (exported for tests) ----------

export function defaultDateRange(now = new Date()) {
  const start = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(now) };
}

export function fmtNum(n) {
  return (Number(n) || 0).toLocaleString("en-US");
}

export function fmtMoney(n, currency) {
  const v = Number(n) || 0;
  const body = v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${body} ${currency}` : body;
}

export function fmtPct(n) {
  return `${((Number(n) || 0) * 100).toFixed(2)}%`;
}

/** Sum the additive columns across dimension rows (same as the tenant's stat cards). */
export function computeTotals(rows) {
  return (rows || []).reduce((acc, r) => ({
    views: acc.views + (Number(r.views) || 0),
    clicks: acc.clicks + (Number(r.clicks) || 0),
    conversions: acc.conversions + (Number(r.conversions) || 0),
    revenue: acc.revenue + (Number(r.revenue) || 0),
    commission: acc.commission + (Number(r.commission) || 0)
  }), { views: 0, clicks: 0, conversions: 0, revenue: 0, commission: 0 });
}

/** Distinct currencies present in the rows (money must never be summed across them silently). */
export function currenciesOf(rows) {
  return [...new Set((rows || []).map((r) => r.currency).filter(Boolean))];
}

export function dimensionLabel(row) {
  if (row.name) return row.name;
  return row.dimensionId != null ? `#${row.dimensionId}` : "Overall";
}

function sectionError(result, fallback) {
  return `<div class="flash flash-error"><strong>${escapeHtml(String(result.status))}</strong> — ${escapeHtml(result.message || fallback)}</div>`;
}

// A generic "not found" message from the HTTP layer (client.js's
// messageForStatus) is technically accurate but unhelpful for a route
// that's simply new: a 404 on one of the v15-only endpoints almost
// always means the tenant hasn't redeployed yet, not that the data
// doesn't exist. Overrides the message for exactly that case.
function sectionErrorV15Aware(result, notFoundHint) {
  const message = result.status === 404
    ? `${notFoundHint} If this tenant hasn't redeployed with Super API v15 yet, that's why.`
    : (result.message || notFoundHint);
  return sectionError({ ...result, message }, notFoundHint);
}

function statCard(label, value) {
  return `<div class="card" style="flex:1;min-width:150px;margin:0;"><div style="font-size:12px;color:var(--text-dim);">${escapeHtml(label)}</div><div style="font-size:22px;font-weight:600;">${escapeHtml(value)}</div></div>`;
}

export function renderTotalsCards(rows, currencyFilter) {
  const t = computeTotals(rows);
  const currencies = currenciesOf(rows);
  const mixed = currencies.length > 1;
  // With mixed currencies a single money total would be meaningless.
  const money = (n) => (mixed ? "mixed currencies" : fmtMoney(n, currencies[0] || currencyFilter || ""));
  return `<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;">
    ${statCard("Views", fmtNum(t.views))}
    ${statCard("Clicks", fmtNum(t.clicks))}
    ${statCard("Conversions", fmtNum(t.conversions))}
    ${statCard("Revenue", money(t.revenue))}
    ${statCard("Commission", money(t.commission))}
  </div>${mixed ? `<p style="font-size:12px;color:var(--text-dim);margin-top:-6px;">Rows span ${escapeHtml(currencies.join(", "))}. Pick a currency in the filter for money totals — revenue is never summed across currencies.</p>` : ""}`;
}

export function renderPerformanceTable(rows) {
  if (!rows.length) return `<p class="empty">No data for that range/dimension.</p>`;
  return `<div style="overflow-x:auto;"><table class="table">
    <thead><tr><th>Name</th><th>Currency</th><th>Views</th><th>Clicks</th><th>Conversions</th><th>Revenue</th><th>Commission</th><th>CTR</th><th>CVR</th><th>EPC</th><th>RPC</th><th>CPA</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${escapeHtml(dimensionLabel(r))}</td>
      <td>${escapeHtml(r.currency ?? "")}</td>
      <td>${fmtNum(r.views)}</td><td>${fmtNum(r.clicks)}</td><td>${fmtNum(r.conversions)}</td>
      <td>${fmtMoney(r.revenue)}</td><td>${fmtMoney(r.commission)}</td>
      <td>${fmtPct(r.ctr)}</td><td>${fmtPct(r.cvr)}</td>
      <td>${fmtMoney(r.epc)}</td><td>${fmtMoney(r.rpc)}</td><td>${fmtMoney(r.cpa)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

export function renderSeriesTable(series) {
  if (!series.length) return `<p class="empty">No revenue data for that range/currency.</p>`;
  return `<div style="overflow-x:auto;"><table class="table">
    <thead><tr><th>Date</th><th>Views</th><th>Clicks</th><th>Conversions</th><th>Revenue</th><th>Commission</th><th>CTR</th><th>CVR</th></tr></thead>
    <tbody>${series.map((r) => `<tr>
      <td>${escapeHtml(r.date)}</td><td>${fmtNum(r.views)}</td><td>${fmtNum(r.clicks)}</td><td>${fmtNum(r.conversions)}</td>
      <td>${fmtMoney(r.revenue)}</td><td>${fmtMoney(r.commission)}</td><td>${fmtPct(r.ctr)}</td><td>${fmtPct(r.cvr)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

export function renderGeoTable(rows) {
  if (!rows.length) return `<p class="empty">No GEO data for that range.</p>`;
  return `<div style="overflow-x:auto;"><table class="table">
    <thead><tr><th>Country</th><th>Clicks</th><th>Conversions</th><th>Revenue</th><th>Commission</th><th>CVR</th><th>EPC</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${escapeHtml(r.country || "Unknown")}</td><td>${fmtNum(r.clicks)}</td><td>${fmtNum(r.conversions)}</td>
      <td>${fmtMoney(r.revenue)}</td><td>${fmtMoney(r.commission)}</td><td>${fmtPct(r.cvr)}</td><td>${fmtMoney(r.epc)}</td>
    </tr>`).join("")}</tbody></table></div>`;
}

const HEALTH_LABEL = {
  ok: "OK", stale: "Stale — has stopped running", disabled: "Disabled (feature flag off)", never_run: "Never run"
};

export function renderHealthTable(jobs) {
  if (!jobs.length) return `<p class="empty">No scheduled jobs reported.</p>`;
  return `<table class="table">
    <thead><tr><th>Job</th><th>Status</th><th>Last run</th></tr></thead>
    <tbody>${jobs.map((j) => `<tr>
      <td>${escapeHtml(j.label || j.key)}</td>
      <td>${escapeHtml(HEALTH_LABEL[j.status] || j.status)}</td>
      <td>${escapeHtml(j.lastRunAt || "—")}</td>
    </tr>`).join("")}</tbody></table>`;
}

export function renderAlertsSummary(alerts) {
  if (!alerts.length) return `<p class="empty">No open alerts.</p>`;
  return `<table class="table">
    <thead><tr><th>Rule</th><th>Scope</th><th>Fired</th></tr></thead>
    <tbody>${alerts.slice(0, 10).map((a) => `<tr>
      <td>${escapeHtml(a.rule_name || a.metric || "")}</td>
      <td>${escapeHtml(a.scope_type || "")}${a.scope_id ? " · " + escapeHtml(a.scope_id) : ""}</td>
      <td>${escapeHtml(a.created_at || "")}</td>
    </tr>`).join("")}</tbody></table>${alerts.length > 10 ? `<p style="font-size:12px;color:var(--text-dim);">Showing 10 of ${escapeHtml(alerts.length)}.</p>` : ""}`;
}

// ---------- page ----------

export async function renderAnalyticsPage(env, admin, query = {}) {
  const activeKey = "content-analytics";
  const title = "Analytics";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const defaults = defaultDateRange();
  const startDate = DATE_RE.test(query.start_date || "") ? query.start_date : defaults.startDate;
  const endDate = DATE_RE.test(query.end_date || "") ? query.end_date : defaults.endDate;
  const dimensionType = DIMENSION_TYPES.includes(query.dimension_type) ? query.dimension_type : "casino";
  const currency = String(query.currency || "").trim().toUpperCase().slice(0, 8);

  const q = (obj) => Object.entries(obj)
    .filter(([, v]) => v !== "" && v != null)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const range = { start_date: startDate, end_date: endDate };

  const [overviewResult, revenueResult, geoResult, healthResult, alertsResult, trackingResult, canRun] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/analytics-overview?${q({ ...range, dimension_type: dimensionType, currency })}`),
    // analytics-revenue REQUIRES a currency (never summed across currencies); default to USD only for the series.
    getFromTenant(env, tenant, `${BASE_PATH}/analytics-revenue?${q({ ...range, currency: currency || "USD" })}`),
    getFromTenant(env, tenant, `${BASE_PATH}/analytics-geo?${q({ ...range, currency })}`),
    getFromTenant(env, tenant, `${BASE_PATH}/analytics-health`),
    getFromTenant(env, tenant, `${BASE_PATH}/alerts?status=open`),
    getFromTenant(env, tenant, `${BASE_PATH}/tracking-health`),
    hasPermission(env, admin, "tenant", "analytics", "create")
  ]);

  const filterBar = `
    <form class="card" method="GET" action="/content/analytics" style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
      <label>Start date<input type="date" name="start_date" value="${escapeHtml(startDate)}" /></label>
      <label>End date<input type="date" name="end_date" value="${escapeHtml(endDate)}" /></label>
      <label>Dimension
        <select name="dimension_type">
          ${DIMENSION_TYPES.map((d) => `<option value="${d}" ${d === dimensionType ? "selected" : ""}>${d}</option>`).join("")}
        </select>
      </label>
      <label>Currency <span style="color:var(--text-dim);font-weight:400;">(blank = all)</span><input type="text" name="currency" value="${escapeHtml(currency)}" placeholder="USD" style="width:90px;" /></label>
      <button type="submit" class="btn btn-small">Apply</button>
    </form>`;

  const overviewRows = overviewResult.ok ? overviewResult.data.rows || [] : [];
  const overviewHtml = overviewResult.ok
    ? renderTotalsCards(overviewRows, currency) + renderPerformanceTable(overviewRows)
    : sectionError(overviewResult, "Could not load overview.");

  const revenueHtml = revenueResult.ok
    ? renderSeriesTable(revenueResult.data.series || [])
    : sectionError(revenueResult, "Could not load revenue.");

  const geoHtml = geoResult.ok
    ? renderGeoTable(geoResult.data.rows || [])
    : sectionErrorV15Aware(geoResult, "Could not load GEO data.");

  const healthJobs = healthResult.ok ? healthResult.data.jobs || [] : [];
  const needsAttention = healthJobs.some((j) => j.status !== "ok");
  const healthHtml = healthResult.ok
    ? renderHealthTable(healthJobs) + (needsAttention
        ? `<p style="font-size:13px;color:var(--text-dim);">If numbers look empty, a job above that is "Never run", "Disabled" or "Stale" is usually why — aggregation fills the daily tables these reports read.</p>`
        : "")
    : sectionErrorV15Aware(healthResult, "Could not load scheduled-job health.");

  const openAlerts = alertsResult.ok ? alertsResult.data.data || [] : [];
  const alertsHtml = alertsResult.ok
    ? renderAlertsSummary(openAlerts)
    : sectionError(alertsResult, "Could not load alerts.");

  let trackingHtml;
  if (!trackingResult.ok) {
    trackingHtml = sectionError(trackingResult, "Could not load tracking health.");
  } else {
    const counts = trackingResult.data.counts || {};
    const unhealthy = trackingResult.data.unhealthy_links || [];
    trackingHtml = `
      <p>${Object.entries(counts).map(([status, count]) => `<strong>${escapeHtml(count)}</strong> ${escapeHtml(status)}`).join(" &nbsp;·&nbsp; ") || "No tracking links yet."}</p>
      ${unhealthy.length ? `<table class="table"><thead><tr><th>Link</th><th>Status</th></tr></thead>
        <tbody>${unhealthy.map((l) => `<tr><td>${escapeHtml(l.name)}</td><td>${escapeHtml(l.status)}</td></tr>`).join("")}</tbody></table>` : ""}`;
  }

  const runsHtml = canRun ? `
    <div class="card">
      <h3 style="margin-top:0;">Manual runs</h3>
      <p style="font-size:13px;color:var(--text-dim);">Same actions as the tenant dashboard. Aggregation rebuilds the daily tables for the date range chosen above; the others run immediately.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button type="button" class="btn btn-small" data-run="aggregate">Run aggregation for range</button>
        <button type="button" class="btn btn-small" data-run="evaluate-alerts">Evaluate alert rules now</button>
        <button type="button" class="btn btn-small" data-run="run-due-reports">Run due scheduled reports now</button>
      </div>
      <div id="manualRunResult" style="margin-top:10px;font-size:13px;"></div>
    </div>
    <script nonce="${nonceToken()}">
      document.querySelectorAll("[data-run]").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          var kind = btn.dataset.run;
          var out = document.getElementById("manualRunResult");
          btn.disabled = true; out.textContent = "Running…";
          try {
            var body = kind === "aggregate" ? { start_date: ${JSON.stringify(startDate)}, end_date: ${JSON.stringify(endDate)} } : {};
            var res = await fetch("/api/analytics/" + kind, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
            var data = await res.json().catch(function () { return {}; });
            out.textContent = data.success ? "Done. Reload to see updated numbers." : "Failed: " + (data.message || data.error || "unknown error");
          } catch (e) { out.textContent = "Failed: network error"; }
          btn.disabled = false;
        });
      });
    </script>` : "";

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · Analytics on <strong>${escapeHtml(tenant.name)}</strong></p>
    ${filterBar}

    <div class="card">
      <h3 style="margin-top:0;">System health</h3>
      ${healthHtml}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Performance by ${escapeHtml(dimensionType)}</h3>
      ${overviewHtml}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Daily trend — ${escapeHtml(currency || "USD")}</h3>
      ${revenueHtml}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">GEO performance</h3>
      ${geoHtml}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Open alerts <a href="/content/alerts" style="font-size:13px;font-weight:400;margin-left:8px;">Manage alerts &amp; rules →</a></h3>
      ${alertsHtml}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Tracking link health</h3>
      ${trackingHtml}
    </div>

    ${runsHtml}
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

// ---------- manual runs (called from index.js after its permission + tenant guards) ----------

async function tenantFor(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

const RUN_PATHS = {
  aggregate: "analytics-aggregate",
  "evaluate-alerts": "analytics-evaluate-alerts",
  "run-due-reports": "analytics-run-due-reports"
};

export function isKnownAnalyticsRun(kind) {
  return Object.prototype.hasOwnProperty.call(RUN_PATHS, kind);
}

export async function submitAnalyticsRun(env, admin, kind, payload) {
  if (!isKnownAnalyticsRun(kind)) return { ok: false, status: 404, reason: "unknown_run" };
  const tenant = await tenantFor(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const body = kind === "aggregate"
    ? { start_date: String(payload?.start_date || ""), end_date: String(payload?.end_date || "") }
    : {};
  return postToTenant(env, tenant, `${BASE_PATH}/${RUN_PATHS[kind]}`, body);
}
