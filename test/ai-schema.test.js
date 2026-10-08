import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  listResourceKeys,
  isKnownResource,
  isKnownField,
  getField,
  describeResource,
  buildSchemaPromptSection
} from "../worker/ai/schema.js";
import { RESOURCES } from "../worker/resources.js";

describe("ai/schema.js", () => {
  test("listResourceKeys returns exactly the RESOURCES keys, no more no less", () => {
    const keys = listResourceKeys();
    assert.deepEqual(new Set(keys), new Set(Object.keys(RESOURCES)));
  });

  test("isKnownResource is false for an invented resource", () => {
    assert.equal(isKnownResource("casinos"), true);
    assert.equal(isKnownResource("bitcoin_wallets"), false);
    assert.equal(isKnownResource(""), false);
    assert.equal(isKnownResource(null), false);
  });

  test("isKnownField rejects a field name the resource doesn't have", () => {
    assert.equal(isKnownField("casinos", "rating"), true);
    assert.equal(isKnownField("casinos", "totally_made_up_field"), false);
    assert.equal(isKnownField("not_a_resource", "rating"), false);
  });

  test("getField returns the real field definition, including lockOnEdit", () => {
    const field = getField("reviews", "slug");
    assert.ok(field);
    assert.equal(field.lockOnEdit, true);
    assert.equal(getField("reviews", "nonexistent"), null);
  });

  test("describeResource never invents fields not in resources.js", () => {
    const described = describeResource("offers");
    assert.ok(described);
    assert.equal(described.supportsDelete, false); // offers is intentionally non-deletable
    const realNames = new Set(RESOURCES.offers.fields.map((f) => f.name));
    for (const f of described.fields) {
      assert.ok(realNames.has(f.name), `${f.name} should exist on the real offers config`);
    }
    assert.equal(described.fields.length, RESOURCES.offers.fields.length);
  });

  test("describeResource returns null for an unknown resource", () => {
    assert.equal(describeResource("nope"), null);
  });

  test("buildSchemaPromptSection mentions every resource key at least once", () => {
    const section = buildSchemaPromptSection();
    for (const key of listResourceKeys()) {
      assert.ok(section.includes(key), `prompt section should mention ${key}`);
    }
  });
});
