import { renderShell, escapeHtml } from "../layout.js";

const PAGE_SIZE = 50;

export async function renderAuditLogsPage(env, admin, query = {}) {
  const tenantId = query.tenant_id || "";
  const action = query.action || "";
  const result = query.result || ""; // "success" | "failed" | ""
  const page = Math.max(1, Number(query.page) || 1);
  const offset = (page - 1) * PAGE_SIZE;

  const conditions = [];
  const params = [];

  if (tenantId) {
    conditions.push("a.tenant_id = ?");
    params.push(tenantId);
  }
  if (action) {
    conditions.push("a.action = ?");
    params.push(action);
  }
  if (result === "success") {
    conditions.push("a.success = 1");
  } else if (result === "failed") {
    conditions.push("a.success = 0");
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const countRow = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM lummet_audit_logs a ${whereClause}`
  ).bind(...params).first();
  const total = countRow?.c || 0;

  const logs = await env.LUMMET_DB.prepare(
    `SELECT a.*, t.name AS tenant_name
     FROM lummet_audit_logs a
     LEFT JOIN tenants t ON t.id = a.tenant_id
     ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT ? OFFSET ?`
  ).bind(...params, PAGE_SIZE, offset).all();

  const rows = logs.results || [];

  const tenantsResult = await env.LUMMET_DB.prepare(`SELECT id, name FROM tenants ORDER BY name`).all();
  const tenants = tenantsResult.results || [];

  const actionsResult = await env.LUMMET_DB.prepare(
    `SELECT DISTINCT action FROM lummet_audit_logs WHERE action IS NOT NULL ORDER BY action`
  ).all();
  const actions = (actionsResult.results || []).map((r) => r.action);

  const buildQueryString = (overrides) => {
    const merged = { tenant_id: tenantId, action, result, page: 1, ...overrides };
    const parts = Object.entries(merged)
      .filter(([, v]) => v !== "" && v != null)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
    return parts.length ? `?${parts.join("&")}` : "";
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const body = `
    <h1>Audit Logs</h1>
    <p class="subtitle">Every registry mutation, login event, and tenant call attempt made from this control plane, most recent first. Secrets are never logged. Entries older than 180 days are pruned automatically.</p>
    <div class="card">
      <form method="GET" action="/platform/audit-logs" style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;margin-bottom:16px;">
        <div style="flex:1;min-width:160px;">
          <label for="tenant_id">Tenant</label>
          <select id="tenant_id" name="tenant_id">
            <option value="">All tenants</option>
            ${tenants.map((t) => `<option value="${escapeHtml(t.id)}" ${t.id === tenantId ? "selected" : ""}>${escapeHtml(t.name)}</option>`).join("")}
          </select>
        </div>
        <div style="flex:1;min-width:160px;">
          <label for="action">Action</label>
          <select id="action" name="action">
            <option value="">All actions</option>
            ${actions.map((a) => `<option value="${escapeHtml(a)}" ${a === action ? "selected" : ""}>${escapeHtml(a)}</option>`).join("")}
          </select>
        </div>
        <div style="flex:1;min-width:160px;">
          <label for="result">Result</label>
          <select id="result" name="result">
            <option value="">All results</option>
            <option value="success" ${result === "success" ? "selected" : ""}>Success only</option>
            <option value="failed" ${result === "failed" ? "selected" : ""}>Failed only</option>
          </select>
        </div>
        <button class="btn btn-secondary" type="submit">Filter</button>
        ${tenantId || action || result ? `<a class="btn btn-secondary" href="/platform/audit-logs">Clear</a>` : ""}
      </form>

      ${
        rows.length === 0
          ? `<div class="empty">No activity matches these filters.</div>`
          : `<table>
              <thead><tr><th>Time</th><th>Admin</th><th>Tenant</th><th>Action</th><th>Resource</th><th>Endpoint</th><th>Result</th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    (log) => `
                    <tr>
                      <td>${escapeHtml(log.created_at)}</td>
                      <td>${log.admin_id != null ? `#${escapeHtml(log.admin_id)}` : '<span style="color:var(--text-dim);">system</span>'}</td>
                      <td>${escapeHtml(log.tenant_name || "—")}</td>
                      <td>${escapeHtml(log.action || "—")}</td>
                      <td>${escapeHtml(log.resource || "—")}${log.resource_id ? ` <span class="mono" style="color:var(--text-dim);">#${escapeHtml(log.resource_id)}</span>` : ""}</td>
                      <td class="mono" style="font-size:12px;">${escapeHtml(log.endpoint || "—")}</td>
                      <td>${log.success ? '<span class="badge badge-ok">OK</span>' : `<span class="badge badge-danger">${escapeHtml(log.status_code || "Failed")}</span>`}</td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;font-size:13px;color:var(--text-dim);">
              <span>${total} total &nbsp;·&nbsp; page ${page} of ${totalPages}</span>
              <div class="actions">
                ${page > 1 ? `<a class="btn btn-secondary btn-small" href="/platform/audit-logs${buildQueryString({ page: page - 1 })}">Previous</a>` : ""}
                ${page < totalPages ? `<a class="btn btn-secondary btn-small" href="/platform/audit-logs${buildQueryString({ page: page + 1 })}">Next</a>` : ""}
              </div>
            </div>`
      }
    </div>
  `;

  return renderShell({ title: "Audit Logs", activeKey: "platform-audit-logs", admin, bodyHtml: body, env });
}

export async function renderCredentialsPage(env, admin) {
  const credentials = await env.LUMMET_DB.prepare(
    `SELECT c.credential_id, c.status, c.created_at, c.rotated_at, t.id AS tenant_id, t.name AS tenant_name
     FROM tenant_api_credentials c
     JOIN tenants t ON t.id = c.tenant_id
     ORDER BY t.name, c.created_at DESC`
  ).all();

  const rows = credentials.results || [];

  const statusBadge = (status) => {
    const map = { active: "badge-ok", rotated: "badge-dim", revoked: "badge-danger" };
    return `<span class="badge ${map[status] || "badge-dim"}">${escapeHtml(status)}</span>`;
  };

  const body = `
    <h1>Credentials</h1>
    <p class="subtitle">Super API credentials issued to each tenant. Secrets themselves are never displayed here — only shown once at issuance/rotation time.</p>
    <div class="card">
      ${
        rows.length === 0
          ? `<div class="empty">No credentials issued yet.</div>`
          : `<table>
              <thead><tr><th>Tenant</th><th>Credential ID</th><th>Status</th><th>Issued</th><th>Rotated</th><th></th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    (c) => `
                    <tr>
                      <td><a href="/tenants/${encodeURIComponent(c.tenant_id)}">${escapeHtml(c.tenant_name)}</a></td>
                      <td class="mono">${escapeHtml(c.credential_id)}</td>
                      <td>${statusBadge(c.status)}</td>
                      <td>${escapeHtml(c.created_at)}</td>
                      <td>${escapeHtml(c.rotated_at || "—")}</td>
                      <td><a href="/tenants/${encodeURIComponent(c.tenant_id)}">Manage</a></td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </div>
  `;

  return renderShell({ title: "Credentials", activeKey: "platform-credentials", admin, bodyHtml: body, env });
}

export async function renderCapabilitiesPage(env, admin) {
  const rows = await env.LUMMET_DB.prepare(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, c.capability, c.enabled
     FROM tenant_capabilities c
     JOIN tenants t ON t.id = c.tenant_id
     ORDER BY t.name, c.capability`
  ).all();

  const byTenant = {};
  for (const row of rows.results || []) {
    if (!byTenant[row.tenant_id]) byTenant[row.tenant_id] = { name: row.tenant_name, caps: [] };
    byTenant[row.tenant_id].caps.push(row);
  }

  const entries = Object.entries(byTenant);

  const body = `
    <h1>Capabilities</h1>
    <p class="subtitle">Cached from each tenant's last successful handshake. Different deployments may support different feature sets.</p>
    ${
      entries.length === 0
        ? `<div class="card"><div class="empty">No capabilities cached yet. Run "Test connection" on a tenant to populate this.</div></div>`
        : entries
            .map(
              ([tenantId, t]) => `
              <div class="card">
                <h2><a href="/tenants/${encodeURIComponent(tenantId)}">${escapeHtml(t.name)}</a></h2>
                <div>
                  ${t.caps
                    .map(
                      (c) => `<span class="badge ${c.enabled ? "badge-ok" : "badge-dim"}" style="margin:2px;">${escapeHtml(c.capability)}</span>`
                    )
                    .join("")}
                </div>
              </div>`
            )
            .join("")
    }
  `;

  return renderShell({ title: "Capabilities", activeKey: "platform-capabilities", admin, bodyHtml: body, env });
}

export async function renderApiReferencePage(env, admin) {
  const body = `
    <h1>API</h1>
    <p class="subtitle">How this control plane talks to tenant deployments.</p>
    <div class="card">
      <h2>Authentication</h2>
      <p style="font-size:14px;color:var(--text-dim);">
        Every request to a tenant's <span class="mono">/en/api/super/*</span> endpoint is signed
        with HMAC-SHA256 using that tenant's dedicated credential. The canonical string is:
      </p>
      <pre class="mono" style="background:var(--bg);padding:14px;border-radius:8px;overflow-x:auto;">{METHOD}\\n{PATH}\\n{TIMESTAMP}\\n{NONCE}\\n{SHA256_HEX(BODY)}</pre>
      <p style="font-size:14px;color:var(--text-dim);">
        Secrets are stored encrypted at rest (AES-GCM) and are only decrypted in-memory,
        immediately before signing an outbound request. They are never sent to this
        dashboard's frontend.
      </p>
    </div>
    <div class="card">
      <h2>Endpoints used</h2>
      <table>
        <thead><tr><th>Method</th><th>Path</th><th>Purpose</th></tr></thead>
        <tbody>
          <tr><td>GET</td><td class="mono">/en/api/super/handshake</td><td>Connection test, capability + version discovery</td></tr>
          <tr><td>GET</td><td class="mono">/en/api/super/health</td><td>Liveness check</td></tr>
          <tr><td>GET</td><td class="mono">/en/api/super/capabilities</td><td>Full capability manifest</td></tr>
          <tr><td>*</td><td class="mono">/en/api/super/&lt;resource&gt;[/:id]</td><td>CRUD for casinos, reviews, news, pages, categories, countries, authors, media, settings, users</td></tr>
        </tbody>
      </table>
      <p style="font-size:13px;color:var(--text-dim);">Full endpoint documentation lives in each tenant repo at <span class="mono">en/docs/super-api.md</span>.</p>
    </div>
  `;

  return renderShell({ title: "API", activeKey: "platform-api", admin, bodyHtml: body, env });
}
