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
import { inspectImage, extensionOf, extensionMatches, MIME_TO_EXT, IMAGE_TYPES } from "./image-inspect.js";

export const PUBLIC_PREFIX = "/brand-media/";
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_FOLDER = "branding";
export const PAGE_SIZE = 24;
export const ALLOWED_EXTENSIONS = Object.values(IMAGE_TYPES).flatMap((t) => t.extensions);
export const ALLOWED_MIMES = Object.values(IMAGE_TYPES).map((t) => t.mime);

const FOLDER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,31}\/[0-9]{10,16}-[0-9a-f]{16}\.(?:png|jpg|gif|webp|ico|svg)$/;

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
    url: publicPathOf(row.r2_key),
    key: row.r2_key,
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
  if (file.size > MAX_IMAGE_BYTES) return { ok: false, status: 413, error: "file_too_large", detail: `${Math.round(MAX_IMAGE_BYTES / 1048576)} MB at most` };

  const filename = cleanFilename(file.name);
  const ext = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext)) return { ok: false, status: 415, error: "unsupported_file_type", detail: `allowed: ${ALLOWED_EXTENSIONS.join(", ")}` };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const seen = inspectImage(bytes);
  if (!seen.ok) return { ok: false, status: 422, error: seen.error, detail: seen.detail };
  if (!extensionMatches(seen.type, filename)) return { ok: false, status: 422, error: "extension_mismatch", detail: `the file is a ${seen.type.toUpperCase()}, not a .${ext}` };

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

export async function getMedia(env, id) {
  const row = await repo.getById(env, String(id || ""));
  return row ? toPublic(row) : null;
}

export async function getMediaByUrl(env, value, origin = "") {
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
  return rows.filter((r) => ownKeyFromUrl(r.value) === media.key).map((r) => r.key);
}

/** Deletes the file and its row. Refused while a branding value still points at it, so the portal never ends up with a broken icon. */
export async function deleteMedia(env, id) {
  if (!storageConfigured(env)) return { ok: false, status: 503, error: "media_storage_not_configured" };
  const row = await repo.getById(env, String(id || ""));
  if (!row) return { ok: false, status: 404, error: "media_not_found" };
  const media = toPublic(row);
  const inUse = await usageOf(env, media);
  if (inUse.length) return { ok: false, status: 409, error: "media_in_use", detail: inUse.join(", "), usedBy: inUse };
  await repo.remove(env, row.id);
  await env.PLATFORM_MEDIA.delete(row.r2_key).catch((error) => console.error(JSON.stringify({ msg: "platform_media_object_delete_failed", key: row.r2_key, error: String(error?.message || error).slice(0, 200) })));
  return { ok: true, id: row.id };
}

const EXT_MIME = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", svg: "image/svg+xml" };
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/** GET/HEAD /brand-media/<key>. Public, no session. The content type comes from the key's extension, which upload fixed from the bytes. */
export async function serveMedia(request, env, rawKey) {
  const key = String(rawKey || "");
  if (!KEY_RE.test(key)) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  if (!storageConfigured(env)) return new Response("Media storage is not configured", { status: 503, headers: { "Cache-Control": "no-store" } });
  const object = await env.PLATFORM_MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404, headers: { "Cache-Control": "public, max-age=60" } });
  const ext = key.slice(key.lastIndexOf(".") + 1);
  const type = EXT_MIME[ext];
  const headers = new Headers({
    "Content-Type": type,
    "Cache-Control": "public, max-age=31536000, immutable",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Content-Disposition": "inline"
  });
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  if (ext === "svg") headers.set("Content-Security-Policy", SVG_CSP);
  const inm = request.headers.get("If-None-Match");
  if (inm && object.httpEtag && inm === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}
