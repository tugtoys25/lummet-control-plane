// =====================================================
// STATIC ASSET HASHING (Cloudflare Workers Assets format)
//
// Cloudflare identifies each uploaded asset by a 32-hex-char hash. The
// algorithm below mirrors the one `wrangler` uses: SHA-256 over the
// file's base64 text followed by its extension (without the dot),
// truncated to 32 hex chars. Keeping the same algorithm means a file
// Cloudflare already holds from any earlier deploy is recognised and not
// re-uploaded. This is written from Cloudflare's documented/observed
// behaviour and has NOT been verified against a live account here; if
// Cloudflare rejects uploads with a hash error, this is the first place
// to look.
// =====================================================
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_ASSET_FILES = 500;

const MIME = {
  html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8", json: "application/json", webmanifest: "application/manifest+json",
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2",
  ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", xml: "application/xml", map: "application/json"
};

export function extensionOf(path) {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  return dot > slash ? path.slice(dot + 1) : "";
}

export function contentTypeFor(path) {
  return MIME[extensionOf(path).toLowerCase()] || "application/octet-stream";
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export async function assetHash(bytes, path) {
  const data = new TextEncoder().encode(bytesToBase64(bytes) + extensionOf(path));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** Returns an error code, or null if the path is acceptable as a served URL path. */
export function validateAssetPath(path) {
  if (typeof path !== "string" || path.length < 2 || path.length > 512) return "invalid_asset_path";
  if (!path.startsWith("/") || path.includes("..") || path.includes("\\") || path.includes("//") || /[\u0000-\u001f?#]/.test(path)) return "invalid_asset_path";
  return null;
}

/** manifest: { "/static/a.css": { hash, size } } -> error code or null */
export function validateAssetManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "assets_must_be_an_object";
  const entries = Object.entries(manifest);
  if (entries.length === 0) return "assets_empty";
  if (entries.length > MAX_ASSET_FILES) return "too_many_assets";
  for (const [path, meta] of entries) {
    if (validateAssetPath(path)) return "invalid_asset_path";
    if (!meta || !/^[0-9a-f]{32}$/.test(String(meta.hash)) || !Number.isInteger(meta.size) || meta.size < 0 || meta.size > MAX_ASSET_BYTES) return "invalid_asset_entry";
  }
  return null;
}
