import { renderShell, escapeHtml } from "../layout.js";

const LABELS = {
  casinos: "Casinos", reviews: "Reviews", news: "News", pages: "Pages",
  categories: "Categories", countries: "Countries",
  users: "Users", permissions: "Permissions", components: "Components",
  media: "Media", settings: "Settings"
};

export async function renderResourcePlaceholder(env, admin, section, resource, activeKey) {
  const label = LABELS[resource] || resource;

  const activeTenant = admin.activeTenantId
    ? await env.LUMMET_DB.prepare(`SELECT id, name, status FROM tenants WHERE id = ?`)
        .bind(admin.activeTenantId)
        .first()
    : null;

  const tenantCount = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM tenants WHERE status = 'active'`
  ).first();

  const hasTenants = (tenantCount?.c || 0) > 0;

  const activeTenantNotice = activeTenant
    ? `<p style="font-size:14px;">Active tenant is <strong>${escapeHtml(activeTenant.name)}</strong> — once ${escapeHtml(label.toLowerCase())} CRUD screens ship (Phase 6), this page will manage that tenant's ${escapeHtml(label.toLowerCase())} directly.</p>`
    : `<p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p>`;

  const body = `
    <h1>${escapeHtml(label)}</h1>
    <p class="subtitle">${escapeHtml(section)} · ${escapeHtml(label)}</p>
    <div class="card">
      <p style="color:var(--text-dim);font-size:14px;">
        Managing ${escapeHtml(label.toLowerCase())} through Lummet resolves against whichever
        tenant is currently active (see the switcher above). The resource-specific CRUD
        screens themselves land in the next phase of the rollout.
      </p>
      ${activeTenantNotice}
      ${
        hasTenants
          ? `<p style="font-size:14px;">You can <a href="/tenants">view registered tenants</a> or check a tenant's <a href="/platform/capabilities">cached capabilities</a> to confirm it supports this resource.</p>`
          : `<p style="font-size:14px;">No active tenants are registered yet — <a href="/tenants/new">add one</a> first.</p>`
      }
    </div>
  `;

  return renderShell({ title: label, activeKey, admin, bodyHtml: body, env });
}
