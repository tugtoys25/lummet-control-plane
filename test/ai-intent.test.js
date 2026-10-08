import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeIntent, fallbackIntent } from "../worker/ai/intent.js";
import { listResourceKeys } from "../worker/ai/schema.js";

const RESOURCE_KEYS = listResourceKeys();

describe("ai/intent.js normalizeIntent (the model-output validator)", () => {
  test("drops a hallucinated resource the model invented", () => {
    const result = normalizeIntent({ operation: "read", resource: "user_secrets" }, RESOURCE_KEYS);
    assert.equal(result.resource, null);
  });

  test("keeps a real resource", () => {
    const result = normalizeIntent({ operation: "read", resource: "casinos" }, RESOURCE_KEYS);
    assert.equal(result.resource, "casinos");
  });

  test("clamps an invalid operation to 'unknown'", () => {
    const result = normalizeIntent({ operation: "drop_table", resource: "casinos" }, RESOURCE_KEYS);
    assert.equal(result.operation, "unknown");
  });

  test("never lets filters/fields be non-object shapes (e.g. the model returning an array)", () => {
    const result = normalizeIntent({ operation: "read", filters: ["not", "an", "object"], fields: "nope" }, RESOURCE_KEYS);
    assert.deepEqual(result.filters, {});
    assert.deepEqual(result.fields, {});
  });

  test("coerces recordId to a string or null, never leaves it as an arbitrary type", () => {
    assert.equal(normalizeIntent({ operation: "read", recordId: 123 }, RESOURCE_KEYS).recordId, "123");
    assert.equal(normalizeIntent({ operation: "read", recordId: "" }, RESOURCE_KEYS).recordId, null);
    assert.equal(normalizeIntent({ operation: "read", recordId: undefined }, RESOURCE_KEYS).recordId, null);
  });

  test("handles completely malformed/missing input without throwing", () => {
    const result = normalizeIntent(null, RESOURCE_KEYS);
    assert.equal(result.operation, "unknown");
    assert.equal(result.resource, null);
    assert.deepEqual(result.filters, {});
  });
});

describe("ai/intent.js fallbackIntent (used when env.AI is absent)", () => {
  test('"Show me all casinos." -> read casinos, no filters', () => {
    const result = fallbackIntent("Show me all casinos.", RESOURCE_KEYS);
    assert.equal(result.operation, "read");
    assert.equal(result.resource, "casinos");
    assert.equal(result.recordId, null);
  });

  test('"Find casino 123." -> read casinos, recordId 123', () => {
    const result = fallbackIntent("Find casino 123.", RESOURCE_KEYS);
    assert.equal(result.operation, "read");
    assert.equal(result.resource, "casinos");
    assert.equal(result.recordId, "123");
  });

  test('"Show me all published research." -> read research', () => {
    const result = fallbackIntent("Show me all published research.", RESOURCE_KEYS);
    assert.equal(result.operation, "read");
    assert.equal(result.resource, "research");
  });

  test('"Show me the fields available for casinos." -> schema operation', () => {
    const result = fallbackIntent("Show me the fields available for casinos.", RESOURCE_KEYS);
    assert.equal(result.operation, "schema");
    assert.equal(result.resource, "casinos");
  });

  test("a request with no resource mentioned asks for clarification instead of guessing", () => {
    const result = fallbackIntent("Show me everything.", RESOURCE_KEYS);
    assert.equal(result.resource, null);
    assert.ok(result.clarificationNeeded);
  });

  test("gibberish never resolves to a real resource or a destructive operation by accident", () => {
    const result = fallbackIntent("asdkfj alksdjf laksjdf", RESOURCE_KEYS);
    assert.equal(result.resource, null);
    assert.notEqual(result.operation, "delete");
  });
});
