// =====================================================
// AI WEB SEARCH (optional, for agent mode only)
// No search provider ships with this codebase or this
// environment. This module exists so agent.js has a real
// tool to call rather than none, but it is inert until an
// admin sets WEB_SEARCH_API_KEY (wrangler secret put) --
// with no key, it returns a clear "not configured" result,
// which the agent then reports to the person rather than
// inventing search results to fill the gap.
//
// Default shape targets the Brave Search API (a simple
// single-header REST API with no SDK needed), configurable
// to any similar provider via WEB_SEARCH_ENDPOINT.
// =====================================================

const DEFAULT_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export async function webSearch(env, query) {
  const key = env.WEB_SEARCH_API_KEY;
  if (!key) {
    return {
      ok: false,
      message: "Web search is not configured in this environment. Set WEB_SEARCH_API_KEY (wrangler secret put) to enable it."
    };
  }
  if (!query || !query.trim()) {
    return { ok: false, message: "No search query given." };
  }

  const endpoint = env.WEB_SEARCH_ENDPOINT || DEFAULT_ENDPOINT;

  try {
    const url = new URL(endpoint);
    url.searchParams.set("q", query);

    const response = await fetch(url.toString(), {
      headers: { Accept: "application/json", "X-Subscription-Token": key }
    });

    if (!response.ok) {
      return { ok: false, message: `Search provider returned HTTP ${response.status}.` };
    }

    const data = await response.json();
    const rawResults = data?.web?.results || data?.results || [];
    const results = rawResults.slice(0, 5).map((r) => ({
      title: r.title || r.name || "",
      url: r.url || r.link || "",
      snippet: r.description || r.snippet || ""
    }));

    return { ok: true, query, results };
  } catch (err) {
    return { ok: false, message: `Search request failed: ${err && err.message ? err.message : String(err)}` };
  }
}
