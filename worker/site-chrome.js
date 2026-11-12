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
//   <!--lummet:site-brand-->           the dashboard sidebar logo icon and site name (same logo and name as the public header)
//   <!--lummet:site-name-->            the site name as plain text (dashboard breadcrumb)
//   <!--lummet:portal-brand-->         the STAFF console's sidebar logo and name: portal branding (Platform settings) when set, else the site's own
//   <!--lummet:portal-name-->          the staff console's name as plain text (breadcrumb, page title)
//   <!--lummet:head-icons-->           favicon, app icon, manifest and theme-colour tags from portal branding; the built-in favicon when none are set
//   <!--lummet:brand-band-->           the customer dashboard's brand partners strip (staff render theirs directly, see layout.js)
//
// Editing the footer text, links or cookie text in the staff console therefore changes every page at once. Fail soft: if the site data
// cannot be read, markers become a minimal header/footer and the page still works.
// =====================================================

import { loadSite } from "./public-site/context.js";
import { renderTemplate } from "./public-site/template.js";
import { renderCookieBannerWithScript, cookieSettingsButton } from "./cookie-consent.js";
import { loadBrandBand, renderBrandBand } from "./brand-band.js";
import { headIconsHtml, FALLBACK_ICON_LINK, portalIdentity } from "./portal-branding.js";

export const MARKERS = {
  header: "<!--lummet:site-header-->",
  footer: "<!--lummet:site-footer-->",
  footerCompact: "<!--lummet:site-footer-compact-->",
  cookie: "<!--lummet:cookie-banner-->",
  brand: "<!--lummet:site-brand-->",
  siteName: "<!--lummet:site-name-->",
  portalBrand: "<!--lummet:portal-brand-->",
  portalName: "<!--lummet:portal-name-->",
  headIcons: "<!--lummet:head-icons-->",
  brandBand: "<!--lummet:brand-band-->"
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
  <span>${esc(site.footer_copyright || `\u00a9 ${site.year} ${site.name}. ${ui.rights || ""}`)}${site.footer_note ? ` <small>${esc(site.footer_note)}</small>` : ""}</span>
  <nav aria-label="${esc(site.name)}">${nav}${contact}${cookieSettingsButton(site.cookie_settings_label)}</nav>
</footer>`;
}

function brandMark(site) {
  const icon = site.has_logo
    ? `<img class="brand-icon" src="${esc(site.logo_url)}" alt="" width="30" height="30">`
    : `<span class="brand-icon brand-icon-fallback" aria-hidden="true">${esc(site.initials || "L")}</span>`;
  return `${icon}<span class="brand-label">${esc(site.name)}</span>`;
}
// Staff console brand: portal branding wins over the site's own name and logo, field by field. An own-library logo is a path, so it is safe in src.
function portalBrandMark(site, identity) {
  const name = identity.name || site.name;
  const icon = identity.logo || site.has_logo
    ? `<img class="brand-icon" src="${esc(identity.logo || site.logo_url)}" alt="" width="30" height="30">`
    : `<span class="brand-icon brand-icon-fallback" aria-hidden="true">${esc((identity.name ? identity.name.trim().charAt(0).toUpperCase() : site.initials) || "L")}</span>`;
  return `${icon}<span class="brand-label">${esc(name)}</span>`;
}
const FALLBACK_BRAND = `<span class="brand-icon brand-icon-fallback" aria-hidden="true">L</span><span class="brand-label">Lummet</span>`;

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
  await fill(MARKERS.brand, (c) => brandMark(c.site), FALLBACK_BRAND);
  await fill(MARKERS.siteName, (c) => esc(c.site.name), "Lummet");

  // Portal branding. Never throws and never needs the site data: any problem leaves the built-in look.
  if (wants(MARKERS.headIcons)) {
    let tags = FALLBACK_ICON_LINK;
    try { tags = await headIconsHtml(env); } catch (err) { console.error(JSON.stringify({ msg: "site_chrome_render_failed", marker: MARKERS.headIcons, error: err?.message || String(err) })); }
    out = out.split(MARKERS.headIcons).join(tags);
  }
  if (wants(MARKERS.portalBrand) || wants(MARKERS.portalName)) {
    let identity = { name: null, logo: null };
    try { identity = await portalIdentity(env); } catch (err) { console.error(JSON.stringify({ msg: "site_chrome_render_failed", marker: MARKERS.portalBrand, error: err?.message || String(err) })); }
    await fill(MARKERS.portalBrand, (c) => portalBrandMark(c.site, identity), identity.name ? portalBrandMark({ name: identity.name, has_logo: false, initials: "L" }, identity) : FALLBACK_BRAND);
    await fill(MARKERS.portalName, (c) => esc(identity.name || c.site.name), esc(identity.name || "Lummet"));
  }
  if (wants(MARKERS.brandBand)) {
    let band = "";
    try { band = renderBrandBand(await loadBrandBand(env), { manage: false }); } catch (err) { console.error(JSON.stringify({ msg: "site_chrome_render_failed", marker: MARKERS.brandBand, error: err?.message || String(err) })); }
    out = out.split(MARKERS.brandBand).join(band);
  }
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
