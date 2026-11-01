// =====================================================
// CUSTOMER PORTAL SHELL
//
// Same shell as the staff console (layout.js): the same stylesheet, icons, grouped collapsible sidebar with
// a page finder, sticky topbar, light/dark theme and phone drawer, all from shell-assets.js. A customer's
// dashboard therefore looks and behaves like the admin one; only the navigation data differs.
//
// What is different from the staff shell, on purpose:
//   - Navigation is entitlement-aware instead of permission-aware. Entries for features the plan does not
//     include are hidden (see hiddenNavKeys in index.js); the routes themselves stay the access control.
//   - The switcher moves between the customer's own organizations, never tenants. Customers never see the
//     tenant registry. The select keeps id="org-switcher" because several pages read it.
//   - Pages that are not built yet (Integrations, Support) are listed as visibly disabled, never as links
//     that would 404.
//
// Pages call renderCustomerShell({ title, activeKey, customer, organizations, activeOrganizationId, bodyHtml,
// hiddenNavKeys, navBadges }); that contract is unchanged.
// =====================================================

import { nonceToken, onClick, onChange } from "../csp.js";
import { escapeHtml } from "./layout.js";
import { ICONS, BOOT_SCRIPT } from "./shell-assets.js";
import { PORTAL_CSS_URL, SHELL_JS_URL } from "../perf/shell-bundle.js";

// Grouping follows the staff console: a workspace group first, then what the customer measures, earns,
// runs, automates and administers. Every group is collapsible and the one holding the current page is open.
const NAV = [
  {
    id: "workspace",
    section: "Workspace",
    icon: "workspace",
    items: [
      { label: "Overview", href: "/app/overview", key: "overview" },
      { label: "Sites", href: "/app/sites", key: "sites" },
      { label: "Content", href: "/app/content", key: "content" },
      { label: "Search", href: "/app/search", key: "search" }
    ]
  },
  {
    id: "insights",
    section: "Insights",
    icon: "insights",
    items: [
      { label: "Analytics", href: "/app/analytics", key: "analytics" },
      { label: "Reports", href: "/app/reports", key: "reports" },
      { label: "Alerts", href: "/app/alerts", key: "alerts" },
      { label: "Notifications", href: "/app/notifications", key: "notifications" }
    ]
  },
  {
    id: "monetization",
    section: "Monetization",
    icon: "money",
    items: [
      { label: "Campaigns", href: "/app/campaigns", key: "campaigns" }
    ]
  },
  {
    id: "hosting",
    section: "Hosting",
    icon: "tenants",
    items: [
      { label: "Domains", href: "/app/domains", key: "domains" },
      { label: "Deployments", href: "/app/deployments", key: "deployments" },
      { label: "Backups", href: "/app/backups", key: "backups" }
    ]
  },
  {
    id: "automation",
    section: "Automation & API",
    icon: "bolt",
    items: [
      { label: "Automations", href: "/app/automations", key: "automations" },
      { label: "API & webhooks", href: "/app/developer", key: "developer" }
    ]
  },
  {
    id: "organization",
    section: "Organization",
    icon: "team",
    items: [
      { label: "Team", href: "/app/team", key: "team" },
      { label: "Billing", href: "/app/billing", key: "billing" },
      { label: "Usage & AI", href: "/app/usage", key: "usage" },
      { label: "Settings", href: "/app/settings", key: "settings" },
      { label: "Account", href: "/app/account", key: "account" }
    ]
  }
];

const COMING_SOON = ["Integrations", "Support"];

function badgeText(count) {
  const n = Number(count) || 0;
  return n > 99 ? "99+" : String(n);
}

/**
 * Renders NAV as collapsible groups, exactly like the staff sidebar. Entries the plan does not include are
 * left out, except the page the customer is on right now (reached by URL), which explains the limit itself.
 * A group with nothing left to show disappears. The group holding the current page is open; so is the first
 * group, so a new visitor sees where to start.
 */
function renderNav(activeKey, hiddenNavKeys = [], navBadges = {}) {
  const hidden = new Set(hiddenNavKeys);
  let firstRendered = true;

  const groups = NAV.map((section) => {
    const visibleItems = section.items.filter((item) => !hidden.has(item.key) || item.key === activeKey);
    if (visibleItems.length === 0) return null;

    const hasActive = visibleItems.some((item) => item.key === activeKey);
    const open = hasActive || firstRendered;
    firstRendered = false;

    return `
      <details class="nav-group" data-group="${escapeHtml(section.id)}"${hasActive ? " data-has-active" : ""}${open ? " open" : ""}>
        <summary>
          <span class="icon group-icon">${ICONS[section.icon] || ""}</span>
          <span class="group-label">${escapeHtml(section.section)}</span>
          <span class="group-count">${visibleItems.length}</span>
          <span class="icon chevron">${ICONS.chevron}</span>
        </summary>
        <div class="nav-links">
          ${visibleItems
            .map((item) => {
              const active = item.key === activeKey;
              const count = Number(navBadges[item.key]) || 0;
              const classes = [active ? "active" : "", count > 0 ? "has-badge" : ""].filter(Boolean).join(" ");
              return `<a href="${item.href}"${classes ? ` class="${classes}"` : ""}${active ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}${count > 0 ? `<span class="nav-badge" aria-label="${count} open">${badgeText(count)}</span>` : ""}</a>`;
            })
            .join("")}
        </div>
      </details>`;
  }).filter(Boolean);

  const soon = `
      <details class="nav-group" data-group="coming-soon">
        <summary>
          <span class="icon group-icon">${ICONS.layout}</span>
          <span class="group-label">Coming soon</span>
          <span class="group-count">${COMING_SOON.length}</span>
          <span class="icon chevron">${ICONS.chevron}</span>
        </summary>
        <div class="nav-links">
          ${COMING_SOON.map((label) => `<span class="nav-disabled" aria-disabled="true">${escapeHtml(label)}<em>soon</em></span>`).join("")}
        </div>
      </details>`;

  return groups.join("") + soon;
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

function renderUserMenu(customer, role) {
  const email = customer.email || "";
  const initial = escapeHtml(email.trim().charAt(0) || "?");
  return `
    <details class="user-menu" id="user-menu">
      <summary aria-label="Account menu">
        <span class="avatar">${initial}</span>
        <span class="who-name">${escapeHtml(email)}</span>
      </summary>
      <div class="menu-pop">
        <div class="who-full">${escapeHtml(email)}${role ? `<br><span class="role-badge">${escapeHtml(role)}</span>` : ""}</div>
        <a href="/app/account">Account</a>
        <a href="/app/billing">Billing</a>
        <button type="button"${onClick("lummetLogout", [])}>Log out</button>
      </div>
    </details>`;
}

/**
 * Full customer-portal page shell: grouped sidebar + topbar (menu toggle, organization switcher, theme,
 * account) + content. `organizations` is the caller's full list; `activeOrganizationId` picks the highlighted
 * one. Which organization a page shows is decided by the route handler before this is called, the same way
 * the staff shell's tenant switcher works.
 */
export function renderCustomerShell({ title, activeKey, customer, organizations = [], activeOrganizationId, bodyHtml, hiddenNavKeys = [], navBadges = {} }) {
  const activeOrg = organizations.find((org) => org.id === activeOrganizationId) || null;
  const role = activeOrg && activeOrg.my_role ? String(activeOrg.my_role) : "";
  const scope = activeOrg && activeOrg.name ? activeOrg.name : "Lummet";

  return `<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark light" />
  <title>${escapeHtml(title)} · Lummet</title>
  <script nonce="${nonceToken()}">${BOOT_SCRIPT}</script>
  <link rel="preload" href="/static/fonts/instrument-400-v1.woff" as="font" type="font/woff" crossorigin />
  <link rel="preload" href="/static/fonts/bricolage-700-v1.woff" as="font" type="font/woff" crossorigin />
  <link rel="stylesheet" href="${PORTAL_CSS_URL}" />
  <script nonce="${nonceToken()}" src="${SHELL_JS_URL}" defer></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <div class="app">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <div class="sidebar-head">
        <a class="brand" href="/app/overview"><span class="dot"></span> Lummet</a>
        <button type="button" class="icon-btn nav-close" id="nav-close" aria-label="Close menu">${ICONS.close}</button>
      </div>
      <div class="nav-filter-wrap">
        <input type="search" id="nav-filter" placeholder="Find a page…" aria-label="Find a page" autocomplete="off" />
      </div>
      <nav class="nav-scroll" aria-label="Sections">
        ${renderNav(activeKey, hiddenNavKeys, navBadges)}
        <div class="nav-empty" id="nav-empty" hidden>No matching pages.</div>
      </nav>
    </aside>
    <div class="nav-backdrop" id="nav-backdrop"></div>
    <div class="main">
      <header class="topbar">
        <button type="button" class="icon-btn" id="nav-toggle" aria-controls="sidebar" aria-expanded="true" aria-label="Toggle menu">${ICONS.menu}</button>
        <div class="page-crumb">${escapeHtml(scope)} <span aria-hidden="true">/</span> <strong>${escapeHtml(title)}</strong></div>
        <div class="topbar-right">
          <button type="button" class="icon-btn theme-toggle" id="theme-toggle" aria-label="Switch color theme"><span class="icon sun">${ICONS.sun}</span><span class="icon moon">${ICONS.moon}</span></button>
          ${customer ? renderUserMenu(customer, role) : ""}
        </div>
        ${organizations.length ? renderOrgSwitcher(organizations, activeOrganizationId) : ""}
      </header>
      <main class="content" id="main-content">
        ${bodyHtml}
      </main>
      <!--lummet:site-footer-compact-->
    </div>
  </div>
  <!--lummet:cookie-banner-->
  <script nonce="${nonceToken()}">
    function lummetLogout() { fetch('/api/customer/logout', { method: 'POST' }).then(function () { location.href = '/app/login'; }); }
    function lummetSwitchOrg(id) {
      fetch('/api/organizations/' + encodeURIComponent(id) + '/switch', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.success) { location.reload(); }
          else { alert('Could not switch organization: ' + (data.error || 'unknown error')); }
        })
        .catch(function () { alert('Could not switch organization.'); });
    }
  </script>
</body>
</html>`;
}

export { escapeHtml, NAV };
