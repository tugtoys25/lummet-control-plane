// =====================================================
// CUSTOMER PORTAL SHELL (master prompt section 8)
//
// Reuses legacy-styles.js STYLES and layout.js escapeHtml (same visual language as
// the staff console — deliberately, this is one product) rather
// than duplicating ~170 lines of CSS. What's different from the
// staff shell: navigation is entitlement-aware instead of
// permission-aware, and the switcher is between the customer's
// own organizations, never between tenants (a customer never
// sees the tenant registry at all).
//
// SCOPE NOTE: only pages that actually exist link anywhere —
// Overview, Sites, Billing, Team. Nav items for pages not yet
// built (Analytics, Domains, Reports, Campaigns, Alerts, Media,
// Integrations, Automations, AI, API Keys, Notifications,
// Settings, Support — master prompt section 8's fuller list)
// are rendered as visibly disabled, not as links that would 404
// — see the "not yet built" reasoning in the completion report.
// Their backend APIs already exist (tenant-portal.js, domains.js)
// for a future pass to wire up.
// =====================================================

import { nonceToken, onClick, onChange } from "../csp.js";
import { escapeHtml } from "./layout.js";
import { STYLES } from "./legacy-styles.js";

const NAV = [
  { label: "Overview", href: "/app/overview", key: "overview" },
  { label: "Sites", href: "/app/sites", key: "sites" },
  { label: "Domains", href: "/app/domains", key: "domains" },
  { label: "Deployments", href: "/app/deployments", key: "deployments" },
  { label: "Team", href: "/app/team", key: "team" },
  { label: "Billing", href: "/app/billing", key: "billing" },
  { label: "Usage & AI", href: "/app/usage", key: "usage" },
  { label: "Backups", href: "/app/backups", key: "backups" },
  { label: "Automations", href: "/app/automations", key: "automations" },
  { label: "API & webhooks", href: "/app/developer", key: "developer" },
  { label: "Settings", href: "/app/settings", key: "settings" },
  { label: "Account", href: "/app/account", key: "account" }
];

const COMING_SOON = [
  "Analytics", "Reports", "Campaigns", "Alerts",
  "Media", "Integrations", "Notifications", "Settings", "Support"
];

function renderNav(activeKey, hiddenNavKeys = []) {
  // Entries the plan doesn't include are hidden, except the page the user
  // is currently on (reached by URL), which explains the limit itself.
  const hidden = new Set(hiddenNavKeys);
  const links = NAV.filter((item) => !hidden.has(item.key) || item.key === activeKey).map(
    (item) => `<a href="${item.href}" class="${item.key === activeKey ? "active" : ""}">${escapeHtml(item.label)}</a>`
  ).join("");

  const disabled = COMING_SOON.map(
    (label) => `<span class="nav-disabled">${escapeHtml(label)} <em>soon</em></span>`
  ).join("");

  return `
    <div class="nav-section">
      <h4>Dashboard</h4>
      ${links}
    </div>
    <div class="nav-section">
      <h4>Coming soon</h4>
      ${disabled}
    </div>`;
}

function renderOrgSwitcher(organizations, activeOrganizationId) {
  const options = organizations
    .map(
      (org) =>
        `<option value="${escapeHtml(org.id)}" ${org.id === activeOrganizationId ? "selected" : ""}>${escapeHtml(org.name)}</option>`
    )
    .join("");

  return `
    <div class="switcher">
      <label for="org-switcher">Organization</label>
      <select id="org-switcher"${onChange("lummetSwitchOrg", ["$value"])}>
        ${options}
      </select>
    </div>`;
}

/**
 * Full customer-portal page shell. `organizations` is the caller's
 * full list (for the switcher); `activeOrganizationId` picks which
 * one is highlighted — the actual "which org is this page showing"
 * decision is made by the route handler before calling this, same
 * as the staff shell's tenant switcher.
 */
export function renderCustomerShell({ title, activeKey, customer, organizations, activeOrganizationId, bodyHtml, hiddenNavKeys = [] }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · Lummet</title>
  <style>
    ${STYLES}
    .switcher { display: flex; align-items: center; gap: 8px; }
    .switcher label { margin: 0; white-space: nowrap; }
    .switcher select { width: auto; min-width: 180px; margin: 0; }
    .topbar-right { display: flex; align-items: center; gap: 18px; }
    .nav-disabled { display: block; padding: 7px 20px; color: #4a4f60; font-size: 14px; }
    .nav-disabled em { font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; margin-left: 4px; }
    .stat { text-align: center; padding: 14px 0; }
    .stat .value { font-size: 26px; font-weight: 700; }
    .stat .label { font-size: 12px; color: var(--text-dim); margin-top: 4px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.03em; }
    .badge-trialing, .badge-active { background: rgba(62, 207, 142, 0.14); color: var(--ok); }
    .badge-past_due, .badge-suspended { background: rgba(245, 166, 35, 0.14); color: var(--warn); }
    .badge-canceled, .badge-failed, .badge-expired { background: rgba(240, 82, 107, 0.14); color: var(--danger); }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; color: var(--text-dim); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.03em; padding: 8px 10px; border-bottom: 1px solid var(--panel-border); }
    td { padding: 10px; border-bottom: 1px solid var(--panel-border); }
    tr:last-child td { border-bottom: none; }
  </style>
</head>
<body>
  <nav class="sidebar">
    <div class="brand"><span class="dot">●</span> Lummet</div>
    ${renderNav(activeKey, hiddenNavKeys)}
  </nav>
  <div class="main">
    <div class="topbar">
      ${organizations.length ? renderOrgSwitcher(organizations, activeOrganizationId) : "<div></div>"}
      <div class="topbar-right">
        <div class="who">${customer ? escapeHtml(customer.email) : ""}</div>
        <a class="logout" href="#"${onClick("lummetLogout", [], { prevent: true })}>Log out</a>
      </div>
    </div>
    <div class="content">
      ${bodyHtml}
    </div>
  </div>
  <script nonce="${nonceToken()}">
    function lummetLogout() { fetch('/api/customer/logout', { method: 'POST' }).then(() => { location.href = '/app/login'; }); }
    function lummetSwitchOrg(id) {
      fetch('/api/organizations/' + id + '/switch', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
          if (data.success) { location.reload(); }
          else { alert('Could not switch organization: ' + (data.error || 'unknown error')); }
        })
        .catch(() => alert('Could not switch organization.'));
    }
  </script>
</body>
</html>`;
}

export { escapeHtml };
