import { renderShell, escapeHtml } from "../layout.js";

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

export async function renderDashboardHome(env, admin) {
  const tenants = await env.LUMMET_DB.prepare(
    `SELECT t.id, t.name, t.status, h.status AS health_status
     FROM tenants t LEFT JOIN tenant_health h ON h.tenant_id = t.id`
  ).all();

  const rows = tenants.results || [];
  const total = rows.length;
  const active = rows.filter((t) => t.status === "active").length;
  const online = rows.filter((t) => t.health_status === "Online").length;
  const attention = rows.filter(
    (t) => t.status === "active" && t.health_status && t.health_status !== "Online"
  ).length;

  const recentAudit = await env.LUMMET_DB.prepare(
    `SELECT a.*, t.name AS tenant_name
     FROM lummet_audit_logs a
     LEFT JOIN tenants t ON t.id = a.tenant_id
     ORDER BY a.created_at DESC LIMIT 10`
  ).all();

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
