// =====================================================
// CUSTOMER ANNOUNCEMENTS: messages from the Lummet team. The body was sanitised when it was saved (html-sanitize.js), so it is shown as is.
// =====================================================
import { escapeHtml } from "../customer-layout.js";

const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function renderCustomerAnnouncementsPage({ items }) {
  const cards = items.map((a) => `<div class="card"${a.unread ? ' style="border-left:4px solid var(--accent,#6d5dfc)"' : ""}>
    <h2>${escapeHtml(a.subject)}${a.unread ? ' <span class="badge badge-active">New</span>' : ""}</h2>
    <p class="muted">${escapeHtml(a.createdAt || "")}${a.edited ? " · edited" : ""}</p>
    <div class="announcement-body">${a.bodyHtml}</div>
    ${a.attachments.length ? `<div style="margin-top:10px">${a.attachments.map((f) => f.isImage
      ? `<a href="${escapeHtml(f.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(f.url)}" alt="${escapeHtml(f.filename)}" style="max-width:320px;max-height:240px;border:1px solid #ccc;border-radius:6px;margin:0 8px 8px 0" /></a>`
      : `<div>&#128206; <a href="${escapeHtml(f.url)}" download>${escapeHtml(f.filename)}</a> <span class="muted">(${fmtSize(f.sizeBytes)})</span></div>`).join("")}</div>` : ""}
  </div>`).join("");
  return `<h1>Announcements</h1><p class="subtitle">News and messages from the Lummet team.</p>${cards || `<div class="card"><p class="empty">No announcements yet.</p></div>`}`;
}
