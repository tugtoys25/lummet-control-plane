// =====================================================
// CUSTOMER ORGANIZATION SETTINGS PAGE (master prompt section 7;
// roadmap 1.2's UI)
//
// Backend (organizations.js's lifecycle functions + routes) already
// existed and was already tested — this closes the "no UI reaches
// it" gap. Owner-only actions are hidden entirely for non-owners
// rather than shown-then-403'd.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

export function renderOrgSettingsPage({ organization, members, isOwner, currentUserId }) {
  const otherMembers = members.filter((m) => m.user_id !== currentUserId);
  const transferOptions = otherMembers.map((m) => `<option value="${escapeHtml(m.user_id)}">${escapeHtml(m.email)} (${escapeHtml(m.role)})</option>`).join("");

  const deletionBlock = organization.scheduled_deletion_at
    ? `<div class="flash flash-error">
        Deletion scheduled for <b>${escapeHtml(organization.scheduled_deletion_at)}</b>.
        ${isOwner ? `<button class="btn"${onClick("lummetCancelDeletion", [])}>Cancel deletion</button>` : ""}
      </div>`
    : isOwner
      ? `<button class="btn btn-danger"${onClick("lummetRequestDeletion", [])}>Delete this organization</button>
         <p style="font-size:12px;color:var(--text-dim)">Closes the organization immediately and permanently deletes it after a 30-day grace period. You can cancel any time before then.</p>`
      : "";

  return `
    <h1>Settings</h1>

    <div class="card">
      <h2>Organization</h2>
      <p><b>${escapeHtml(organization.name)}</b> &middot; <span class="badge badge-${organization.status === "active" ? "active" : "pending"}">${escapeHtml(organization.status)}</span></p>
    </div>

    ${isOwner ? `
    <div class="card">
      <h2>Transfer ownership</h2>
      ${otherMembers.length ? `
      <form id="transfer-form">
        <label for="transfer-to">New owner</label>
        <select id="transfer-to" required>${transferOptions}</select>
        <button class="btn" type="submit">Transfer ownership</button>
      </form>
      <p style="font-size:12px;color:var(--text-dim)">You'll become an admin on this organization — you won't be removed.</p>` : `<p class="empty">Invite a team member first, then you can transfer ownership to them.</p>`}
    </div>

    <div class="card">
      <h2>Deactivate</h2>
      ${organization.status === "active"
        ? `<button class="btn"${onClick("lummetDeactivate", [])}>Deactivate organization</button><p style="font-size:12px;color:var(--text-dim)">Pauses access without deleting anything. Reactivate any time.</p>`
        : organization.status === "closed" && !organization.scheduled_deletion_at
          ? `<button class="btn"${onClick("lummetReactivate", [])}>Reactivate organization</button>`
          : `<p class="empty">Not available right now.</p>`}
    </div>

    <div class="card">
      <h2>Delete organization</h2>
      ${deletionBlock}
    </div>` : `<div class="card"><p class="empty">Only the organization owner can change these settings.</p></div>`}

    <script nonce="${nonceToken()}">
      function lummetOrgId() { return document.getElementById('org-switcher').value; }
      function post(path) { return fetch('/api/organizations/' + lummetOrgId() + path, { method: 'POST' }).then(function (r) { return r.json(); }); }

      var tf = document.getElementById('transfer-form');
      if (tf) tf.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!confirm('Transfer ownership? You will become an admin.')) return;
        fetch('/api/organizations/' + lummetOrgId() + '/transfer-ownership', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toUserId: document.getElementById('transfer-to').value })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (d.success) location.reload(); else alert('Could not transfer ownership: ' + (d.error || 'unknown error'));
        });
      });

      window.lummetDeactivate = function () {
        if (!confirm('Deactivate this organization? You can reactivate it later.')) return;
        post('/deactivate').then(function (d) { if (d.success) location.reload(); else alert(d.error || 'unknown error'); });
      };
      window.lummetReactivate = function () {
        post('/reactivate').then(function (d) { if (d.success) location.reload(); else alert(d.error || 'unknown error'); });
      };
      window.lummetRequestDeletion = function () {
        if (!confirm('Delete this organization? It will close immediately and be permanently deleted in 30 days unless you cancel.')) return;
        post('/request-deletion').then(function (d) { if (d.success) location.reload(); else alert(d.error || 'unknown error'); });
      };
      window.lummetCancelDeletion = function () {
        post('/cancel-deletion').then(function (d) { if (d.success) location.reload(); else alert(d.error || 'unknown error'); });
      };
    </script>
  `;
}
