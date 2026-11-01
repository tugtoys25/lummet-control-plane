import test from "node:test";
import assert from "node:assert/strict";
import { renderCustomerShell } from "../worker/views/customer-layout.js";

const base = { title: "T", activeKey: "overview", customer: { email: "a@b.co" }, organizations: [{ id: "o1", name: "Org", my_role: "owner" }], activeOrganizationId: "o1", bodyHtml: "<p>x</p>" };

test("Security link: in the account menu and the Organization nav only when the 2FA page is on", () => {
  const on = String(renderCustomerShell({ ...base, securityLink: true }));
  const off = String(renderCustomerShell({ ...base }));
  assert.equal((on.match(/href="\/app\/security\/2fa"/g) || []).length, 2, "menu + nav");
  assert.ok(!off.includes("/app/security/2fa"), "no link while the page is off");
  assert.ok(on.indexOf('href="/app/account">Account') < on.indexOf('<a href="/app/security/2fa">Security'), "menu: Security sits below Account");
});
