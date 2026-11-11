// =====================================================
// AFTERMARKET — A VERIFIED DOMAIN'S OWN ADDRESS
//
// Once a seller's nameservers are verified (aftermarket-zones.js) the domain is attached to this Worker, so EVERY path of that
// domain reaches the whole control plane: admin, customer portal, API, the public site. A for-sale domain must show only its
// enquiry page, so this gate runs first in handleRequest and, for a domain listed with hosted = 1:
//
//   * serves     /  (the for-sale page), its own enquiry POST (/aftermarket/domains/<domain>), /static/* and a small robots.txt
//   * redirects  every other GET/HEAD path to the same path on the Lummet site (301)
//   * refuses    every other method with 404 (nobody can sign in, post an API call or reach the admin from a seller's domain)
//
// absolutizeLinks() then points every Lummet link on the for-sale page (header, footer, breadcrumbs) at the Lummet site, so a click
// leaves the domain for Lummet. Static files and the hashed shell assets stay on the domain.
// Domains that are not hosted, and the platform's own hosts, are untouched (a 60 second per-isolate cache keeps the lookup cheap).
// =====================================================

import * as data from "./public-site/data.js";
import { loadSite } from "./public-site/context.js";
import { normalizeDomain } from "./public-site/aftermarket-domains.js";
import { isShellAssetPath } from "./perf/shell-bundle.js";

const TTL_MS = 60 * 1000;
const cache = new Map();   // host -> { row, at }

export function __clearHostedCacheForTests() { cache.clear(); }

async function hostedRow(env, host) {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  let row = null;
  try { row = await data.getHostedAftermarketDomain(env, host); } catch (_) { row = null; }   // a database hiccup must not break other hosts
  if (cache.size > 500) cache.clear();
  cache.set(host, { row, at: Date.now() });
  return row;
}

/** Where "the Lummet site" is: the configured public address, else the portal address. Never the domain itself. */
async function lummetBase(env, url) {
  const own = url.hostname.replace(/^www\./, "");
  const candidates = [];
  try { candidates.push(new URL((await loadSite(env, url)).site.base_url).origin); } catch (_) { /* not configured */ }
  try { candidates.push(new URL(env.PORTAL_BASE_URL).origin); } catch (_) { /* not configured */ }
  return candidates.find((o) => new URL(o).hostname.replace(/^www\./, "") !== own) || "";
}

const text = (body, status, type = "text/plain; charset=utf-8") =>
  new Response(body, { status, headers: { "content-type": type, "cache-control": "no-store" } });

/**
 * null  = not a hosted for-sale domain: carry on as normal.
 * { response } = answer this request now (redirect / refusal / robots.txt).
 * { base }     = a for-sale page request: carry on, then call absolutizeLinks(response, base).
 */
export async function hostedGate(request, env) {
  const url = new URL(request.url);
  let portalHost = "";
  try { portalHost = new URL(env.PORTAL_BASE_URL).hostname; } catch (_) { return null; }   // without a known portal host the feature is off
  if (!portalHost || url.hostname === portalHost || url.hostname.endsWith(".workers.dev")) return null;
  const host = normalizeDomain(url.hostname);
  if (!host) return null;
  const row = await hostedRow(env, host);
  if (!row) return null;

  const method = request.method.toUpperCase();
  const path = url.pathname;
  const read = method === "GET" || method === "HEAD";
  if (isShellAssetPath(path) && read) return null;
  if (read && path === "/robots.txt") return { response: text("User-agent: *\nAllow: /\n", 200) };
  const own = path.replace(/\/+$/, "") === `/aftermarket/domains/${row.domain}`;
  if ((read && (path === "/" || own || path.startsWith("/static/") || path.startsWith("/brand-media/"))) || (method === "POST" && own)) {
    return { base: await lummetBase(env, url) };
  }
  if (read) {
    const base = await lummetBase(env, url);
    if (base) return { response: new Response(null, { status: 301, headers: { location: `${base}${path}${url.search}`, "cache-control": "no-store" } }) };
  }
  return { response: text("Not found", 404) };
}

/** Make every site-relative link on a for-sale page lead to the Lummet site. Static files and shell assets stay on the domain. */
export async function absolutizeLinks(response, base) {
  const type = response.headers.get("content-type") || "";
  if (!base || !type.includes("text/html") || !response.body) return response;
  const html = await response.text();
  const out = html.replace(/(\shref=")\/(?!\/)([^"]*)"/g, (all, pre, rest) => {
    const path = `/${rest}`;
    return path.startsWith("/static/") || path.startsWith("/brand-media/") || isShellAssetPath(path) ? all : `${pre}${base}${path}"`;
  });
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(out, { status: response.status, statusText: response.statusText, headers });
}
