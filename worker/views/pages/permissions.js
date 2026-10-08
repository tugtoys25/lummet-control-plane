// =====================================================
// PERMISSIONS
// Two related but distinct screens:
//
//   1. Role permissions matrix (/system/permissions) — the
//      existing role/resource/action `permissions` table on the
//      tenant, which the Super API already exposed (handleList/Set/
//      DeletePermission) but no control-plane screen ever rendered.
//
//   2. Per-user item-level access (/system/users/:id/item-access) —
//      the tenant's separate, finer-grained `user_item_access` /
//      `item_access_assignments` tables (migration 0014), which
//      previously had no Super API surface at all (see
//      handlers.js's new handleGetUserItemAccess etc.).
//
// Both auto-save each change with a small fetch on change/click —
// there's no single "Save" button, matching the tenant's own
// settings-style screens elsewhere isn't required here since every
// control here maps to exactly one row in the tenant's DB.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";

async function resolveActiveTenant(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

function noActiveTenantNotice(env, admin, activeKey, title) {
  const body = `
    <h1>${escapeHtml(title)}</h1>
    <div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>
  `;
  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

// -----------------------------------------------------
// 1. ROLE PERMISSIONS MATRIX
// -----------------------------------------------------

const ACTIONS = ["create", "read", "update", "delete"];

// A broad, practical set of resource keys this tenant's own
// checkPermission() calls actually gate — the permissions table
// itself has no fixed resource enum (it's free-text), so custom
// resource names can still be added via the "Add resource" field.
// -----------------------------------------------------------------
// IMPORTANT: these strings must match, character for character, what
// each route actually passes to hasPermission() in rbac.js -- that
// function does a raw exact-string lookup with NO hyphen/underscore
// normalization (see rbac.js). Verified against index.js directly
// (both flavors of gate):
//   - Generic crud.js resources: the gate is whatever key that
//     resource uses in resources.js's RESOURCES dictionary --
//     hyphenated for every multi-word one (e.g. "affiliate-partners",
//     "tracking-links", "payment-methods"). This list previously had
//     several of these as "affiliate_partners" etc. (underscored,
//     matching the TENANT's own internal api.js permission strings,
//     not the control plane's own). That mismatch meant: a
//     non-super-admin granted "affiliate_partners" via this exact
//     matrix would NEVER actually pass the real check, since the
//     route looks up "affiliate-partners" -- the grant silently did
//     nothing. Fixed below.
//   - Dedicated (non-generic) routes: the gate is whatever literal
//     string is hand-written at that route's requirePermission/
//     checkResourcePermission call -- these already use underscores
//     ("seo_pages", "analytics_alerts") and were already correct.
// Resources removed from the list below (ad-rules, platform-updates,
// permissions, seo, postback_configs, import_batches,
// provider_adapter_configs, analytics_conversions, the old "nav") are
// not phantom by accident -- grepping index.js confirms nothing in
// the control plane currently calls hasPermission with those exact
// strings (a couple appear ONLY inside logAudit's audit-log label,
// which is unrelated to enforcement). Toggling them here would set a
// permissions-table row that is never read by anything. They stay out
// until each gets a real gated route of its own; setting one up is
// the same handful-of-lines pattern as ad-rules currently uses
// (folded into "settings"), reports.js, or alerts.js.
// -----------------------------------------------------------------
const DEFAULT_RESOURCES = [
  // Content (CMS) -- generic crud.js/resources.js dispatch
  "casinos", "reviews", "news", "updates", "pages", "categories", "countries", "research",
  "authors", "media", "components", "banners", "nav-items", "users", "blocks",
  "affiliate-partners", "affiliate-programs", "affiliate-accounts",
  "commercial-terms", "offers", "tracking-links", "campaigns", "payment-methods",
  // Dedicated routes -- literal strings verified at each call site
  "settings", "seo_pages", "reports", "analytics", "analytics_alerts", "seo",
  // Support tooling (no tenant-side RBAC exists yet -- see
  // handlers.js section header on the tenant. This matrix is
  // currently the ONLY place these are gated at all.)
  "inquiries", "submissions", "notifications", "newsletter"
];

export async function renderPermissionsMatrix(env, admin) {
  const activeKey = "system-permissions";
  const tenant = await resolveActiveTenant(env, admin);
  if (!tenant) return noActiveTenantNotice(env, admin, activeKey, "Permissions");

  const [permsResult, usersResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/permissions`),
    getFromTenant(env, tenant, `${BASE_PATH}/users`)
  ]);

  if (!permsResult.ok) {
    const body = `
      <h1>Permissions</h1>
      <div class="flash flash-error"><strong>${escapeHtml(String(permsResult.status))}</strong> — ${escapeHtml(permsResult.message || "Could not load permissions.")}</div>
    `;
    return renderShell({ title: "Permissions", activeKey, admin, bodyHtml: body, env });
  }

  const matrix = permsResult.data.data?.matrix || {};
  const rows = permsResult.data.data?.rows || [];
  const users = usersResult.ok ? usersResult.data.data || [] : [];

  // Roles worth showing: any role a real user has, plus any role
  // that already has explicit permission rows — minus 'admin',
  // which bypasses this table entirely (checkPermission returns
  // true unconditionally for it — see permissions.js on the tenant).
  const roles = [...new Set([...users.map((u) => u.role), ...rows.map((r) => r.role)])]
    .filter((r) => r && r !== "admin")
    .sort();

  const resources = [...new Set([...DEFAULT_RESOURCES, ...rows.map((r) => r.resource)])];

  const rowIdByCell = {};
  for (const r of rows) rowIdByCell[`${r.role}::${r.resource}::${r.action}`] = r.id;

  function cell(role, resource, action) {
    const allowed = matrix[role]?.[resource]?.[action] === true;
    return `<label class="perm-toggle" title="${escapeHtml(action)}">
      <input type="checkbox" data-role="${escapeHtml(role)}" data-resource="${escapeHtml(resource)}" data-action="${escapeHtml(action)}" ${allowed ? "checked" : ""} />
      <span>${action[0].toUpperCase()}</span>
    </label>`;
  }

  const tableHtml = roles.length === 0
    ? `<div class="empty">No non-admin roles yet — add one below, or invite a user with a non-admin role first.</div>`
    : `<div style="overflow-x:auto;">
        <table>
          <thead>
            <tr>
              <th>Role</th>
              ${resources.map((r) => `<th>${escapeHtml(r)}</th>`).join("")}
            </tr>
          </thead>
          <tbody id="permMatrixBody">
            ${roles.map((role) => `
              <tr>
                <td><strong>${escapeHtml(role)}</strong></td>
                ${resources.map((resource) => `
                  <td style="white-space:nowrap;">
                    ${ACTIONS.map((action) => cell(role, resource, action)).join("")}
                  </td>
                `).join("")}
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>`;

  const body = `
    <h1>Permissions</h1>
    <p class="subtitle">System · Permissions on <strong>${escapeHtml(tenant.name)}</strong> — role/resource/action matrix</p>
    <div class="card">
      <p style="font-size:13px;color:var(--text-dim);margin-top:0;">Toggle which actions a role can take on each resource. <strong>admin</strong> always has full access and isn't shown. Checking a box grants it immediately — there's nothing else to save.</p>
      ${tableHtml}
      <div style="display:flex;gap:8px;align-items:center;margin-top:16px;">
        <input type="text" id="newRoleInput" placeholder="Add a role (e.g. editor)" style="max-width:220px;margin:0;" />
        <button type="button" class="btn btn-secondary btn-small" id="addRoleBtn">Add role</button>
        <input type="text" id="newResourceInput" placeholder="Add a resource (e.g. faqs)" style="max-width:220px;margin:0;" />
        <button type="button" class="btn btn-secondary btn-small" id="addResourceBtn">Add resource</button>
      </div>
    </div>
    <p class="subtitle" style="margin-top:20px;">Looking for per-item access (which specific casino/review/etc a user can touch)? Set that from a user's row on the <a href="/system/users">Users</a> page.</p>
    <style>
      .perm-toggle { display:inline-flex; align-items:center; gap:3px; margin-right:8px; font-size:11px; color:var(--text-dim); cursor:pointer; }
      .perm-toggle input { width:auto; margin:0; }
    </style>
    <script nonce="${nonceToken()}">
      async function lummetSetPermission(role, resource, action, allowed) {
        const res = await fetch("/api/permissions/set", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role, resource, action, allowed })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.success) alert("Could not save: " + (data.message || data.error || "unknown error"));
      }

      document.getElementById("permMatrixBody")?.addEventListener("change", (e) => {
        const input = e.target.closest("input[data-role]");
        if (!input) return;
        lummetSetPermission(input.dataset.role, input.dataset.resource, input.dataset.action, input.checked);
      });

      document.getElementById("addRoleBtn")?.addEventListener("click", () => {
        const input = document.getElementById("newRoleInput");
        const role = input.value.trim();
        if (!role) return;
        // A role with no rows yet has nothing to show until its
        // first box is checked — so create one explicit "read:
        // false" row via the same endpoint to make the row appear,
        // then reload to render it in the matrix.
        lummetSetPermission(role, ${JSON.stringify(resources[0] || "casinos")}, "read", false)
          .then(() => location.reload());
      });

      document.getElementById("addResourceBtn")?.addEventListener("click", () => {
        const input = document.getElementById("newResourceInput");
        const resource = input.value.trim();
        if (!resource || ${JSON.stringify(roles)}.length === 0) return;
        lummetSetPermission(${JSON.stringify(roles[0] || "")}, resource, "read", false)
          .then(() => location.reload());
      });
    </script>
  `;

  return renderShell({ title: "Permissions", activeKey, admin, bodyHtml: body, env });
}

export async function submitSetPermission(env, admin, payload) {
  const tenant = await resolveActiveTenant(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  if (!payload.role || !payload.resource || !payload.action) {
    return { ok: false, status: 422, reason: "role_resource_and_action_required" };
  }
  const { putToTenant } = await import("../../client.js");
  return putToTenant(env, tenant, `${BASE_PATH}/permissions`, {
    role: payload.role,
    resource: payload.resource,
    action: payload.action,
    allowed: !!payload.allowed
  });
}

// -----------------------------------------------------
// 2. PER-USER ITEM-LEVEL ACCESS
// -----------------------------------------------------

const ITEM_ACCESS_ACTIONS = ["create", "read", "update", "delete"];
const SCOPES = ["none", "own", "all", "assigned"];
const SCOPE_HINTS = {
  none: "no access",
  own: "only items they created",
  all: "every item",
  assigned: "only specifically assigned items"
};

// Resources this control plane can already list by id/slug + a
// human label, for a friendlier "add assignment" picker. Anything
// else (e.g. platform-updates, which has no Super API list yet)
// still works — the picker just falls back to a plain numeric id.
const ITEM_LABEL_SOURCES = {
  casinos: { path: "casinos", labelKey: "name", idKey: "id" },
  reviews: { path: "reviews", labelKey: "title", idKey: "id" },
  news: { path: "news", labelKey: "title", idKey: "id" },
  pages: { path: "pages", labelKey: "title", idKey: "id" },
  media: { path: "media", labelKey: "filename", idKey: "id" }
};

export async function renderUserItemAccess(env, admin, userId) {
  const activeKey = "system-users";
  const tenant = await resolveActiveTenant(env, admin);
  if (!tenant) return noActiveTenantNotice(env, admin, activeKey, "Item access");

  const [userResult, accessResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/users/${encodeURIComponent(userId)}`),
    getFromTenant(env, tenant, `${BASE_PATH}/item-access/${encodeURIComponent(userId)}`)
  ]);

  if (!userResult.ok) {
    const body = `<h1>Item access</h1><div class="flash flash-error">Could not load that user.</div>`;
    return renderShell({ title: "Item access", activeKey, admin, bodyHtml: body, env });
  }
  if (!accessResult.ok) {
    const body = `<h1>Item access</h1><div class="flash flash-error"><strong>${escapeHtml(String(accessResult.status))}</strong> — ${escapeHtml(accessResult.message || "Could not load item access. If this tenant hasn't redeployed with the new /en/api/super/item-access routes yet, that's why.")}</div>`;
    return renderShell({ title: "Item access", activeKey, admin, bodyHtml: body, env });
  }

  const user = userResult.data.data;
  const { access, defaultScope, resources, assignments } = accessResult.data.data;

  const scopeByCell = {};
  for (const row of access) scopeByCell[`${row.resource}::${row.action}`] = row.scope;

  // Best-effort: fetch a label list for any resource this control
  // plane knows how to list. Failures here just mean plainer
  // (id-only) pickers for that resource — never block the page.
  const itemOptions = {};
  await Promise.all(
    Object.entries(ITEM_LABEL_SOURCES).map(async ([resource, src]) => {
      const r = await getFromTenant(env, tenant, `${BASE_PATH}/${src.path}`);
      itemOptions[resource] = r.ok
        ? (r.data.data || []).map((item) => ({ id: item[src.idKey], label: item[src.labelKey] || `#${item[src.idKey]}` }))
        : [];
    })
  );

  const scopeSelect = (resource, action) => {
    const current = scopeByCell[`${resource}::${action}`] || `default (${defaultScope})`;
    const options = [`<option value="">default — ${escapeHtml(defaultScope)}</option>`]
      .concat(SCOPES.map((s) => `<option value="${s}" ${scopeByCell[`${resource}::${action}`] === s ? "selected" : ""}>${s} — ${escapeHtml(SCOPE_HINTS[s])}</option>`))
      .join("");
    return `<select data-scope-resource="${escapeHtml(resource)}" data-scope-action="${escapeHtml(action)}" style="width:auto;">${options}</select>`;
  };

  const assignmentRows = (resource) => {
    const ids = assignments[resource] || [];
    const options = itemOptions[resource] || [];
    const labelFor = (id) => options.find((o) => String(o.id) === String(id))?.label || `#${id}`;
    return `
      <div data-assignment-list="${escapeHtml(resource)}" style="margin:6px 0 10px 0;">
        ${
          ids.length === 0
            ? `<span style="color:var(--text-dim);font-size:12px;">No items assigned yet.</span>`
            : ids
                .map(
                  (id) => `<span class="badge" data-item-id="${escapeHtml(id)}" style="margin:0 6px 6px 0;display:inline-flex;align-items:center;gap:6px;">
                    ${escapeHtml(labelFor(id))}
                    <a href="#" data-unassign="${escapeHtml(resource)}" data-item="${escapeHtml(id)}" style="color:var(--danger);">✕</a>
                  </span>`
                )
                .join("")
        }
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        ${
          options.length > 0
            ? `<select data-assign-picker="${escapeHtml(resource)}" style="flex:1;max-width:320px;">
                <option value="">Choose an item…</option>
                ${options.filter((o) => !ids.includes(o.id)).map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.label)} (#${escapeHtml(o.id)})</option>`).join("")}
              </select>`
            : `<input type="number" data-assign-picker="${escapeHtml(resource)}" placeholder="Item id" style="max-width:120px;margin:0;" />`
        }
        <button type="button" class="btn btn-secondary btn-small" data-assign-btn="${escapeHtml(resource)}">Assign</button>
      </div>`;
  };

  const resourceSections = resources
    .map(
      (resource) => `
      <div class="card" style="margin-bottom:14px;">
        <h3 style="margin-top:0;">${escapeHtml(resource)}</h3>
        <table style="margin-bottom:10px;">
          <thead><tr><th>Action</th><th>Scope</th></tr></thead>
          <tbody>
            ${ITEM_ACCESS_ACTIONS.map((action) => `<tr><td>${action}</td><td>${scopeSelect(resource, action)}</td></tr>`).join("")}
          </tbody>
        </table>
        <div data-assigned-section="${escapeHtml(resource)}" style="${(ITEM_ACCESS_ACTIONS.some((a) => scopeByCell[`${resource}::${a}`] === "assigned")) ? "" : "display:none;"}">
          <label style="font-size:12px;color:var(--text-dim);">Assigned items (used when any action's scope above is "assigned")</label>
          ${assignmentRows(resource)}
        </div>
      </div>`
    )
    .join("");

  const body = `
    <h1>Item access</h1>
    <p class="subtitle">System · Users · Item access for <strong>${escapeHtml(user.email)}</strong> (${escapeHtml(user.role)}) on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card">
      <p style="font-size:13px;color:var(--text-dim);margin-top:0;">
        This sits on top of the role permissions matrix (<a href="/system/permissions">Permissions</a>): that decides whether ${escapeHtml(user.role)} can act on a resource at all, this decides <em>which items</em>.
        Leaving a scope on "default" means it follows the tenant-wide default (currently <strong>${escapeHtml(defaultScope)}</strong>).
      </p>
    </div>
    ${resourceSections}
    <a class="btn btn-secondary" href="/system/users">Back to Users</a>
    <script nonce="${nonceToken()}">
      const USER_ID = ${JSON.stringify(String(userId))};

      async function callItemAccess(path, body) {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        const data = await res.json().catch(() => ({}));
        if (!data.success) alert("Could not save: " + (data.message || data.error || "unknown error"));
        return data.success;
      }

      document.body.addEventListener("change", (e) => {
        const sel = e.target.closest("select[data-scope-resource]");
        if (!sel) return;
        const resource = sel.dataset.scopeResource;
        const action = sel.dataset.scopeAction;
        const scope = sel.value;
        const section = document.querySelector('[data-assigned-section="' + resource + '"]');
        if (section) section.style.display = scope === "assigned" ? "" : "none";
        if (!scope) return; // "default" — nothing to persist, but we don't have a clean "unset" here, so leave it selected only
        callItemAccess("/api/item-access/" + USER_ID + "/scope", { resource, action, scope });
      });

      document.body.addEventListener("click", (e) => {
        const assignBtn = e.target.closest("[data-assign-btn]");
        if (assignBtn) {
          const resource = assignBtn.dataset.assignBtn;
          const picker = document.querySelector('[data-assign-picker="' + resource + '"]');
          const itemId = picker.value;
          if (!itemId) return;
          callItemAccess("/api/item-access/" + USER_ID + "/assignment", { resource, item_id: Number(itemId), assigned: true })
            .then((success) => { if (success) location.reload(); });
          return;
        }
        const unassign = e.target.closest("[data-unassign]");
        if (unassign) {
          e.preventDefault();
          const resource = unassign.dataset.unassign;
          const itemId = unassign.dataset.item;
          callItemAccess("/api/item-access/" + USER_ID + "/assignment", { resource, item_id: Number(itemId), assigned: false })
            .then((success) => { if (success) location.reload(); });
        }
      });
    </script>
  `;

  return renderShell({ title: "Item access", activeKey, admin, bodyHtml: body, env });
}

export async function submitSetItemScope(env, admin, userId, payload) {
  const tenant = await resolveActiveTenant(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const { putToTenant } = await import("../../client.js");
  return putToTenant(env, tenant, `${BASE_PATH}/item-access/${encodeURIComponent(userId)}`, {
    resource: payload.resource,
    action: payload.action,
    scope: payload.scope
  });
}

export async function submitSetItemAssignment(env, admin, userId, payload) {
  const tenant = await resolveActiveTenant(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  const { putToTenant } = await import("../../client.js");
  return putToTenant(env, tenant, `${BASE_PATH}/item-access/${encodeURIComponent(userId)}/assignment`, {
    resource: payload.resource,
    item_id: payload.item_id,
    assigned: !!payload.assigned
  });
}
