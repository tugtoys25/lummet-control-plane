// =====================================================
// AUTH SHELL (release 2.6.0.23, extended in 2.6.0.24)
//
// Log in / Create account for the customer portal, in the same look as the public site (2.6.0.20). It loads the public
// design tokens (colors, Bricolage Grotesque + Instrument Sans, radii) from /static/css/tokens.css and adds a small inline
// stylesheet for the auth card only. Since 2.6.0.24 every sign-in style page uses it: customer login/signup, forgot/reset/verify/invitation, 2FA enroll, IP-denied and the
// staff console login (renderAuthShell in layout.js delegates here with audience "staff").
//
// Security is unchanged: the theme boot script and the shell script keep their nonces, and there are no inline handlers.
// tokens.css is a same-origin stylesheet under /static, versioned with ASSET_VERSION like the public pages, so no
// public/static file changes in this release and the asset-version lock stays as it is.
// =====================================================
import { nonceToken } from "../csp.js";
import { BOOT_SCRIPT } from "./shell-assets.js";
import { SHELL_JS_URL } from "../perf/shell-bundle.js";
import { ASSET_VERSION } from "../perf/asset-version.js";

// Local copy so this module does not import layout.js (layout.js delegates renderAuthShell here; no import cycle).
function escapeHtml(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const AUTH_CSS = `
  /* Customer pages carry the public site's header and footer (see site-chrome.js): the card is centred between them. */
  body.auth-chrome { display: block; padding: 0; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; align-items: stretch; justify-content: flex-start; }
  body.auth-chrome > .auth-wrap { flex: 1 0 auto; width: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 16px; }
  body.auth-chrome .site-footer { margin-top: auto; }
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: flex; flex-direction: column; align-items: center; justify-content: center;
    padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); font-family: var(--font-sans); font-size: 1rem; line-height: 1.5;
    color: var(--ink); background: radial-gradient(900px 520px at 50% -8%, var(--accent-soft), transparent 70%), var(--bg-soft); }
  .auth-brand { display: inline-flex; align-items: center; gap: 10px; margin-bottom: 22px; font-family: var(--font-display); font-weight: 700; font-size: 1.6rem;
    letter-spacing: -0.02em; color: var(--ink); text-decoration: none; }
  .auth-brand .dot { width: 30px; height: 30px; border-radius: 9px; background: var(--grad); box-shadow: 0 6px 18px -6px var(--accent-glow); }
  .auth-card { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
    box-shadow: var(--shadow-lg); padding: 32px 28px 26px; }
  .auth-card h1 { margin: 0 0 6px; font-family: var(--font-display); font-weight: 700; font-size: 1.65rem; line-height: 1.15; letter-spacing: -0.02em; }
  .auth-sub { margin: 0 0 22px; color: var(--ink-dim); font-size: var(--fs-sm); }
  .auth-card label { display: block; margin: 14px 0 6px; font-size: var(--fs-xs); font-weight: 700; letter-spacing: 0.01em; color: var(--ink-dim); }
  .auth-card input[type=email], .auth-card input[type=password], .auth-card input[type=text] { width: 100%; min-height: 46px; padding: 11px 14px; font: inherit;
    color: var(--ink); background: var(--bg); border: 1px solid var(--border-strong); border-radius: var(--radius-sm); transition: border-color .15s var(--ease), box-shadow .15s var(--ease); }
  .auth-card input::placeholder { color: var(--ink-faint); }
  .auth-card input:focus-visible { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft), 0 0 0 1px var(--accent); }
  .auth-btn { width: 100%; min-height: 48px; margin-top: 22px; padding: 12px 18px; font: inherit; font-weight: 700; color: #fff; cursor: pointer; border: 0;
    border-radius: var(--radius-pill); background: var(--grad); box-shadow: 0 10px 24px -10px var(--accent-glow); transition: transform .15s var(--ease), box-shadow .15s var(--ease), filter .15s var(--ease); }
  .auth-btn:hover { transform: translateY(-1px); filter: brightness(1.06); }
  .auth-btn:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; box-shadow: 0 0 0 2px var(--accent); }
  .auth-btn[disabled] { opacity: .65; cursor: progress; transform: none; }
  .auth-alt { margin: 18px 0 0; text-align: center; font-size: var(--fs-sm); color: var(--ink-dim); }
  .auth-alt a { color: var(--accent-ink); font-weight: 700; text-decoration: none; }
  .auth-alt a:hover { text-decoration: underline; }
  .auth-alt .sep { margin: 0 6px; color: var(--ink-faint); }
  .auth-flash:empty { display: none; }
  .auth-flash > div { margin-bottom: 16px; padding: 11px 14px; border-radius: var(--radius-sm); font-size: var(--fs-sm); border: 1px solid transparent; }
  .auth-flash .flash-error { color: var(--danger); background: var(--danger-soft); border-color: var(--danger); }
  .auth-flash .flash-success { color: var(--ok); background: var(--ok-soft); border-color: var(--ok); }
  .auth-card .btn { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 48px; margin-top: 22px; padding: 12px 18px; font: inherit; font-weight: 700; color: #fff; cursor: pointer; text-decoration: none;
    border: 0; border-radius: var(--radius-pill); background: var(--grad); box-shadow: 0 10px 24px -10px var(--accent-glow); }
  .auth-card .btn:hover { filter: brightness(1.06); text-decoration: none; }
  .auth-card .btn:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; }
  .auth-card .btn[disabled], .auth-card .btn:disabled { opacity: .65; cursor: progress; }
  .auth-card .flash { margin-bottom: 16px; padding: 11px 14px; border-radius: var(--radius-sm); font-size: var(--fs-sm); border: 1px solid transparent; }
  .auth-card .flash-error { color: var(--danger); background: var(--danger-soft); border-color: var(--danger); }
  .auth-card .flash-success { color: var(--ok); background: var(--ok-soft); border-color: var(--ok); }
  #flash:empty { display: none; }
  .auth-card p { margin: 0 0 14px; color: var(--ink-dim); font-size: var(--fs-sm); }
  .auth-card code { font-family: var(--font-mono); font-size: .85em; background: var(--bg-tint); border: 1px solid var(--border); border-radius: 6px; padding: 1px 6px; word-break: break-all; }
  .auth-card ul { padding-left: 20px; color: var(--ink-dim); font-size: var(--fs-sm); }
  .auth-card [hidden] { display: none !important; }
  .auth-card a:not(.btn) { color: var(--accent-ink); font-weight: 700; }
  .auth-badge { display: inline-block; margin: 0 0 12px; padding: 3px 11px; border-radius: var(--radius-pill); font-size: var(--fs-xs); font-weight: 700; letter-spacing: .02em; color: var(--accent-ink); background: var(--accent-soft); }
  .auth-switch { width: 100%; max-width: 420px; margin: 16px 0 0; padding: 13px 16px; text-align: center; font-size: var(--fs-sm); color: var(--ink-dim);
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-md); }
  .auth-switch a { color: var(--accent-ink); font-weight: 700; text-decoration: none; }
  .auth-switch a:hover { text-decoration: underline; }
  .auth-turnstile { margin-top: 4px; }
  .auth-back { margin-top: 18px; font-size: var(--fs-xs); }
  .auth-back a { color: var(--ink-faint); text-decoration: none; }
  .auth-back a:hover { color: var(--ink-dim); text-decoration: underline; }
  @media (max-width: 440px) { .auth-card { padding: 26px 20px 22px; border-radius: var(--radius-md); } }
  @media (prefers-reduced-motion: reduce) { .auth-btn, .auth-card input { transition: none; } .auth-btn:hover { transform: none; } }
`;

/**
 * audience "customer" (default) shows a plain back link; "staff" marks the page as the staff console and adds the
 * "Are you a customer? Log in here" switch that points to the customer portal login.
 */
export function renderCustomerAuthShell({ title, bodyHtml, audience = "customer" }) {
  const staff = audience === "staff";
  // Customer pages: the public base styles, header and footer (and the cookie banner) are swapped in by site-chrome.js.
  // Staff sign-in carries the same public header, footer and cookie banner as the customer sign-in (the staff badge and the
  // "Are you a customer?" link stay inside the card area).
  const chrome = true;
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="light dark" />
  <meta name="robots" content="noindex" />
  <title>${escapeHtml(title)} · Lummet</title>
  <link rel="icon" type="image/svg+xml" href="/static/images/favicon.svg" />
  ${chrome ? `<script nonce="${nonceToken()}" src="/static/js/theme.js?v=${ASSET_VERSION}"></script>` : `<script nonce="${nonceToken()}">${BOOT_SCRIPT}</script>`}
  <link rel="preload" href="/static/fonts/instrument-400-v1.woff" as="font" type="font/woff" crossorigin />
  <link rel="preload" href="/static/fonts/bricolage-700-v1.woff" as="font" type="font/woff" crossorigin />
  <link rel="stylesheet" href="/static/css/tokens.css?v=${ASSET_VERSION}" />
  ${chrome ? `<link rel="stylesheet" href="/static/css/base.css?v=${ASSET_VERSION}" />
  <link rel="stylesheet" href="/static/css/components.css?v=${ASSET_VERSION}" />` : ""}
  <style>${AUTH_CSS}</style>
  <script nonce="${nonceToken()}" src="${SHELL_JS_URL}" defer></script>
  ${chrome ? `<script nonce="${nonceToken()}" src="/static/js/nav.js?v=${ASSET_VERSION}" defer></script>` : ""}
</head>
<body${chrome ? ' class="auth-chrome"' : ""}>
  ${chrome ? "<!--lummet:site-header-->" : ""}
  ${chrome ? '<div class="auth-wrap">' : '<a class="auth-brand" href="/" aria-label="Lummet home"><span class="dot"></span>Lummet</a>'}
  <main class="auth-card" id="main">
    ${staff ? '<span class="auth-badge">Staff console</span>' : ""}
    ${bodyHtml}
  </main>
  ${staff ? '<p class="auth-switch">Are you a customer? <a href="/app/login">Log in here</a></p>' : ""}
  ${chrome ? "" : '<p class="auth-back"><a href="/">&larr; Back to home</a></p>'}
  ${chrome ? "</div>" : ""}
  ${chrome ? "<!--lummet:site-footer-->\n  <!--lummet:cookie-banner-->" : ""}
</body>
</html>`;
}
