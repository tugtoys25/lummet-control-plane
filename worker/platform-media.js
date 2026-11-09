// =====================================================
// CONTROL-PLANE MEDIA LIBRARY
//
// The control plane's own, dedicated media library: files live in the R2 bucket bound as PLATFORM_MEDIA, their records in D1
// (platform_media, migration 0096). It exists so staff can PICK or UPLOAD the logo, favicons and app icons of the portal instead of
// pasting a link. It is modelled on the tenant's media library (R2 object + D1 row + a picker) and deliberately separate from it:
// nothing here reads or writes a tenant.
//
// Where the tenant trusts the browser, this does not:
//   - the content type comes from the file's BYTES (image-inspect.js), never from the name or the type the browser sent;
//   - the extension has to agree with those bytes;
//   - SVG is refused when it can run script or fetch anything;
//   - stored objects are served with nosniff, a year of immutable caching (keys are unique) and, for SVG, a locked-down CSP.
//
// Public address of a file: /brand-media/<r2_key>. Fails closed when PLATFORM_MEDIA is not bound (503 media_storage_not_configured);
// pasting an https address in the branding form keeps working without it.
// =====================================================

import * as repo from "./repositories/platform-media.js";
import * as brandingRepo from "./repositories/portal-branding.js";
import { inspectFile, extensionOf, MIME_TO_EXT, FILE_TYPES, kindOfMime, typeForExtension } from "./image-inspect.js";

export const PUBLIC_PREFIX = "/brand-media/";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
// A Worker reads the whole file into memory (and hashes it), so video is capped well below the tenant's 100 MB.
export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_BYTES = { image: MAX_IMAGE_BYTES, document: MAX_DOCUMENT_BYTES, video: MAX_VIDEO_BYTES };
export const MAX_REQUEST_BYTES = MAX_VIDEO_BYTES + 1024 * 1024;
export const MAX_FILES_PER_REQUEST = 10;
export const KIND_FILTERS = {
  image: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/svg+xml"],
  video: ["video/mp4", "video/quicktime", "video/webm", "video/ogg"],
  file: ["application/pdf", "text/plain", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
};
export const DEFAULT_FOLDER = "branding";
export const PAGE_SIZE = 24;
export const ALLOWED_EXTENSIONS = Object.values(FILE_TYPES).flatMap((t) => t.extensions);
export const ALLOWED_MIMES = Object.values(FILE_TYPES).map((t) => t.mime);

const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}\/[0-9]{10,16}-[0-9a-f]{16}\.(?:png|jpg|gif|webp|ico|svg|mp4|webm|ogg|mov|pdf|txt|doc|docx)$/;

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));

async function sha256Hex(bytes) {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export const publicPathOf = (r2Key) => `${PUBLIC_PREFIX}${r2Key}`;

/** The r2 key when `value` is the address of one of our own files (a path, or an absolute address on `origin`); otherwise null. */
export function ownKeyFromUrl(value, origin = "") {
  let s = String(value ?? "").trim();
  if (!s) return null;
  if (origin && s.startsWith(origin)) s = s.slice(origin.length);
  if (!s.startsWith(PUBLIC_PREFIX)) return null;
  const key = s.slice(PUBLIC_PREFIX.length).split(/[?#]/)[0];
  return KEY_RE.test(key) ? key : null;
}

/** An https address safe to keep and to put in src/href: no credentials, no spaces or quote characters, 500 characters at most. Returns the normalised address or null. */
// eslint-disable-next-line no-control-regex
const BAD_URL_CHARS = /[\u0000-\u0020\u007f"'<>\\`]/;
export function cleanExternalUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s.length > 500 || BAD_URL_CHARS.test(s)) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") ? u.href : null;
  } catch (_) {
    return null;
  }
}

export function cleanFolder(raw) {
  const s = String(raw ?? "").trim().toLowerCase() || DEFAULT_FOLDER;
  return FOLDER_RE.test(s) ? s : null;
}

function cleanFilename(raw) {
  // eslint-disable-next-line no-control-regex
  const base = String(raw ?? "").replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f<>"'`]/g, "").trim();
  return (base || "upload").slice(0, 120);
}

const cleanAlt = (raw) => String(raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 200);

/** What the page and the picker get for one row. */
export function toPublic(row) {
  return {
    id: row.id,
    filename: row.filename,
    url: row.external_url || publicPathOf(row.r2_key),
    external: Boolean(row.external_url),
    kind: kindOfMime(row.mime_type),
    key: row.external_url ? null : row.r2_key,
    mimeType: row.mime_type,
    size: row.size,
    width: row.width ?? null,
    height: row.height ?? null,
    altText: row.alt_text || "",
    folder: row.folder,
    uploadedBy: row.uploaded_by || null,
    createdAt: row.created_at
  };
}

export const storageConfigured = (env) => Boolean(env && env.PLATFORM_MEDIA);

/**
 * Validates and stores one uploaded file. `file` is a File/Blob from multipart form data.
 * Returns {ok:true, media, duplicate} or {ok:false, status, error, detail?}.
 */
export async function uploadMedia(env, { file, folder, altText, actorId }) {
  if (!storageConfigured(env)) return { ok: false, status: 503, error: "media_storage_not_configured" };
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, status: 400, error: "no_file" };
  const cleanedFolder = cleanFolder(folder);
  if (!cleanedFolder) return { ok: false, status: 422, error: "invalid_folder" };
  if (!(file.size > 0)) return { ok: false, status: 422, error: "empty_file" };
  const filename = cleanFilename(file.name);
  const expected = typeForExtension(filename);
  if (!expected) return { ok: false, status: 415, error: "unsupported_file_type", detail: `allowed: ${ALLOWED_EXTENSIONS.join(", ")}` };
  const limit = MAX_BYTES[expected.kind];
  if (file.size > limit) return { ok: false, status: 413, error: "file_too_large", detail: `${Math.round(limit / 1048576)} MB at most for ${expected.kind === "document" ? "a document" : expected.kind === "video" ? "a video" : "an image"}` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const seen = inspectFile(bytes, filename);
  if (!seen.ok) return { ok: false, status: 422, error: seen.error, detail: seen.detail };

  const sha = await sha256Hex(bytes);
  const existing = await repo.findBySha(env, sha, cleanedFolder);
  if (existing) return { ok: true, duplicate: true, media: toPublic(existing) };

  const r2Key = `${cleanedFolder}/${Date.now()}-${randomHex(8)}.${MIME_TO_EXT[seen.mime]}`;
  const id = `pm_${randomHex(8)}`;
  await env.PLATFORM_MEDIA.put(r2Key, bytes, {
    httpMetadata: { contentType: seen.mime, cacheControl: "public, max-age=31536000, immutable" },
    customMetadata: { uploadedBy: String(actorId ?? ""), originalFilename: filename, sha256: sha }
  });
  try {
    await repo.insert(env, { id, r2Key, filename, mimeType: seen.mime, size: bytes.length, width: seen.width, height: seen.height, altText: cleanAlt(altText), folder: cleanedFolder, sha256: sha, uploadedBy: actorId == null ? null : String(actorId) });
  } catch (error) {
    // The row failed after the object was written: remove the object so nothing is left that the library cannot see.
    await env.PLATFORM_MEDIA.delete(r2Key).catch((cleanup) => console.error(JSON.stringify({ msg: "platform_media_orphan_cleanup_failed", key: r2Key, error: String(cleanup?.message || cleanup).slice(0, 200) })));
    console.error(JSON.stringify({ msg: "platform_media_insert_failed", key: r2Key, error: String(error?.message || error).slice(0, 200) }));
    return { ok: false, status: 500, error: "upload_failed" };
  }
  return { ok: true, duplicate: false, media: toPublic(await repo.getById(env, id)) };
}

/**
 * Adds an image that stays at its own https address (nothing is downloaded or stored in R2), like the tenant's "add image from external
 * URL". The type comes from the file name's extension; width and height are optional and only used to check icon sizes.
 * Returns {ok:true, media, duplicate} or {ok:false, status, error, detail?}.
 */
export async function addFromUrl(env, { url, filename, folder, altText, width, height, actorId }) {
  const address = cleanExternalUrl(url);
  if (!address) return { ok: false, status: 422, error: "invalid_image_address", detail: "an https address, no spaces, 500 characters at most" };
  const cleanedFolder = cleanFolder(folder);
  if (!cleanedFolder) return { ok: false, status: 422, error: "invalid_folder" };
  const name = cleanFilename(filename || new URL(address).pathname.split("/").pop());
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.includes(ext)) return { ok: false, status: 422, error: "unsupported_file_type", detail: `the file name needs one of: ${ALLOWED_EXTENSIONS.join(", ")}` };
  const type = typeForExtension(name);
  const dim = (v) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) && n > 0 && n <= 16384 ? n : null; };
  const existing = await repo.getByExternalUrl(env, address);
  if (existing) return { ok: true, duplicate: true, media: toPublic(existing) };
  const id = `pm_${randomHex(8)}`;
  try {
    await repo.insert(env, { id, r2Key: `ext:${id}`, externalUrl: address, filename: name, mimeType: type.mime, size: 0, width: dim(width), height: dim(height), altText: cleanAlt(altText), folder: cleanedFolder, uploadedBy: actorId == null ? null : String(actorId) });
  } catch (error) {
    console.error(JSON.stringify({ msg: "platform_media_link_insert_failed", error: String(error?.message || error).slice(0, 200) }));
    return { ok: false, status: 500, error: "add_failed" };
  }
  return { ok: true, duplicate: false, media: toPublic(await repo.getById(env, id)) };
}

export async function getMedia(env, id) {
  const row = await repo.getById(env, String(id || ""));
  return row ? toPublic(row) : null;
}

export async function getMediaByUrl(env, value, origin = "") {
  if (/^https:\/\//i.test(String(value || "").trim())) {
    const linked = await repo.getByExternalUrl(env, String(value).trim());
    return linked ? toPublic(linked) : null;
  }
  const key = ownKeyFromUrl(value, origin);
  if (!key) return null;
  const row = await repo.getByKey(env, key);
  return row ? toPublic(row) : null;
}

/** Paged list for the library page and the picker. `kind` "image" is every type; `accept` is a list of mime types to narrow to. */
export async function listMedia(env, { folder = "", search = "", accept = null, page = 1 } = {}) {
  const pageNumber = Math.max(1, Math.min(10000, Number.parseInt(page, 10) || 1));
  const cleanedFolder = folder ? cleanFolder(folder) : "";
  if (folder && !cleanedFolder) return { items: [], total: 0, page: pageNumber, pageSize: PAGE_SIZE, folders: await repo.listFolders(env) };
  const mimes = Array.isArray(accept) ? accept.filter((m) => ALLOWED_MIMES.includes(m)) : null;
  const q = { folder: cleanedFolder || "", search: String(search || "").trim().slice(0, 80), mimes: mimes && mimes.length ? mimes : null };
  const [rows, total, folders] = await Promise.all([
    repo.list(env, { ...q, limit: PAGE_SIZE, offset: (pageNumber - 1) * PAGE_SIZE }),
    repo.count(env, q),
    repo.listFolders(env)
  ]);
  return { items: rows.map(toPublic), total, page: pageNumber, pageSize: PAGE_SIZE, folders };
}

export async function updateMedia(env, id, { altText, folder }) {
  const row = await repo.getById(env, String(id || ""));
  if (!row) return { ok: false, status: 404, error: "media_not_found" };
  const nextFolder = folder === undefined ? row.folder : cleanFolder(folder);
  if (!nextFolder) return { ok: false, status: 422, error: "invalid_folder" };
  // The file itself (and so its address) never moves; the folder is a label in the library.
  await repo.updateMeta(env, row.id, { altText: altText === undefined ? row.alt_text : cleanAlt(altText), folder: nextFolder });
  return { ok: true, media: toPublic(await repo.getById(env, row.id)) };
}

/** Branding values that point at this file. */
export async function usageOf(env, media) {
  const rows = await brandingRepo.listAll(env);
  return rows.filter((r) => (media.external ? r.value === media.url : ownKeyFromUrl(r.value) === media.key)).map((r) => r.key);
}

/** Deletes the file and its row. Refused while a branding value still points at it, so the portal never ends up with a broken icon. */
export async function deleteMedia(env, id) {
  const row = await repo.getById(env, String(id || ""));
  if (!row) return { ok: false, status: 404, error: "media_not_found" };
  if (!row.external_url && !storageConfigured(env)) return { ok: false, status: 503, error: "media_storage_not_configured" };
  const media = toPublic(row);
  const inUse = await usageOf(env, media);
  if (inUse.length) return { ok: false, status: 409, error: "media_in_use", detail: inUse.join(", "), usedBy: inUse };
  await repo.remove(env, row.id);
  if (row.external_url) return { ok: true, id: row.id }; // a link: there is no stored object
  await env.PLATFORM_MEDIA.delete(row.r2_key).catch((error) => console.error(JSON.stringify({ msg: "platform_media_object_delete_failed", key: row.r2_key, error: String(error?.message || error).slice(0, 200) })));
  return { ok: true, id: row.id };
}

const EXT_MIME = Object.fromEntries(Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime]));
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
const DOWNLOAD_ONLY = new Set(["doc", "docx"]);

/** Parses "bytes=a-b", "bytes=a-" or "bytes=-n" for a file of `size` bytes: {start,end} (inclusive), "unsatisfiable", or null (not a single range). */
export function parseByteRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return !Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end ? "unsatisfiable" : { start, end };
}

/**
 * GET/HEAD /brand-media/<key>. Public, no session. The content type comes from the key's extension, which upload fixed from the bytes.
 * Video honours byte ranges (Safari and iPhones need them). Word files download instead of opening; plain text is served as text.
 */
export async function serveMedia(request, env, rawKey) {
  const key = String(rawKey || "");
  if (!KEY_RE.test(key)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  if (!storageConfigured(env)) return new Response("Media storage is not configured", { status: 503, headers: { "Cache-Control": "no-store" } });
  const ext = key.slice(key.lastIndexOf(".") + 1);
  const type = EXT_MIME[ext];
  const headers = new Headers({
    "Content-Type": type === "text/plain" ? "text/plain; charset=utf-8" : type,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Accept-Ranges": "bytes",
    "Content-Disposition": DOWNLOAD_ONLY.has(ext) ? `attachment; filename="${key.split("/").pop()}"` : "inline"
  });
  if (ext === "svg") headers.set("Content-Security-Policy", SVG_CSP);

  const range = request.headers.get("Range");
  if (range && typeof env.PLATFORM_MEDIA.head === "function") {
    const head = await env.PLATFORM_MEDIA.head(key);
    if (!head) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
    const parsed = parseByteRange(range, head.size);
    if (parsed === "unsatisfiable") { headers.set("Content-Range", `bytes */${head.size}`); return new Response(null, { status: 416, headers }); }
    if (parsed) {
      const length = parsed.end - parsed.start + 1;
      const part = request.method === "HEAD" ? null : await env.PLATFORM_MEDIA.get(key, { range: { offset: parsed.start, length } });
      if (request.method !== "HEAD" && !part) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
      headers.set("Content-Range", `bytes ${parsed.start}-${parsed.end}/${head.size}`);
      headers.set("Content-Length", String(length));
      if (head.httpEtag) headers.set("ETag", head.httpEtag);
      return new Response(part ? part.body : null, { status: 206, headers });
    }
  }

  const object = await env.PLATFORM_MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  const inm = request.headers.get("If-None-Match");
  if (inm && object.httpEtag && inm === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}
