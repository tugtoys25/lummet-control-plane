// =====================================================
// STAFF: trial extension requests. A customer whose free trial ended asks for more time; staff approve with a number of days or
// decline with a comment. The customer is told in their dashboard and by email. Every decision is audited.
// =====================================================
import { renderShell, escapeHtml as h } from "../layout.js";
import { nonceToken } from "../../csp.js";
import * as repo from "../../repositories/trial-extensions.js";

const FILTERS = [["", "All"], ["pending", "Waiting"], ["approved", "Approved"], ["declined", "Declined"]];

export async function renderTrialExtensionsPage(env, admin, { status = "" } = {}) {
  const [rows, pending] = await Promise.all([repo.listForStaff(env, { status }), repo.countPending(env)]);
  const tabs = FILTERS.map(([v, l]) => `<a href="/platform/saas/trial-extensions${v ? "?status=" + v : ""}" ${status === v ? 'style="font-weight:700"' : ""}>${h(l)}${v === "pending" ? ` (${pending})` : ""}</a>`).join(" · ");
  const body = rows.map((r) => {
    const open = r.status === "pending";
    const decision = open
      ? `<div class="te-act" data-id="${h(r.id)}">
           <label>Days to grant (1-90)<input type="number" class="te-days" min="1" max="90" value="${h(r.wanted_days || 7)}" style="width:6rem" /></label>
           <label>Comment (required to decline)<input type="text" class="te-comment" maxlength="1000" style="width:100%" /></label>
           <button class="btn" type="button" data-te="approve">Approve</button> <button class="btn btn-danger" type="button" data-te="decline">Decline</button>
           <span class="te-msg" role="status"></span></div>`
      : `<span class="badge badge-${r.status === "approved" ? "active" : "past_due"}">${h(r.status)}</span>${r.decided_days ? ` ${h(r.decided_days)} days` : ""} ${h(r.decided_at || "")}<br>${h(r.decision_comment || "")}`;
    return `<tr><td><a href="/platform/saas/organizations/${h(r.organization_id)}">${h(r.organization_name || r.organization_id)}</a><br><span style="color:var(--text-dim)">${h(r.requested_by_email || "")}</span></td>
      <td>${h(r.created_at)}</td><td>${h(r.site_count)}</td><td>${h(r.message || "")}${r.wanted_days ? `<br><em>Asked for ${h(r.wanted_days)} days</em>` : ""}</td><td>${decision}</td></tr>`;
  }).join("");
  const page = `<h1>Trial extensions</h1>
    <p style="color:var(--text-dim)">A free trial can only be used once per organization. When it ends, the customer's sites are paused (when <code>BILLING_TRIAL_END_SITES</code> is on) and they can ask for more time here. Approving gives a new trial of the days you choose and puts their sites back online; declining sends your comment to the customer.</p>
    <p>${tabs}</p>
    <table><thead><tr><th>Organization</th><th>Requested</th><th>Sites</th><th>Their message</th><th>Decision</th></tr></thead>
    <tbody>${body || `<tr><td colspan="5" style="color:var(--text-dim)">No requests${status ? " in this view" : " yet"}.</td></tr>`}</tbody></table>
    <script nonce="${nonceToken()}">
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-te]'); if (!b) return;
      var box = b.closest('.te-act'), msg = box.querySelector('.te-msg'), verb = b.getAttribute('data-te');
      var comment = box.querySelector('.te-comment').value.trim(), days = Number(box.querySelector('.te-days').value);
      if (verb === 'decline' && comment.length < 3) { msg.textContent = 'Write a comment so the customer knows why.'; return; }
      if (verb === 'approve' && !(days >= 1 && days <= 90)) { msg.textContent = 'Choose 1 to 90 days.'; return; }
      if (!confirm(verb === 'approve' ? 'Grant ' + days + ' more trial day(s) and put their sites back online?' : 'Decline this request?')) return;
      b.disabled = true;
      fetch('/api/platform/saas/trial-extensions/' + box.getAttribute('data-id') + '/' + verb, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: days, comment: comment }) })
        .then(function (r) { return r.json(); }).then(function (d) { if (d.success) location.reload(); else { b.disabled = false; msg.textContent = 'Could not save: ' + String(d.error || '').replace(/_/g, ' '); } })
        .catch(function () { b.disabled = false; msg.textContent = 'Could not save. Try again.'; });
    });
    </script>`;
  return renderShell({ title: "Trial extensions", activeKey: "saas-trial-extensions", admin, env, bodyHtml: page });
}
