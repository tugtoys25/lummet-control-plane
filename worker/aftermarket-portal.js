// =====================================================
// AFTERMARKET — SELLER PORTAL (customer accounts)
//
// The "Aftermarket" tab of the customer portal (/app/aftermarket). A seller signs in with their normal Lummet account and, for the
// active organization:
//   * lists a domain       (organization-owned claim; prove control by TXT record or by nameservers, aftermarket-zones.js)
//   * edits its listing    headline, description, asking price; unlist / list again once verified
//   * sees enquiry activity  when, the offer text, where it came from. Buyer contact details stay with Lummet, which handles buyers.
//   * manages DNS          for a nameserver-verified domain (the zone is ours; the for-sale page records are read-only)
//
// Everything is scoped to the organization in the repository calls; a domain of another organization answers 404.
// Reading is open to any member; every change needs the admin role (same rule as the Domains tab).
// This module has no SQL (worker/repositories/public-site.js) and no Cloudflare calls (aftermarket-zones.js).
// =====================================================

import * as repo from "./repositories/public-site.js";
import * as zones from "./aftermarket-zones.js";
import * as aftermarketNotify from "./aftermarket-notify.js";
import * as images from "./aftermarket-images.js";
import { cleanExternalUrl } from "./platform-media.js";
import { loadSite } from "./public-site/context.js";
import { normalizeDomain, isReservedDomain, newVerifyToken } from "./public-site/aftermarket-domains.js";
import { escapeHtml } from "./views/customer-layout.js";
import { nonceToken } from "./csp.js";

const COOLDOWN_MS = 15 * 1000;
const MAX_LISTINGS_PER_ORG = 25;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);

export const STATUS_LABEL = { pending: "Waiting for verification", listed: "Listed", unlisted: "Not listed", sold: "Sold", draft: "Draft" };

// ----------------------------------------------------------------- service

async function baseUrlOf(env, request) {
  try { return (await loadSite(env, new URL(request.url))).site.base_url; } catch (_) { return ""; }
}

/** Create (or re-create) the organization's claim on a domain. */
export async function createClaim(env, { organizationId, userId, email, domain: rawDomain, price, description, baseUrl }) {
  const domain = normalizeDomain(rawDomain);
  if (!domain) return { ok: false, status: 422, error: "invalid_domain" };
  if (isReservedDomain(env, domain, baseUrl)) return { ok: false, status: 409, error: "domain_unavailable" };
  const existing = await repo.getAftermarketDomain(env, domain);
  if (existing) {
    const mine = existing.organization_id === organizationId;
    const open = existing.source === "seller" && ["pending", "unlisted"].includes(existing.status) && (mine || !existing.organization_id);
    if (!open) return { ok: false, status: 409, error: mine ? "already_yours" : "domain_unavailable" };
  }
  const saved = await repo.upsertAftermarketClaim(env, {
    domain, email, price: clean(price, 60), description: clean(description, 1500), token: newVerifyToken(), organizationId, userId
  });
  return saved ? { ok: true, domain } : { ok: false, status: 409, error: "domain_unavailable" };
}

/** Delete a domain: its Cloudflare zone (if any) is released first so nothing is left running, then its images, then the row. */
export async function removeDomain(env, row) {
  if (row.cf_zone_id) {
    const released = await zones.releaseZone(env, row);
    if (!released.ok) return { ok: false, status: 502, error: "provider_error" };
  }
  await images.purge(env, "domain", row.id);
  await repo.deleteAftermarketDomainRow(env, row.id);
  return { ok: true };
}

export async function updateListing(env, row, input) {
  const patch = {};
  if ("headline" in input) patch.headline = clean(input.headline, 120);
  if ("description" in input) patch.description = clean(input.description, 1500);
  if ("asking_price" in input) patch.asking_price = clean(input.asking_price, 60);
  await repo.updateAftermarketListing(env, row.id, patch);
  return { ok: true };
}

export async function setStatus(env, row, status) {
  if (status === "unlisted" && ["listed", "pending"].includes(row.status)) {
    await repo.updateAftermarketListing(env, row.id, { status: "unlisted", notified_status: "unlisted" });   // the maintenance tick releases a nameserver zone
    return { ok: true };
  }
  if (status === "listed" && row.status === "unlisted" && row.verified_at) {
    await repo.updateAftermarketListing(env, row.id, { status: "listed", notified_status: "listed" });
    return { ok: true };
  }
  return { ok: false, status: 409, error: "status_not_allowed" };
}

export async function verify(env, row, method) {
  if (row.status !== "pending") return { ok: false, status: 409, error: "not_pending" };
  const last = row.last_check_at ? Date.parse(`${String(row.last_check_at).replace(" ", "T")}Z`) : 0;
  if (last && Date.now() - last < COOLDOWN_MS) return { ok: false, status: 429, error: "rate_limited" };
  await repo.touchAftermarketCheck(env, row.id);
  if (method === "txt") {
    if (!(await zones.checkTxt(row))) return { ok: true, state: "waiting" };
    await repo.markAftermarketVerified(env, row.id, "txt");
    return { ok: true, state: "listed" };
  }
  if (method === "ns_start") {
    const started = await zones.startZone(env, row);
    return started.ok ? { ok: true, state: "started" } : { ok: false, status: started.error === "ns_busy" ? 503 : 409, error: started.error };
  }
  if (method === "ns") {
    if (!row.cf_zone_id) return { ok: false, status: 409, error: "ns_not_started" };
    return { ok: true, state: (await zones.checkZone(env, row, { manual: true })).state };
  }
  return { ok: false, status: 422, error: "unknown_method" };
}


// ----------------------------------------------------------------- business listings

export const LISTING_STATUS_LABEL = { pending: "Waiting for approval", listed: "Listed", unlisted: "Not listed", sold: "Sold", draft: "Draft" };

function slugify(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "") || "listing";
}

/** Validate and clean the fields a seller can set. Returns { ok, fields } or { ok:false, status, error }. */
async function cleanListingFields(env, input, { partial = false } = {}) {
  const f = {};
  const take = (key, max) => { if (!partial || key in input) f[key] = clean(input[key], max); };
  take("title", 120); take("summary", 300); take("description", 3000); take("location", 120);
  take("asking_price", 60); take("revenue", 60); take("profit", 60);
  if (!partial || "website_url" in input) {
    const raw = clean(input.website_url, 500);
    const site = raw ? cleanExternalUrl(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`) : "";
    if (raw && !site) return { ok: false, status: 422, error: "invalid_website" };
    f.website_url = site;
  }
  if (!partial || "title" in input) { if (f.title.length < 3) return { ok: false, status: 422, error: "invalid_title" }; }
  if (!partial || "category_slug" in input) {
    const cat = await repo.getListingCategory(env, clean(input.category_slug, 80).toLowerCase());
    if (!cat) return { ok: false, status: 422, error: "invalid_category" };
    f.category_slug = cat.slug;
  }
  return { ok: true, fields: f };
}

export async function createListing(env, { organizationId, userId, email, input }) {
  const cleaned = await cleanListingFields(env, input);
  if (!cleaned.ok) return cleaned;
  const open = (await repo.listListingsForOrg(env, organizationId)).filter((l) => l.status !== "sold").length;
  if (open >= MAX_LISTINGS_PER_ORG) return { ok: false, status: 409, error: "too_many_listings" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = `${slugify(cleaned.fields.title)}-${[...crypto.getRandomValues(new Uint8Array(2))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    try {
      const id = await repo.insertListing(env, { ...cleaned.fields, slug, status: "pending", organization_id: organizationId, owner_user_id: userId, owner_email: email });
      await aftermarketNotify.listingForReview(env, null, { ...cleaned.fields, id, slug, owner_email: email }, { edited: false });
      return { ok: true, id, slug };
    } catch (err) {
      if (!/unique|constraint/i.test(String(err?.message || ""))) throw err;
    }
  }
  return { ok: false, status: 503, error: "try_again" };
}

/** A change to what buyers read sends a listed listing back to review, so approved text cannot be swapped afterwards. */
export async function editListing(env, row, input) {
  if (row.status === "sold") return { ok: false, status: 409, error: "status_not_allowed" };
  const cleaned = await cleanListingFields(env, input, { partial: true });
  if (!cleaned.ok) return cleaned;
  const patch = { ...cleaned.fields };
  const changed = Object.keys(patch).some((k) => String(patch[k] ?? "") !== String(row[k] ?? ""));
  if (changed && row.status === "listed") { patch.status = "pending"; patch.notified_status = "pending"; }
  await repo.updateListing(env, row.id, patch);
  if (patch.status === "pending") await aftermarketNotify.listingForReview(env, null, { ...row, ...patch }, { edited: true });
  return { ok: true, status: patch.status || row.status };
}

/** What buyers see changed (an image was added or removed): a listed business goes back to review, like a text edit. */
async function listingContentChanged(env, row) {
  if (row.status !== "listed") return;
  await repo.updateListing(env, row.id, { status: "pending", notified_status: "pending" });
  await aftermarketNotify.listingForReview(env, null, { ...row, status: "pending" }, { edited: true });
}

export async function deleteListing(env, row) {
  await images.purge(env, "listing", row.id);
  await repo.deleteListingRow(env, row.id);
  return { ok: true };
}

export async function setListingStatus(env, row, status) {
  const allowed = {
    unlisted: ["listed", "pending"],       // take it off the market
    pending: ["unlisted"],                 // put it back: an admin approves it again
    sold: ["listed", "pending", "unlisted"]
  };
  if (!(allowed[status] || []).includes(row.status)) return { ok: false, status: 409, error: "status_not_allowed" };
  await repo.updateListing(env, row.id, { status, notified_status: status });
  if (status === "pending") await aftermarketNotify.listingForReview(env, null, row, { edited: false });
  return { ok: true, status };
}

async function handleListingsApi({ env, request, method, rest, organizationId, customer, guard, audit }) {
  const read = method === "GET";
  const m = rest.match(/^\/aftermarket\/listings(?:\/(\d+)(?:\/([a-z]+)(?:\/(\d+)(?:\/([a-z]+))?)?)?)?$/);
  if (!m) return null;
  const denied = await guard(read ? "viewer" : "admin");
  if (denied) return denied;
  const [, idText, action, subId, subAction] = m;
  const isUpload = action === "images" && method === "POST" && !subId;
  const body = read || method === "DELETE" || isUpload ? {} : await request.json().catch(() => ({}));
  const done = async (name, result) => {
    if (!read && audit) await audit(name, result, idText || result.id || null);
    if (!result.ok) return json({ success: false, error: result.error }, result.status || 400);
    const { ok, ...rest2 } = result;
    return json({ success: true, ...rest2 });
  };
  if (!idText) {
    if (read) return json({ success: true, data: (await repo.listListingsForOrg(env, organizationId)).map(publicListing) });
    if (method === "POST") return done("listing_create", await createListing(env, { organizationId, userId: customer.id, email: customer.email, input: body }));
    return json({ success: false, error: "method_not_allowed" }, 405);
  }
  const row = await repo.getListingForOrg(env, organizationId, idText);
  if (!row) return json({ success: false, error: "not_found" }, 404);
  if (!action && read) return json({ success: true, listing: publicListing(row), enquiries: await repo.listEnquiriesForListing(env, row.slug), images: (await repo.listImages(env, "listing", row.id)).map((i) => images.toPublic(i, row.title)) });
  if (!action && method === "DELETE") return done("listing_delete", await deleteListing(env, row));
  if (action === "images") {
    if (row.status === "sold") return json({ success: false, error: "status_not_allowed" }, 409);
    const result = await handleImages({ env, request, kind: "listing", subject: row, organizationId, customer, method, subId, subAction, isUpload, altFallback: row.title });
    if (result.ok && method !== "GET") await listingContentChanged(env, row);
    return done(subId ? "listing_image" : "listing_image_add", result);
  }
  if (!action && method === "POST") return done("listing_update", await editListing(env, row, body));
  if (action === "status" && method === "POST") return done("listing_status", await setListingStatus(env, row, String(body.status || "")));
  return json({ success: false, error: "not_found" }, 404);
}

/** Upload (multipart "file", optional "caption"), delete, or make-cover for a domain or listing the caller already owns. */
async function handleImages({ env, request, kind, subject, organizationId, customer, method, subId, subAction, isUpload, altFallback }) {
  if (isUpload) {
    if (Number(request.headers.get("content-length") || 0) > images.MAX_BYTES + 64 * 1024) return { ok: false, status: 413, error: "file_too_large" };
    let form;
    try { form = await request.formData(); } catch (_) { return { ok: false, status: 400, error: "no_file" }; }
    return images.attach(env, { kind, subjectId: subject.id, organizationId, file: form.get("file"), caption: form.get("caption"), altFallback, actorId: customer.id });
  }
  if (!subId) return { ok: false, status: 404, error: "not_found" };
  const image = await repo.getImage(env, kind, subject.id, subId);
  if (!image) return { ok: false, status: 404, error: "not_found" };
  if (method === "DELETE") { await images.remove(env, image); return { ok: true }; }
  if (method === "POST" && subAction === "cover") { await repo.makeCover(env, kind, subject.id, image.id); return { ok: true }; }
  return { ok: false, status: 404, error: "not_found" };
}

function publicListing(r) {
  return {
    id: r.id, slug: r.slug, title: r.title, category_slug: r.category_slug || "", summary: r.summary || "", description: r.description || "", location: r.location || "",
    website_url: r.website_url || "", asking_price: r.asking_price || "", revenue: r.revenue || "", profit: r.profit || "", status: r.status, enquiry_count: r.enquiry_count ?? undefined
  };
}

// ----------------------------------------------------------------- API (mounted under /api/organizations/:orgId/aftermarket)

/**
 * Returns a Response for /aftermarket/... routes, null for anything else.
 * GET    /aftermarket/domains                      list
 * POST   /aftermarket/domains                      { domain, askingPrice, description }
 * GET    /aftermarket/domains/:domain              detail + enquiries
 * POST   /aftermarket/domains/:domain/listing      { headline, description, asking_price }
 * POST   /aftermarket/domains/:domain/status       { status: "listed" | "unlisted" }
 * POST   /aftermarket/domains/:domain/verify       { method: "txt" | "ns_start" | "ns" }
 * GET    /aftermarket/domains/:domain/records      DNS records (nameserver-verified domains)
 * POST   /aftermarket/domains/:domain/records      { type, name, content, priority? }
 * DELETE /aftermarket/domains/:domain/records/:id
 */
export async function handleApi({ env, request, method, path, organizationId, customer, requireOrgRole, audit }) {
  const subPath = String(path || "").replace(/^\/api\/organizations\/[^/]+/, "");
  if (subPath === "/aftermarket/categories" && method === "GET") {
    const denied = await requireOrgRole(organizationId, "viewer");
    return denied || json({ success: true, data: (await repo.listListingCategories(env)).map((c) => ({ slug: c.slug, name: c.name })) });
  }
  if (subPath.startsWith("/aftermarket/listings")) {
    return handleListingsApi({ env, request, method, rest: subPath, organizationId, customer, guard: (min) => requireOrgRole(organizationId, min), audit });
  }
  const m = subPath.match(/^\/aftermarket\/domains(?:\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+)(?:\/([a-z]+))?)?)?)?$/);
  if (!m) return null;
  const [, rawDomain, action, subId, subAction] = m;
  const read = method === "GET";
  const guard = await requireOrgRole(organizationId, read ? "viewer" : "admin");
  if (guard) return guard;
  const isUpload = action === "images" && method === "POST" && !subId;
  const body = read || method === "DELETE" || isUpload ? {} : await request.json().catch(() => ({}));
  const done = async (name, result, extra = {}) => {
    if (!read && audit) await audit(name, result, rawDomain || body.domain || null);
    if (!result.ok) return json({ success: false, error: result.error }, result.status || 400);
    const { ok, ...rest } = result;
    return json({ success: true, ...rest, ...extra });
  };

  if (!rawDomain) {
    if (read) return json({ success: true, data: (await repo.listAftermarketForOrg(env, organizationId)).map(publicRow) });
    if (method === "POST") {
      return done("claim", await createClaim(env, {
        organizationId, userId: customer.id, email: customer.email, domain: body.domain, price: body.askingPrice, description: body.description, baseUrl: await baseUrlOf(env, request)
      }));
    }
    return json({ success: false, error: "method_not_allowed" }, 405);
  }

  const domain = normalizeDomain(rawDomain);
  const row = domain ? await repo.getAftermarketForOrg(env, organizationId, domain) : null;
  if (!row) return json({ success: false, error: "not_found" }, 404);

  if (!action && read) return json({ success: true, domain: publicRow(row), enquiries: await repo.listEnquiriesForDomain(env, domain), images: (await repo.listImages(env, "domain", row.id)).map((i) => images.toPublic(i, row.domain)) });
  if (!action && method === "DELETE") return done("domain_delete", await removeDomain(env, row));
  if (action === "images") {
    return done(subId ? "domain_image" : "domain_image_add", await handleImages({ env, request, kind: "domain", subject: row, organizationId, customer, method, subId, subAction, isUpload, altFallback: row.domain }));
  }
  if (action === "listing" && method === "POST") return done("listing_update", await updateListing(env, row, body));
  if (action === "status" && method === "POST") return done("status", await setStatus(env, row, String(body.status || "")));
  if (action === "verify" && method === "POST") return done("verify", await verify(env, row, String(body.method || "")));
  if (action === "records") {
    if (read) return done("records", await zones.listRecords(env, row));
    if (method === "POST") return done("record_add", await zones.addRecord(env, row, body));
    if (method === "DELETE" && subId) return done("record_remove", await zones.deleteRecord(env, row, subId));
  }
  return json({ success: false, error: "not_found" }, 404);
}

/** The columns a seller's browser may see: never the owner's email or the Cloudflare zone id. */
function publicRow(r) {
  return {
    domain: r.domain, status: r.status, headline: r.headline || "", description: r.description || "", asking_price: r.asking_price || "",
    verified_method: r.verified_method || null, verified_at: r.verified_at || null, hosted: Boolean(r.hosted),
    verify_token: r.status === "pending" ? r.verify_token : null, txt_name: `_lummet-verify.${r.domain}`,
    name_servers: zones.assignedNameServers(r), ns_seen: Boolean(r.ns_detected_at),
    dns: zones.canManageDns(r), enquiry_count: r.enquiry_count ?? undefined, last_enquiry_at: r.last_enquiry_at ?? undefined
  };
}

// ----------------------------------------------------------------- pages

const ERRORS = {
  invalid_domain: "That does not look like a valid domain. Enter it like example.com.",
  domain_unavailable: "That domain is already listed or reserved. Contact support if it is yours.",
  already_yours: "That domain is already on your list.",
  forbidden: "You need to be an administrator to do that.",
  rate_limited: "Please wait a few seconds before checking again.",
  not_pending: "This domain is not waiting for verification.",
  ns_off: "Nameserver verification is not available right now. Use the TXT record option.",
  ns_taken: "This domain is already connected to an account here, so nameservers cannot be set up for it. Use the TXT record option.",
  ns_busy: "Nameserver setup is busy right now. Try again later, or use the TXT record option.",
  ns_error: "We could not set up nameservers right now. Try again later, or use the TXT record option.",
  ns_not_started: "Press Get my nameservers first.",
  status_not_allowed: "That change is not allowed for this listing.",
  dns_not_available: "DNS can be managed once the domain is verified by nameservers.",
  hostname_managed_by_lummet: "This record serves your for-sale page and cannot be edited.",
  record_exists: "That record already exists.",
  record_outside_domain: "That name is outside your domain.",
  invalid_record_content: "The record value is not valid for that type.",
  invalid_record_priority: "Enter a priority between 0 and 65535.",
  cname_at_root_not_allowed: "A CNAME cannot be set on the main domain itself.",
  unsupported_record_type: "That record type is not supported here.",
  invalid_title: "Enter a title of at least 3 characters.",
  invalid_website: "Enter the website address like https://example.com.",
  media_storage_not_configured: "Image storage is not available right now. Please try again later.",
  no_file: "Choose an image to upload.",
  empty_file: "That file is empty.",
  file_too_large: "That image is larger than 5 MB.",
  unsupported_file_type: "Use a PNG, JPEG or WebP image.",
  not_an_image: "That file is not a valid PNG, JPEG or WebP image.",
  image_dimensions: "The image must be between 100 and 10000 pixels on each side.",
  too_many_images: "You have reached the maximum number of images for this listing.",
  invalid_category: "Choose a category.",
  too_many_listings: "You have reached the maximum number of open listings. Mark one as sold or remove it from sale first.",
  try_again: "Something went wrong. Please try again.",
  provider_error: "The DNS provider did not accept that just now. Please try again in a minute."
};

const esc = escapeHtml;

function badge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;
}

function listHtml(rows, canManage) {
  const body = rows.length
    ? `<table class="table"><thead><tr><th>Domain</th><th>Status</th><th>Price</th><th>Enquiries</th><th></th></tr></thead><tbody>${rows.map((r) => `
        <tr><td class="mono">${esc(r.domain)}</td><td>${badge(r.status)}</td><td>${esc(r.asking_price || "Make an offer")}</td>
        <td>${Number(r.enquiry_count) || 0}</td><td><a class="btn" href="/app/aftermarket/${encodeURIComponent(r.domain)}">Manage</a></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty"><p>You have not listed a domain yet.</p></div>`;
  const form = canManage
    ? `<div class="card"><h2>List a domain</h2>
        <form id="am-add"><label for="am-domain">Domain you own</label><input type="text" id="am-domain" placeholder="example.com" autocomplete="off" required>
        <label for="am-price">Asking price (USD)</label><input type="text" id="am-price" placeholder="2500, or Make an offer" maxlength="60">
        <label for="am-desc">About the domain (shown on its page)</label><textarea id="am-desc" rows="3" maxlength="1500"></textarea>
        <button class="btn" type="submit">Continue to verification</button></form><div id="am-result"></div></div>`
    : `<p class="muted">Only organization administrators can list domains.</p>`;
  return `<h1>Domains for sale</h1><p class="subtitle">List your domains for sale. Buyers contact Lummet, and we pass serious offers to you.</p>${body}${form}`;
}

function detailHtml(r, enquiries, canManage, imgs = []) {
  const pending = r.status === "pending";
  const verifyCard = pending ? `
    <div class="card"><h2>Verify ownership</h2>
      <h3>Option 1: TXT record</h3>
      <p class="muted">Add this record at your DNS provider. Your nameservers stay as they are; the domain is listed on Lummet.</p>
      <table class="table"><tr><th>Type</th><td class="mono">TXT</td></tr><tr><th>Name</th><td class="mono">${esc(`_lummet-verify.${r.domain}`)}</td></tr><tr><th>Value</th><td class="mono">${esc(r.verify_token || "")}</td></tr></table>
      ${canManage ? `<button class="btn" data-am-verify="txt">Verify TXT record</button>` : ""}
      <h3>Option 2: nameservers</h3>
      <p class="muted">Get two nameservers made for this domain and set them at your registrar. Once Cloudflare confirms them, the for-sale page also shows at the domain itself, and you can manage its DNS here. Existing DNS records are copied across.</p>
      ${r.cf_zone_id ? `<ul class="ns-list">${zones.assignedNameServers(r).map((n) => `<li class="mono">${esc(n)}</li>`).join("")}</ul>${r.ns_detected_at ? `<p class="muted">We can see the new nameservers. Cloudflare is confirming them (usually a few minutes).</p>` : ""}
        ${canManage ? `<button class="btn" data-am-verify="ns">Check nameservers</button>` : ""}`
        : canManage ? `<button class="btn" data-am-verify="ns_start">Get my nameservers</button>` : ""}
      <div id="am-verify-result"></div></div>` : "";
  const edit = canManage && ["pending", "listed", "unlisted"].includes(r.status) ? `
    <div class="card"><h2>Listing</h2><form id="am-edit">
      <label for="am-headline">Headline</label><input type="text" id="am-headline" value="${esc(r.headline || "")}" maxlength="120">
      <label for="am-price">Asking price (USD)</label><input type="text" id="am-price" value="${esc(r.asking_price || "")}" maxlength="60">
      <label for="am-desc">Description</label><textarea id="am-desc" rows="4" maxlength="1500">${esc(r.description || "")}</textarea>
      <button class="btn" type="submit">Save</button>
      ${r.status === "listed" ? `<button class="btn btn-danger" type="button" data-am-status="unlisted">Remove from sale</button>` : ""}
      ${r.status === "unlisted" && r.verified_at ? `<button class="btn" type="button" data-am-status="listed">List again</button>` : ""}
    </form><div id="am-edit-result"></div></div>` : "";
  const page = r.status === "listed" ? `<p><a href="/aftermarket/domains/${encodeURIComponent(r.domain)}" target="_blank" rel="noopener">View your public page</a>${r.hosted ? ` · <a href="https://${esc(r.domain)}/" target="_blank" rel="noopener">${esc(r.domain)}</a>` : ""}</p>` : "";
  const enquiryRows = enquiries.length
    ? `<table class="table"><thead><tr><th>Received (UTC)</th><th>Offer</th><th>From</th></tr></thead><tbody>${enquiries.map((e) => `<tr><td>${esc(e.created_at)}</td><td>${esc((e.summary || "").replace(new RegExp(`^${r.domain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - `), ""))}</td><td>${esc(e.source || "")}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty"><p>No enquiries yet.</p></div>`;
  const dns = r.verified_method === "ns" && r.status === "listed" ? `<div class="card"><h2>DNS</h2><p class="muted">Records for ${esc(r.domain)}. The records that serve your for-sale page are managed by Lummet.</p><div id="am-records">Loading…</div>
      ${canManage ? `<form id="am-record-add"><select id="am-rtype"><option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option></select>
        <input type="text" id="am-rname" placeholder="name (@ or mail)" required><input type="text" id="am-rcontent" placeholder="value" required><input type="number" id="am-rprio" placeholder="priority (MX)" min="0" max="65535"><button class="btn" type="submit">Add record</button></form><div id="am-record-result"></div>` : ""}</div>` : `<div class="card"><h2>DNS</h2><p class="muted">DNS can be managed here once this domain is verified by nameservers.</p></div>`;
  const remove = canManage ? `<div class="card"><h2>Delete domain</h2><p class="muted">Removes ${esc(r.domain)} from the marketplace for good${r.cf_zone_id ? ", releases its nameserver setup" : ""} and deletes its image. Past enquiries stay in Lummet's inbox.</p><button class="btn btn-danger" type="button" id="am-delete">Delete this domain</button></div>` : "";
  return `<p><a href="/app/aftermarket">&larr; Domains for sale</a></p><h1 class="mono">${esc(r.domain)}</h1><p>${badge(r.status)}</p>${page}${verifyCard}${edit}
    ${imagesHtml(imgs, { max: images.MAX_IMAGES.domain, canManage, multiple: false })}
    <div class="card"><h2>Enquiries</h2><p class="muted">Lummet handles buyer contact; you see when enquiries arrive.</p>${enquiryRows}</div>${dns}${remove}`;
}


function categoryOptions(categories, selected) {
  return categories.map((c) => `<option value="${esc(c.slug)}"${c.slug === selected ? " selected" : ""}>${esc(c.name)}</option>`).join("");
}

function listingFormFields(l, categories) {
  return `<label for="bz-title">Title</label><input type="text" id="bz-title" value="${esc(l.title || "")}" maxlength="120" required>
    <label for="bz-category">Category</label><select id="bz-category" required>${categoryOptions(categories, l.category_slug)}</select>
    <label for="bz-summary">Summary (one or two sentences, shown in lists)</label><textarea id="bz-summary" rows="2" maxlength="300">${esc(l.summary || "")}</textarea>
    <label for="bz-location">Location</label><input type="text" id="bz-location" value="${esc(l.location || "")}" maxlength="120">
    <label for="bz-website">Website</label><input type="url" id="bz-website" value="${esc(l.website_url || "")}" maxlength="500" placeholder="https://example.com">
    <label for="bz-price">Asking price (USD)</label><input type="text" id="bz-price" value="${esc(l.asking_price || "")}" maxlength="60" placeholder="120000, or Make an offer">
    <label for="bz-revenue">Revenue</label><input type="text" id="bz-revenue" value="${esc(l.revenue || "")}" maxlength="60" placeholder="40000 USD / year">
    <label for="bz-profit">Profit</label><input type="text" id="bz-profit" value="${esc(l.profit || "")}" maxlength="60">
    <label for="bz-desc">Description</label><textarea id="bz-desc" rows="6" maxlength="3000">${esc(l.description || "")}</textarea>`;
}

/** The images card: thumbnails with cover/delete, and an upload form. `kind` is "domain" or "listing". */
function imagesHtml(items, { max, canManage, multiple }) {
  const grid = items.length
    ? `<ul class="am-images">${items.map((i, n) => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener"><img src="${esc(i.url)}" alt="${esc(i.alt)}" loading="lazy"></a>
        ${n === 0 ? `<span class="badge">Cover</span>` : ""}${i.hidden ? `<span class="badge badge-unlisted">Hidden by Lummet</span>` : ""}
        ${canManage ? `<div class="actions">${n > 0 ? `<button class="btn" type="button" data-am-cover="${Number(i.id)}">Make cover</button>` : ""}<button class="btn btn-danger" type="button" data-am-image-delete="${Number(i.id)}">Delete</button></div>` : ""}</li>`).join("")}</ul>`
    : `<div class="empty"><p>No images yet.</p></div>`;
  const form = canManage && (multiple ? items.length < max : true)
    ? `<form id="am-image-form"><label for="am-image-file">${multiple ? `Add images (${items.length} of ${max})` : "Cover image"}</label>
        <input type="file" id="am-image-file" accept="image/png,image/jpeg,image/webp"${multiple ? " multiple" : ""} required>
        <label for="am-image-caption">Description of the image (optional)</label><input type="text" id="am-image-caption" maxlength="120">
        <button class="btn" type="submit">Upload</button></form><p class="muted">PNG, JPEG or WebP, up to 5 MB each.</p><div id="am-image-result"></div>`
    : "";
  return `<div class="card"><h2>${multiple ? "Images and screenshots" : "Image"}</h2>${grid}${form}</div>`;
}

function listingBadge(status) {
  return `<span class="badge badge-${esc(status)}">${esc(LISTING_STATUS_LABEL[status] || status)}</span>`;
}

function businessesHtml(rows, categories, canManage) {
  const table = rows.length
    ? `<table class="table"><thead><tr><th>Listing</th><th>Status</th><th>Price</th><th>Enquiries</th><th></th></tr></thead><tbody>${rows.map((r) => `
        <tr><td>${esc(r.title)}</td><td>${listingBadge(r.status)}</td><td>${esc(r.asking_price || "Make an offer")}</td><td>${Number(r.enquiry_count) || 0}</td>
        <td><a class="btn" href="/app/aftermarket/business/${Number(r.id)}">Manage</a></td></tr>`).join("")}</tbody></table>`
    : `<div class="empty"><p>You have not listed a business yet.</p></div>`;
  const form = canManage
    ? `<div class="card"><h2>List a business</h2><p class="muted">New listings are reviewed before they appear on the marketplace.</p>
        <form id="bz-add">${listingFormFields({}, categories)}<button class="btn" type="submit">Submit for review</button></form><div id="bz-result"></div></div>`
    : "";
  return `<h1>Businesses for sale</h1><p class="subtitle">List a business you want to sell. Buyers contact Lummet, and we pass serious enquiries to you.</p>${table}${form}`;
}

function businessDetailHtml(l, categories, enquiries, canManage, imgs = []) {
  const notice = l.status === "pending" ? `<p class="muted">Waiting for approval. It goes public once Lummet approves it.</p>`
    : l.status === "listed" ? `<p><a href="/aftermarket/listings/${encodeURIComponent(l.slug)}" target="_blank" rel="noopener">View your public page</a></p><p class="muted">Changing the text or numbers sends the listing back for approval.</p>` : "";
  const editable = canManage && l.status !== "sold";
  const actions = editable ? `
      ${["listed", "pending"].includes(l.status) ? `<button class="btn btn-danger" type="button" data-bz-status="unlisted">Remove from sale</button>` : ""}
      ${l.status === "unlisted" ? `<button class="btn" type="button" data-bz-status="pending">Submit for sale again</button>` : ""}
      <button class="btn" type="button" data-bz-status="sold">Mark as sold</button>` : "";
  const edit = editable ? `<div class="card"><h2>Listing</h2><form id="bz-edit">${listingFormFields(l, categories)}<button class="btn" type="submit">Save</button>${actions}</form><div id="bz-result"></div></div>` : `<div class="card"><h2>${esc(l.title)}</h2><p>${esc(l.summary)}</p></div>`;
  const rows = enquiries.length
    ? `<table class="table"><thead><tr><th>Received (UTC)</th><th>Offer</th><th>From</th></tr></thead><tbody>${enquiries.map((e) => `<tr><td>${esc(e.created_at)}</td><td>${esc(e.summary || "")}</td><td>${esc(e.source || "")}</td></tr>`).join("")}</tbody></table>`
    : `<div class="empty"><p>No enquiries yet.</p></div>`;
  return `<p><a href="/app/aftermarket/businesses">&larr; Businesses for sale</a></p><h1>${esc(l.title)}</h1><p>${listingBadge(l.status)}</p>${notice}${edit}
    ${l.status === "sold" ? "" : imagesHtml(imgs, { max: images.MAX_IMAGES.listing, canManage, multiple: true })}
    <div class="card"><h2>Enquiries</h2><p class="muted">Lummet handles buyer contact; you see when enquiries arrive.</p>${rows}</div>
    ${canManage ? `<div class="card"><h2>Delete listing</h2><p class="muted">Removes the listing and its images for good. Past enquiries stay in Lummet's inbox.</p><button class="btn btn-danger" type="button" id="bz-delete">Delete this listing</button></div>` : ""}`;
}

const SCRIPT = `
  var AM = window.__AM || {};
  function amMsg(c){ return AM.errors[c] || c || 'unknown error'; }
  function amOrg(){ var el = document.getElementById('org-switcher'); return el ? el.value : AM.org; }
  function amApi(method, path, body){
    var o = { method: method, headers: {} };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch('/api/organizations/' + amOrg() + '/aftermarket' + path, o).then(function(r){ return r.json().catch(function(){ return { success:false, error:'bad_response' }; }); });
  }
  function amBox(id, text, bad){ var b = document.getElementById(id); if (!b) return; b.textContent = text; b.className = bad ? 'flash flash-error' : 'flash'; }
  var add = document.getElementById('am-add');
  if (add) add.addEventListener('submit', function(e){ e.preventDefault();
    amApi('POST', '/domains', { domain: document.getElementById('am-domain').value, askingPrice: document.getElementById('am-price').value, description: document.getElementById('am-desc').value }).then(function(d){
      if (d.success) location.href = '/app/aftermarket/' + encodeURIComponent(d.domain); else amBox('am-result', amMsg(d.error), true); }); });
  var edit = document.getElementById('am-edit');
  if (edit) edit.addEventListener('submit', function(e){ e.preventDefault();
    amApi('POST', '/domains/' + encodeURIComponent(AM.domain) + '/listing', { headline: document.getElementById('am-headline').value, asking_price: document.getElementById('am-price').value, description: document.getElementById('am-desc').value }).then(function(d){
      amBox('am-edit-result', d.success ? 'Saved.' : amMsg(d.error), !d.success); }); });
  document.querySelectorAll('[data-am-status]').forEach(function(b){ b.addEventListener('click', function(){
    amApi('POST', '/domains/' + encodeURIComponent(AM.domain) + '/status', { status: b.getAttribute('data-am-status') }).then(function(d){ if (d.success) location.reload(); else amBox('am-edit-result', amMsg(d.error), true); }); }); });
  document.querySelectorAll('[data-am-verify]').forEach(function(b){ b.addEventListener('click', function(){
    amBox('am-verify-result', 'Checking\\u2026');
    amApi('POST', '/domains/' + encodeURIComponent(AM.domain) + '/verify', { method: b.getAttribute('data-am-verify') }).then(function(d){
      if (!d.success) return amBox('am-verify-result', amMsg(d.error), true);
      if (d.state === 'listed' || d.state === 'started') return location.reload();
      amBox('am-verify-result', d.state === 'seen' ? 'We can see the new nameservers. Cloudflare is still confirming them: try again in a few minutes.' : 'Not verified yet. DNS changes can take a while: try again in a few minutes.');
    }); }); });
  function amRecords(){
    var box = document.getElementById('am-records'); if (!box) return;
    amApi('GET', '/domains/' + encodeURIComponent(AM.domain) + '/records').then(function(d){
      box.textContent = '';
      if (!d.success) { box.textContent = amMsg(d.error); return; }
      var t = document.createElement('table'); t.className = 'table';
      d.records.forEach(function(r){
        var tr = document.createElement('tr');
        [r.type, r.name, r.content].forEach(function(v){ var td = document.createElement('td'); td.className = 'mono'; td.textContent = String(v); tr.appendChild(td); });
        var td = document.createElement('td');
        if (r.managed) { td.textContent = 'Managed by Lummet'; }
        else if (AM.canManage) { var x = document.createElement('button'); x.className = 'btn btn-danger'; x.textContent = 'Delete';
          x.addEventListener('click', function(){ if (!confirm('Delete this record?')) return; amApi('DELETE', '/domains/' + encodeURIComponent(AM.domain) + '/records/' + encodeURIComponent(r.id)).then(function(z){ if (z.success) amRecords(); else amBox('am-record-result', amMsg(z.error), true); }); });
          td.appendChild(x); }
        tr.appendChild(td); t.appendChild(tr); });
      box.appendChild(t); }); }
  function bzBody(){ return { title: document.getElementById('bz-title').value, category_slug: document.getElementById('bz-category').value, summary: document.getElementById('bz-summary').value,
    location: document.getElementById('bz-location').value, website_url: document.getElementById('bz-website').value, asking_price: document.getElementById('bz-price').value, revenue: document.getElementById('bz-revenue').value,
    profit: document.getElementById('bz-profit').value, description: document.getElementById('bz-desc').value }; }
  var bzAdd = document.getElementById('bz-add');
  if (bzAdd) bzAdd.addEventListener('submit', function(e){ e.preventDefault();
    amApi('POST', '/listings', bzBody()).then(function(d){ if (d.success) location.href = '/app/aftermarket/business/' + encodeURIComponent(d.id); else amBox('bz-result', amMsg(d.error), true); }); });
  var bzEdit = document.getElementById('bz-edit');
  if (bzEdit) bzEdit.addEventListener('submit', function(e){ e.preventDefault();
    amApi('POST', '/listings/' + encodeURIComponent(AM.listingId), bzBody()).then(function(d){ if (d.success) location.reload(); else amBox('bz-result', amMsg(d.error), true); }); });
  document.querySelectorAll('[data-bz-status]').forEach(function(b){ b.addEventListener('click', function(){
    var st = b.getAttribute('data-bz-status'); if (st === 'sold' && !confirm('Mark this listing as sold?')) return;
    amApi('POST', '/listings/' + encodeURIComponent(AM.listingId) + '/status', { status: st }).then(function(d){ if (d.success) location.reload(); else amBox('bz-result', amMsg(d.error), true); }); }); });
  function amImageApi(method, suffix, form){
    var o = { method: method }; if (form) o.body = form;
    return fetch('/api/organizations/' + amOrg() + '/aftermarket' + AM.imageBase + '/images' + (suffix || ''), o).then(function(r){ return r.json().catch(function(){ return { success:false, error:'bad_response' }; }); });
  }
  var imgForm = document.getElementById('am-image-form');
  if (imgForm) imgForm.addEventListener('submit', function(e){ e.preventDefault();
    var files = Array.prototype.slice.call(document.getElementById('am-image-file').files); if (!files.length) return;
    var caption = document.getElementById('am-image-caption').value, i = 0;
    (function next(){
      if (i >= files.length) return location.reload();
      amBox('am-image-result', 'Uploading ' + (i + 1) + ' of ' + files.length + '\u2026');
      var f = new FormData(); f.append('file', files[i]); f.append('caption', caption);
      amImageApi('POST', '', f).then(function(d){ if (!d.success) { amBox('am-image-result', files[i].name + ': ' + amMsg(d.error), true); if (i > 0) setTimeout(function(){ location.reload(); }, 2500); return; } i += 1; next(); });
    })(); });
  document.querySelectorAll('[data-am-image-delete]').forEach(function(b){ b.addEventListener('click', function(){
    if (!confirm('Delete this image?')) return;
    amImageApi('DELETE', '/' + encodeURIComponent(b.getAttribute('data-am-image-delete'))).then(function(d){ if (d.success) location.reload(); else amBox('am-image-result', amMsg(d.error), true); }); }); });
  document.querySelectorAll('[data-am-cover]').forEach(function(b){ b.addEventListener('click', function(){
    amImageApi('POST', '/' + encodeURIComponent(b.getAttribute('data-am-cover')) + '/cover').then(function(d){ if (d.success) location.reload(); else amBox('am-image-result', amMsg(d.error), true); }); }); });
  var delDomain = document.getElementById('am-delete');
  if (delDomain) delDomain.addEventListener('click', function(){
    if (!confirm('Delete ' + AM.domain + ' from the marketplace? This cannot be undone.')) return;
    amApi('DELETE', '/domains/' + encodeURIComponent(AM.domain)).then(function(d){ if (d.success) location.href = '/app/aftermarket'; else amBox('am-edit-result', amMsg(d.error), true); }); });
  var delListing = document.getElementById('bz-delete');
  if (delListing) delListing.addEventListener('click', function(){
    if (!confirm('Delete this listing? This cannot be undone.')) return;
    amApi('DELETE', '/listings/' + encodeURIComponent(AM.listingId)).then(function(d){ if (d.success) location.href = '/app/aftermarket/businesses'; else amBox('bz-result', amMsg(d.error), true); }); });
  amRecords();
  var radd = document.getElementById('am-record-add');
  if (radd) radd.addEventListener('submit', function(e){ e.preventDefault();
    var rec = { type: document.getElementById('am-rtype').value, name: document.getElementById('am-rname').value, content: document.getElementById('am-rcontent').value };
    var p = document.getElementById('am-rprio').value; if (p !== '') rec.priority = Number(p);
    amApi('POST', '/domains/' + encodeURIComponent(AM.domain) + '/records', rec).then(function(d){ if (d.success) { radd.reset(); amBox('am-record-result', 'Added.'); amRecords(); } else amBox('am-record-result', amMsg(d.error), true); }); });
`;

/** Body of /app/aftermarket and /app/aftermarket/<domain>. Returns { status, html }. */
export async function renderPage(env, { organizationId, path, canManage }) {
  const m = path.match(/^\/app\/aftermarket(?:\/([^/]+))?\/?$/);
  const bizList = /^\/app\/aftermarket\/businesses\/?$/.test(path);
  const biz = path.match(/^\/app\/aftermarket\/business\/(\d+)\/?$/);
  let domain = null;
  let listingId = null;
  let content;
  if (biz) {
    const row = await repo.getListingForOrg(env, organizationId, biz[1]);
    if (!row) return { status: 404, html: `<h1>Not found</h1><p><a href="/app/aftermarket">Back to Aftermarket</a></p>` };
    listingId = row.id;
    content = businessDetailHtml(row, await repo.listListingCategories(env), await repo.listEnquiriesForListing(env, row.slug), canManage, (await repo.listImages(env, "listing", row.id)).map((i) => images.toPublic(i, row.title)));
  } else if (bizList) {
    content = businessesHtml(await repo.listListingsForOrg(env, organizationId), await repo.listListingCategories(env), canManage);
  } else if (m && m[1]) {
    domain = normalizeDomain(decodeURIComponent(m[1]));
    const row = domain ? await repo.getAftermarketForOrg(env, organizationId, domain) : null;
    if (!row) return { status: 404, html: `<h1>Not found</h1><p><a href="/app/aftermarket">Back to Aftermarket</a></p>` };
    content = detailHtml({ ...publicRow(row), cf_zone_id: row.cf_zone_id, ns_detected_at: row.ns_detected_at, verify_token: row.verify_token, ns_assigned: row.ns_assigned }, await repo.listEnquiriesForDomain(env, domain), canManage, (await repo.listImages(env, "domain", row.id)).map((i) => images.toPublic(i, row.domain)));
  } else {
    content = listHtml(await repo.listAftermarketForOrg(env, organizationId), canManage);
  }
  const boot = JSON.stringify({ errors: ERRORS, domain, listingId, imageBase: biz ? "/listings/" + biz[1] : domain ? "/domains/" + encodeURIComponent(domain) : "", org: organizationId, canManage: Boolean(canManage) }).replace(/</g, "\\u003c");
  return { status: 200, activeKey: bizList || biz ? "aftermarket-businesses" : "aftermarket", html: `${content}<script nonce="${nonceToken()}">window.__AM = ${boot};${SCRIPT}</script>` };
}
