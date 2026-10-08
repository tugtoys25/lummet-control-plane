import { renderShell, escapeHtml } from "../layout.js";
import * as registry from "../../registry.js";
import { nonceToken, onClick } from "../../csp.js";

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

function statusBadge(status) {
  return status === "active"
    ? '<span class="badge badge-ok">Active</span>'
    : '<span class="badge badge-dim">Disabled</span>';
}

// -----------------------------------------------------
// All Tenants
// -----------------------------------------------------

export async function renderTenantsList(env, admin, flash) {
  const tenants = await registry.listTenants(env);

  const flashHtml = flash
    ? `<div class="flash ${flash.type === "error" ? "flash-error" : "flash-success"}">${escapeHtml(flash.message)}</div>`
    : "";

  const body = `
    <h1>All Tenants</h1>
    <p class="subtitle">Every deployment registered with this control plane.</p>
    ${flashHtml}
    <div class="card">
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
        <a class="btn" href="/tenants/new">Add Tenant</a>
      </div>
      ${
        tenants.length === 0
          ? `<div class="empty">No tenants registered yet.</div>`
          : `<table>
              <thead><tr><th>Name</th><th>Host</th><th>Status</th><th>Health</th><th>Last seen</th><th></th></tr></thead>
              <tbody>
                ${tenants
                  .map(
                    (t) => `
                    <tr>
                      <td>${escapeHtml(t.name)}</td>
                      <td class="mono">${escapeHtml(t.host)}</td>
                      <td>${statusBadge(t.status)}</td>
                      <td>${healthBadge(t.health_status)}</td>
                      <td>${escapeHtml(t.last_seen_at || "never")}</td>
                      <td><a href="/tenants/${encodeURIComponent(t.id)}">Manage</a></td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </div>
  `;

  return renderShell({ title: "All Tenants", activeKey: "tenants-all", admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Add Tenant
// -----------------------------------------------------

export async function renderAddTenantForm(env, admin, { error } = {}) {
  const flash = error ? `<div class="flash flash-error">${escapeHtml(error)}</div>` : "";

  const body = `
    <h1>Add Tenant</h1>
    <p class="subtitle">Register a new deployment. You'll be shown a credential to configure on the tenant Worker — save it immediately, it's shown only once.</p>
    ${flash}
    <div class="card" style="max-width:520px;">
      <form method="POST" action="/tenants/new">
        <label for="name">Display name</label>
        <input type="text" id="name" name="name" required placeholder="Example Casino" />
        <label for="host">Hostname</label>
        <input type="text" id="host" name="host" required placeholder="example.com" />
        <label for="api_base_url">API base URL (optional — defaults to https://&lt;host&gt;)</label>
        <input type="text" id="api_base_url" name="api_base_url" placeholder="https://example.com" />
        <label for="description">Description (optional)</label>
        <input type="text" id="description" name="description" />
        <button class="btn" type="submit">Register tenant</button>
      </form>
    </div>
  `;

  return renderShell({ title: "Add Tenant", activeKey: "tenants-new", admin, bodyHtml: body, env });
}

export async function renderTenantCreatedPage(env, admin, tenant, credential) {
  const body = `
    <h1>Tenant registered</h1>
    <p class="subtitle">Configure these on the <strong>${escapeHtml(tenant.host)}</strong> Worker now — the secret is shown only this once.</p>
    <div class="card" style="max-width:640px;">
      <h2>Worker secrets to set</h2>
      <p style="color:var(--text-dim);font-size:13px;">Run on the tenant deployment:</p>
      <pre class="mono" style="background:var(--bg);padding:14px;border-radius:8px;overflow-x:auto;">wrangler secret put SUPER_API_CREDENTIAL_ID
# paste: ${escapeHtml(credential.credentialId)}

wrangler secret put SUPER_API_SECRET
# paste: ${escapeHtml(credential.secret)}</pre>
      <div class="actions" style="margin-top:18px;">
        <a class="btn" href="/tenants/${encodeURIComponent(tenant.id)}">Go to tenant</a>
        <a class="btn btn-secondary" href="/tenants">Back to all tenants</a>
      </div>
    </div>
  `;

  return renderShell({ title: "Tenant registered", activeKey: "tenants-new", admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Health
// -----------------------------------------------------

export async function renderHealthPage(env, admin) {
  const tenants = await registry.listTenants(env);

  const body = `
    <h1>Health</h1>
    <p class="subtitle">Last known reachability for each tenant. Checked automatically every few minutes, or run it now below.</p>
    <div class="card">
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
        <button class="btn" id="run-all-btn"${onClick("lummetRunAllHealthChecks", [])}>Run all now</button>
      </div>
      <div id="run-all-result"></div>
      ${
        tenants.length === 0
          ? `<div class="empty">No tenants registered yet.</div>`
          : `<table>
              <thead><tr><th>Tenant</th><th>Status</th><th>Last checked</th></tr></thead>
              <tbody>
                ${tenants
                  .map(
                    (t) => `
                    <tr>
                      <td><a href="/tenants/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a></td>
                      <td>${healthBadge(t.health_status)}</td>
                      <td>${escapeHtml(t.last_checked_at || "never")}</td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </div>

    <script nonce="${nonceToken()}">
      function lummetRunAllHealthChecks() {
        const btn = document.getElementById('run-all-btn');
        const resultEl = document.getElementById('run-all-result');
        btn.disabled = true;
        btn.textContent = 'Running…';
        fetch('/api/tenants/health-check-all', { method: 'POST' })
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              const s = data.data;
              resultEl.innerHTML = '<div class="flash flash-success">Checked ' + s.checked +
                ' tenant(s) — ' + s.online + ' online, ' + s.disabled + ' disabled, ' + s.failed + ' failed.</div>';
              setTimeout(() => location.reload(), 1200);
            } else {
              resultEl.innerHTML = '<div class="flash flash-error">Run failed: ' + (data.error || 'unknown error') + '</div>';
              btn.disabled = false;
              btn.textContent = 'Run all now';
            }
          })
          .catch(() => {
            resultEl.innerHTML = '<div class="flash flash-error">Run failed.</div>';
            btn.disabled = false;
            btn.textContent = 'Run all now';
          });
      }
    </script>
  `;

  return renderShell({ title: "Health", activeKey: "tenants-health", admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Deployments
// -----------------------------------------------------

export async function renderDeploymentsPage(env, admin) {
  const tenants = await registry.listTenants(env);

  const body = `
    <h1>Deployments</h1>
    <p class="subtitle">Deployment identifiers and reported Super API versions.</p>
    <div class="card">
      ${
        tenants.length === 0
          ? `<div class="empty">No tenants registered yet.</div>`
          : `<table>
              <thead><tr><th>Tenant</th><th>Deployment ID</th><th>API version</th><th>Base URL</th></tr></thead>
              <tbody>
                ${tenants
                  .map(
                    (t) => `
                    <tr>
                      <td><a href="/tenants/${encodeURIComponent(t.id)}">${escapeHtml(t.name)}</a></td>
                      <td class="mono">${escapeHtml(t.deployment_identifier || "—")}</td>
                      <td>${t.api_version != null ? escapeHtml(t.api_version) : "—"}</td>
                      <td class="mono">${escapeHtml(t.api_base_url)}</td>
                    </tr>`
                  )
                  .join("")}
              </tbody>
            </table>`
      }
    </div>
  `;

  return renderShell({ title: "Deployments", activeKey: "tenants-deployments", admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Tenant detail
// -----------------------------------------------------

export async function renderTenantDetail(env, admin, tenantId, flash) {
  const tenant = await registry.getTenant(env, tenantId);
  if (!tenant) return null;

  const health = await registry.getTenantHealth(env, tenantId);
  const capabilities = await registry.getTenantCapabilities(env, tenantId);

  const flashHtml = flash
    ? `<div class="flash ${flash.type === "error" ? "flash-error" : "flash-success"}">${escapeHtml(flash.message)}</div>`
    : "";

  const capabilityRows = capabilities.length
    ? capabilities
        .map(
          (c) => `<span class="badge ${c.enabled ? "badge-ok" : "badge-dim"}" style="margin:2px;">${escapeHtml(c.capability)}</span>`
        )
        .join("")
    : `<span style="color:var(--text-dim);font-size:13px;">No capabilities cached yet — run "Test connection".</span>`;

  const isActive = admin.activeTenantId === tenant.id;

  const body = `
    <h1>${escapeHtml(tenant.name)}</h1>
    <p class="subtitle mono">${escapeHtml(tenant.host)} &nbsp;·&nbsp; ${escapeHtml(tenant.api_base_url)}</p>
    ${flashHtml}

    <div class="card">
      <h2>Status</h2>
      <p>${statusBadge(tenant.status)} &nbsp; ${healthBadge(health?.status)}
        ${health?.last_checked_at ? `<span style="color:var(--text-dim);font-size:13px;"> — checked ${escapeHtml(health.last_checked_at)}</span>` : ""}
        ${isActive ? `<span class="badge badge-ok" style="margin-left:6px;">Active tenant</span>` : ""}
      </p>
      ${health?.last_error ? `<p style="color:var(--danger);font-size:13px;">Last error: ${escapeHtml(health.last_error)}</p>` : ""}
      <div class="actions">
        ${
          isActive
            ? ""
            : `<button class="btn"${onClick("lummetAction", [`/api/tenants/${tenant.id}/switch`, "POST", "Switching\u2026"])}>Set as active tenant</button>`
        }
        <button class="btn ${isActive ? "" : "btn-secondary"}"${onClick("lummetAction", [`/api/tenants/${tenant.id}/test-connection`, "POST", "Testing connection\u2026"])}>Test connection</button>
        ${
          tenant.status === "active"
            ? `<button class="btn btn-secondary"${onClick("lummetAction", [`/api/tenants/${tenant.id}/disable`, "POST", "Disabling\u2026"])}>Disable</button>`
            : `<button class="btn btn-secondary"${onClick("lummetAction", [`/api/tenants/${tenant.id}/enable`, "POST", "Enabling\u2026"])}>Enable</button>`
        }
        <button class="btn btn-secondary"${onClick("lummetRotate", [tenant.id], {confirm: "Rotate credential? The tenant Worker will need updated secrets immediately."})}>Rotate credential</button>
        <button class="btn btn-danger" ${onClick("lummetAction", [`/api/tenants/${tenant.id}`, "DELETE", "Deleting…", "/tenants"], { confirm: "Delete this tenant from the registry? This does NOT touch the tenant's own data." })}>Delete registration</button>
      </div>
    </div>

    <div class="card">
      <h2>Capabilities</h2>
      <div>${capabilityRows}</div>
    </div>

    <div class="card">
      <h2>Details</h2>
      <table>
        <tbody>
          <tr><td style="color:var(--text-dim);">Deployment ID</td><td class="mono">${escapeHtml(tenant.deployment_identifier || "—")}</td></tr>
          <tr><td style="color:var(--text-dim);">Description</td><td>${escapeHtml(tenant.description || "—")}</td></tr>
          <tr><td style="color:var(--text-dim);">Registered</td><td>${escapeHtml(tenant.created_at)}</td></tr>
          <tr><td style="color:var(--text-dim);">Last seen</td><td>${escapeHtml(tenant.last_seen_at || "never")}</td></tr>
        </tbody>
      </table>
    </div>

    <div id="rotate-result"></div>

    <script nonce="${nonceToken()}">
      function lummetAction(url, method, loadingMsg, redirectTo) {
        fetch(url, { method })
          .then(r => r.json())
          .then(data => {
            if (data.success) {
              location.href = redirectTo || location.href;
            } else {
              alert('Failed: ' + (data.error || 'unknown error'));
              location.reload();
            }
          })
          .catch(() => { alert('Request failed.'); location.reload(); });
      }

      function lummetRotate(id) {
        fetch('/api/tenants/' + id + '/rotate-credential', { method: 'POST' })
          .then(r => r.json())
          .then(data => {
            if (!data.success) { alert('Failed: ' + (data.message || data.error || 'unknown error')); return; }
            document.getElementById('rotate-result').innerHTML =
              '<div class="card"><h2>New credential — copy it now, shown only once</h2>' +
              '<pre class="mono" style="background:var(--bg);padding:14px;border-radius:8px;overflow-x:auto;">' +
              'wrangler secret put SUPER_API_CREDENTIAL_ID\\n# paste: ' + data.credential.credentialId + '\\n\\n' +
              'wrangler secret put SUPER_API_SECRET\\n# paste: ' + data.credential.secret +
              '</pre></div>';
          })
          .catch(() => alert('Request failed.'));
      }
    </script>
  `;

  return renderShell({ title: tenant.name, activeKey: "tenants-all", admin, bodyHtml: body, env });
}
