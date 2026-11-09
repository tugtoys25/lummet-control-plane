// =====================================================
// PORTAL BRANDING
//
// What the control plane looks like to the people who use it: its name, logo, favicons, app icons and theme colours. Set by staff in
// Platform settings -> Branding; the images are picked from (or uploaded to) the control plane's own media library (platform-media.js).
// It mirrors the tenant's "Favicons & App Icons" settings (site_favicon_svg / _ico / _96, site_apple_touch_icon, site_pwa_icon_192 /
// _512, site_logo, site_og_image, the manifest options) and adds validation the tenant does not have: an icon must be the right TYPE and
// the right SIZE (a 96 px favicon must be a 96 x 96 PNG).
//
// WHERE IT SHOWS
//   name and logo                       the staff console (sidebar, page title)
//   favicons, app icons, theme colour   every page this Worker renders: staff console, sign-in pages, the customer dashboard, the public site
//   /favicon.ico and /site.webmanifest  answered from these values (see handlePublicBrandingRoute)
//   nothing set                         the built-in look, exactly as before
//
// FRESHNESS. Each isolate caches the values for 15 seconds (like platform settings); a save in the isolate that took it is visible at
// once. FAIL SOFT: if the table cannot be read, the built-in look is used and the failure is logged. Branding never blocks a page.
// =====================================================

import * as repo from "./repositories/portal-branding.js";
import * as media from "./platform-media.js";

const CACHE_MS = 15_000;
const FAILURE_MS = 5_000;

const PNG = ["image/png"];
const ANY_IMAGE = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml"];

function field(key, group, type, opts = {}) {
  return { key, group, type, ...opts };
}

/** Every branding value, in the order the form shows them. `accept` = content types; `size` = exact pixel size an own image must have. */
export const FIELDS = [
  field("brand_name", "identity", "text", { max: 60, label: "Portal name", help: "Shown in the staff console sidebar and in the page title. Leave empty to keep the site name." }),
  field("brand_short_name", "identity", "text", { max: 24, label: "Short name", help: "Used under the app icon on a phone's home screen." }),
  field("logo", "identity", "image", { accept: ANY_IMAGE, label: "Logo", help: "Shown in the staff console sidebar. A square image, at least 64 by 64 pixels, looks best." }),
  field("og_image", "identity", "image", { accept: ["image/png", "image/jpeg", "image/webp"], label: "Social share image", help: "The picture shown when a link to the portal is shared. 1200 by 630 pixels works best." }),

  field("favicon_svg", "favicons", "image", { accept: ["image/svg+xml"], label: "Favicon (SVG)", help: "Modern browsers use this one first." }),
  field("favicon_ico", "favicons", "image", { accept: ["image/x-icon"], label: "Favicon (ICO)", help: "Fallback for older browsers. Also answers /favicon.ico." }),
  field("favicon_96", "favicons", "image", { accept: PNG, size: 96, label: "Favicon (96 px)", help: "PNG, exactly 96 by 96 pixels." }),
  field("apple_touch_icon", "favicons", "image", { accept: PNG, size: 180, label: "Home-screen icon (Apple)", help: "PNG, exactly 180 by 180 pixels." }),

  field("pwa_icon_192", "app", "image", { accept: PNG, size: 192, label: "App icon 192", help: "PNG, exactly 192 by 192 pixels. Listed in the web app manifest." }),
  field("pwa_icon_512", "app", "image", { accept: PNG, size: 512, label: "App icon 512", help: "PNG, exactly 512 by 512 pixels. Listed in the web app manifest." }),
  field("manifest_display", "app", "enum", { options: ["standalone", "minimal-ui", "browser"], label: "App display mode", help: "How the portal opens when it is added to a phone home screen." }),
  field("theme_color", "app", "color", { label: "Theme colour", help: "Colours the browser's address bar on phones. For example #1a56db." }),
  field("background_color", "app", "color", { label: "App background colour", help: "Shown while an installed app starts. For example #ffffff." })
];

export const GROUPS = [
  { id: "identity", title: "Name and logo", help: "Shown in the staff console." },
  { id: "favicons", title: "Favicons", help: "Browser tab and bookmark icons. Used on every Lummet page." },
  { id: "app", title: "App icons and colours", help: "For adding the portal to a phone home screen. Used on every Lummet page." }
];

const BY_KEY = new Map(FIELDS.map((f) => [f.key, f]));
export const getField = (key) => BY_KEY.get(key) || null;

// ---------- validation ----------

const bad = (error, detail) => ({ ok: false, error, ...(detail ? { detail } : {}) });
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0020\u007f"'<>\\`]/;

function externalUrl(s) {
  if (s.length > 500 || CONTROL.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : null;
  } catch (_) {
    return null;
  }
}

/** Checks one raw value for a field. Returns {ok:true, value} (value "" = clear it) or {ok:false, error, detail?}. */
export async function validateValue(env, definition, raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return { ok: true, value: "" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(s)) return bad("invalid_value");
  switch (definition.type) {
    case "text":
      return s.length <= definition.max ? { ok: true, value: s } : bad("too_long", `${definition.max} characters at most`);
    case "enum": {
      const v = s.toLowerCase();
      return definition.options.includes(v) ? { ok: true, value: v } : bad("invalid_value", `one of: ${definition.options.join(", ")}`);
    }
    case "color": {
      const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
      if (!m) return bad("invalid_color", "use a hex colour such as #1a56db");
      const h = m[1].toLowerCase();
      return { ok: true, value: `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}` };
    }
    case "image": {
      if (s.length > 500) return bad("too_long", "500 characters at most");
      if (s.startsWith("/")) {
        const key = media.ownKeyFromUrl(s);
        if (!key) return bad("invalid_image_address", `a file from the media library, or an https address`);
        const row = await media.getMediaByUrl(env, s);
        if (!row) return bad("media_not_found", "that file is not in the media library");
        if (!definition.accept.includes(row.mimeType)) return bad("wrong_image_type", `${definition.label} needs ${definition.accept.map((m) => m.replace("image/", "").replace("svg+xml", "svg").replace("x-icon", "ico")).join(" / ")}, this file is ${row.mimeType.replace("image/", "")}`);
        if (definition.size && (row.width !== definition.size || row.height !== definition.size)) return bad("wrong_dimensions", `${definition.label} must be ${definition.size} by ${definition.size} pixels, this file is ${row.width ?? "?"} by ${row.height ?? "?"}`);
        return { ok: true, value: media.publicPathOf(key) };
      }
      const external = externalUrl(s);
      return external ? { ok: true, value: external } : bad("invalid_image_address", "a file from the media library, or an https address");
    }
    default:
      return bad("invalid_value");
  }
}

// ---------- loading ----------

const caches = new WeakMap(); // LUMMET_DB binding -> { at, ttl, values }

function readableValues(rows) {
  const out = {};
  for (const row of rows) {
    if (BY_KEY.has(row.key) && typeof row.value === "string" && row.value !== "") out[row.key] = row.value;
  }
  return out;
}

export function invalidateBrandingCache(env) {
  if (env && env.LUMMET_DB) caches.delete(env.LUMMET_DB);
}

/** The values staff have set, as a plain object ({} when none). Cached per isolate; never throws. */
export async function loadBranding(env, { fresh = false } = {}) {
  const db = env && env.LUMMET_DB;
  if (!db) return {};
  const entry = caches.get(db);
  const now = Date.now();
  if (!fresh && entry && now - entry.at < entry.ttl) return entry.values;
  try {
    const values = readableValues(await repo.listAll(env));
    caches.set(db, { at: now, ttl: CACHE_MS, values });
    return values;
  } catch (error) {
    console.error(JSON.stringify({ msg: "portal_branding_unreadable", error: String(error?.message || error).slice(0, 200) }));
    const values = entry?.values || {};
    caches.set(db, { at: now, ttl: FAILURE_MS, values });
    return values;
  }
}

// ---------- reading, for the staff page ----------

/** Every field with its stored value, who set it and when. */
export async function listFields(env) {
  const rows = await repo.listAll(env);
  const meta = new Map(rows.map((r) => [r.key, r]));
  const values = readableValues(rows);
  return FIELDS.map((f) => ({
    key: f.key, group: f.group, type: f.type, label: f.label, help: f.help,
    accept: f.accept || null, size: f.size || null, options: f.options || null, max: f.max || null,
    value: values[f.key] || "",
    updatedBy: meta.get(f.key)?.updated_by || null,
    updatedAt: meta.get(f.key)?.updated_at || null
  }));
}

// ---------- writing ----------

const reasonOf = (reason) => String(reason ?? "").trim();

/**
 * Saves the branding form. `values` maps field key -> raw value; a key that is missing is left as it is, an empty value clears it.
 * Everything is checked first and nothing is written unless every value is good. Needs a reason (audited by the caller).
 * Returns {ok, changed:[keys], fields} or {ok:false, status, error, errors:{key:{error,detail}}}.
 */
export async function saveBranding(env, { values, actorId, reason }) {
  if (reasonOf(reason).length < 3) return { ok: false, status: 422, error: "reason_required" };
  if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, status: 422, error: "invalid_body" };
  const unknown = Object.keys(values).filter((k) => !BY_KEY.has(k));
  if (unknown.length) return { ok: false, status: 422, error: "unknown_setting", detail: unknown.join(", ") };

  const current = await loadBranding(env, { fresh: true });
  const errors = {};
  const sets = [];
  const removes = [];
  for (const [key, raw] of Object.entries(values)) {
    const checked = await validateValue(env, BY_KEY.get(key), raw);
    if (!checked.ok) { errors[key] = { error: checked.error, detail: checked.detail || null }; continue; }
    if (checked.value === "") { if (current[key] !== undefined) removes.push(key); }
    else if (current[key] !== checked.value) sets.push({ key, value: checked.value });
  }
  if (Object.keys(errors).length) return { ok: false, status: 422, error: "invalid_values", errors };
  if (!sets.length && !removes.length) return { ok: true, changed: [], unchanged: true, fields: await listFields(env) };

  await repo.applyChanges(env, { sets, removes, actorId });
  invalidateBrandingCache(env);
  return {
    ok: true,
    changed: [...sets.map((s) => s.key), ...removes],
    before: Object.fromEntries([...sets.map((s) => s.key), ...removes].map((k) => [k, current[k] ?? null])),
    after: Object.fromEntries([...sets.map((s) => [s.key, s.value]), ...removes.map((k) => [k, null])]),
    fields: await listFields(env)
  };
}

// ---------- using it ----------

const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const FALLBACK_ICON_LINK = `<link rel="icon" type="image/svg+xml" href="/static/images/favicon.svg" />`;
export const MANIFEST_PATH = "/site.webmanifest";

/** True when a web app manifest is worth publishing: at least one app icon is set. */
export const hasManifest = (values) => Boolean(values.pwa_icon_192 || values.pwa_icon_512);

/**
 * The <head> tags for the icons, theme colour and manifest, or "" when staff have set none of them (callers then keep the built-in
 * favicon). Safe to drop into any HTML head; every value is escaped.
 */
export function iconLinksHtml(values) {
  const v = values || {};
  const out = [];
  if (v.favicon_svg) out.push(`<link rel="icon" type="image/svg+xml" href="${esc(v.favicon_svg)}" />`);
  if (v.favicon_ico) out.push(`<link rel="icon" type="image/x-icon" sizes="any" href="${esc(v.favicon_ico)}" />`);
  if (v.favicon_96) out.push(`<link rel="icon" type="image/png" sizes="96x96" href="${esc(v.favicon_96)}" />`);
  if (v.apple_touch_icon) out.push(`<link rel="apple-touch-icon" sizes="180x180" href="${esc(v.apple_touch_icon)}" />`);
  if (hasManifest(v)) out.push(`<link rel="manifest" href="${MANIFEST_PATH}" />`);
  if (v.theme_color) out.push(`<meta name="theme-color" content="${esc(v.theme_color)}" />`);
  return out.join("\n  ");
}

/** The tags the head-icons marker is replaced with: the staff-set tags, or the built-in favicon when none are set. */
export async function headIconsHtml(env) {
  return iconLinksHtml(await loadBranding(env)) || FALLBACK_ICON_LINK;
}

/** Name and logo for the staff console, or null for each one that is not set (the caller keeps the site's own). */
export async function portalIdentity(env) {
  const v = await loadBranding(env);
  return { name: v.brand_name || null, logo: v.logo || null };
}

/** The web app manifest as an object, or null when no app icon is set. */
export function buildManifest(values, fallbackName = "Lummet") {
  const v = values || {};
  if (!hasManifest(v)) return null;
  const icons = [];
  if (v.pwa_icon_192) icons.push({ src: v.pwa_icon_192, sizes: "192x192", type: "image/png", purpose: "any" });
  if (v.pwa_icon_512) icons.push({ src: v.pwa_icon_512, sizes: "512x512", type: "image/png", purpose: "any" });
  const name = v.brand_name || fallbackName;
  return {
    name,
    short_name: v.brand_short_name || name.slice(0, 24),
    start_url: "/dashboard",
    scope: "/",
    display: v.manifest_display || "standalone",
    theme_color: v.theme_color || "#0b1220",
    background_color: v.background_color || v.theme_color || "#0b1220",
    icons
  };
}

const SHORT_CACHE = "public, max-age=300";

/**
 * Public, session-free GET/HEAD routes this feature owns. Returns a Response, or null for any other path.
 *   /brand-media/<key>   a file from the media library
 *   /favicon.ico         redirects to the ICO (else the 96 px PNG, else the SVG) when one is set; otherwise falls through
 *   /site.webmanifest    the web app manifest, 404 until an app icon is set
 */
export async function handlePublicBrandingRoute(request, env, url) {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const path = url.pathname;
  if (path.startsWith(media.PUBLIC_PREFIX)) {
    let key = "";
    try { key = decodeURIComponent(path.slice(media.PUBLIC_PREFIX.length)); } catch (_) { key = ""; } // a malformed escape is just "no such file"
    return media.serveMedia(request, env, key);
  }
  if (path === "/favicon.ico") {
    const v = await loadBranding(env);
    const target = v.favicon_ico || v.favicon_96 || v.favicon_svg;
    return target ? new Response(null, { status: 302, headers: { Location: target, "Cache-Control": SHORT_CACHE } }) : null;
  }
  if (path === MANIFEST_PATH) {
    const manifest = buildManifest(await loadBranding(env));
    if (!manifest) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
    return new Response(method === "HEAD" ? null : JSON.stringify(manifest), { status: 200, headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": SHORT_CACHE, "X-Content-Type-Options": "nosniff" } });
  }
  return null;
}
