// =====================================================
// PUBLIC SITE — PAGE RENDERER
// One place that turns (page template + data) into a full HTML
// response through the shared layout:
//
//   templates/layout/base.html   <- <head>, header, {{{content}}}, footer, scripts
//     templates/layout/header.html
//     templates/layout/footer.html
//   templates/pages/<name>.html  <- rendered first, injected as {{{content}}}
//
// Mirrors the tenant's Renderer (base + header + footer + page), so the
// two projects are organised the same way.
// =====================================================

import { renderTemplate } from "./template.js";

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join("; ");

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "content-security-policy": CSP
};

// Short shared-cache lifetime: a dashboard edit is live within about a minute.
export const PAGE_CACHE_CONTROL = "public, max-age=30, s-maxage=60, stale-while-revalidate=300";

export function textResponse(body, contentType, { status = 200, cacheControl = PAGE_CACHE_CONTROL } = {}) {
  return new Response(body, {
    status,
    headers: { "content-type": contentType, "cache-control": cacheControl, ...SECURITY_HEADERS }
  });
}

export async function renderPage(ctx, { template, data = {}, head = "", status = 200, bodyClass = "" }) {
  const { env, siteCtx, url } = ctx;
  const view = { ...data, site: siteCtx.site, icons: siteCtx.icons, ui: siteCtx.ui };
  const content = await renderTemplate(env, `pages/${template}`, view);
  const html = await renderTemplate(env, "layout/base", {
    site: siteCtx.site,
    icons: siteCtx.icons,
    ui: siteCtx.ui,
    head_html: head,
    content,
    body_class: bodyClass,
    current_path: url.pathname
  });
  return textResponse(html, "text/html; charset=utf-8", {
    status,
    cacheControl: status === 200 ? PAGE_CACHE_CONTROL : "public, max-age=30"
  });
}
