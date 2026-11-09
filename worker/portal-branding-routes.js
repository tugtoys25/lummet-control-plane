// Staff routes for portal branding and the control plane's media library. Handled in its own module (like platform domains), called from
// worker/index.js INSIDE the /api/platform/saas/ block, so the super-admin gate has already run. Returns a Response, or null when the
// path is not ours.
//
//   GET    /api/platform/saas/branding             every branding field with its value, plus whether file storage is set up
//   PUT    /api/platform/saas/branding             { values: {key: value}, reason }   empty value clears; all-or-nothing
//   GET    /api/platform/saas/media                ?folder=&q=&kind=image|video|file&accept=image/png,image/svg+xml&page=
//   POST   /api/platform/saas/media                multipart: file (one or up to 10), folder?, alt_text?. One file: {media}. Several: {results:[...]}
//   POST   /api/platform/saas/media/from-url      { url, filename?, folder?, altText?, width?, height? }  keeps the image at its own https address
//   PATCH  /api/platform/saas/media/:id            { altText?, folder? }
//   DELETE /api/platform/saas/media/:id            refused (409 media_in_use) while a branding value points at the file
//
// The public side (/brand-media/*, /favicon.ico, /site.webmanifest) is portal-branding.js handlePublicBrandingRoute.
// Every write goes through logAudit.

import * as branding from "./portal-branding.js";
import * as media from "./platform-media.js";

const ID = /^\/api\/platform\/saas\/media\/([A-Za-z0-9_-]{1,64})$/;
// Anything bigger than the largest allowed upload (a video) plus its multipart wrapping is refused before it is read.
const MAX_BODY = media.MAX_REQUEST_BYTES;

export async function handlePortalBrandingRoute(ctx) {
  const { env, request, url, method, path, admin, requestId, ipHash, json, logAudit } = ctx;
  const isBranding = path === "/api/platform/saas/branding";
  const isMediaList = path === "/api/platform/saas/media";
  const isFromUrl = path === "/api/platform/saas/media/from-url";
  const idMatch = isFromUrl ? null : ID.exec(path);
  if (!isBranding && !isMediaList && !isFromUrl && !idMatch) return null;

  const actorId = `staff:${admin.id}`;
  const audit = (resource, resourceId, action, result, reason = "") => logAudit(env, {
    adminId: admin.id, endpoint: path, method, resource, resourceId, action,
    reason: String(reason || "").trim().slice(0, 1000), success: !!result.ok, statusCode: result.ok ? 200 : result.status || 400,
    errorMessage: result.ok ? null : result.error, requestId, ipHash
  });
  const fail = (r) => json({ success: false, error: r.error, detail: r.detail || null, errors: r.errors || null, usedBy: r.usedBy || null }, r.status || 400);

  if (isBranding) {
    if (method === "GET") {
      return json({ success: true, data: await branding.listFields(env), groups: branding.GROUPS, storageConfigured: media.storageConfigured(env) });
    }
    if (method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const result = await branding.saveBranding(env, { values: body.values, actorId, reason: body.reason });
      // The audit row says which fields changed and from/to what: these are addresses and colours, never secrets.
      const summary = result.ok ? `${body.reason} | changed: ${result.changed.join(", ") || "nothing"}` : body.reason;
      await audit("portal_branding", "branding", result.ok && result.unchanged ? "save_unchanged" : "save", result, summary);
      return result.ok ? json({ success: true, unchanged: !!result.unchanged, changed: result.changed, data: result.fields }) : fail(result);
    }
    return null;
  }

  if (isMediaList) {
    if (method === "GET") {
      const kind = media.KIND_FILTERS[url.searchParams.get("kind") || ""] || null;
      const accept = kind || (url.searchParams.get("accept") || "").split(",").map((m) => m.trim()).filter(Boolean);
      const data = await media.listMedia(env, { folder: url.searchParams.get("folder") || "", search: url.searchParams.get("q") || "", accept: accept.length ? accept : null, page: url.searchParams.get("page") || 1 });
      return json({ success: true, ...data, storageConfigured: media.storageConfigured(env) });
    }
    if (method === "POST") {
      if (!media.storageConfigured(env)) { const r = { ok: false, status: 503, error: "media_storage_not_configured" }; await audit("platform_media", null, "upload", r); return fail(r); }
      const declared = Number(request.headers.get("Content-Length"));
      if (Number.isFinite(declared) && declared > MAX_BODY) { const r = { ok: false, status: 413, error: "file_too_large" }; await audit("platform_media", null, "upload", r); return fail(r); }
      let form;
      try { form = await request.formData(); } catch (_) { form = null; }
      const files = form ? form.getAll("file").filter((f) => f && typeof f !== "string") : [];
      if (!files.length) { const r = { ok: false, status: 400, error: "no_file" }; await audit("platform_media", null, "upload", r); return fail(r); }
      if (files.length > media.MAX_FILES_PER_REQUEST) { const r = { ok: false, status: 413, error: "too_many_files", detail: `${media.MAX_FILES_PER_REQUEST} at most per request` }; await audit("platform_media", null, "upload", r); return fail(r); }
      const folder = form.get("folder") || undefined;
      const altText = form.get("alt_text") || "";
      const results = [];
      for (const file of files) {
        const result = await media.uploadMedia(env, { file, folder, altText, actorId });
        await audit("platform_media", result.ok ? result.media.id : null, result.ok && result.duplicate ? "upload_duplicate" : "upload", result, result.ok ? result.media.filename : file.name);
        results.push({ name: file.name, ...result });
      }
      if (files.length === 1) { const result = results[0]; return result.ok ? json({ success: true, duplicate: !!result.duplicate, media: result.media }, result.duplicate ? 200 : 201) : fail(result); }
      const uploaded = results.filter((r) => r.ok).length;
      return json({ success: uploaded > 0, uploaded, failed: results.length - uploaded, results: results.map((r) => (r.ok ? { name: r.name, ok: true, duplicate: !!r.duplicate, media: r.media } : { name: r.name, ok: false, error: r.error, detail: r.detail || null })) });
    }
    return null;
  }

  if (isFromUrl) {
    if (method !== "POST") return null;
    const body = await request.json().catch(() => ({}));
    const result = await media.addFromUrl(env, { url: body.url, filename: body.filename, folder: body.folder, altText: body.altText ?? body.alt_text, width: body.width, height: body.height, actorId });
    await audit("platform_media", result.ok ? result.media.id : null, result.ok && result.duplicate ? "add_link_duplicate" : "add_link", result, result.ok ? result.media.url : "");
    return result.ok ? json({ success: true, duplicate: !!result.duplicate, media: result.media }, result.duplicate ? 200 : 201) : fail(result);
  }

  const id = idMatch[1];
  if (method === "PATCH") {
    const body = await request.json().catch(() => ({}));
    const result = await media.updateMedia(env, id, { altText: body.altText, folder: body.folder });
    await audit("platform_media", id, "update", result);
    return result.ok ? json({ success: true, media: result.media }) : fail(result);
  }
  if (method === "DELETE") {
    const result = await media.deleteMedia(env, id);
    await audit("platform_media", id, "delete", result);
    return result.ok ? json({ success: true, id: result.id }) : fail(result);
  }
  return null;
}
