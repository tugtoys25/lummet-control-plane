// =====================================================
// SHELL BUNDLE (performance, release 2.6.0.16)
//
// The staff console and the customer portal used to inline ~20 KB of CSS and ~5 KB of script into EVERY page. Inline
// bytes cannot be cached, so every navigation re-downloaded and re-parsed them. They are now served as three small
// files under /_s/, named by a content hash and marked immutable: the browser fetches each once, ever (until the
// content changes, which changes the name), and every later page is just its own HTML.
//
// Security is unchanged. The script is same-origin and carries the page's nonce (script-src 'nonce-...' stays the only
// script source); the stylesheet is same-origin. The tiny BOOT_SCRIPT stays inline: it must run before first paint to
// avoid a theme flash.
// =====================================================
import { STYLES, CUSTOMER_STYLES, CLIENT_SCRIPT } from "../views/shell-assets.js";

/** 32-bit FNV-1a, hex. Sync (Workers allow no async work at module scope); only used to name a file by its content. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

const FILES = {
  staffCss: { body: STYLES, type: "text/css; charset=utf-8", ext: "css", stem: "shell" },
  customerCss: { body: STYLES + CUSTOMER_STYLES, type: "text/css; charset=utf-8", ext: "css", stem: "portal" },
  clientJs: { body: CLIENT_SCRIPT, type: "text/javascript; charset=utf-8", ext: "js", stem: "shell" }
};

for (const f of Object.values(FILES)) {
  f.hash = fnv1a(f.body);
  f.path = `/_s/${f.stem}.${f.hash}.${f.ext}`;
}

export const SHELL_CSS_URL = FILES.staffCss.path;
export const PORTAL_CSS_URL = FILES.customerCss.path;
export const SHELL_JS_URL = FILES.clientJs.path;

const BY_PATH = new Map(Object.values(FILES).map((f) => [f.path, f]));

export function isShellAssetPath(path) {
  return typeof path === "string" && path.startsWith("/_s/");
}

/**
 * Serves a hashed shell file. Unknown or stale names answer 404 (never the new content under an old name, which would
 * poison caches). Content-addressed, so it is safe to cache for a year and share across users: it contains no user data.
 */
export function serveShellAsset(request) {
  const path = new URL(request.url).pathname;
  const file = BY_PATH.get(path);
  const method = request.method.toUpperCase();
  if (!file || (method !== "GET" && method !== "HEAD")) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
  }
  const etag = `"${file.hash}"`;
  const headers = {
    "content-type": file.type,
    "cache-control": "public, max-age=31536000, immutable",
    etag,
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin"
  };
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(method === "HEAD" ? null : file.body, { status: 200, headers });
}
