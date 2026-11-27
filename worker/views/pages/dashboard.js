import { renderShell, escapeHtml } from "../layout.js";
import { loadOpsSummary, attentionItems } from "../../ops-summary.js";

function healthBadge(status) {
  if (!status) return `<span class="badge badge-dim">Unknown</span>`;
  const map = {
    Online: "badge-ok",
    Timeout: "badge-warn",
    Unauthorized: "badge-danger",
    Unavailable: "badge-danger",
    Disabled: "badge-dim",
    "Configuration Error": "badge-warn"
  };
  return `<span class="badge ${map[status] || "badge-dim"}">${escapeHtml(status)}</span>`;
}

function sparkline(values, bad = false) {
  const max = Math.max(1, ...values), w = 140, h = 36, step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 3 - (v / max) * (h - 8)).toFixed(1)}`).join(" ");
  const total = values.reduce((n, v) => n + v, 0);
  return `<svg class="ops-spark${bad ? " is-bad" : ""}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Last 14 days, ${total} in total"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

function panel(title, linkHref, linkText, inner) {
  return `<div class="card"><div class="ops-head"><h2>${escapeHtml(title)}</h2>${linkHref ? `<a href="${linkHref}">${escapeHtml(linkText)}</a>` : ""}</div>${inner}</div>`;
}

function attentionHtml(items) {
  if (!items.length) return `<div class="ops-allclear"><span class="badge badge-ok">All clear</span><span class="ops-note">Nothing needs attention right now.</span></div>`;
  return `<ul class="ops-attn">${items.slice(0, 8).map((i) => `<li class="is-${i.level}"><span class="badge ${i.level === "danger" ? "badge-danger" : "badge-warn"}">${i.level === "danger" ? "Urgent" : "Check"}</span><span><div class="ops-t">${escapeHtml(i.title)}</div><div class="ops-d">${escapeHtml(i.detail)}</div></span><a class="ops-go" href="${i.href}">Open</a></li>`).join("")}</ul>${items.length > 8 ? `<p class="ops-sub">+ ${items.length - 8} more.</p>` : ""}`;
}

function releaseHtml(r, trend) {
  if (!r) return `<div class="empty">Release data is not available.</div>`;
  const pct = r.totalLive ? Math.round((r.onActive / r.totalLive) * 100) : 100;
  let run = "";
  if (r.running) {
    const c = r.running.counts || {}, done = (c.succeeded || 0) + (c.skipped || 0) + (c.failed || 0), all = Object.values(c).reduce((n, v) => n + v, 0);
    run = `<p class="ops-sub"><span class="badge badge-warn">Rolling out</span> ${escapeHtml(String(r.running.version || ""))}: ${done} of ${all} sites done${c.failed ? `, ${c.failed} failed` : ""}.</p>`;
  }
  const last = (r.recent || []).slice(0, 3).map((x) => `<tr><td>${escapeHtml(String(x.version))}</td><td><span class="badge ${x.status === "completed" ? "badge-ok" : x.status === "failed" ? "badge-danger" : "badge-dim"}">${escapeHtml(x.status)}</span></td><td>${escapeHtml(String(x.createdAt || "").slice(0, 16))}</td></tr>`).join("");
  return `<dl class="ops-kv"><dt>Active release</dt><dd>${escapeHtml(r.activeVersion || "none")}</dd><dt>Sites on it</dt><dd>${r.onActive} of ${r.totalLive}</dd><dt>Behind</dt><dd>${r.outdated}</dd></dl>
    <div class="ops-bar" role="img" aria-label="${pct}% of sites on the active release"><span style="width:${pct}%"></span></div>${run}
    ${last ? `<table><thead><tr><th>Rollout</th><th>Status</th><th>Started</th></tr></thead><tbody>${last}</tbody></table>` : ""}
    ${trend ? `<div class="ops-spark-label">Deployments, last 14 days</div>${sparkline(trend.all)}<div class="ops-spark-label">Failed or rolled back</div>${sparkline(trend.failed, true)}` : ""}`;
}

function money(cents, cur) { try { return new Intl.NumberFormat("en", { style: "currency", currency: String(cur || "USD").toUpperCase() }).format((cents || 0) / 100); } catch { return `${((cents || 0) / 100).toFixed(2)} ${cur || ""}`; } }

function billingHtml(b) {
  if (!b) return `<div class="empty">Billing data is not available.</div>`;
  const n = (k) => b.subs[k] || 0;
  const overdue = (b.overdue || []).map((o) => `${o.n} overdue (${money(o.cents, o.currency)})`).join(", ");
  return `<dl class="ops-kv"><dt>Active</dt><dd>${n("active")}</dd><dt>On trial</dt><dd>${n("trialing")}</dd><dt>Past due</dt><dd>${n("past_due")}</dd><dt>Restricted or suspended</dt><dd>${n("restricted") + n("unpaid") + n("suspended")}</dd><dt>Failed payments, 7 days</dt><dd>${b.failed7}</dd></dl>
    ${overdue ? `<p class="ops-sub">Open invoices: ${escapeHtml(overdue)}.</p>` : ""}
    ${b.atRisk.length ? `<table><thead><tr><th>Organization</th><th>Status</th></tr></thead><tbody>${b.atRisk.map((x) => `<tr><td>${escapeHtml(x.org)}</td><td><span class="badge ${x.status === "past_due" ? "badge-warn" : "badge-danger"}">${escapeHtml(x.status.replace("_", " "))}</span></td></tr>`).join("")}</tbody></table>` : `<p class="ops-sub">No subscriptions at risk.</p>`}`;
}

function incidentsHtml(inc, failedActions) {
  const list = inc === null ? `<div class="empty">Alert data is not available.</div>` : inc.length
    ? `<table><thead><tr><th>Alert</th><th>Count</th></tr></thead><tbody>${inc.map((a) => `<tr><td><a href="${escapeHtml(a.path)}">${escapeHtml(a.title)}</a></td><td>${a.count ?? "—"}</td></tr>`).join("")}</tbody></table>`
    : `<p class="ops-sub"><span class="badge badge-ok">None firing</span></p>`;
  return `${list}<div class="ops-spark-label">Failed admin actions, last 14 days</div>${sparkline(failedActions, true)}`;
}

export async function renderDashboardHome(env, admin) {
  const s = await loadOpsSummary(env, admin);
  const rows = s.tenants;
  const total = rows.length;
  const active = rows.filter((t) => t.status === "active").length;
  const online = rows.filter((t) => t.health_status === "Online").length;
  const attention = rows.filter(
    (t) => t.status === "active" && t.health_status && t.health_status !== "Online"
  ).length;
  const items = attentionItems(s);
  const recentAudit = { results: s.audit };

  const auditRows = (recentAudit.results || [])
    .map(
      (log) => `
        <tr>
          <td>${escapeHtml(log.created_at)}</td>
          <td>${escapeHtml(log.tenant_name || "—")}</td>
          <td>${escapeHtml(log.action || "—")}</td>
          <td>${escapeHtml(log.resource || "—")}</td>
          <td>${log.success ? '<span class="badge badge-ok">OK</span>' : '<span class="badge badge-danger">Failed</span>'}</td>
        </tr>`
    )
    .join("");

  const body = `
    <h1>Overview</h1>
    <p class="subtitle">Welcome back, ${escapeHtml(admin.email)}.</p>

    <div class="grid" style="margin-bottom:24px;">
      <div class="stat"><div class="num">${total}</div><div class="label">Registered tenants</div></div>
      <div class="stat"><div class="num">${active}</div><div class="label">Active</div></div>
      <div class="stat"><div class="num">${online}</div><div class="label">Online</div></div>
      <div class="stat"><div class="num">${attention}</div><div class="label">Need attention</div></div>
    </div>

    ${panel("Needs attention", "", "", attentionHtml(items))}

    <div class="ops-cols" style="margin-bottom:16px;">
      ${s.sup ? panel("Releases and rollout", "/tenants/deployments", "Open", releaseHtml(s.releases, s.deployTrend)) : ""}
      ${s.sup ? panel("Billing", "/platform/saas/subscriptions", "Open", billingHtml(s.billing)) : ""}
      ${s.sup ? panel("Incidents", "/platform/saas/alerts", "Open", incidentsHtml(s.incidents, s.failedActions)) : ""}
    </div>

    <div class="card">
      <h2>Tenants</h2>
      ${
        rows.length === 0
          ? `<div class="empty">No tenants registered yet. <a href="/tenants/new">Add one</a>.</div>`
          : `<table>
              <thead><tr><th>Name</th><th>Status</th><th>Health</th><th></th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    (t) => `
                    <tr>
                      <td>${escapeHtml(t.name)}</td>
                      <td>${t.status === "active" ? '<span class="badge badge-ok">Active</span>' : '<span class="badge badge-dim">Disabled</span>'}</td>
                      <td>${healthBadge(t.health_status)}</td>
                      <td><a href="/tenants/${encodeURIComponent(t.id)}">View</a></td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </div>

    <div class="card">
      <h2>Recent activity</h2>
      ${
        auditRows
          ? `<table>
              <thead><tr><th>Time</th><th>Tenant</th><th>Action</th><th>Resource</th><th>Result</th></tr></thead>
              <tbody>${auditRows}</tbody>
            </table>`
          : `<div class="empty">No activity yet.</div>`
      }
    </div>
  `;

  return renderShell({ title: "Overview", activeKey: "dashboard", admin, bodyHtml: body, env });
}
