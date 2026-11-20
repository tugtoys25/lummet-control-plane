// =====================================================
// PRIVATE FILES: photos, screenshots and documents shared on support tickets, and files staff attach to announcements.
//
// Bytes go to the existing PLATFORM_MEDIA R2 bucket under "private/<purpose>/<id>"; the public /brand-media route cannot serve those keys.
// Any extension may be sent EXCEPT ones that run or execute (see BLOCKED). Nothing is rendered by the browser from our origin except
// images whose bytes really are an image: every other file is served as a download with a neutral content type.
// =====================================================
import * as repo from "./repositories/private-files.js";

export const MAX_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_PENDING_PER_PERSON = 20;

// Files that run code on open (or can carry script in a browser) are refused whatever they are called.
export const BLOCKED = new Set(["exe", "msi", "bat", "cmd", "com", "scr", "pif", "dll", "sys", "vbs", "vbe", "js", "mjs", "cjs", "jse", "wsf", "wsh", "ps1", "psm1", "sh", "bash", "zsh", "jar", "apk", "ipa", "app", "dmg", "pkg", "deb", "rpm", "hta", "lnk", "reg", "cpl", "msc", "html", "htm", "xhtml", "shtml", "svg", "svgz", "xml", "xsl", "php", "phtml", "asp", "aspx", "jsp", "cgi", "pl", "py", "rb", "iso", "swf"]);
const IMAGE_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const OTHER_MIME = { txt: "text/plain", csv: "text/csv", md: "text/markdown", json: "application/json", pdf: "application/pdf", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", zip: "application/zip" };

export const extensionOf = (name) => { const m = /\.([A-Za-z0-9]{1,12})$/.exec(String(name || "")); return m ? m[1].toLowerCase() : ""; };
export function cleanFilename(name) {
  const base = String(name || "file").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f"<>:*?|]/g, "").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
  return (base || "file").slice(0, 120);
}
const startsWith = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);
/** True when the bytes really are the image the extension claims. */
export function looksLikeImage(bytes, ext) {
  if (ext === "png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (ext === "jpg" || ext === "jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (ext === "gif") return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
  if (ext === "webp") return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
  return false;
}
/** Content type a stored file is served with: the image type for real images, otherwise a known document type or a plain download. */
export const serveMime = (stored) => (Object.values(IMAGE_MIME).includes(stored) ? stored : "application/octet-stream");
export const isImageMime = (m) => Object.values(IMAGE_MIME).includes(m);
export const storageConfigured = (env) => Boolean(env && env.PLATFORM_MEDIA);

/** Stores one uploaded file. `who` = {kind:'customer'|'staff', id, organizationId?}. Returns {ok, file} or {ok:false,status,error,detail?}. */
export async function uploadFile(env, { file, purpose, who }) {
  if (!storageConfigured(env)) return { ok: false, status: 503, error: "file_storage_not_configured" };
  if (!["support", "announcement"].includes(purpose)) return { ok: false, status: 422, error: "invalid_purpose" };
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, status: 400, error: "no_file" };
  if (!(file.size > 0)) return { ok: false, status: 422, error: "empty_file" };
  if (file.size > MAX_BYTES) return { ok: false, status: 413, error: "file_too_large", detail: `${MAX_BYTES / 1048576} MB at most` };
  const filename = cleanFilename(file.name);
  const ext = extensionOf(filename);
  if (BLOCKED.has(ext)) return { ok: false, status: 415, error: "file_type_not_allowed", detail: `.${ext} files can run code, so they cannot be shared. Put it in a .zip if you really need to send it.` };
  if ((await repo.countPendingFor(env, who.kind, who.id)) >= MAX_PENDING_PER_PERSON) return { ok: false, status: 429, error: "too_many_unsent_files" };
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (IMAGE_MIME[ext] && !looksLikeImage(bytes, ext)) return { ok: false, status: 422, error: "image_not_valid", detail: `this file is not really a .${ext} image` };
  const mimeType = IMAGE_MIME[ext] || OTHER_MIME[ext] || "application/octet-stream";
  const id = crypto.randomUUID();
  const r2Key = `private/${purpose}/${id}`;
  await env.PLATFORM_MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" } });
  try {
    await repo.insert(env, { id, organizationId: who.organizationId || null, purpose, filename, mimeType, sizeBytes: bytes.length, r2Key, uploadedByKind: who.kind, uploadedBy: who.id });
  } catch (e) {
    await env.PLATFORM_MEDIA.delete(r2Key).catch(() => {});
    return { ok: false, status: 500, error: "upload_failed" };
  }
  return { ok: true, file: { id, filename, mimeType, sizeBytes: bytes.length, isImage: isImageMime(mimeType) } };
}

/** The response that delivers a stored file: images are shown, everything else downloads. Never executes anything from our origin. */
export async function fileResponse(env, row) {
  if (!row || !env.PLATFORM_MEDIA) return new Response("Not found", { status: 404 });
  const obj = await env.PLATFORM_MEDIA.get(row.r2_key);
  if (!obj) return new Response("Not found", { status: 404 });
  const image = isImageMime(row.mime_type);
  const safeName = row.filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "");
  return new Response(obj.body, { status: 200, headers: {
    "Content-Type": serveMime(row.mime_type),
    "Content-Disposition": `${image ? "inline" : "attachment"}; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
    "Content-Length": String(row.size_bytes),
    "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox", "Cache-Control": "private, max-age=300"
  } });
}

// ---- signed links (announcement files, so an email can show a photo or offer a document) ----
async function hmac(env, data) {
  const secret = env.CREDENTIAL_KEK || env.SESSION_SECRET;
  if (!secret) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`lummet-file-link:${secret}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function signedPath(env, fileId) { const s = await hmac(env, fileId); return s ? `/f/${fileId}/${s}` : null; }
export async function verifySigned(env, fileId, sig) {
  const want = await hmac(env, fileId);
  if (!want || typeof sig !== "string" || sig.length !== want.length) return false;
  let d = 0; for (let i = 0; i < want.length; i++) d |= want.charCodeAt(i) ^ sig.charCodeAt(i);
  return d === 0;
}
/** Public file link: only announcement files that were really sent are reachable. */
export async function publicFile(env, fileId, sig) {
  if (!(await verifySigned(env, fileId, sig))) return null;
  const row = await repo.get(env, fileId);
  return row && row.purpose === "announcement" && row.announcement_id ? row : null;
}

export const pendingAnnouncementFiles = (env, ids, staffId) => repo.pendingAnnouncement(env, [...new Set(ids)].slice(0, 10), staffId);
export const getFile = (env, id) => repo.get(env, id);
export const pendingSupportFiles = (env, ids, organizationId, kind, uploadedBy) => repo.pendingSupport(env, [...new Set(ids)].slice(0, MAX_FILES_PER_MESSAGE), organizationId, kind, uploadedBy);
export const attachToMessage = (env, ids, messageId) => repo.attachToMessage(env, ids, messageId);
export const attachmentsByMessage = async (env, messageIds) => {
  const map = {};
  for (const f of await repo.forMessages(env, messageIds)) (map[f.message_id] ||= []).push({ id: f.id, filename: f.filename, mimeType: f.mime_type, sizeBytes: f.size_bytes, isImage: isImageMime(f.mime_type) });
  return map;
};

/** Removes abandoned uploads (never attached to anything) after a day. Called from the maintenance tick. */
export async function purgeOrphans(env, { now = Date.now(), limit = 50 } = {}) {
  const rows = await repo.orphans(env, new Date(now - 24 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19), limit);
  for (const r of rows) { try { if (env.PLATFORM_MEDIA) await env.PLATFORM_MEDIA.delete(r.r2_key); await repo.remove(env, r.id); } catch { /* retried next tick */ } }
  return rows.length;
}
/** Erasure: delete every private file of an organization from R2 then the rows. Returns failures. */
export async function purgeOrganization(env, organizationId) {
  const rows = await repo.forOrganization(env, organizationId);
  if (rows.length && !env.PLATFORM_MEDIA) throw new Error("file_storage_not_configured");
  for (const r of rows) { await env.PLATFORM_MEDIA.delete(r.r2_key); }
}
