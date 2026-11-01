// =====================================================
// COOKIE CONSENT BANNER
//
// Nothing about the banner is written in code except its structure:
//   - on/off and how long a choice is remembered: Platform settings COOKIE_BANNER (on|off, default on) and COOKIE_CONSENT_DAYS (default 180).
//   - every word and link: Interface text (lummet_ui_strings, group "cookies"; seeded by migration 0076), editable in the staff console.
//       cookie_banner_title, cookie_banner_text, cookie_accept_label, cookie_decline_label, cookie_settings_label,
//       cookie_link_1_label / cookie_link_1_href, cookie_link_2_label / cookie_link_2_href
//     An empty cookie_banner_text switches the banner off; a link with an empty label or address is not shown.
//
// The same fragment is used on the public site, the sign-in pages and the customer dashboard. It is hidden in the HTML
// and revealed by /static/js/cookie-consent.js only when the visitor has not chosen yet, so cached public pages stay shared.
// The choice is stored in a first-party cookie (lummet_cookie_consent = accepted | declined) and announced to the page with a
// "lummet:cookie-consent" event, so anything that needs consent can wait for it.
// =====================================================

import { ASSET_VERSION } from "./perf/asset-version.js";
import { nonceToken } from "./csp.js";

export const CONSENT_COOKIE = "lummet_cookie_consent";

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Same rule as the public site's safeUrl: same-site paths, anchors, http(s) and mailto only. */
function safeHref(value) {
  const v = String(value || "").trim();
  if (!v) return "";
  if (v.startsWith("/") && !v.startsWith("//")) return v;
  if (v.startsWith("#")) return v;
  if (/^https?:\/\//i.test(v)) return v;
  if (/^mailto:/i.test(v)) return v;
  return "";
}

export function cookieBannerOn(env) {
  return String((env && env.COOKIE_BANNER) || "on").trim().toLowerCase() !== "off";
}

export function consentDays(env) {
  const n = Number(env && env.COOKIE_CONSENT_DAYS);
  return Number.isInteger(n) && n >= 1 && n <= 400 ? n : 180;
}

/** The banner's text and links as plain data, or null when it is off or has no text. */
export function cookieBannerModel(env, ui = {}) {
  if (!cookieBannerOn(env)) return null;
  const text = String(ui.cookie_banner_text || "").trim();
  if (!text) return null;
  const links = [1, 2, 3]
    .map((i) => ({ label: String(ui[`cookie_link_${i}_label`] || "").trim(), href: safeHref(ui[`cookie_link_${i}_href`]) }))
    .filter((l) => l.label && l.href);
  return {
    title: String(ui.cookie_banner_title || "").trim(),
    text,
    accept: String(ui.cookie_accept_label || "").trim() || "Accept",
    decline: String(ui.cookie_decline_label || "").trim(),
    settings: String(ui.cookie_settings_label || "").trim(),
    links,
    days: consentDays(env)
  };
}

const CSS = `
.lummet-cookie{position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483000;max-width:760px;margin:0 auto;padding:16px 18px;border-radius:14px;background:var(--surface,#fff);color:var(--ink,var(--text,#14162b));border:1px solid var(--border,rgba(128,128,128,.3));box-shadow:0 18px 50px -12px rgba(0,0,0,.35);font:14px/1.5 var(--font-sans,system-ui,sans-serif)}
.lummet-cookie__inner{display:flex;flex-wrap:wrap;gap:14px 20px;align-items:center;justify-content:space-between}
.lummet-cookie__body{flex:1 1 320px;min-width:0}
.lummet-cookie__title{margin:0 0 4px;font-weight:700;font-size:15px}
.lummet-cookie__text{margin:0;color:var(--ink-dim,var(--text-dim,inherit));opacity:.95}
.lummet-cookie__text a{color:inherit;font-weight:700;text-decoration:underline;margin-left:8px}
.lummet-cookie__actions{display:flex;flex-wrap:wrap;gap:10px;flex:0 0 auto}
.lummet-cookie__btn{font:inherit;font-weight:700;min-height:40px;padding:9px 18px;border-radius:999px;cursor:pointer;border:1px solid var(--border-strong,rgba(128,128,128,.5));background:transparent;color:inherit}
.lummet-cookie__btn--primary{border-color:transparent;color:#fff;background:var(--grad,var(--accent,#5b47f5))}
.lummet-cookie__btn:focus-visible{outline:3px solid var(--accent-soft,rgba(91,71,245,.35));outline-offset:2px}
.lummet-cookie-settings{font:inherit;background:none;border:0;padding:0;margin:0 0 0 14px;color:inherit;text-decoration:underline;cursor:pointer;opacity:.85}
@media (max-width:520px){.lummet-cookie{left:8px;right:8px;bottom:8px}.lummet-cookie__actions{width:100%}.lummet-cookie__btn{flex:1}}
`.replace(/\s*\n\s*/g, "");

/**
 * The banner markup (no script), or "" when the banner is off. The public site's base template adds the script itself, because
 * its policy allows same-origin scripts; pages under a nonce-only policy use renderCookieBannerWithScript below.
 */
export function renderCookieBanner(env, ui) {
  const m = cookieBannerModel(env, ui);
  if (!m) return "";
  const links = m.links.map((l) => `<a href="${esc(l.href)}">${esc(l.label)}</a>`).join("");
  const label = m.title || m.text.slice(0, 40);
  return `<style>${CSS}</style>
<div class="lummet-cookie" id="lummet-cookie-banner" role="region" aria-label="${esc(label)}" data-cookie-days="${m.days}" data-cookie-name="${CONSENT_COOKIE}" hidden>
  <div class="lummet-cookie__inner">
  <div class="lummet-cookie__body">
    ${m.title ? `<p class="lummet-cookie__title">${esc(m.title)}</p>` : ""}
    <p class="lummet-cookie__text">${esc(m.text)}${links}</p>
  </div>
  <div class="lummet-cookie__actions">
    ${m.decline ? `<button type="button" class="lummet-cookie__btn" data-cookie-choice="declined">${esc(m.decline)}</button>` : ""}
    <button type="button" class="lummet-cookie__btn lummet-cookie__btn--primary" data-cookie-choice="accepted">${esc(m.accept)}</button>
  </div>
  </div>
</div>`;
}

/** Banner plus its script for sign-in pages and the dashboard (nonce-only script policy). */
export function renderCookieBannerWithScript(env, ui) {
  const banner = renderCookieBanner(env, ui);
  return banner ? `${banner}\n<script nonce="${nonceToken()}" src="/static/js/cookie-consent.js?v=${ASSET_VERSION}" defer></script>` : "";
}

/** The "Cookie settings" button label for footers, or "" when the banner is off. */
export function cookieSettingsLabel(env, ui) {
  const m = cookieBannerModel(env, ui);
  return m ? m.settings : "";
}

export function cookieSettingsButton(label) {
  return label ? `<button type="button" class="lummet-cookie-settings" data-cookie-settings>${esc(label)}</button>` : "";
}
