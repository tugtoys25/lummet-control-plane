// =====================================================
// NEWSLETTER SUBSCRIBERS
// List/add/unsubscribe only. Deliberately does NOT expose
// en/worker/email-campaigns.js's sendCampaign() -- that sends real
// email to real subscribers and is an irreversible side effect; it
// belongs in its own separately-reviewed feature, not bundled into a
// subscriber-list CRUD page. See handlers.js section header.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { getFromTenant, postToTenant, deleteFromTenant } from "../../client.js";
import { getTenant } from "../../registry.js";
import { nonceToken } from "../../csp.js";

const BASE_PATH = "/en/api/super";

export async function renderNewsletterPage(env, admin) {
  const activeKey = "content-newsletter";
  const title = "Newsletter";

  if (!admin.activeTenantId) {
    const body = `<h1>${title}</h1><div class="card"><p style="font-size:14px;">No active tenant is selected. Use the switcher at the top of the page to pick one.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const tenant = await getTenant(env, admin.activeTenantId);
  if (!tenant) {
    const body = `<h1>${title}</h1><div class="card"><p>Active tenant no longer exists.</p></div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }

  const listResult = await getFromTenant(env, tenant, `${BASE_PATH}/newsletter-subscribers`);
  if (!listResult.ok) {
    const body = `<h1>${title}</h1><div class="flash flash-error"><strong>${escapeHtml(String(listResult.status))}</strong> — ${escapeHtml(listResult.message || "Could not load subscribers. If this tenant hasn't redeployed with the /en/api/super/newsletter-subscribers routes yet, that's why.")}</div>`;
    return renderShell({ title, activeKey, admin, bodyHtml: body, env });
  }
  const rows = listResult.data.data || [];
  const counts = listResult.data.counts || {};

  const rowHtml = (s) => `
    <tr>
      <td>${escapeHtml(s.email)}</td>
      <td>${escapeHtml(s.status)}</td>
      <td>${escapeHtml(s.created_at || "")}</td>
      <td>
        ${s.status !== "unsubscribed" ? `<button type="button" class="btn btn-small btn-danger" data-unsub="${s.id}">Unsubscribe</button>` : ""}
      </td>
    </tr>`;

  const body = `
    <h1>${title}</h1>
    <p class="subtitle">Content · Newsletter on <strong>${escapeHtml(tenant.name)}</strong></p>
    <div class="card" style="font-size:13px;color:var(--text-dim);">
      List and manage subscribers only — sending an actual campaign email isn't available from the control plane.
    </div>

    <div class="card">
      <p>${Object.entries(counts).map(([status, count]) => `<strong>${escapeHtml(count)}</strong> ${escapeHtml(status)}`).join(" &nbsp;·&nbsp; ") || "No subscribers yet."}</p>
      ${rows.length ? `
      <table class="table">
        <thead><tr><th>Email</th><th>Status</th><th>Since</th><th></th></tr></thead>
        <tbody>${rows.map(rowHtml).join("")}</tbody>
      </table>` : `<p class="empty">No subscribers yet.</p>`}
    </div>

    <div class="card" style="border-style:dashed;">
      <h3 style="margin-top:0;">Add a subscriber</h3>
      <label>Email<input type="email" id="newSubEmail" /></label>
      <button type="button" class="btn btn-small" id="addSubBtn" style="margin-top:8px;">Add (confirmed)</button>
    </div>

    <script nonce="${nonceToken()}">
      document.getElementById("addSubBtn").addEventListener("click", async () => {
        const email = document.getElementById("newSubEmail").value.trim();
        if (!email) { alert("Enter an email first."); return; }
        const res = await fetch("/api/newsletter-subscribers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }) });
        const data = await res.json().catch(() => ({}));
        if (!data.success) { alert("Could not add: " + (data.message || data.error || "unknown error")); return; }
        location.reload();
      });

      document.body.addEventListener("click", async (e) => {
        const unsubBtn = e.target.closest("[data-unsub]");
        if (!unsubBtn) return;
        if (!confirm("Unsubscribe this address?")) return;
        const res = await fetch("/api/newsletter-subscribers/" + unsubBtn.dataset.unsub, { method: "DELETE" });
        const data = await res.json().catch(() => ({}));
        if (!data.success) { alert("Could not unsubscribe: " + (data.message || data.error || "unknown error")); return; }
        location.reload();
      });
    </script>
  `;

  return renderShell({ title, activeKey, admin, bodyHtml: body, env });
}

async function resolveTenantOrNull(env, admin) {
  if (!admin.activeTenantId) return null;
  return getTenant(env, admin.activeTenantId);
}

export async function submitAddSubscriber(env, admin, payload) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return postToTenant(env, tenant, `${BASE_PATH}/newsletter-subscribers`, payload);
}

export async function submitUnsubscribe(env, admin, id) {
  const tenant = await resolveTenantOrNull(env, admin);
  if (!tenant) return { ok: false, status: 422, reason: "no_active_tenant" };
  return deleteFromTenant(env, tenant, `${BASE_PATH}/newsletter-subscribers/${encodeURIComponent(id)}`);
}
