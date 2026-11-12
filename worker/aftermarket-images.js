// =====================================================
// AFTERMARKET — IMAGES FOR DOMAINS AND BUSINESS LISTINGS
//
// A domain has one cover image; a business listing has up to ten (logo, screenshots, photos). Files go into the platform media library
// (platform-media.js: R2 binding PLATFORM_MEDIA), which already does the hard part: the type is decided from the file's BYTES, never the
// name or the browser's word; the extension has to agree; objects are served nosniff, immutable, from /brand-media/<key>.
// On top of that, this module only accepts what a marketplace needs:
//   - PNG, JPEG or WebP (no GIF, no SVG, no icons, no video, no documents);
//   - 5 MB at most, between 100 and 10000 pixels on each side;
//   - a limit on how many images an item can hold.
// A listing's image rows say which file belongs where; a file shared by two rows (identical upload) is deleted only with its last row.
// Fails closed (503 media_storage_not_configured) when PLATFORM_MEDIA is not bound.
// =====================================================

import * as media from "./platform-media.js";
import { inspectFile, extensionOf } from "./image-inspect.js";
import * as repo from "./repositories/public-site.js";

export const FOLDER = "market";
export const MAX_IMAGES = { domain: 1, listing: 10 };
export const MAX_BYTES = 5 * 1024 * 1024;
const MIMES = new Set(["image/png", "image/jpeg", "image/webp"]);
const EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp"]);
const MIN_SIDE = 100;
const MAX_SIDE = 10000;

const cleanCaption = (v) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 120);

/** What a page needs for one image. */
export function toPublic(row, fallbackAlt = "") {
  return {
    id: row.id, url: media.publicPathOf(row.r2_key), alt: row.caption || row.alt_text || fallbackAlt, width: row.width ?? null, height: row.height ?? null, hidden: row.status === "hidden"
  };
}

/** Add an uploaded file to a domain or listing. Returns { ok, image } or { ok:false, status, error }. */
export async function attach(env, { kind, subjectId, organizationId, file, caption, altFallback = "", actorId = null }) {
  if (!media.storageConfigured(env)) return { ok: false, status: 503, error: "media_storage_not_configured" };
  if (!file || typeof file.arrayBuffer !== "function") return { ok: false, status: 400, error: "no_file" };
  if (!(file.size > 0)) return { ok: false, status: 422, error: "empty_file" };
  if (file.size > MAX_BYTES) return { ok: false, status: 413, error: "file_too_large" };
  if (!EXTENSIONS.has(extensionOf(file.name || ""))) return { ok: false, status: 415, error: "unsupported_file_type" };

  const limit = MAX_IMAGES[kind];
  const have = await repo.countImages(env, kind, subjectId);
  if (limit > 1 && have >= limit) return { ok: false, status: 409, error: "too_many_images" };

  const seen = inspectFile(new Uint8Array(await file.arrayBuffer()), file.name || "");
  if (!seen.ok || !MIMES.has(seen.mime)) return { ok: false, status: 422, error: "not_an_image" };
  if (!(seen.width >= MIN_SIDE && seen.height >= MIN_SIDE) || seen.width > MAX_SIDE || seen.height > MAX_SIDE) return { ok: false, status: 422, error: "image_dimensions" };

  const stored = await media.uploadMedia(env, { file, folder: FOLDER, altText: cleanCaption(caption) || altFallback, actorId });
  if (!stored.ok) return { ok: false, status: stored.status || 400, error: stored.error };

  // One cover image per domain: the new file replaces the old one.
  if (limit === 1) for (const old of await repo.listImages(env, kind, subjectId)) await remove(env, old);

  const id = await repo.insertImage(env, { kind, subjectId, mediaId: stored.media.id, caption: cleanCaption(caption), organizationId });
  return { ok: true, id, image: toPublic(await repo.getImage(env, kind, subjectId, id), altFallback) };
}

/** Delete one image row, and its file when nothing else uses it. */
export async function remove(env, imageRow) {
  await repo.deleteImageRow(env, imageRow.id);
  if ((await repo.countMediaRefs(env, imageRow.media_id)) === 0) {
    const res = await media.deleteMedia(env, imageRow.media_id).catch(() => null);
    if (res && !res.ok && res.error !== "media_not_found") console.error(JSON.stringify({ msg: "aftermarket_image_file_not_deleted", media: imageRow.media_id, error: res.error }));
  }
}

/** Remove every image of a domain or listing (used when it is deleted). */
export async function purge(env, kind, subjectId) {
  for (const row of await repo.listImages(env, kind, subjectId)) await remove(env, row);
}

/** Remove every image an organization uploaded (used when the organization is erased). */
export async function purgeOrganization(env, organizationId) {
  for (const row of await repo.listImagesForOrg(env, organizationId)) await remove(env, row);
}

/** Staff side: the item an image would belong to (a domain row or a listing row), or null. */
export async function subjectForStaff(env, kind, id) {
  if (kind === "domain") { const r = await repo.getAftermarketDomainById(env, id); return r ? { row: r, label: r.domain } : null; }
  if (kind === "listing") { const r = await repo.getListingById(env, id); return r ? { row: r, label: r.title } : null; }
  return null;
}
