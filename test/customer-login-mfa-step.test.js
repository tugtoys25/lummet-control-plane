import test from "node:test";
import assert from "node:assert/strict";
import { renderCustomerLoginPage } from "../worker/views/customer-pages/login.js";

test("the customer login page has a 2FA code step and does not treat a pending challenge as a finished login", () => {
  const html = String(renderCustomerLoginPage({}));
  assert.ok(html.includes('id="mfa-view"') && html.includes('id="mfa-form"'), "code step markup");
  assert.ok(html.includes("/api/customer/mfa/complete"), "posts the code to the completion route");
  const login = html.indexOf("/api/customer/login");
  const guard = html.indexOf("data.mfaRequired", login);
  const done = html.indexOf("location.href = intentDestination()", login);
  assert.ok(guard > login && guard < done, "mfaRequired is checked before the redirect to the app");
  assert.ok(!/onclick=|onsubmit=/i.test(html.slice(html.indexOf('id="mfa-view"'), html.indexOf('id="signup-view"'))), "no inline handlers in the new markup");
});
