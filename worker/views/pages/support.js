// =====================================================
// SUPPORT (User Inquiries + Casino Submissions + Notifications)
//
// Backed by new Super API routes added alongside this control-plane
// change (worker/super/handlers.js / router.js on the tenant) --
// none of these three existed on the Super API before. Per that
// handler file's own header: none of these three has ANY permission
// gating on the tenant's own dashboard today either (session-admin
// only) -- so unlike Postback Configs/Provider Adapters, there's no
// existing "admin-only, no editor rows" boundary to preserve here.
// Gated through the ordinary permission matrix ("inquiries",
// "submissions", "notifications" resources), delegatable like any
// other content-moderation work.
//
// Notifications has no list -- createNotification() targets one
// user_id at a time and there's no admin-wide feed in
// user_dashboard.js, so this is a compose-and-send form only.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant, putToTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";
const SUBMISSION_STATUSES = ["pending", "approved", "rejected"];

export async function renderSupportPage(env, admin) {
  const activeKey = "content-support";
  const title = "Support";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const [inquiriesResult, submissionsResult] = await Promise.all([
    getFromTenant(env, tenant, `${BASE_PATH}/inquiries`),
    getFromTenant(env, tenant, `${BASE_PATH}/submissions`)
  ]);

  const errBlock = (r, label) => !r.ok
    ? `<div class="flash flash-error"><strong>${escapeHtml(String(r.status))}</strong> — ${escapeHtml(r.message || `Could not load ${label}. If this tenant hasn't redeployed with the new /en/api/super routes yet, that's why.`)}</div>`
    : null;

  const inquiries = inquiriesResult.ok ? (inquiriesResult.data.data || []) : [];
  const submissions = submissionsResult.ok ? (submissionsResult.data.data || []) : [];

  const inquiryRow = (i) => `
    <tr>
      <td>${escapeHtml(i.user_email)}</td>
      <td>${escapeHtml(i.subject)}</td>
      <td style="max-width:280px;white-space:normal;">${escapeHtml(i.message)}</td>
      <td>${escapeHtml(i.status)}</td>
      <td>${i.admin_reply ? `<em style="font-size:12px;color:var(--text-dim);">${escapeHtml(i.admin_reply)}</em>` : `
        <div style="display:flex;gap:6px;">
          <input type="text" placeholder="Reply…" data-reply-input="${i.id}" style="flex:1;" />
          <button type="button" class="btn btn-small" data-reply-btn="${i.id}">Send</button>
        </div>`}
      </td>
    </tr>`;

  const submissionRow = (s) => `
    <tr>
      <td>${escapeHtml(s.user_email)}</td>
      <td>${escapeHtml(s.name)}</td>
      <td><a href="${escapeHtml(s.website_url)}" target="_blank" rel="noopener">${escapeHtml(s.website_url)}</a></td>
      <td>${escapeHtml(s.bonus_value || "")}</td>
      <td>${escapeHtml(s.status)}</td>
      <td>
        <select data-status-select="${s.id}">
          ${SUBMISSION_STATUSES.map((st) => `<option value="${st}" ${st === s.status ? "selected" : ""}>${st}</option>`).join("")}
        </select>
        <button type="button" class="btn btn-small" data-status-save="${s.id}">Save</button>
      </td>
    </tr>`;

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · Support on <strong>${escapeHtml(tenant.name)}</strong></p>

    <div class="card">
      <h3 style="margin-top:0;">User Inquiries</h3>
      ${errBlock(inquiriesResult, "inquiries") || (inquiries.length ? `
      <table class="table">
        <thead><tr><th>From</th><th>Subject</th><th>Message</th><th>Status</th><th>Reply</th></tr></thead>
        <tbody>${inquiries.map(inquiryRow).join("")}</tbody>
      </table>` : `<p class="empty">No inquiries.</p>`)}
    </div>

    <div class="card">
      <h3 style="margin-top:0;">Casino Submissions</h3>
      ${errBlock(submissionsResult, "submissions") || (submissions.length ? `
      <table class="table">
        <thead><tr><th>From</th><th>Casino</th><th>Website</th><th>Bonus</th><th>Status</th><th></th></tr></thead>
        <tbody>${submissions.map(submissionRow).join("")}</tbody>
      </table>` : `<p class="empty">No submissions.</p>`)}
    </div>

    <div class="card" style="border-style:dashed;">
      <h3 style="margin-top:0;">Send a notification</h3>
      <div style="font-size:13px;color:var(--text-dim);margin-bottom:8px;">
        Goes to one specific user's in-app notification feed — there's no broadcast-to-all here.
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;">
        <label>User ID<input type="number" id="notifUserId" /></label>
        <label>Title<input type="text" id="notifTitle" /></label>
      </div>
      <label>Message<textarea id="notifMessage"></textarea></label>
      <label>Link <span style="color:var(--text-dim);font-weight:normal;">(optional)</span><input type="text" id="notifLink" /></label>
      <button type="button" class="btn btn-small" id="sendNotifBtn" style="margin-top:8px;">Send</button>
    </div>

    <script nonce="${nonceToken()}">
      async function supportApi(method, path, body) {
        const opts = { method, headers: { "Content-Type": "application/json" } };
        if (body !== undefined) opts.body = JSON.stringify(body);
        const res = await fetch(path, opts);
        return res.json().catch(() => ({}));
      }

      document.body.addEventListener("click", async (e) => {
        const replyBtn = e.target.closest("[data-reply-btn]");
        if (replyBtn) {
          const id = replyBtn.dataset.replyBtn;
          const input = document.querySelector('[data-reply-input="' + id + '"]');
          const reply = input.value.trim();
          if (!reply) { alert("Write a reply first."); return; }
          const data = await supportApi("POST", "/api/inquiries/" + id + "/reply", { reply });
          if (!data.success) { alert("Could not send: " + (data.message || data.error || "unknown error")); return; }
          location.reload();
          return;
        }

        const statusSave = e.target.closest("[data-status-save]");
        if (statusSave) {
          const id = statusSave.dataset.statusSave;
          const status = document.querySelector('[data-status-select="' + id + '"]').value;
          const data = await supportApi("PUT", "/api/submissions/" + id, { status });
          if (!data.success) { alert("Could not save: " + (data.message || data.error || "unknown error")); return; }
          location.reload();
        }
      });

      document.getElementById("sendNotifBtn").addEventListener("click", async () => {
        const userId = document.getElementById("notifUserId").value.trim();
        const title = document.getElementById("notifTitle").value.trim();
        const message = document.getElementById("notifMessage").value.trim();
        const link = document.getElementById("notifLink").value.trim();
        if (!userId || !title || !message) { alert("User ID, title and message are all required."); return; }
        const data = await supportApi("POST", "/api/notifications", { userId, title, message, link: link || undefined });
        if (!data.success) { alert("Could not send: " + (data.message || data.error || "unknown error")); return; }
        alert("Sent.");
        document.getElementById("notifTitle").value = "";
        document.getElementById("notifMessage").value = "";
        document.getElementById("notifLink").value = "";
      });
    </script>
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

export async function submitReplyInquiry(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/inquiries/${encodeURIComponent(id)}/reply`, payload);
}

export async function submitUpdateSubmissionStatus(env, admin, id, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return putToTenant(env, tenant, `${BASE_PATH}/submissions/${encodeURIComponent(id)}`, {
    status: payload.status,
    admin_notes: payload.adminNotes
  });
}

export async function submitSendNotification(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/notifications`, {
    user_id: payload.userId,
    title: payload.title,
    message: payload.message,
    link: payload.link
  });
}
