import { escapeHtml } from "../customer-layout.js";
import { nonceToken } from "../../csp.js";

const ROLES = ["viewer", "analyst", "editor", "admin", "owner"];

export function renderTeamPage({ members, pendingInvitations, canManage }) {
  const memberRows = members
    .map(
      (m) => `
      <tr>
        <td>${escapeHtml(m.full_name || m.email)}</td>
        <td>${escapeHtml(m.email)}</td>
        <td>${escapeHtml(m.role)}</td>
      </tr>`
    )
    .join("");

  const invitationRows = pendingInvitations.length
    ? pendingInvitations
        .map(
          (i) => `
          <tr>
            <td>${escapeHtml(i.email)}</td>
            <td>${escapeHtml(i.role)}</td>
            <td><span class="badge badge-past_due">${escapeHtml(i.status)}</span></td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="3" class="empty">No pending invitations.</td></tr>`;

  const roleOptions = ROLES.map((r) => `<option value="${r}">${r}</option>`).join("");

  const inviteForm = canManage
    ? `
      <div class="card">
        <h2>Invite a team member</h2>
        <form id="invite-form">
          <label for="invite-email">Email</label>
          <input type="email" id="invite-email" required />
          <label for="invite-role">Role</label>
          <select id="invite-role">${roleOptions}</select>
          <button class="btn" type="submit">Send invitation</button>
        </form>
        <p id="invite-token-note" style="display:none;font-size:13px;color:var(--text-dim);margin-top:10px;"></p>
      </div>`
    : "";

  return `
    <h1>Team</h1>
    <p class="subtitle">Everyone with access to this organization.</p>

    <div class="card">
      <h2>Members</h2>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th></tr></thead>
        <tbody>${memberRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Pending invitations</h2>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
        <tbody>${invitationRows}</tbody>
      </table>
    </div>

    ${inviteForm}

    <script nonce="${nonceToken()}">
      var inviteForm = document.getElementById('invite-form');
      if (inviteForm) {
        inviteForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var orgId = document.getElementById('org-switcher').value;
          fetch('/api/organizations/' + orgId + '/invitations', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: document.getElementById('invite-email').value,
              role: document.getElementById('invite-role').value
            })
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.success) {
                var note = document.getElementById('invite-token-note');
                note.style.display = 'block';
                note.textContent = 'Invitation created. Share this link with them: ' + location.origin + '/app/invitations/' + data.token;
                document.getElementById('invite-email').value = '';
              } else {
                alert('Could not send invitation: ' + (data.error || 'unknown error'));
              }
            });
        });
      }
    </script>
  `;
}
