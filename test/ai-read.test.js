import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resourceListPath, resourceRecordPath, applyFilters, projectFields, matchesFilter } from "../worker/ai/read.js";

describe("ai/read.js path building", () => {
  test("list path matches the tenant Super API's own convention", () => {
    assert.equal(resourceListPath("casinos"), "/en/api/super/casinos");
  });

  test("record path URL-encodes the record id", () => {
    assert.equal(resourceRecordPath("casinos", "abc/123"), "/en/api/super/casinos/abc%2F123");
  });
});

describe("ai/read.js matchesFilter", () => {
  test("matches a direct field via case-insensitive substring", () => {
    assert.equal(matchesFilter({ country: "Rwanda" }, "country", "rwanda"), true);
    assert.equal(matchesFilter({ country: "Rwanda" }, "country", "kenya"), false);
  });

  test("returns null (not false) for a field the record doesn't have at all", () => {
    assert.equal(matchesFilter({ country: "Rwanda" }, "made_up_field", "x"), null);
  });

  test("falls back to a _id/_code suffix if the bare key isn't present", () => {
    assert.equal(matchesFilter({ country_id: "RW" }, "country", "rw"), true);
  });
});

describe("ai/read.js applyFilters", () => {
  const records = [
    { id: 1, country: "Rwanda", status: "published" },
    { id: 2, country: "Kenya", status: "draft" },
    { id: 3, country: "Rwanda", status: "draft" }
  ];

  test("no filters returns everything untouched, and reports no unrecognized filters", () => {
    const { records: result, unrecognizedFilters } = applyFilters(records, {});
    assert.equal(result.length, 3);
    assert.deepEqual(unrecognizedFilters, []);
  });

  test("a single literal filter narrows correctly and never invents/drops values", () => {
    const { records: result } = applyFilters(records, { country: "Rwanda" });
    assert.equal(result.length, 2);
    assert.ok(result.every((r) => r.country === "Rwanda"));
  });

  test("multiple filters combine with AND semantics", () => {
    const { records: result } = applyFilters(records, { country: "Rwanda", status: "draft" });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 3);
  });

  test("a filter key the resource doesn't have is reported, not silently ignored or treated as a match-all", () => {
    const { records: result, unrecognizedFilters } = applyFilters(records, { made_up_field: "x" });
    assert.equal(result.length, 3); // ignored filter does not narrow results
    assert.deepEqual(unrecognizedFilters, ["made_up_field"]);
  });
});

describe("ai/read.js projectFields", () => {
  const record = { id: 1, rating: 4.5, status: "draft", secret_internal_notes: "do not show" };

  test("no requested fields returns the full record, values untouched", () => {
    assert.deepEqual(projectFields(record, []), record);
  });

  test("requested fields narrow to exactly those keys, exact values preserved", () => {
    const result = projectFields(record, ["rating"]);
    assert.deepEqual(result, { rating: 4.5 });
  });

  test("a requested field that doesn't exist on the record is simply omitted, not fabricated", () => {
    const result = projectFields(record, ["rating", "nonexistent_field"]);
    assert.deepEqual(result, { rating: 4.5 });
  });
});
