// =====================================================
// CUSTOMER SUPPORT PAGES: write to the platform team and follow the conversation.
// Every member of an organization can use them. All text is escaped; replies are plain text with line breaks kept.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick, onSubmit, BROWSER_HELPER } from "../../csp.js";
import { CATEGORIES, PRIORITIES, LIMITS } from "../../support.js";

const STATUS_LABEL = { open: "Waiting for us", answered: "Answered", closed: "Closed" };
const STATUS_CLASS = { open: "badge-pending", answered: "badge-active", closed: "badge-suspended" };
const badge = (s) => `<span class="badge ${STATUS_CLASS[s] || ""}">${escapeHtml(STATUS_LABEL[s] || s)}</span>`;
const SCRIPT_HEAD = `${BROWSER_HELPER}
  function base() { var el = document.getElementById('org-switcher'); return '/api/organizations/' + (el ? el.value : ''); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
  var ERRORS = { subject_required: 'Write a short subject (at least 3 characters).', message_required: 'Write your message.', too_many_open_tickets: 'You have many open requests. Close some before opening new ones.', invalid_site: 'That site is not yours.' };
  function call(method, url, body, ok) {
    fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (d.success) ok(d); else { var m = document.getElementById('sup-msg'); var t = ERRORS[d.error] || d.error || 'Something went wrong.'; if (m) m.innerHTML = '<div class="flash flash-error">' + esc(t) + '</div>'; } })
      .catch(function () { var m = document.getElementById('sup-msg'); if (m) m.innerHTML = '<div class="flash flash-error">Could not reach the server.</div>'; });
  }`;

export function renderSupportList({ tickets, sites }) {
  const siteOpts = `<option value="">No specific site</option>${(sites || []).map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")}`;
  const rows = tickets.map((t) => `<tr>
    <td><a href="/app/support/${escapeHtml(t.id)}"><strong>${escapeHtml(t.subject)}</strong></a><br><span class="muted">${escapeHtml(CATEGORIES[t.category] || t.category)} · ${escapeHtml(PRIORITIES[t.priority] || t.priority)}</span></td>
    <td>${badge(t.status)}</td><td>${escapeHtml(String(t.message_count))}</td><td>${escapeHtml(t.updated_at || "")}</td></tr>`).join("");
  return `
    <h1>Support</h1>
    <p class="subtitle">Ask the Lummet team for help. Everyone in your organization can see these requests. We answer here and by email.</p>
    <div id="sup-msg"></div>
    <div class="card"><h2>New request</h2>
      <form id="sup-form"${onSubmit("lummetSupportCreate", [], { prevent: true })}>
        <label for="sup-subject">Subject</label><input type="text" id="sup-subject" maxlength="${LIMITS.subject}" required />
        <label for="sup-category">Topic</label><select id="sup-category">${Object.entries(CATEGORIES).map(([k, v]) => `<option value="${k}">${escapeHtml(v)}</option>`).join("")}</select>
        <label for="sup-priority">How urgent is it?</label><select id="sup-priority">${Object.entries(PRIORITIES).map(([k, v]) => `<option value="${k}"${k === "normal" ? " selected" : ""}>${escapeHtml(v)}</option>`).join("")}</select>
        <label for="sup-site">Site</label><select id="sup-site">${siteOpts}</select>
        <label for="sup-body">What do you need?</label><textarea id="sup-body" rows="6" maxlength="${LIMITS.body}" required placeholder="What happened, what you expected, and any page or error you saw."></textarea>
        <p class="muted">Never include passwords or full card numbers.</p>
        <button class="btn btn-primary" type="submit">Send request</button>
      </form></div>
    <div class="card"><h2>Your requests</h2>
      <table><thead><tr><th>Request</th><th>Status</th><th>Messages</th><th>Last update</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="4" class="empty">No requests yet.</td></tr>`}</tbody></table></div>
    <script nonce="${nonceToken()}">${SCRIPT_HEAD}
      function lummetSupportCreate() {
        call('POST', base() + '/support/tickets', { subject: document.getElementById('sup-subject').value, category: document.getElementById('sup-category').value, priority: document.getElementById('sup-priority').value, siteId: document.getElementById('sup-site').value || null, body: document.getElementById('sup-body').value },
          function (d) { location.href = '/app/support/' + d.id; });
      }
    </script>`;
}

export function renderSupportTicket({ ticket }) {
  if (!ticket) return `<h1>Support</h1><div class="card"><p class="empty">That request was not found.</p></div><p><a href="/app/support">Back to support</a></p>`;
  const msgs = ticket.messages.map((m) => `
    <div class="card" style="${m.author_type === "staff" ? "border-left:4px solid var(--accent,#6d5dfc)" : ""}">
      <p class="muted"><strong>${escapeHtml(m.author_label)}</strong>${m.author_type === "staff" ? " · Lummet team" : ""} · ${escapeHtml(m.created_at || "")}</p>
      <div style="white-space:pre-wrap">${escapeHtml(m.body)}</div></div>`).join("");
  const closed = ticket.status === "closed";
  return `
    <p><a href="/app/support">← All requests</a></p>
    <h1>${escapeHtml(ticket.subject)}</h1>
    <p class="subtitle">${badge(ticket.status)} · ${escapeHtml(CATEGORIES[ticket.category] || ticket.category)} · ${escapeHtml(PRIORITIES[ticket.priority] || ticket.priority)}</p>
    <div id="sup-msg"></div>
    ${msgs}
    <div class="card"><h2>${closed ? "Re-open this request" : "Reply"}</h2>
      <form id="sup-reply"${onSubmit("lummetSupportReply", [ticket.id], { prevent: true })}>
        <textarea id="sup-body" rows="5" maxlength="${LIMITS.body}" required></textarea><br>
        <button class="btn btn-primary" type="submit">${closed ? "Send and re-open" : "Send reply"}</button>
        ${closed ? "" : ` <button class="btn" type="button"${onClick("lummetSupportClose", [ticket.id])}>Mark as solved</button>`}
      </form></div>
    <script nonce="${nonceToken()}">${SCRIPT_HEAD}
      function lummetSupportReply(id) {
        call('POST', base() + '/support/tickets/' + id + '/reply', { body: document.getElementById('sup-body').value }, function () { location.reload(); });
      }
      function lummetSupportClose(id) { call('POST', base() + '/support/tickets/' + id + '/status', { status: 'closed' }, function () { location.reload(); }); }
    </script>`;
}
