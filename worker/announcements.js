// =====================================================
// ANNOUNCEMENTS: staff write to everyone, one person, an organization, a site, or billing contacts - in the dashboard, by email, or both.
//
// Additive: this does not touch the automated billing/reminder emails. Emails go through the same durable outbox (queueEmail), in small
// batches from the maintenance tick, so a large audience never blocks a request. The dashboard list is computed from the audience rule.
// The body is HTML (sanitised on the way in) or plain text; staff may attach photos and documents (signed links).
// =====================================================
import { queueEmail, portalLink } from "./email.js";
import { sanitizeHtml, textToHtml, htmlToText, MAX_HTML_CHARS } from "./html-sanitize.js";
import * as repo from "./repositories/announcements.js";
import * as files from "./private-files.js";
import * as filesRepo from "./repositories/private-files.js";

export const KINDS = { all: "Everyone", user: "One person", organization: "One organization", site: "One site", billing: "Billing contacts" };
export const CHANNELS = ["dashboard", "email"];
export const MAX_RECIPIENTS = repo.MAX_RECIPIENTS;
export const EMAIL_BATCH = 40;
export const MAX_ATTEMPTS = 3;

const clean = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Who an audience rule reaches (without sending anything). Returns {ok, label, people} or {ok:false,...}. */
export async function resolve(env, kind, ref) {
  if (!KINDS[kind]) return { ok: false, status: 422, error: "invalid_audience" };
  const r = clean(ref, 120); let label = KINDS[kind], useRef = r || null;
  if (kind === "user") {
    const u = r && (await repo.findUser(env, r)); if (!u) return { ok: false, status: 404, error: "user_not_found" };
    label = `Person: ${u.email}`; useRef = u.id;
  } else if (kind === "organization") {
    const o = r && (await repo.findOrganization(env, r)); if (!o) return { ok: false, status: 404, error: "organization_not_found" };
    label = `Organization: ${o.name}`;
  } else if (kind === "site") {
    const s = r && (await repo.findSite(env, r)); if (!s) return { ok: false, status: 404, error: "site_not_found" };
    label = `Site: ${s.name} (${s.organization})`;
  } else if (kind === "billing") {
    if (r) { const o = await repo.findOrganization(env, r); if (!o) return { ok: false, status: 404, error: "organization_not_found" }; label = `Billing contacts: ${o.name}`; }
    else label = "Billing contacts: all organizations";
  } else useRef = null;
  const people = await repo.resolveAudience(env, kind, useRef);
  if (people.length > MAX_RECIPIENTS) return { ok: false, status: 422, error: "audience_too_large", detail: `at most ${MAX_RECIPIENTS} people per announcement; send to organizations or billing contacts instead` };
  return { ok: true, label, ref: useRef, people };
}

export function prepareBody(format, raw) {
  const text = String(raw == null ? "" : raw).slice(0, MAX_HTML_CHARS * 2);
  const html = format === "text" ? textToHtml(text) : sanitizeHtml(text);
  return html.length > MAX_HTML_CHARS ? null : html;
}

/** Preview for the composer: how many people, a few addresses, and the sanitised body exactly as it will be sent. */
export async function preview(env, { kind, ref, format, body }) {
  const a = await resolve(env, kind, ref);
  if (!a.ok) return a;
  const bodyHtml = prepareBody(format === "text" ? "text" : "html", body);
  if (bodyHtml == null) return { ok: false, status: 422, error: "body_too_long" };
  return { ok: true, label: a.label, count: a.people.length, sample: a.people.slice(0, 5).map((p) => p.email), bodyHtml };
}

export async function send(env, { staff, subject, body, format, kind, ref, channels, fileIds = [] }) {
  const subj = clean(subject, 140).replace(/\s+/g, " ");
  if (subj.length < 3) return { ok: false, status: 422, error: "subject_required" };
  const chans = [...new Set((Array.isArray(channels) ? channels : []).filter((c) => CHANNELS.includes(c)))];
  if (!chans.length) return { ok: false, status: 422, error: "channel_required" };
  const fmt = format === "text" ? "text" : "html";
  const bodyHtml = prepareBody(fmt, body);
  if (bodyHtml == null) return { ok: false, status: 422, error: "body_too_long" };
  const attachments = await files.pendingAnnouncementFiles(env, fileIds, staff.id);
  if (htmlToText(bodyHtml).trim().length < 2 && !attachments.length) return { ok: false, status: 422, error: "message_required" };
  const a = await resolve(env, kind, ref);
  if (!a.ok) return a;
  if (!a.people.length) return { ok: false, status: 422, error: "no_recipients" };
  const id = crypto.randomUUID();
  const emailing = chans.includes("email");
  await repo.insertAnnouncement(env, { id, subject: subj, bodyHtml, format: fmt, audienceKind: kind, audienceRef: a.ref, audienceLabel: a.label, channels: chans, recipientCount: a.people.length, emailTotal: emailing ? a.people.length : 0, createdByStaff: staff.id },
    emailing ? a.people : []);
  await filesRepo.attachToAnnouncement(env, attachments.map((f) => f.id), id);
  const warnings = [];
  if (emailing && !portalLink(env, "/")) warnings.push("PORTAL_BASE_URL is not set: emails will not include attachment links or images.");
  if (emailing) await processEmails(env, { limit: EMAIL_BATCH }).catch(() => {});
  return { ok: true, id, recipients: a.people.length, warnings };
}

/** Builds the finished email: body, attachments (signed links) and a footer. Relative /f/ links become absolute; without a portal address they are removed. */
export async function buildEmail(env, row) {
  const base = portalLink(env, "");
  const atts = (await filesRepo.forAnnouncements(env, [row.announcement_id])).filter((f) => !row.body_html.includes(`/f/${f.id}/`));
  let body = row.body_html;
  const abs = (p) => (base ? `${base}${p}` : null);
  body = body.replace(/<img\b[^>]*\ssrc="(\/[^"]*)"[^>]*>/g, (m, p) => (abs(p) ? m.replace(`src="${p}"`, `src="${esc(abs(p))}"`) : ""))
             .replace(/<a\b([^>]*)\shref="(\/[^"]*)"/g, (m, rest, p) => (abs(p) ? `<a${rest} href="${esc(abs(p))}"` : m));
  let list = "", listText = "";
  if (atts.length && base) {
    const rows = [];
    for (const f of atts) { const p = await files.signedPath(env, f.id); if (!p) continue; rows.push({ f, url: abs(p) }); }
    if (rows.length) {
      list = `<hr><p><b>Attachments</b></p><ul>${rows.map((r) => `<li><a href="${esc(r.url)}">${esc(r.f.filename)}</a></li>`).join("")}</ul>`;
      listText = `\n\nAttachments:\n${rows.map((r) => `${r.f.filename}: ${r.url}`).join("\n")}`;
    }
  }
  const link = portalLink(env, "/app/announcements");
  const footer = `<hr><p style="color:#666;font-size:12px">You are receiving this message because you have a Lummet account.${link ? ` <a href="${esc(link)}">Open your dashboard</a>` : ""}</p>`;
  return {
    subject: row.subject,
    html: `<div style="font-family:Arial,sans-serif;line-height:1.5">${body}${list}${footer}</div>`,
    text: `${htmlToText(row.body_html)}${listText}${link ? `\n\nOpen your dashboard: ${link}` : ""}`
  };
}

/** Moves a batch of pending recipients into the email outbox. Safe to run repeatedly; a duplicate key means it was already queued. */
export async function processEmails(env, { limit = EMAIL_BATCH } = {}) {
  const rows = await repo.pendingRecipients(env, limit);
  let queued = 0, failed = 0;
  const cache = new Map();
  for (const row of rows) {
    try {
      if (!cache.has(row.announcement_id)) cache.set(row.announcement_id, await buildEmail(env, row));
      const r = await queueEmail(env, { to: row.email, template: "announcement", message: cache.get(row.announcement_id), dedupeKey: `announce:${row.announcement_id}:${row.user_id}` });
      if (r.ok) { await repo.markRecipient(env, row.announcement_id, row.user_id, "queued"); queued++; } else throw new Error(r.error || "queue_failed");
    } catch {
      const giveUp = row.attempts + 1 >= MAX_ATTEMPTS;
      await repo.markRecipient(env, row.announcement_id, row.user_id, giveUp ? "failed" : "pending", true).catch(() => {});
      if (giveUp) failed++;
    }
  }
  return { queued, failed };
}

// ---- staff and customer reads ----
export const listForStaff = (env) => repo.listForStaff(env);
export const unreadCount = (env, userId) => repo.unreadCount(env, userId).catch(() => 0);

/** The person's announcements with attachments (signed links). Opening the page marks what was shown as read. */
export async function inbox(env, userId, { markRead = true } = {}) {
  const rows = await repo.listForUser(env, userId);
  const atts = await filesRepo.forAnnouncements(env, rows.map((r) => r.id));
  const out = [];
  for (const r of rows) {
    const mine = [];
    for (const f of atts.filter((x) => x.announcement_id === r.id && !r.body_html.includes(`/f/${x.id}/`))) { const p = await files.signedPath(env, f.id); if (p) mine.push({ filename: f.filename, sizeBytes: f.size_bytes, url: p, isImage: files.isImageMime(f.mime_type) }); }
    out.push({ id: r.id, subject: r.subject, bodyHtml: r.body_html, createdAt: r.created_at, edited: Boolean(r.edited_at), unread: !r.is_read, attachments: mine });
  }
  if (markRead) { const ids = rows.filter((r) => !r.is_read).map((r) => r.id); if (ids.length) await repo.markRead(env, userId, ids).catch(() => {}); }
  return out;
}
export const pickers = (env) => repo.pickers(env);

// ---- staff management: edit, hide/show, delete. Audience and channels stay as sent; emails already sent cannot be recalled. ----
export const getForStaff = (env, id) => repo.getAnnouncement(env, id);
export async function update(env, id, { subject, body, format }) {
  const a = await repo.getAnnouncement(env, id);
  if (!a) return { ok: false, status: 404, error: "not_found" };
  const subj = clean(subject, 140).replace(/\s+/g, " ");
  if (subj.length < 3) return { ok: false, status: 422, error: "subject_required" };
  const fmt = format === "text" ? "text" : "html";
  const bodyHtml = prepareBody(fmt, body);
  if (bodyHtml == null) return { ok: false, status: 422, error: "body_too_long" };
  if (htmlToText(bodyHtml).trim().length < 2 && !bodyHtml.includes("<img")) return { ok: false, status: 422, error: "message_required" };
  await repo.updateAnnouncement(env, id, { subject: subj, bodyHtml, format: fmt });
  return { ok: true };
}
export async function setHidden(env, id, hidden) {
  if (!(await repo.getAnnouncement(env, id))) return { ok: false, status: 404, error: "not_found" };
  await repo.setHidden(env, id, hidden !== false);
  return { ok: true };
}
export async function remove(env, id) {
  if (!(await repo.getAnnouncement(env, id))) return { ok: false, status: 404, error: "not_found" };
  await files.purgeAnnouncementFiles(env, id);
  await repo.deleteAnnouncement(env, id);
  return { ok: true };
}
