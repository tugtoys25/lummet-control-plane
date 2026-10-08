// =====================================================
// ANALYTICS ALERTS
// Wraps en/worker/super/handlers-reporting.js's ALERTS section
// (backed by en/worker/database/alerts.js).
//
// NOT built on the generic crud.js pattern: the Super API exposes
// list+create for rules (no GET /:id, no PUT, no DELETE at all -- see
// that handler file's header: "create/delete rules is admin-only" on
// the tenant dashboard itself, and the Super API mirrors exactly that
// split, nothing more). An "Edit" link would have nowhere to load
// from or save to, so rules are create-only here, matching what the
// tenant dashboard itself allows. Fired alerts (the analytics_alerts
// table, distinct from the rules that generate them) are listed with
// an Acknowledge action, per handleAcknowledgeAlert.
//
// metric/scopeType/thresholdType option lists below are hand-kept in
// sync with en/worker/database/alerts.js's VALID_DAILY_METRIC_COLUMNS,
// POSTBACK_RATE_METRICS, ALERT_SCOPE_RESOURCE, and the threshold_type
// checks in evaluateDailyMetricRule/evaluateHealthRule -- the Super
// API has no "list valid options" endpoint for these.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";

const METRIC_OPTIONS = [
  "page_views", "clicks", "unique_clicks", "conversions", "revenue", "commission",
  "postback_unattributed_rate", "postback_duplicate_rate",
  "tracking_link_health", "postback_silence_hours",
  "commission_discrepancy_pct", "reconciliation_missing"
];
const SCOPE_TYPE_OPTIONS = ["global", "casino", "offer", "tracking_link", "partner", "account"];
const THRESHOLD_TYPE_OPTIONS = ["percent_drop", "absolute_drop", "zero_conversion", "health_failure"];

export async function renderAlertsPage(env, admin) {
  const activeKey = "content-alerts";
  const title = "Alerts";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const [rulesResult, alertsResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/alert-rules`),
    getFromTenant(env, tenant, `${BASE_PATH}/alerts?status=open`)
  ]);

  if (!rulesResult.ok) {
    const body = `<h1>${title}</h1><div class="flash flash-error"><strong>${escapeHtml(String(rulesResult.status))}</strong> — ${escapeHtml(rulesResult.message || "Could not load alert rules. If this tenant hasn't redeployed with the /en/api/super/analytics-alert-rules routes yet, that's why.")}</div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const rules = rulesResult.data.data || [];
  const openAlerts = alertsResult.ok ? (alertsResult.data.data || []) : [];

  const ruleRow = (r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td><code>${escapeHtml(r.metric)}</code></td>
      <td>${escapeHtml(r.scope_type)}${r.scope_id ? " · " + escapeHtml(r.scope_id) : ""}</td>
      <td>${escapeHtml(r.threshold_type)}${r.threshold_value != null ? " · " + escapeHtml(r.threshold_value) : ""}</td>
      <td>${escapeHtml(r.comparison_window_days ?? "")}d</td>
    </tr>`;

  const alertRow = (a) => `
    <tr>
      <td>${escapeHtml(a.rule_name || a.metric || "")}</td>
      <td>${escapeHtml(a.scope_type || "")}${a.scope_id ? " · " + escapeHtml(a.scope_id) : ""}</td>
      <td>${escapeHtml(a.created_at || "")}</td>
      <td><button type="button" class="btn btn-small" data-ack-alert="${a.id}">Acknowledge</button></td>
    </tr>`;

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · Alerts on <strong>${escapeHtml(tenant.name)}</strong></p>

    <div class="card">
      <h3 style="margin-top:0;">Open alerts</h3>
      ${openAlerts.length ? `
      <table class="table">
        <thead><tr><th>Rule</th><th>Scope</th><th>Fired</th><th></th></tr></thead>
        <tbody>${openAlerts.map(alertRow).join("")}</tbody>
      </table>` : `<p class="empty">No open alerts.</p>`}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Alert rules</h3>
      <div style="font-size:13px;color:var(--text-dim);margin-bottom:10px;">
        Create-only here, matching the tenant dashboard's own admin-only rule editing — there's no edit or delete route to wire up.
      </div>
      ${rules.length ? `
      <table class="table">
        <thead><tr><th>Name</th><th>Metric</th><th>Scope</th><th>Threshold</th><th>Window</th></tr></thead>
        <tbody>${rules.map(ruleRow).join("")}</tbody>
      </table>` : `<p class="empty">No alert rules yet.</p>`}
    </div>

    <div class="card" style="border-style:dashed;">
      <h3 style="margin-top:0;">New alert rule</h3>
      <label>Name<input type="text" id="ruleName" placeholder="e.g. Conversions dropped" /></label>
      <label>Metric
        <select id="ruleMetric">${METRIC_OPTIONS.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
      </label>
      <label>Scope type
        <select id="ruleScopeType">${SCOPE_TYPE_OPTIONS.map((s) => `<option value="${s}">${s}</option>`).join("")}</select>
      </label>
      <label>Scope ID <span style="color:var(--text-dim);font-weight:normal;">(required unless scope is global)</span>
        <input type="text" id="ruleScopeId" />
      </label>
      <label>Threshold type
        <select id="ruleThresholdType">${THRESHOLD_TYPE_OPTIONS.map((t) => `<option value="${t}">${t}</option>`).join("")}</select>
      </label>
      <label>Threshold value <span style="color:var(--text-dim);font-weight:normal;">(not used by zero_conversion/health_failure)</span>
        <input type="number" id="ruleThresholdValue" step="any" />
      </label>
      <label>Comparison window (days)<input type="number" id="ruleWindowDays" value="7" /></label>
      <button type="button" class="btn btn-small" id="createRuleBtn" style="margin-top:8px;">Create rule</button>
    </div>

    <script nonce="${nonceToken()}">
      async function alertApi(path, body) {
        const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        const data = await res.json().catch(() => ({}));
        return data;
      }

      document.getElementById("createRuleBtn").addEventListener("click", async () => {
        const name = document.getElementById("ruleName").value.trim();
        const metric = document.getElementById("ruleMetric").value;
        const thresholdType = document.getElementById("ruleThresholdType").value;
        if (!name) { alert("Give the rule a name first."); return; }
        const payload = {
          name, metric,
          scopeType: document.getElementById("ruleScopeType").value,
          scopeId: document.getElementById("ruleScopeId").value.trim() || undefined,
          thresholdType,
          thresholdValue: document.getElementById("ruleThresholdValue").value
            ? Number(document.getElementById("ruleThresholdValue").value) : undefined,
          comparisonWindowDays: Number(document.getElementById("ruleWindowDays").value) || 7
        };
        const data = await alertApi("/api/alert-rules", payload);
        if (!data.success) { alert("Could not create: " + (data.message || data.error || "unknown error")); return; }
        location.reload();
      });

      document.body.addEventListener("click", (e) => {
        const ackBtn = e.target.closest("[data-ack-alert]");
        if (!ackBtn) return;
        alertApi("/api/alerts/" + ackBtn.dataset.ackAlert + "/acknowledge", {}).then((data) => {
          if (!data.success) { alert("Could not acknowledge: " + (data.message || data.error || "unknown error")); return; }
          location.reload();
        });
      });
    </script>
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

export async function submitCreateAlertRule(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/alert-rules`, payload);
}

export async function submitAcknowledgeAlert(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/alerts/${encodeURIComponent(id)}/acknowledge`, {});
}
