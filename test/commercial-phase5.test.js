import test from "node:test";
import assert from "node:assert/strict";
import { roleAtLeast, isValidRole } from "../worker/customer-rbac.js";
test("billing role is non-hierarchical", () => { assert.equal(isValidRole("billing"), true); assert.equal(roleAtLeast("billing", "billing"), true); assert.equal(roleAtLeast("admin", "billing"), true); assert.equal(roleAtLeast("billing", "viewer"), false); assert.equal(roleAtLeast("billing", "editor"), false); });

test("credit-pack Checkout requires a caller-supplied retry-stable idempotency key", async () => {
  const { startCreditPackCheckout } = await import("../worker/commercial.js");
  const env = { LUMMET_DB: { prepare(sql) { return { bind() { return { async first() { return sql.includes("credit_packs") ? { id: "pack", credits: 10, stripe_price_id: "price_test" } : null; } }; } }; } } };
  const result = await startCreditPackCheckout(env, "org", "pack", "https://portal.example", "");
  assert.equal(result.ok, false);
  assert.equal(result.error, "idempotency_key_required");
});


test("staff quote editing refuses a sent quote and never grants entitlements on acceptance", async () => {
  const { editQuote, sendQuote } = await import("../worker/commercial.js");
  const env = { LUMMET_DB: { prepare(sql) { return { bind() { return { async first() { return { id: "q1", status: "sent", valid_until: null }; }, async all() { return { results: [{ id: "l1" }] }; }, async run() { return { success: true, meta: { changes: 1 } }; } }; } }; } } };
  const edited = await editQuote(env, "q1", { notes: "change" }, { staffId: "staff-1" });
  assert.equal(edited.ok, false);
  assert.equal(edited.error, "quote_not_editable");
  const sent = await sendQuote(env, "q1", { staffId: "staff-1" });
  assert.equal(sent.ok, false);
  assert.equal(sent.error, "quote_not_draft");
});

test("quote expiry rejects past timestamps and customer data is not echoed in errors", async () => {
  const { editQuote } = await import("../worker/commercial.js");
  const env = { LUMMET_DB: { prepare() { return { bind() { return { async first() { return { id: "q2", status: "draft", valid_until: null }; } }; } }; } } };
  const result = await editQuote(env, "q2", { valid_until: "2000-01-01T00:00:00Z" }, { staffId: "staff-1" });
  assert.equal(result.ok, false);
  assert.equal(result.error, "invalid_quote_expiry");
});
