import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, applyMigrations } from "./support/d1-shim.js";
import { renderShell, NAV } from "../worker/views/layout.js";

// Every link the sidebar offered before the grouped redesign. The redesign
// moves links between groups; it must never drop or add one.
// (v7A: plus the SaaS console links, which the SaaS merge added to the staff nav.)
const PREVIOUS_HREFS = [
  "/dashboard",
  "/platform/saas",
  "/platform/saas/organizations",
  "/platform/saas/subscriptions",
  "/platform/saas/plans",
  "/platform/saas/coupons",
  "/platform/saas/domains",
  "/platform/saas/deployments",
  "/platform/saas/webhooks",
  "/platform/saas/api-keys",
  "/platform/saas/backups",
  "/platform/saas/alerts",
  "/platform/saas/cp-backups",
  "/platform/saas/key-rotation",
  "/platform/saas/jobs",
  "/platform/saas/email",
  "/platform/saas/releases",

  "/ai",
  "/tenants",
  "/tenants/new",
  "/tenants/health",
  "/tenants/deployments",
  "/content/casinos",
  "/content/reviews",
  "/content/news",
  "/content/authors",
  "/content/updates",
  "/content/pages",
  "/content/categories",
  "/content/countries",
  "/content/research",
  "/content/newsroom-sections",
  "/content/newsroom-topics",
  "/content/newsroom-entities",
  "/content/newsroom-series",
  "/content/research-sources",
  "/content/country-pages",
  "/content/category-countries",
  "/content/seo",
  "/content/integrations",
  "/content/ai-tools",
  "/content/support",
  "/content/newsletter",
  "/content/affiliate-partners",
  "/content/affiliate-programs",
  "/content/affiliate-accounts",
  "/content/commercial-terms",
  "/content/offers",
  "/content/tracking-links",
  "/content/payment-methods",
  "/content/campaigns",
  "/content/reports",
  "/content/alerts",
  "/content/analytics",
  "/system/users",
  "/system/permissions",
  "/system/components",
  "/system/blocks",
  "/system/nav-items",
  "/system/banners",
  "/system/media",
  "/system/settings",
  "/cms/pages",
  "/cms/authors",
  "/cms/brands",
  "/cms/partners",
  "/cms/updates",
  "/cms/publications",
  "/cms/advertisements",
  "/cms/homepage_sections",
  "/cms/features",
  "/cms/faqs",
  "/cms/nav_links",
  "/cms/inquiries",
  "/cms/forms",
  "/cms/form_fields",
  "/cms/ui_strings",
  "/cms/settings",
  "/platform/admins",
  "/platform/api",
  "/platform/credentials",
  "/platform/audit-logs",
  "/platform/capabilities"
];

let env;

beforeEach(async () => {
  const db = createTestDb();
  applyMigrations(db);
  env = { LUMMET_DB: db };
  await db.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (1, 'a@test.local', 'x', 'super_admin')`).run();
  await db.prepare(`INSERT INTO lummet_admins (id, email, password_hash, role) VALUES (2, 'staff@test.local', 'x', 'admin')`).run();
});

const superAdmin = { id: 1, role: "super_admin", email: "a@test.local", activeTenantId: null };
const staff = { id: 2, role: "admin", email: "staff@test.local", activeTenantId: null };

function hrefsIn(html) {
  const nav = html.slice(html.indexOf('id="sidebar"'), html.indexOf('class="nav-backdrop"'));
  return [...nav.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);
}

describe("navigation data", () => {
  test("the grouped nav offers exactly the links the flat nav did", () => {
    const now = NAV.flatMap((s) => s.items.map((i) => i.href));
    assert.deepEqual([...now].sort(), [...PREVIOUS_HREFS].sort());
  });

  test("keys and hrefs are unique and every group has an id, label and icon", () => {
    const items = NAV.flatMap((s) => s.items);
    assert.equal(new Set(items.map((i) => i.key)).size, items.length);
    assert.equal(new Set(items.map((i) => i.href)).size, items.length);
    for (const s of NAV) {
      assert.ok(s.id && s.section && s.icon, `incomplete group ${s.section}`);
    }
    assert.equal(new Set(NAV.map((s) => s.id)).size, NAV.length);
  });

  test("no group is a wall of links (largest group stays scannable)", () => {
    assert.ok(Math.max(...NAV.map((s) => s.items.length)) <= 10);
  });

  test("Tenants, SaaS and Platform stay super-admin only; permission-gated items keep area and resource", () => {
    assert.deepEqual(NAV.filter((s) => s.superAdminOnly).map((s) => s.id).sort(), ["platform", "saas", "saas-ops", "tenants"]);
    const ai = NAV.flatMap((s) => s.items).find((i) => i.key === "ai-chat");
    assert.equal(ai.href, "/ai");
    assert.equal(ai.area, undefined);
    const casinos = NAV.flatMap((s) => s.items).find((i) => i.key === "content-casinos");
    assert.deepEqual([casinos.area, casinos.resource], ["tenant", "casinos"]);
  });
});

describe("renderShell", () => {
  test("super admin sees every link, grouped, with a menu toggle instead of a link bar", async () => {
    const html = await renderShell({ title: "Overview", activeKey: "dashboard", admin: superAdmin, bodyHtml: "<p>x</p>", env });
    assert.deepEqual([...hrefsIn(html)].sort(), [...PREVIOUS_HREFS].sort());
    assert.match(html, /id="nav-toggle"[^>]*aria-controls="sidebar"[^>]*aria-expanded=/);
    assert.match(html, /class="nav-backdrop" id="nav-backdrop"/);
    assert.match(html, /<details class="nav-group"/);
    assert.match(html, /class="skip-link" href="#main-content"/);
    assert.match(html, /<main class="content" id="main-content">/);
    assert.match(html, /@media \(max-width: 900px\)/);
  });

  test("the active page is marked, its group is open and flagged", async () => {
    const html = await renderShell({ title: "Reviews", activeKey: "content-reviews", admin: superAdmin, bodyHtml: "", env });
    assert.match(html, /<a href="\/content\/reviews" class="active" aria-current="page">Reviews<\/a>/);
    assert.match(html, /<details class="nav-group" data-group="content" data-has-active open>/);
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
  });

  test("a staff admin with no grants sees only always-visible links, and no super-admin groups", async () => {
    const html = await renderShell({ title: "Overview", activeKey: "dashboard", admin: staff, bodyHtml: "", env });
    const links = hrefsIn(html);
    assert.deepEqual([...links].sort(), ["/ai", "/dashboard"]);
    assert.doesNotMatch(html, /data-group="tenants"/);
    assert.doesNotMatch(html, /data-group="platform"/);
    assert.doesNotMatch(html, /\/platform\/credentials/);
  });

  test("a staff admin sees a link only after a read grant, and empty groups disappear", async () => {
    await env.LUMMET_DB.prepare(
      `INSERT INTO lummet_admin_permissions (admin_id, area, resource, action, allowed) VALUES (2, 'tenant', 'casinos', 'read', 1)`
    ).run();
    const html = await renderShell({ title: "Overview", activeKey: "dashboard", admin: staff, bodyHtml: "", env });
    const links = hrefsIn(html);
    assert.ok(links.includes("/content/casinos"));
    assert.ok(!links.includes("/content/reviews"));
    assert.match(html, /data-group="content"/);
    assert.doesNotMatch(html, /data-group="monetization"/);
  });

  test("supports light and dark themes without a flash and remembers the choice safely", async () => {
    const html = await renderShell({ title: "Overview", activeKey: "dashboard", admin: superAdmin, bodyHtml: "", env });
    assert.match(html, /:root\[data-theme="light"\]/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /prefers-color-scheme: light/);
    assert.match(html, /try \{[\s\S]*localStorage/);
  });

  test("wraps page content in a table-scroll helper and escapes the title and email", async () => {
    const evil = { ...superAdmin, email: '<img src=x onerror=1>@test.local' };
    const html = await renderShell({ title: "<script>alert(1)</script>", activeKey: "dashboard", admin: evil, bodyHtml: "", env });
    assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
    assert.doesNotMatch(html, /<img src=x onerror=1>/);
    assert.match(html, /table-wrap/);
  });
});
