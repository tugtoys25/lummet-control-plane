import test from "node:test";
import assert from "node:assert/strict";
import * as ps from "../worker/platform-settings.js";

test("API_ENTITLEMENT, ORG_2FA_PASSKEY_COUNTS and ORG_2FA_SCOPE are manageable in the staff console with the code defaults", () => {
  const want = { API_ENTITLEMENT: ["off", ["off", "shadow", "enforce"]], ORG_2FA_PASSKEY_COUNTS: ["off", ["off", "on"]], ORG_2FA_SCOPE: ["any_org", ["any_org", "active_org"]] };
  for (const [key, [dflt, options]] of Object.entries(want)) {
    const d = ps.getDef(key);
    assert.ok(d, key + " is defined");
    assert.equal(d.default, dflt);
    assert.deepEqual(d.options, options);
    assert.equal(ps.NOT_MANAGEABLE.has(key), false);
    for (const o of options) assert.equal(ps.validateValue(d, o).ok, true, key + "=" + o);
    assert.equal(ps.validateValue(d, "bogus").ok, false, key + " refuses a stray value");
  }
});
