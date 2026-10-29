// =====================================================
// PUBLIC SITE — ROUTER
// Entry point called from index.js for GET/HEAD requests, BEFORE the
// authenticated admin routes. Returns a Response for a public route
// and null for anything else, so the admin app is untouched.
//
//   /                    homepage (everyone, signed in or not)
//   /brands  /brands/:slug
//   /updates /updates/:slug
//   /insights /insights/:slug
//   /partners
//   /authors/:slug
//   /contact  /demo  /forms/:key     (GET page + POST submission)
//   /p/:slug   plus clean aliases /about /security /privacy /terms
//   /sitemap.xml  /robots.txt
//   /static/*            css / js / images (Workers Assets)
//
// Rendered pages are cached at the edge for about a minute (Cache API),
// so the database is not hit on every view.
// =====================================================

import { loadSite } from "./context.js";
import * as pages from "./pages.js";
import * as forms from "./forms.js";
import { sitemapXml, robotsTxt } from "./sitemap.js";
import { textResponse } from "./render.js";

function matchPath(pattern, path) {
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(":")) {
      try {
        params[a[i].slice(1)] = decodeURIComponent(b[i]);
      } catch {
        return null;
      }
    } else if (a[i] !== b[i]) {
      return null;
    }
  }
  return params;
}

const ROUTES = [
  ["/brands", pages.brandsPage],
  ["/brands/:slug", pages.brandPage],
  ["/updates", pages.updatesPage],
  ["/updates/:slug", pages.updatePage],
  ["/insights", pages.insightsPage],
  ["/insights/:slug", pages.insightPage],
  ["/partners", pages.partnersPage],
  ["/pricing", pages.pricingPage],
  ["/status", pages.statusPage],
  ["/legal", pages.legalIndexPage],
  ["/legal/:slug", (ctx, params) => pages.legalPage(ctx, params)],
  ["/docs", pages.docsPage],
  ["/openapi.json", pages.openApiJsonPage],
  ["/security", pages.securityPage],
  ["/changelog", pages.changelogPage],
  ["/contact-sales", (ctx) => (pages.trustMode(ctx.env) === "off" ? null : forms.formPage(ctx, { key: "contact", path: "/contact-sales" }))],
  ["/authors/:slug", pages.authorPage],
  ["/contact", (ctx) => forms.formPage(ctx, { key: "contact" })],
  ["/demo", (ctx) => forms.formPage(ctx, { key: "demo" })],
  ["/forms/:key", forms.formPage]
];

// The only public POST routes: form submissions. Same paths as the GET pages.
const FORM_POST_ROUTES = [
  ["/contact", (ctx) => forms.submitForm(ctx, { key: "contact" })],
  ["/contact-sales", (ctx) => (pages.trustMode(ctx.env) === "off" ? null : forms.submitForm(ctx, { key: "contact", path: "/contact-sales" }))],
  ["/demo", (ctx) => forms.submitForm(ctx, { key: "demo" })],
  ["/forms/:key", forms.submitForm]
];

/** Paths this router owns. Anything else is left to the admin app. */
export function isPublicPath(path) {
  if (path === "/" || path === "/sitemap.xml" || path === "/robots.txt" || path === "/.well-known/security.txt") return true;
  if (path.startsWith("/static/")) return true;
  if (path.startsWith("/p/")) return true;
  if (pages.PAGE_ALIASES.has(path.slice(1))) return true;
  return ROUTES.some(([pattern]) => matchPath(pattern, path));
}

// Last-resort page, used only when the database itself cannot be read, so by
// definition it cannot come from the database. Kept deliberately minimal.
function unavailable() {
  return textResponse(
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Temporarily unavailable</title><body style='font-family:system-ui,sans-serif;padding:3rem;max-width:36rem;margin:auto'><h1>Temporarily unavailable</h1><p>Please try again in a moment.</p>",
    "text/html; charset=utf-8",
    { status: 503, cacheControl: "no-store" }
  );
}

async function notFoundFor({ env, request, url, execCtx }) {
  try {
    const siteCtx = await loadSite(env, url);
    return await pages.notFoundPage({ env, request, url, siteCtx, execCtx });
  } catch {
    return unavailable();
  }
}

async function serveStatic(request, env) {
  const res = await env.ASSETS.fetch(request);
  if (!res.ok) return res;
  const headers = new Headers(res.headers);
  headers.set("x-content-type-options", "nosniff");
  // Normally static files are served straight from the assets layer (wrangler.jsonc run_worker_first excludes /static/*,
  // and public/_headers sets the same policy). This path is the fallback (workers.dev, tests, a rollback to
  // run_worker_first: true) and applies the identical policy:
  //   css/js are referenced with ?v=<token> (asset-version.js), so they are cached for a year;
  //   everything else is cached briefly and revalidated in the background.
  const url = new URL(request.url);
  const versioned = /^\/static\/(css|js)\//.test(url.pathname) && url.searchParams.has("v");
  if (!headers.has("cache-control") || /max-age=0/.test(headers.get("cache-control"))) {
    headers.set("cache-control", versioned ? "public, max-age=31536000, immutable" : "public, max-age=3600, stale-while-revalidate=86400");
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function cacheKeyFor(url) {
  // Only the query parameters that change the rendered page are part of the key.
  const key = new URL(url.origin + url.pathname);
  for (const name of ["page", "type"]) {
    if (url.searchParams.has(name)) key.searchParams.set(name, url.searchParams.get(name));
  }
  return new Request(key.toString(), { method: "GET" });
}

async function resolve(ctx) {
  const { url, env } = ctx;
  const path = url.pathname;

  if (path === "/.well-known/security.txt") {
    // Served only when the trust-page rollout is on; otherwise behaves as an unknown path.
    if (pages.trustMode(env) !== "on") return pages.notFoundPage(ctx);
    const contact = String(env.SECURITY_CONTACT || "").trim();
    const expires = String(env.SECURITY_TXT_EXPIRES || "").trim();
    const expiresOk = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(expires) && Number.isFinite(Date.parse(expires)) && Date.parse(expires) > Date.now();
    if (!/^(mailto:[^\s]+|https:\/\/[^\s]+)$/i.test(contact) || !expiresOk) {
      return textResponse("security.txt is not configured.\n", "text/plain; charset=utf-8", { status: 503, cacheControl: "no-store" });
    }
    return textResponse(`Contact: ${contact}\nExpires: ${expires}\nPreferred-Languages: en\n`, "text/plain; charset=utf-8", { cacheControl: "public, max-age=3600" });
  }
  if (path === "/robots.txt") return robotsTxt(ctx);
  if (path === "/sitemap.xml") return sitemapXml(ctx);
  if (path === "/") return pages.homePage(ctx);
  // With the rollout shadow/on, the explicit trust routes take precedence over legacy CMS aliases such as /security.
  // With it off, nothing here changes: the alias and 404 behaviour of 2.6.0.3 is kept.
  if (pages.trustMode(env) !== "off") {
    for (const [trustPath, handler] of ROUTES.filter(([routePath]) => ["/status", "/security", "/changelog", "/contact-sales", "/docs"].includes(routePath))) {
      if (path === trustPath) return (await handler(ctx)) || pages.notFoundPage(ctx);
    }
  }

  if (path.startsWith("/p/")) {
    const slug = path.slice(3).replace(/\/+$/, "");
    if (!slug || slug.includes("/")) return pages.notFoundPage(ctx);
    if (pages.PAGE_ALIASES.has(slug)) {
      return new Response(null, { status: 301, headers: { location: `/${slug}` } });
    }
    return (await pages.cmsPage(ctx, { slug })) || pages.notFoundPage(ctx);
  }

  const alias = path.slice(1);
  if (pages.PAGE_ALIASES.has(alias)) {
    return (await pages.cmsPage(ctx, { slug: alias })) || pages.notFoundPage(ctx);
  }

  for (const [pattern, handler] of ROUTES) {
    const params = matchPath(pattern, path);
    if (params) return (await handler(ctx, params)) || pages.notFoundPage(ctx);
  }
  return null;
}

/**
 * @param {{request: Request, env: object, ctx: object}} args
 */
export async function handlePublicRoute({ request, env, ctx: execCtx }) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD" && method !== "POST") return null;

  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
  if (path !== url.pathname) url.pathname = path;

  if (method === "POST") {
    const route = FORM_POST_ROUTES.map(([pattern, handler]) => [matchPath(pattern, path), handler]).find(([params]) => params);
    if (!route) return null;
    let response;
    try {
      const siteCtx = await loadSite(env, url);
      response = await route[1]({ env, request, url, siteCtx, execCtx }, route[0]);
    } catch (err) {
      console.error("public-site form submit failed:", err?.message || err);
      return unavailable();
    }
    return response || (await notFoundFor({ env, request, url, execCtx }));
  }

  if (!isPublicPath(path)) return null;
  if (path.startsWith("/static/")) return serveStatic(request, env);

  // "/" is the public homepage for everyone, signed in or not. The staff
  // dashboard lives at /dashboard.

  // A page showing "sent" state, or anything carrying form state, is never shared.
  // Legal pages and the OpenAPI document depend on rollout flags and recorded approvals, so they are never shared-cached.
  const uncachedPath = path === "/legal" || path.startsWith("/legal/") || path === "/openapi.json";
  const cache = typeof caches !== "undefined" && !url.searchParams.has("sent") && !uncachedPath ? caches.default : null;
  const key = cacheKeyFor(url);
  if (cache) {
    try {
      const hit = await cache.match(key);
      if (hit) return method === "HEAD" ? new Response(null, hit) : hit;
    } catch {
      // cache unavailable (e.g. workers.dev) — render normally
    }
  }

  let response;
  try {
    const siteCtx = await loadSite(env, url);
    response = await resolve({ env, request, url, siteCtx, execCtx });
  } catch (err) {
    console.error("public-site render failed:", err?.message || err);
    return unavailable();
  }
  if (!response) return null;

  if (cache && response.status === 200 && execCtx?.waitUntil) {
    try {
      execCtx.waitUntil(cache.put(key, response.clone()));
    } catch {
      // ignore cache write failures
    }
  }
  return method === "HEAD" ? new Response(null, response) : response;
}
