import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateProposedFields, valueToFormString, buildProposedForm, buildMergedForm } from "../worker/ai/form-adapter.js";
import { RESOURCES } from "../worker/resources.js";

const casinoConfig = RESOURCES.casinos;
const reviewConfig = RESOURCES.reviews; // has a lockOnEdit field (slug)

describe("ai/form-adapter.js validateProposedFields", () => {
  test("rejects a field name that doesn't exist on the resource", () => {
    const result = validateProposedFields(casinoConfig, { made_up_field: 1 }, { forUpdate: true });
    assert.equal(result.ok, false);
    assert.deepEqual(result.unknownFields, ["made_up_field"]);
  });

  test("rejects changing a lockOnEdit field on update, but allows it on create", () => {
    const slugField = reviewConfig.fields.find((f) => f.lockOnEdit);
    assert.ok(slugField, "fixture assumption: reviews has a lockOnEdit field");

    const onUpdate = validateProposedFields(reviewConfig, { [slugField.name]: "new-slug" }, { forUpdate: true });
    assert.equal(onUpdate.ok, false);
    assert.deepEqual(onUpdate.lockedFields, [slugField.name]);

    const onCreate = validateProposedFields(reviewConfig, { [slugField.name]: "new-slug" }, { forUpdate: false });
    assert.equal(onCreate.ok, true);
  });

  test("accepts a valid, real, unlocked field", () => {
    const result = validateProposedFields(casinoConfig, { rating: 4.7 }, { forUpdate: true });
    assert.equal(result.ok, true);
  });
});

describe("ai/form-adapter.js valueToFormString", () => {
  test("checkbox: normalizes truthy/stringy values, never string-truthiness bugs on 'false'", () => {
    const field = { type: "checkbox" };
    assert.equal(valueToFormString(field, true), "1");
    assert.equal(valueToFormString(field, false), "");
    assert.equal(valueToFormString(field, "false"), ""); // the bug this guards against
    assert.equal(valueToFormString(field, "true"), "1");
    assert.equal(valueToFormString(field, 1), "1");
    assert.equal(valueToFormString(field, 0), "");
  });

  test("number: null/undefined/empty become empty string, real numbers stringify", () => {
    const field = { type: "number" };
    assert.equal(valueToFormString(field, 4.7), "4.7");
    assert.equal(valueToFormString(field, 0), "0");
    assert.equal(valueToFormString(field, null), "");
    assert.equal(valueToFormString(field, undefined), "");
  });

  test("list: array joins with newlines, matching coerceFieldValue's split('\\n')", () => {
    const field = { type: "list" };
    assert.equal(valueToFormString(field, ["a", "b", "c"]), "a\nb\nc");
  });

  test("multi_select: always valid JSON array text", () => {
    const field = { type: "multi_select" };
    assert.equal(valueToFormString(field, ["a", "b"]), '["a","b"]');
    assert.equal(valueToFormString(field, null), "[]");
  });

  test("json_object: object stringifies; a pre-stringified value passes through unchanged", () => {
    const field = { type: "json_object" };
    assert.equal(valueToFormString(field, { a: 1 }), '{"a":1}');
    assert.equal(valueToFormString(field, '{"a":1}'), '{"a":1}');
  });

  test("default (text/select/textarea): stringifies non-null, empties null", () => {
    const field = { type: "text" };
    assert.equal(valueToFormString(field, "hello"), "hello");
    assert.equal(valueToFormString(field, null), "");
  });
});

describe("ai/form-adapter.js buildProposedForm (CREATE)", () => {
  test("only includes fields actually specified", () => {
    const form = buildProposedForm(casinoConfig, { rating: 4.5 });
    assert.ok("rating" in form);
    // fields not specified should not appear at all (left for tenant defaults)
    const otherField = casinoConfig.fields.find((f) => f.name !== "rating");
    if (otherField) assert.ok(!(otherField.name in form));
  });
});

describe("ai/form-adapter.js buildMergedForm (UPDATE) — the critical no-data-loss guarantee", () => {
  test("every field in the config gets SOME value in the resulting form, changed or not", () => {
    const current = {};
    for (const f of casinoConfig.fields) current[f.name] = f.type === "number" ? 1 : "existing";
    const form = buildMergedForm(casinoConfig, current, { rating: 4.9 });

    for (const field of casinoConfig.fields) {
      assert.ok(field.name in form, `${field.name} must be present in the merged form`);
    }
  });

  test("an untouched field's CURRENT value survives the round trip — this is the regression the whole adapter exists to prevent", () => {
    const current = { rating: 3.0, status: "published" };
    // fabricate a minimal 2-field config to keep the assertion crisp
    const miniConfig = {
      fields: [
        { name: "rating", type: "number" },
        { name: "status", type: "text" }
      ]
    };
    const form = buildMergedForm(miniConfig, current, { rating: 4.9 }); // only rating is "changing"
    assert.equal(form.rating, "4.9");
    assert.equal(form.status, "published"); // NOT nulled out just because it wasn't in proposedValues
  });
});
