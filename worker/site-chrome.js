// =====================================================
// SHARED SITE CHROME FOR NON-PUBLIC PAGES
//
// The public site's header and footer are content (navigation, footer columns, legal links and text come from the database and
// are rendered from public/templates/layout/*). The sign-in pages and the customer dashboard are built by plain string views, so
// they cannot await that data. Instead they write a MARKER where the shared piece belongs, and the Worker swaps the marker for the
// real thing on the way out (after the route has run, before the nonce is applied):
//
//   <!--lummet:site-header-->          the public site header (sign-in pages)
//   <!--lummet:site-footer-->          the public site footer, without its marketing call to action (sign-in pages)
//   <!--lummet:site-footer-compact-->  a slim footer using the same text and links (dashboard)
//   <!--lummet:cookie-banner-->        the cookie consent banner (see cookie-consent.js)
//
// Editing the footer text, links or cookie text in the staff console therefore changes every page at once. Fail soft: if the site data
// cannot be read, markers become a minimal header/footer and the page still works.
// =====================================================

import { loadSite } from "./public-site/context.js";
import { renderTemplate } from "./public-site/template.js";
import { renderCookieBannerWithScript, cookieSettingsButton } from "./cookie-consent.js";

export const MARKERS = {
  header: "<!--lummet:site-header-->",
  footer: "<!--lummet:site-footer-->",
  footerCompact: "<!--lummet:site-footer-compact-->",
  cookie: "<!--lummet:cookie-banner-->"
};
export const CHROME_HEADER = "x-lummet-chrome";

export const hasChromeMarkers = (s) => typeof s === "string" && s.includes("<!--lummet:");

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const COMPACT_CSS = `
.lummet-app-footer{margin-top:auto;padding:18px 24px calc(18px + env(safe-area-inset-bottom));border-top:1px solid var(--border,rgba(128,128,128,.25));color:var(--text-dim,inherit);font-size:13px;display:flex;flex-wrap:wrap;gap:8px 18px;align-items:center;justify-content:space-between}
.lummet-app-footer nav{display:flex;flex-wrap:wrap;gap:6px 16px}
.lummet-app-footer a{color:inherit;text-decoration:none}
.lummet-app-footer a:hover{text-decoration:underline}
.lummet-app-footer .lummet-cookie-settings{margin:0}
`.replace(/\s*\n\s*/g, "");

function compactFooter(site, ui) {
  const links = (site.footer_columns || []).flatMap((c) => c.links || []);
  const seen = new Set();
  const nav = links.filter((l) => (seen.has(l.href) ? false : seen.add(l.href))).slice(0, 8)
    .map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join("");
  const contact = site.has_contact ? `<a href="mailto:${esc(site.contact_email)}">${esc(site.contact_email)}</a>` : "";
  return `<style>${COMPACT_CSS}</style><footer class="lummet-app-footer">
  <span>&copy; ${esc(site.year)} ${esc(site.name)}. ${esc(ui.rights || "")}</span>
  <nav aria-label="${esc(site.name)}">${nav}${contact}${cookieSettingsButton(site.cookie_settings_label)}</nav>
</footer>`;
}

const FALLBACK_HEADER = `<header class="site-header"><div class="container header-inner"><a class="brand" href="/" aria-label="Home"><span class="brand-mark" aria-hidden="true"></span><span class="brand-name">Lummet</span></a></div></header>`;
const FALLBACK_FOOTER = `<footer class="lummet-app-footer"><span>&copy; ${new Date().getUTCFullYear()} Lummet</span></footer>`;

/** Replaces every marker in an HTML string. Never throws. */
export async function injectSiteChrome(htmlText, env, url) {
  let out = String(htmlText);
  const wants = (m) => out.includes(m);
  let siteCtx = null;
  try { siteCtx = await loadSite(env, url); } catch (err) { console.error(JSON.stringify({ msg: "site_chrome_load_failed", error: err?.message || String(err) })); }

  const fill = async (marker, build, fallback) => {
    if (!wants(marker)) return;
    let piece = fallback;
    if (siteCtx) { try { piece = await build(siteCtx); } catch (err) { console.error(JSON.stringify({ msg: "site_chrome_render_failed", marker, error: err?.message || String(err) })); } }
    out = out.split(marker).join(piece);
  };

  await fill(MARKERS.header, (c) => renderTemplate(env, "layout/header", { site: c.site, icons: c.icons, ui: c.ui }), FALLBACK_HEADER);
  await fill(MARKERS.footer, (c) => renderTemplate(env, "layout/footer", { site: { ...c.site, footer_cta: null }, icons: c.icons, ui: c.ui }), FALLBACK_FOOTER);
  await fill(MARKERS.footerCompact, (c) => compactFooter(c.site, c.ui), FALLBACK_FOOTER);
  await fill(MARKERS.cookie, (c) => renderCookieBannerWithScript(env, c.ui), "");
  return out;
}

/** Wraps a finished Response: only responses flagged by html() (they contain a marker) are read and rewritten. */
export async function applySiteChrome(response, env, request) {
  if (!response || response.headers.get(CHROME_HEADER) !== "1") return response;
  const text = await response.text();
  const body = await injectSiteChrome(text, env, new URL(request.url));
  const headers = new Headers(response.headers);
  headers.delete(CHROME_HEADER);
  headers.delete("Content-Length");
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}
