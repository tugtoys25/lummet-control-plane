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
import { loadSite } from "./public-site/context.js";
import { normalizeDomain, isReservedDomain, newVerifyToken } from "./public-site/aftermarket-domains.js";
import { escapeHtml } from "./views/customer-layout.js";
import { nonceToken } from "./csp.js";

const COOLDOWN_MS = 15 * 1000;
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
    await repo.updateAftermarketListing(env, row.id, { status: "unlisted" });   // the maintenance tick releases a nameserver zone
    return { ok: true };
  }
  if (status === "listed" && row.status === "unlisted" && row.verified_at) {
    await repo.updateAftermarketListing(env, row.id, { status: "listed" });
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
  const m = subPath.match(/^\/aftermarket\/domains(?:\/([^/]+)(?:\/([a-z]+)(?:\/([^/]+))?)?)?$/);
  if (!m) return null;
  const [, rawDomain, action, subId] = m;
  const read = method === "GET";
  const guard = await requireOrgRole(organizationId, read ? "viewer" : "admin");
  if (guard) return guard;
  const body = read || method === "DELETE" ? {} : await request.json().catch(() => ({}));
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

  if (!action && read) return json({ success: true, domain: publicRow(row), enquiries: await repo.listEnquiriesForDomain(env, domain) });
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
  return `<h1>Aftermarket</h1><p class="subtitle">List your domains for sale. Buyers contact Lummet, and we pass serious offers to you.</p>${body}${form}`;
}

function detailHtml(r, enquiries, canManage) {
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
  return `<p><a href="/app/aftermarket">&larr; All domains</a></p><h1 class="mono">${esc(r.domain)}</h1><p>${badge(r.status)}</p>${page}${verifyCard}${edit}
    <div class="card"><h2>Enquiries</h2><p class="muted">Lummet handles buyer contact; you see when offers arrive.</p>${enquiryRows}</div>${dns}`;
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
  let domain = null;
  let content;
  if (m && m[1]) {
    domain = normalizeDomain(decodeURIComponent(m[1]));
    const row = domain ? await repo.getAftermarketForOrg(env, organizationId, domain) : null;
    if (!row) return { status: 404, html: `<h1>Not found</h1><p><a href="/app/aftermarket">Back to Aftermarket</a></p>` };
    content = detailHtml({ ...publicRow(row), cf_zone_id: row.cf_zone_id, ns_detected_at: row.ns_detected_at, verify_token: row.verify_token, ns_assigned: row.ns_assigned }, await repo.listEnquiriesForDomain(env, domain), canManage);
  } else {
    content = listHtml(await repo.listAftermarketForOrg(env, organizationId), canManage);
  }
  const boot = JSON.stringify({ errors: ERRORS, domain, org: organizationId, canManage: Boolean(canManage) }).replace(/</g, "\\u003c");
  return { status: 200, html: `${content}<script nonce="${nonceToken()}">window.__AM = ${boot};${SCRIPT}</script>` };
}
