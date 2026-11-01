import test from "node:test";
import assert from "node:assert/strict";
import { renderOverviewPage } from "../worker/views/customer-pages/overview.js";

const usage = { sites: { used: 0, limit: 1 }, users: { used: 1, limit: 1 }, customDomains: { used: 0, limit: 0 } };
const base = { organization: { name: "Org" }, subscription: null, plan: null, usage, sites: [] };

test("overview: 2FA notice only when asked, linking to the setup page", () => {
  const on = renderOverviewPage({ ...base, showTwoFactorNotice: true });
  const off = renderOverviewPage({ ...base });
  assert.ok(on.includes("Strengthen your account security") && on.includes('href="/app/security/2fa"'));
  assert.ok(!off.includes("Strengthen your account security"));
});

test("overview: getting-started guide is a collapsible details block with clickable action paths, shown until a site exists", () => {
  const html = renderOverviewPage({ ...base });
  assert.ok(html.includes('<details class="card" id="getting-started-guide">') && html.includes("<summary"));
  assert.ok(html.includes("GET YOUR WEBSITE LIVE") && html.includes("Paying with crypto"));
  for (const p of ["/app/billing", "/app/sites", "/app/content", "/app/domains"]) assert.ok(html.includes('href="' + p + '"'), p);
  const withSite = renderOverviewPage({ ...base, sites: [{ id: "s1", name: "S", status: "live" }] });
  assert.ok(!withSite.includes("getting-started-guide"));
});
