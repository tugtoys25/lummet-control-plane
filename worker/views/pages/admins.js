// =====================================================
// LUMMET ADMIN MANAGEMENT (Phase 10)
// Super-admin-only screens: list/create/edit Lummet staff
// accounts, grant/revoke super admin, enable/disable an
// account, scope which tenants a staff account may switch
// to, and scope which Content/System resources (per tenant)
// and which lummet.com CMS resources they may act on.
//
// Route-level enforcement (not just hiding the nav link) is
// what actually matters here — see index.js, which checks
// rbac.isSuperAdmin() before every handler in this file.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import * as auth from "../../auth.js";
import { setPermission, setTenantAccess, loadPermissionMap, isSuperAdmin } from "../../rbac.js";
import { RESOURCES } from "../../resources.js";
import { CMS_RESOURCES } from "../../cms-resources.js";
import { nonceToken } from "../../csp.js";

const ACTIONS = ["create", "read", "update", "delete"];

function flashHtml(flash) {
  if (!flash) return "";
  return `<div class="flash flash-${flash.type === "error" ? "error" : "success"}">${escapeHtml(flash.message)}</div>`;
}

// -----------------------------------------------------
// LIST
// -----------------------------------------------------

export async function renderAdminsList(env, admin, flash) {
  const admins = await auth.listAdmins(env);

  const rows = admins
    .map((a) => {
      const roleLabel = a.role === "super_admin" || a.role === "master_admin" ? "Super admin" : "Staff";
      return `<tr>
        <td>${escapeHtml(a.email)}</td>
        <td>${escapeHtml(roleLabel)}</td>
        <td>${a.status === "disabled" ? `<span style="color:var(--danger);">Disabled</span>` : "Active"}</td>
        <td>${a.two_factor_enabled ? "On" : `<span style="color:var(--danger);">Off</span>`}</td>
        <td>${escapeHtml((a.created_at || "").slice(0, 10))}</td>
        <td style="white-space:nowrap;">
          <a class="btn btn-secondary btn-small" href="/platform/admins/${a.id}">Manage</a>
          ${a.id !== admin.id ? `<button type="button" class="btn btn-secondary btn-small" data-toggle-status="${a.id}" data-next="${a.status === "disabled" ? "active" : "disabled"}">${a.status === "disabled" ? "Enable" : "Disable"}</button>` : ""}
          ${a.id !== admin.id && a.two_factor_enabled ? `<button type="button" class="btn btn-secondary btn-small" data-reset-2fa="${a.id}">Reset 2FA</button>` : ""}
        </td>
      </tr>`;
    })
    .join("");

  const body = `
    <h1>Admins</h1>
    <p class="subtitle">Platform · Lummet staff accounts — who can log in to this control plane, and what they can do.</p>
    ${flashHtml(flash)}
    <div class="card">
      <div style="display:flex;justify-content:flex-end;margin-bottom:12px;">
        <a class="btn btn-primary" href="/platform/admins/new">+ New admin</a>
      </div>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Created</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <script nonce="${nonceToken()}">
      document.body.addEventListener("click", (e) => {
        const resetBtn = e.target.closest("[data-reset-2fa]");
        if (resetBtn) {
          if (!confirm("Remove this admin's two-factor authentication and sign them out? They must set it up again.")) return;
          fetch("/api/admins/" + resetBtn.dataset.reset2fa + "/2fa-reset", { method: "POST" })
            .then((r) => r.json()).then((d) => { if (d.success) location.reload(); else alert("Could not reset: " + (d.error || "unknown error")); });
          return;
        }
        const btn = e.target.closest("[data-toggle-status]");
        if (!btn) return;
        fetch("/api/admins/" + btn.dataset.toggleStatus + "/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: btn.dataset.next })
        }).then((r) => r.json()).then((data) => {
          if (data.success) location.reload();
          else alert("Could not update: " + (data.error || "unknown error"));
        });
      });
    </script>`;

  return renderShell({ title: "Admins", activeKey: "platform-admins", admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// NEW
// -----------------------------------------------------

export async function renderNewAdminForm(env, admin, formError) {
  const body = `
    <h1>New admin</h1>
    <p class="subtitle">Platform · Admins · New</p>
    ${formError ? `<div class="flash flash-error">${escapeHtml(formError)}</div>` : ""}
    <form method="POST" action="/platform/admins/new" class="card">
      <div class="form-group">
        <label>Email</label>
        <input type="email" name="email" required />
      </div>
      <div class="form-group">
        <label>Role</label>
        <select name="role">
          <option value="staff">Staff — access granted individually below, after creation</option>
          <option value="super_admin">Super admin — full access to everything, always</option>
        </select>
      </div>
      <p style="font-size:13px;color:var(--text-dim);">
        A temporary password is generated automatically and shown exactly once on the next screen —
        there's no email sending set up, so make sure to copy it before leaving the page.
        The new admin must change it on first login.
      </p>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button type="submit" class="btn btn-primary">Create admin</button>
        <a class="btn btn-secondary" href="/platform/admins">Cancel</a>
      </div>
    </form>`;

  return renderShell({ title: "New admin", activeKey: "platform-admins", admin, bodyHtml: body, env });
}

export function renderAdminCreatedPage(env, admin, newAdminEmail, tempPassword) {
  const body = `
    <h1>Admin created</h1>
    <p class="subtitle">Platform · Admins · ${escapeHtml(newAdminEmail)}</p>
    <div class="flash flash-success">Account created. This temporary password is shown <strong>exactly once</strong> — copy it now.</div>
    <div class="card">
      <div class="form-group"><label>Email</label><input type="text" readonly value="${escapeHtml(newAdminEmail)}" /></div>
      <div class="form-group"><label>Temporary password</label><input type="text" readonly value="${escapeHtml(tempPassword)}" style="font-family:monospace;" /></div>
    </div>
    <a class="btn btn-primary" href="/platform/admins/${encodeURIComponent(newAdminEmail)}">Grant access now</a>
    <a class="btn btn-secondary" href="/platform/admins">Back to Admins</a>`;

  return renderShell({ title: "Admin created", activeKey: "platform-admins", admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// DETAIL — role/status toggles, tenant access, permission matrix
// -----------------------------------------------------

export async function renderAdminDetail(env, admin, targetId, flash) {
  const target = await auth.getAdminById(env, targetId);
  if (!target) {
    return renderShell({ title: "Admin", activeKey: "platform-admins", admin, bodyHtml: `<h1>Admin</h1><div class="flash flash-error">Not found.</div>`, env });
  }

  const targetIsSuper = isSuperAdmin(target);

  const tenantsResult = await env.LUMMET_DB.prepare(`SELECT id, name FROM tenants ORDER BY name`).all();
  const allTenants = tenantsResult.results || [];
  const accessResult = await env.LUMMET_DB.prepare(
    `SELECT tenant_id FROM lummet_admin_tenant_access WHERE admin_id = ?`
  ).bind(target.id).all();
  const accessTenantIds = new Set((accessResult.results || []).map((r) => r.tenant_id));

  const permMap = targetIsSuper ? null : await loadPermissionMap(env, target);

  const tenantChecklist = allTenants.length
    ? allTenants
        .map(
          (t) => `<label class="perm-toggle" style="display:flex;gap:6px;align-items:center;margin:4px 0;">
            <input type="checkbox" data-tenant-access="${escapeHtml(t.id)}" ${accessTenantIds.has(t.id) ? "checked" : ""} ${targetIsSuper ? "disabled" : ""} />
            <span>${escapeHtml(t.name)}</span>
          </label>`
        )
        .join("")
    : `<div class="empty">No tenants registered yet.</div>`;

  function matrixTable(area, resourceKeys) {
    const cell = (resource, action) => {
      const allowed = permMap === null ? true : !!permMap?.[area]?.[resource]?.[action];
      return `<label class="perm-toggle" title="${escapeHtml(action)}">
        <input type="checkbox" data-area="${area}" data-resource="${escapeHtml(resource)}" data-action="${escapeHtml(action)}" ${allowed ? "checked" : ""} ${targetIsSuper ? "disabled" : ""} />
        <span>${action[0].toUpperCase()}</span>
      </label>`;
    };
    return `<div style="overflow-x:auto;">
      <table>
        <thead><tr><th>Resource</th><th>Actions</th></tr></thead>
        <tbody>
          ${resourceKeys.map((r) => `<tr><td>${escapeHtml(r)}</td><td style="white-space:nowrap;">${ACTIONS.map((a) => cell(r, a)).join("")}</td></tr>`).join("")}
        </tbody>
      </table>
    </div>`;
  }

  const tenantResourceKeys = Object.keys(RESOURCES).concat(["settings", "seo_pages", "postback_configs", "ai_tools"]);
  const cmsResourceKeys = Object.keys(CMS_RESOURCES).concat(["site_settings"]);

  const body = `
    <h1>${escapeHtml(target.email)}</h1>
    <p class="subtitle">Platform · Admins · ${escapeHtml(target.email)}</p>
    ${flashHtml(flash)}

    <div class="card">
      <h3 style="margin-top:0;">Role &amp; status</h3>
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-end;">
        <div class="form-group" style="min-width:220px;">
          <label>Role</label>
          <select id="roleSelect" ${target.id === admin.id ? "disabled" : ""}>
            <option value="staff" ${!targetIsSuper ? "selected" : ""}>Staff — scoped access below</option>
            <option value="super_admin" ${targetIsSuper ? "selected" : ""}>Super admin — full access always</option>
          </select>
        </div>
        <button type="button" class="btn btn-secondary" id="saveRoleBtn" ${target.id === admin.id ? "disabled" : ""}>Save role</button>
      </div>
      ${target.id === admin.id ? `<p style="font-size:12px;color:var(--text-dim);">You can't change your own role.</p>` : ""}
      ${target.must_change_password ? `<p style="font-size:12px;color:var(--warn);">This admin hasn't changed their temporary password yet.</p>` : ""}
    </div>

    ${targetIsSuper
      ? `<div class="card"><p style="font-size:13px;color:var(--text-dim);">Super admins always have full access to every tenant and every resource — there's nothing to scope. Switch this admin to "Staff" above to configure granular access.</p></div>`
      : `
      <div class="card">
        <h3 style="margin-top:0;">Tenant access</h3>
        <p style="font-size:13px;color:var(--text-dim);margin-top:0;">Which tenants this admin may switch to and act on at all.</p>
        <div id="tenantChecklist">${tenantChecklist}</div>
      </div>

      <div class="card">
        <h3 style="margin-top:0;">Content &amp; System access (per active tenant)</h3>
        <p style="font-size:13px;color:var(--text-dim);margin-top:0;">Same resources as the tenant's own Content/System nav. Applies to whichever tenant this admin has switched to.</p>
        ${matrixTable("tenant", tenantResourceKeys)}
      </div>

      <div class="card">
        <h3 style="margin-top:0;">Lummet Site (CMS) access</h3>
        <p style="font-size:13px;color:var(--text-dim);margin-top:0;">lummet.com's own pages, authors, brands, partners, updates, publications, advertisements and homepage settings.</p>
        ${matrixTable("cms", cmsResourceKeys)}
      </div>
      `}

    <a class="btn btn-secondary" href="/platform/admins">Back to Admins</a>
    ${target.id !== admin.id ? `<button type="button" class="btn btn-secondary" id="deleteAdminBtn" style="color:var(--danger);">Delete admin</button>` : ""}

    <script nonce="${nonceToken()}">
      const TARGET_ID = ${JSON.stringify(String(target.id))};

      document.getElementById("saveRoleBtn")?.addEventListener("click", () => {
        const role = document.getElementById("roleSelect").value;
        fetch("/api/admins/" + TARGET_ID + "/role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role })
        }).then((r) => r.json()).then((data) => {
          if (data.success) location.reload();
          else alert("Could not save: " + (data.error || "unknown error"));
        });
      });

      document.getElementById("tenantChecklist")?.addEventListener("change", (e) => {
        const input = e.target.closest("[data-tenant-access]");
        if (!input) return;
        fetch("/api/admins/" + TARGET_ID + "/tenant-access", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tenant_id: input.dataset.tenantAccess, allowed: input.checked })
        }).then((r) => r.json()).then((data) => {
          if (!data.success) alert("Could not save: " + (data.error || "unknown error"));
        });
      });

      document.body.addEventListener("change", (e) => {
        const input = e.target.closest("input[data-area][data-resource][data-action]");
        if (!input) return;
        fetch("/api/admins/" + TARGET_ID + "/permission", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ area: input.dataset.area, resource: input.dataset.resource, action: input.dataset.action, allowed: input.checked })
        }).then((r) => r.json()).then((data) => {
          if (!data.success) alert("Could not save: " + (data.error || "unknown error"));
        });
      });

      document.getElementById("deleteAdminBtn")?.addEventListener("click", () => {
        if (!confirm("Delete this admin? This cannot be undone.")) return;
        fetch("/api/admins/" + TARGET_ID, { method: "DELETE" }).then((r) => r.json()).then((data) => {
          if (data.success) location.href = "/platform/admins";
          else alert("Could not delete: " + (data.error || "unknown error"));
        });
      });
    </script>
    <style>
      .perm-toggle { display:inline-flex; align-items:center; gap:3px; margin-right:8px; font-size:11px; color:var(--text-dim); cursor:pointer; }
      .perm-toggle input { width:auto; margin:0; }
    </style>`;

  return renderShell({ title: target.email, activeKey: "platform-admins", admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// Submit handlers (called from index.js)
// -----------------------------------------------------

export async function submitCreateAdmin(env, admin, form) {
  const result = await auth.createAdmin(env, { email: form.email, role: form.role || "staff", createdBy: admin.id });
  return result;
}

export async function submitSetRole(env, targetId, role, requestingAdminId) {
  if (String(targetId) === String(requestingAdminId)) {
    return { ok: false, status: 403, error: "cannot_change_own_role" };
  }
  if (role !== "super_admin") {
    const remaining = await auth.countSuperAdmins(env);
    const target = await auth.getAdminById(env, targetId);
    const targetWasSuper = target && (target.role === "super_admin" || target.role === "master_admin");
    if (targetWasSuper && remaining <= 1) {
      return { ok: false, status: 409, error: "last_super_admin" };
    }
  }
  return auth.setAdminRole(env, targetId, role);
}

export async function submitSetStatus(env, targetId, status, requestingAdminId) {
  if (String(targetId) === String(requestingAdminId)) {
    return { ok: false, status: 403, error: "cannot_disable_self" };
  }
  return auth.setAdminStatus(env, targetId, status);
}

export async function submitDeleteAdmin(env, targetId, requestingAdminId) {
  if (String(targetId) === String(requestingAdminId)) {
    return { ok: false, status: 403, error: "cannot_delete_self" };
  }
  const target = await auth.getAdminById(env, targetId);
  if (target && (target.role === "super_admin" || target.role === "master_admin")) {
    const remaining = await auth.countSuperAdmins(env);
    if (remaining <= 1) return { ok: false, status: 409, error: "last_super_admin" };
  }
  return auth.deleteAdmin(env, targetId);
}

export async function submitSetTenantAccess(env, targetId, tenantId, allowed) {
  await setTenantAccess(env, targetId, tenantId, allowed);
  return { ok: true };
}

export async function submitSetPermission(env, targetId, area, resource, action, allowed) {
  await setPermission(env, targetId, area, resource, action, allowed);
  return { ok: true };
}
