// =====================================================
// REPORTS
// Wraps en/worker/super/handlers-reporting.js's REPORTS section.
//
// NOT built on the generic crud.js pattern: the Super API only
// exposes GET (list/get), POST create, and POST :id/run -- there is
// no PUT or DELETE route for report_definitions at all (see that
// file's header comment: reports are meant to be defined once and
// run repeatedly, not edited). Wiring this into resources.js/crud.js
// would produce an "Edit" link that 404s on save, so it gets its own
// page instead, same reasoning as review-blocks.js.
//
// reportType is a fixed server-side enum (REPORT_TYPES in
// en/worker/database/reports.js) -- kept in sync here by hand since
// the Super API doesn't expose a "list valid types" endpoint, only
// a "columns for this type" one (handleReportColumnOptions), which
// this page calls live once a type is picked.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";

// Mirrors REPORT_TYPES in en/worker/database/reports.js exactly --
// update both lists together if the tenant adds a new report type.
const REPORT_TYPES = [
  "executive_performance", "affiliate_performance", "partner_performance",
  "program_performance", "account_performance", "offer_performance",
  "tracking_link_performance", "casino_performance", "geo_performance",
  "content_performance", "traffic_performance", "conversion_funnel",
  "revenue_commission", "seo_performance", "operational_health", "reconciliation",
  "cohort_analysis", "ltv_analysis"
];

export async function renderReportsPage(env, admin) {
  const activeKey = "content-reports";
  const title = "Reports";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const listResult = await getFromTenant(env, tenant, `${BASE_PATH}/reports`);
  if (!listResult.ok) {
    const body = `<h1>${title}</h1><div class="flash flash-error"><strong>${escapeHtml(String(listResult.status))}</strong> — ${escapeHtml(listResult.message || "Could not load reports. If this tenant hasn't redeployed with the /en/api/super/reports routes yet, that's why.")}</div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const reports = listResult.data.data || [];

  const rowHtml = (r) => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td><code>${escapeHtml(r.report_type)}</code></td>
      <td>${escapeHtml(r.owner_id ?? "")}</td>
      <td>
        <button type="button" class="btn btn-small" data-run-report="${r.id}" data-report-type="${escapeHtml(r.report_type)}">Run…</button>
      </td>
    </tr>`;

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · Reports on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card" style="font-size:13px;color:var(--text-dim);">
      Report definitions are created once and run on demand — there's no edit here because the Super API doesn't support updating a definition, only defining it and running it (see the reports handler's own notes on why).
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Existing reports</h3>
      ${reports.length ? `
      <table class="table">
        <thead><tr><th>Name</th><th>Type</th><th>Owner</th><th></th></tr></thead>
        <tbody>${reports.map(rowHtml).join("")}</tbody>
      </table>` : `<p class="empty">No report definitions yet.</p>`}
    </div>

    <div class="card" style="border-style:dashed;">
      <h3 style="margin-top:0;">Define a new report</h3>
      <label>Name<input type="text" id="newReportName" placeholder="e.g. Weekly affiliate performance" /></label>
      <label>Report type
        <select id="newReportType">
          ${REPORT_TYPES.map((t) => `<option value="${t}">${t}</option>`).join("")}
        </select>
      </label>
      <label>Owner user ID <span style="color:var(--text-dim);font-weight:normal;">(optional — defaults to this tenant's first admin)</span>
        <input type="text" id="newReportOwnerId" placeholder="leave blank to auto-assign" />
      </label>
      <button type="button" class="btn btn-small" id="createReportBtn" style="margin-top:8px;">Create report</button>
    </div>

    <div class="card" id="runReportCard" style="display:none;border-style:dashed;">
      <h3 style="margin-top:0;">Run report <span id="runReportName"></span></h3>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>Start date<input type="date" id="runStartDate" /></label>
        <label>End date<input type="date" id="runEndDate" /></label>
        <label>Currency <span style="color:var(--text-dim);font-weight:normal;">(optional)</span><input type="text" id="runCurrency" placeholder="USD" style="width:90px;" /></label>
        <label>Group by <span style="color:var(--text-dim);font-weight:normal;">(optional)</span>
          <select id="runGroupBy"><option value="">— none —</option></select>
        </label>
      </div>
      <div id="runColumnPicker" style="margin-top:10px;"></div>
      <button type="button" class="btn btn-small" id="runReportBtn" style="margin-top:8px;">Run now</button>
      <div id="runReportOutput" style="margin-top:14px;overflow-x:auto;"></div>
    </div>

    <script nonce="${nonceToken()}">
      let runReportId = null;

      async function reportApi(path, body) {
        const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
        const data = await res.json().catch(() => ({}));
        return data;
      }

      document.getElementById("createReportBtn").addEventListener("click", async () => {
        const name = document.getElementById("newReportName").value.trim();
        const reportType = document.getElementById("newReportType").value;
        const ownerId = document.getElementById("newReportOwnerId").value.trim();
        if (!name) { alert("Give the report a name first."); return; }
        const data = await reportApi("/api/reports", { name, reportType, ownerId: ownerId || undefined });
        if (!data.success) { alert("Could not create: " + (data.message || data.error || "unknown error")); return; }
        location.reload();
      });

      let runReportType = null;

      async function loadColumnOptions(reportType) {
        const picker = document.getElementById("runColumnPicker");
        const groupSel = document.getElementById("runGroupBy");
        groupSel.innerHTML = "<option value=\"\">— none —</option>";
        picker.innerHTML = "Loading columns…";
        const res = await fetch("/api/reports/column-options?report_type=" + encodeURIComponent(reportType));
        const data = await res.json().catch(() => ({}));
        const columns = data.success ? (data.data || []) : [];
        if (!columns.length) { picker.innerHTML = "<p style=\"font-size:12px;color:var(--text-dim);\">Column selection not available for this report type — it will show every column.</p>"; return; }
        picker.innerHTML = "<div style=\"font-size:12px;color:var(--text-dim);margin-bottom:4px;\">Columns (unchecked = leave out; none checked = all columns)</div>" +
          "<div style=\"display:flex;gap:10px;flex-wrap:wrap;\">" +
          columns.map((c) => "<label style=\"font-weight:400;\"><input type=\"checkbox\" class=\"run-col\" value=\"" + c.key + "\" checked /> " + (c.label || c.key) + "</label>").join("") +
          "</div>";
        columns.filter((c) => c.groupable).forEach((g) => {
          const opt = document.createElement("option");
          opt.value = g.key; opt.textContent = g.label || g.key;
          groupSel.appendChild(opt);
        });
      }

      document.body.addEventListener("click", (e) => {
        const runBtn = e.target.closest("[data-run-report]");
        if (!runBtn) return;
        runReportId = runBtn.dataset.runReport;
        runReportType = runBtn.dataset.reportType || null;
        document.getElementById("runReportName").textContent = "#" + runReportId;
        document.getElementById("runReportOutput").innerHTML = "";
        document.getElementById("runReportCard").style.display = "block";
        document.getElementById("runReportCard").scrollIntoView({ behavior: "smooth" });
        if (runReportType) loadColumnOptions(runReportType);
      });

      document.getElementById("runReportBtn").addEventListener("click", async () => {
        const startDate = document.getElementById("runStartDate").value;
        const endDate = document.getElementById("runEndDate").value;
        const currency = document.getElementById("runCurrency").value.trim();
        const groupBy = document.getElementById("runGroupBy").value;
        const checked = Array.from(document.querySelectorAll(".run-col:checked")).map((el) => el.value);
        const allBoxes = document.querySelectorAll(".run-col").length;
        const selectedColumns = checked.length && checked.length < allBoxes ? checked : undefined;
        if (!startDate || !endDate) { alert("Pick a start and end date."); return; }
        const data = await reportApi("/api/reports/" + runReportId + "/run", {
          startDate, endDate, currency: currency || undefined,
          selectedColumns, groupBy: groupBy || undefined
        });
        if (!data.success) { alert("Could not run: " + (data.message || data.error || "unknown error")); return; }
        const { columns, rows } = data.data || {};
        const out = document.getElementById("runReportOutput");
        if (!rows || !rows.length) { out.innerHTML = "<p class=\\"empty\\">No rows for that range.</p>"; return; }
        const cols = columns && columns.length ? columns : Object.keys(rows[0]);
        out.innerHTML = "<table class=\\"table\\"><thead><tr>" +
          cols.map((c) => "<th>" + c + "</th>").join("") +
          "</tr></thead><tbody>" +
          rows.map((r) => "<tr" + (r.is_subtotal ? " style=\\"font-weight:600;background:var(--panel-alt);\\"" : "") + ">" +
            cols.map((c) => "<td>" + (r[c] ?? "") + "</td>").join("") + "</tr>").join("") +
          "</tbody></table>";
      });
    </script>
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

export async function submitCreateReport(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/reports`, payload);
}

export async function submitRunReport(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/reports/${encodeURIComponent(id)}/run`, payload);
}

// Feeds the run panel's column-picker/group-by controls (GET, read-only —
// no audit entry, same as any other list/read call in this codebase).
export async function fetchReportColumnOptions(env, admin, reportType) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return getFromTenant(env, tenant, `${BASE_PATH}/report-column-options?report_type=${encodeURIComponent(reportType)}`);
}
