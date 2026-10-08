import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { webSearch } from "../worker/ai/web-search.js";

let originalFetch;
afterEach(() => {
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
});

describe("ai/web-search.js", () => {
  test("with no WEB_SEARCH_API_KEY, reports not-configured rather than calling out or fabricating results", async () => {
    const result = await webSearch({}, "best casino bonuses 2026");
    assert.equal(result.ok, false);
    assert.match(result.message, /not configured/i);
  });

  test("an empty query is rejected even with a key present", async () => {
    const result = await webSearch({ WEB_SEARCH_API_KEY: "fake" }, "   ");
    assert.equal(result.ok, false);
  });

  test("with a key configured, calls the provider and returns parsed results", async () => {
    originalFetch = globalThis.fetch;
    let capturedUrl, capturedHeaders;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedHeaders = opts.headers;
      return {
        ok: true,
        json: async () => ({
          web: {
            results: [
              { title: "Result One", url: "https://example.com/1", description: "First result" },
              { title: "Result Two", url: "https://example.com/2", description: "Second result" }
            ]
          }
        })
      };
    };

    const result = await webSearch({ WEB_SEARCH_API_KEY: "real-key" }, "casino licensing Curacao");
    assert.equal(result.ok, true);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].title, "Result One");
    assert.equal(capturedHeaders["X-Subscription-Token"], "real-key");
    assert.match(capturedUrl, /q=casino/);
  });

  test("a non-OK provider response is reported, not silently swallowed", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    const result = await webSearch({ WEB_SEARCH_API_KEY: "real-key" }, "anything");
    assert.equal(result.ok, false);
    assert.match(result.message, /429/);
  });

  test("a thrown network error is caught and reported, never propagates", async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };
    const result = await webSearch({ WEB_SEARCH_API_KEY: "real-key" }, "anything");
    assert.equal(result.ok, false);
    assert.match(result.message, /network down/);
  });

  test("a custom WEB_SEARCH_ENDPOINT is honored", async () => {
    originalFetch = globalThis.fetch;
    let capturedUrl;
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return { ok: true, json: async () => ({ results: [] }) };
    };
    await webSearch({ WEB_SEARCH_API_KEY: "k", WEB_SEARCH_ENDPOINT: "https://custom.example/search" }, "x");
    assert.match(capturedUrl, /^https:\/\/custom\.example\/search/);
  });
});
