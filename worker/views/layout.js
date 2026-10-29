// =====================================================
// DASHBOARD SHELL
// Server-rendered HTML shell shared by every Lummet
// dashboard page. Deliberately its own visual identity —
// distinct from the tenant admin UI — per the master
// plan's rule #11 ("visually and structurally separate
// from the normal tenant admin").
//
// Navigation is grouped into collapsible sections behind a
// menu toggle (docked sidebar on desktop, off-canvas drawer
// on phones). Styles, icons and client scripts live in
// shell-assets.js.
// =====================================================

import { nonceToken, onChange } from "../csp.js";
import { isSuperAdmin, loadPermissionMap, getAdminTenantIds } from "../rbac.js";
import { ICONS, BOOT_SCRIPT } from "./shell-assets.js";
import { SHELL_CSS_URL, SHELL_JS_URL } from "../perf/shell-bundle.js";
import { renderCustomerAuthShell } from "./customer-auth-shell.js";

// Every item below (besides Overview/AI Chat, always visible) can
// declare `area` + `resource` to be gated by rbac.js's permission
// map — a staff admin only ever sees a link if they hold a "read"
// grant on that area/resource; a super admin sees everything.
// Sections marked superAdminOnly (Tenants, Platform) touch the
// control plane itself rather than a single tenant's or
// lummet.com's content. Hiding a link is a convenience only: the
// route guards in worker/index.js are the real boundary.
const NAV = [
  {
    id: "workspace",
    section: "Workspace",
    icon: "workspace",
    items: [
      { label: "Overview", href: "/dashboard", key: "dashboard" },
      { label: "AI Chat", href: "/ai", key: "ai-chat" },
      { label: "AI Tools", href: "/content/ai-tools", key: "content-ai-tools", area: "tenant", resource: "ai_tools" }
    ]
  },
  {
    id: "tenants",
    section: "Tenants",
    icon: "tenants",
    superAdminOnly: true,
    items: [
      { label: "All Tenants", href: "/tenants", key: "tenants-all" },
      { label: "Add Tenant", href: "/tenants/new", key: "tenants-new" },
      { label: "Health", href: "/tenants/health", key: "tenants-health" },
      { label: "Deployments", href: "/tenants/deployments", key: "tenants-deployments" }
    ]
  },
  {
    id: "content",
    section: "Content",
    icon: "content",
    items: [
      { label: "Casinos", href: "/content/casinos", key: "content-casinos", area: "tenant", resource: "casinos" },
      { label: "Reviews", href: "/content/reviews", key: "content-reviews", area: "tenant", resource: "reviews" },
      { label: "News", href: "/content/news", key: "content-news", area: "tenant", resource: "news" },
      { label: "Authors", href: "/content/authors", key: "content-authors", area: "tenant", resource: "authors" },
      { label: "Updates", href: "/content/updates", key: "content-updates", area: "tenant", resource: "updates" },
      { label: "Pages", href: "/content/pages", key: "content-pages", area: "tenant", resource: "pages" },
      { label: "Categories", href: "/content/categories", key: "content-categories", area: "tenant", resource: "categories" },
      { label: "Countries", href: "/content/countries", key: "content-countries", area: "tenant", resource: "countries" }
    ]
  },
  {
    id: "research",
    section: "Research & Newsroom",
    icon: "research",
    items: [
      { label: "Research Zone", href: "/content/research", key: "content-research", area: "tenant", resource: "research" },
      { label: "Research Sources", href: "/content/research-sources", key: "content-research-sources", area: "tenant", resource: "research-sources" },
      { label: "Newsroom Sections", href: "/content/newsroom-sections", key: "content-newsroom-sections", area: "tenant", resource: "newsroom-sections" },
      { label: "Newsroom Topics", href: "/content/newsroom-topics", key: "content-newsroom-topics", area: "tenant", resource: "newsroom-topics" },
      { label: "Newsroom Entities", href: "/content/newsroom-entities", key: "content-newsroom-entities", area: "tenant", resource: "newsroom-entities" },
      { label: "Newsroom Series", href: "/content/newsroom-series", key: "content-newsroom-series", area: "tenant", resource: "newsroom-series" }
    ]
  },
  {
    id: "seo",
    section: "SEO & Geo",
    icon: "seo",
    items: [
      { label: "SEO Meta", href: "/content/seo", key: "content-seo", area: "tenant", resource: "seo" },
      { label: "Country Pages", href: "/content/country-pages", key: "content-country-pages", area: "tenant", resource: "seo_pages" },
      { label: "Category Countries", href: "/content/category-countries", key: "content-category-countries", area: "tenant", resource: "seo_pages" }
    ]
  },
  {
    id: "monetization",
    section: "Monetization",
    icon: "money",
    items: [
      { label: "Affiliate Partners", href: "/content/affiliate-partners", key: "content-affiliate-partners", area: "tenant", resource: "affiliate-partners" },
      { label: "Affiliate Programs", href: "/content/affiliate-programs", key: "content-affiliate-programs", area: "tenant", resource: "affiliate-programs" },
      { label: "Affiliate Accounts", href: "/content/affiliate-accounts", key: "content-affiliate-accounts", area: "tenant", resource: "affiliate-accounts" },
      { label: "Commercial Terms", href: "/content/commercial-terms", key: "content-commercial-terms", area: "tenant", resource: "commercial-terms" },
      { label: "Offers & Bonuses", href: "/content/offers", key: "content-offers", area: "tenant", resource: "offers" },
      { label: "Tracking Links", href: "/content/tracking-links", key: "content-tracking-links", area: "tenant", resource: "tracking-links" },
      { label: "Payment Methods", href: "/content/payment-methods", key: "content-payment-methods", area: "tenant", resource: "payment-methods" },
      { label: "Campaigns", href: "/content/campaigns", key: "content-campaigns", area: "tenant", resource: "campaigns" },
      { label: "Integrations", href: "/content/integrations", key: "content-integrations", area: "tenant", resource: "postback_configs" }
    ]
  },
  {
    id: "insights",
    section: "Insights",
    icon: "insights",
    items: [
      { label: "Analytics", href: "/content/analytics", key: "content-analytics", area: "tenant", resource: "analytics" },
      { label: "Reports", href: "/content/reports", key: "content-reports", area: "tenant", resource: "reports" },
      { label: "Alerts", href: "/content/alerts", key: "content-alerts", area: "tenant", resource: "analytics_alerts" }
    ]
  },
  {
    id: "engagement",
    section: "Engagement",
    icon: "engagement",
    items: [
      { label: "Support", href: "/content/support", key: "content-support", area: "tenant", resource: "inquiries" },
      { label: "Newsletter", href: "/content/newsletter", key: "content-newsletter", area: "tenant", resource: "newsletter" }
    ]
  },
  {
    id: "system",
    section: "System",
    icon: "system",
    items: [
      { label: "Users", href: "/system/users", key: "system-users", area: "tenant", resource: "users" },
      { label: "Permissions", href: "/system/permissions", key: "system-permissions", area: "tenant", resource: "users" },
      { label: "Components", href: "/system/components", key: "system-components", area: "tenant", resource: "components" },
      { label: "Blocks", href: "/system/blocks", key: "system-blocks", area: "tenant", resource: "components" },
      { label: "Navigation", href: "/system/nav-items", key: "system-nav-items", area: "tenant", resource: "settings" },
      { label: "Banners", href: "/system/banners", key: "system-banners", area: "tenant", resource: "banners" },
      { label: "Media", href: "/system/media", key: "system-media", area: "tenant", resource: "media" },
      { label: "Settings", href: "/system/settings", key: "system-settings", area: "tenant", resource: "settings" }
    ]
  },
  {
    id: "site",
    section: "Lummet Site",
    icon: "globe",
    items: [
      { label: "Pages", href: "/cms/pages", key: "cms-pages", area: "cms", resource: "pages" },
      { label: "Authors", href: "/cms/authors", key: "cms-authors", area: "cms", resource: "authors" },
      { label: "Brand profiles", href: "/cms/brands", key: "cms-brands", area: "cms", resource: "brands" },
      { label: "Partners", href: "/cms/partners", key: "cms-partners", area: "cms", resource: "partners" },
      { label: "Updates", href: "/cms/updates", key: "cms-updates", area: "cms", resource: "updates" },
      { label: "Publications", href: "/cms/publications", key: "cms-publications", area: "cms", resource: "publications" },
      { label: "Advertisements", href: "/cms/advertisements", key: "cms-advertisements", area: "cms", resource: "advertisements" }
    ]
  },
  {
    id: "site-layout",
    section: "Site Layout",
    icon: "layout",
    items: [
      { label: "Homepage sections", href: "/cms/homepage_sections", key: "cms-homepage-sections", area: "cms", resource: "homepage_sections" },
      { label: "Features", href: "/cms/features", key: "cms-features", area: "cms", resource: "features" },
      { label: "FAQs", href: "/cms/faqs", key: "cms-faqs", area: "cms", resource: "faqs" },
      { label: "Navigation links", href: "/cms/nav_links", key: "cms-nav-links", area: "cms", resource: "nav_links" },
      { label: "Interface text", href: "/cms/ui_strings", key: "cms-ui-strings", area: "cms", resource: "ui_strings" },
      { label: "Homepage settings", href: "/cms/settings", key: "cms-site-settings", area: "cms", resource: "site_settings" }
    ]
  },
  {
    id: "site-forms",
    section: "Site Forms",
    icon: "forms",
    items: [
      { label: "Forms", href: "/cms/forms", key: "cms-forms", area: "cms", resource: "forms" },
      { label: "Form fields", href: "/cms/form_fields", key: "cms-form-fields", area: "cms", resource: "form_fields" },
      { label: "Inquiries", href: "/cms/inquiries", key: "cms-inquiries", area: "cms", resource: "inquiries" }
    ]
  },
  {
    id: "saas",
    section: "SaaS",
    icon: "platform",
    superAdminOnly: true,
    items: [
      { label: "Overview", href: "/platform/saas", key: "saas-overview" },
      { label: "Organizations", href: "/platform/saas/organizations", key: "saas-orgs" },
      { label: "Subscriptions", href: "/platform/saas/subscriptions", key: "saas-subs" },
      { label: "Plans & pricing", href: "/platform/saas/plans", key: "saas-plans" },
      { label: "Coupons", href: "/platform/saas/coupons", key: "saas-coupons" },
      { label: "Domains", href: "/platform/saas/domains", key: "saas-domains" },
      { label: "Deployments", href: "/platform/saas/deployments", key: "saas-deployments" },
      { label: "Webhooks", href: "/platform/saas/webhooks", key: "saas-webhooks" },
      { label: "Site access", href: "/platform/saas/site-access", key: "saas-site-access" }
    ]
  },
  {
    id: "saas-ops",
    section: "SaaS Operations",
    icon: "platform",
    superAdminOnly: true,
    items: [
      { label: "API keys", href: "/platform/saas/api-keys", key: "saas-apikeys" },
      { label: "Backups", href: "/platform/saas/backups", key: "saas-backups" },
      { label: "Alerts", href: "/platform/saas/alerts", key: "saas-alerts" },
      { label: "Server errors", href: "/platform/saas/errors", key: "saas-errors" },
      { label: "DB backups", href: "/platform/saas/cp-backups", key: "saas-cpbackups" },
      { label: "Key rotation", href: "/platform/saas/key-rotation", key: "saas-keyrotation" },
      { label: "Jobs", href: "/platform/saas/jobs", key: "saas-jobs" },
      { label: "Email outbox", href: "/platform/saas/email", key: "saas-email" },
      { label: "Billing notifications", href: "/platform/saas/notifications", key: "saas-notifications" },
      { label: "Tenant releases", href: "/platform/saas/releases", key: "saas-releases" }
    ]
  },
  {
    id: "platform",
    section: "Platform",
    icon: "platform",
    superAdminOnly: true,
    items: [
      { label: "Admins", href: "/platform/admins", key: "platform-admins" },
      { label: "API", href: "/platform/api", key: "platform-api" },
      { label: "Credentials", href: "/platform/credentials", key: "platform-credentials" },
      { label: "Audit Logs", href: "/platform/audit-logs", key: "platform-audit-logs" },
      { label: "Capabilities", href: "/platform/capabilities", key: "platform-capabilities" }
    ]
  }
];

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * Filters NAV down to what this admin may actually use, then
 * renders it as collapsible groups. `permMap` is the output of
 * rbac.js's loadPermissionMap() — `null` means "super admin,
 * allow everything" (see rbac.js), matching the tenant's own
 * `admin` role bypassing its permissions table. The group that
 * holds the current page is open and marked; the first group is
 * open by default so a new visitor sees where to start.
 */
function renderNav(activeKey, permMap, isSuper) {
  let firstRendered = true;
  return NAV.map((section) => {
    if (section.superAdminOnly && !isSuper) return null;

    const visibleItems = section.items.filter((item) => {
      if (!item.area) return true; // e.g. Overview — always visible
      if (permMap === null) return true; // super admin sentinel
      return !!permMap?.[item.area]?.[item.resource]?.read;
    });
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
            .map(
              (item) =>
                `<a href="${item.href}" class="${item.key === activeKey ? "active" : ""}"${item.key === activeKey ? ' aria-current="page"' : ""}>${escapeHtml(item.label)}</a>`
            )
            .join("")}
        </div>
      </details>`;
  }).filter(Boolean).join("");
}

const SHELL_PREFETCH = new WeakMap();

function loadShellData(env, admin, isSuper = isSuperAdmin(admin)) {
  return Promise.all([
    env ? getSwitcherTenants(env) : [],
    env && admin ? loadPermissionMap(env, admin) : null,
    env && admin && !isSuper ? getAdminTenantIds(env, admin.id) : null
  ]);
}

/**
 * Starts the reads renderShell needs, without waiting for them. Called by the router right after the session is proven,
 * so they overlap with the page's own queries. Never throws and is harmless if the page never renders a shell
 * (JSON routes, redirects): a failed read is swallowed here and simply re-run by renderShell.
 */
export function prefetchShellData(env, admin) {
  if (!env || !admin || SHELL_PREFETCH.has(admin)) return;
  const p = loadShellData(env, admin);
  p.catch(() => SHELL_PREFETCH.delete(admin));
  SHELL_PREFETCH.set(admin, p);
}

async function getSwitcherTenants(env) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT id, name, status FROM tenants ORDER BY name`
  ).all();
  return result.results || [];
}

function renderTenantSwitcher(tenants, activeTenantId) {
  const options = [`<option value="">— none —</option>`]
    .concat(
      tenants.map(
        (t) =>
          `<option value="${escapeHtml(t.id)}" ${t.id === activeTenantId ? "selected" : ""}>${escapeHtml(t.name)}${t.status !== "active" ? " (disabled)" : ""}</option>`
      )
    )
    .join("");

  return `
    <div class="switcher">
      <label for="tenant-switcher">Active tenant</label>
      <select id="tenant-switcher" ${onChange("lummetSwitchTenant", ["$value"])}>
        ${options}
      </select>
    </div>`;
}

function renderUserMenu(admin, isSuper) {
  const initial = escapeHtml((admin.email || "?").trim().charAt(0));
  return `
    <details class="user-menu" id="user-menu">
      <summary aria-label="Account menu">
        <span class="avatar">${initial}</span>
        <span class="who-name">${escapeHtml(admin.email)}</span>
      </summary>
      <div class="menu-pop">
        <div class="who-full">${escapeHtml(admin.email)}<br><span class="role-badge">${escapeHtml(isSuper ? "super admin" : "staff")}</span></div>
        <a href="/account/2fa">Two-factor</a>
        <a href="/account/password">Change password</a>
        <button type="button" id="logout-btn">Log out</button>
      </div>
    </details>`;
}

/**
 * Full page shell: grouped sidebar + topbar (menu toggle, tenant
 * switcher, theme, account) + content. Use for every
 * authenticated dashboard page. Pass `env` so the switcher can
 * list registered tenants; omit it only for pages rendered
 * without D1 access (there currently are none).
 */
export async function renderShell({ title, activeKey, admin, bodyHtml, env }) {
  const isSuper = isSuperAdmin(admin);
  // The three reads that build the chrome are independent, so they run together; and when the router started them as
  // soon as the session was known (prefetchShellData), they have been running while the page itself was being built.
  const [allTenants, permMap, accessibleIds] = await ((admin && SHELL_PREFETCH.get(admin)) || loadShellData(env, admin, isSuper));
  const accessible = accessibleIds ? new Set(accessibleIds) : null;
  const tenants = accessible ? allTenants.filter((t) => accessible.has(t.id)) : allTenants;

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
  <link rel="stylesheet" href="${SHELL_CSS_URL}" />
  <script nonce="${nonceToken()}" src="${SHELL_JS_URL}" defer></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <div class="app">
    <aside class="sidebar" id="sidebar" aria-label="Main navigation">
      <div class="sidebar-head">
        <a class="brand" href="/dashboard"><span class="dot"></span> Lummet</a>
        <button type="button" class="icon-btn nav-close" id="nav-close" aria-label="Close menu">${ICONS.close}</button>
      </div>
      <div class="nav-filter-wrap">
        <input type="search" id="nav-filter" placeholder="Find a page…" aria-label="Find a page" autocomplete="off" />
      </div>
      <nav class="nav-scroll" aria-label="Sections">
        ${renderNav(activeKey, permMap, isSuper)}
        <div class="nav-empty" id="nav-empty" hidden>No matching pages.</div>
      </nav>
    </aside>
    <div class="nav-backdrop" id="nav-backdrop"></div>
    <div class="main">
      <header class="topbar">
        <button type="button" class="icon-btn" id="nav-toggle" aria-controls="sidebar" aria-expanded="true" aria-label="Toggle menu">${ICONS.menu}</button>
        <div class="page-crumb">Lummet <span aria-hidden="true">/</span> <strong>${escapeHtml(title)}</strong></div>
        <div class="topbar-right">
          <a class="btn btn-secondary btn-small view-site" href="/" target="_blank" rel="noopener">View site</a>
          <button type="button" class="icon-btn theme-toggle" id="theme-toggle" aria-label="Switch color theme"><span class="icon sun">${ICONS.sun}</span><span class="icon moon">${ICONS.moon}</span></button>
          ${admin ? renderUserMenu(admin, isSuper) : ""}
        </div>
        ${admin ? renderTenantSwitcher(tenants, admin.activeTenantId) : ""}
      </header>
      <main class="content" id="main-content">
        ${admin && !admin.two_factor_enabled && admin.two_factor_enabled !== undefined ? `<div class="flash flash-error">Your account has no second factor. <a href="/account/2fa">Turn on two-factor authentication</a>: staff accounts can reach every customer.</div>` : ""}
        ${bodyHtml}
      </main>
    </div>
  </div>
  <script nonce="${nonceToken()}">
    function lummetSwitchTenant(id) {
      const url = id ? ('/api/tenants/' + id + '/switch') : '/api/session/active-tenant';
      const method = id ? 'POST' : 'DELETE';
      fetch(url, { method })
        .then(r => r.json())
        .then(data => {
          if (data.success) { location.reload(); }
          else { alert('Could not switch tenant: ' + (data.error || 'unknown error')); }
        })
        .catch(() => alert('Could not switch tenant.'));
    }
  </script>
</body>
</html>`;
}

/**
 * Minimal unauthenticated page shell (login/bootstrap and the emailed-link pages). Since 2.6.0.24 it renders the same
 * auth shell as the customer login (public-site look); audience "staff" adds the "Are you a customer?" link.
 */
export function renderAuthShell({ title, bodyHtml, audience = "customer" }) {
  return renderCustomerAuthShell({ title, bodyHtml, audience });
}

export { escapeHtml, NAV };
