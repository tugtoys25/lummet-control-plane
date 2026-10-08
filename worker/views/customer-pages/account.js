// =====================================================
// CUSTOMER ACCOUNT PAGE: download my data, delete my account (roadmap 1.3)
// Organization closure lives with the organization (owner only): shown here
// per organization so the path to leaving is in one place.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

export function renderAccountPage({ customer, ownedOrganizations, isSsoManaged }) {
  const orgRows = ownedOrganizations.length
    ? ownedOrganizations.map((o) => `
        <tr>
          <td>${escapeHtml(o.name)}</td>
          <td>${o.scheduled_deletion_at
            ? `Scheduled for deletion on ${escapeHtml(o.scheduled_deletion_at.slice(0, 10))}`
            : "Active"}</td>
          <td class="actions">${o.scheduled_deletion_at
            ? `<button class="btn"${onClick("lummetOrgAction", [o.id, "cancel-deletion"])}>Cancel deletion</button>`
            : `<button class="btn btn-danger" ${onClick("lummetOrgDelete", [o.id, o.name])}>Delete organization</button>`}</td>
        </tr>`).join("")
    : `<tr><td colspan="3" class="empty">You do not own any organizations.</td></tr>`;

  return `
    <h1>Account</h1>
    <p class="subtitle">${escapeHtml(customer.email)}</p>

    <div class="card">
      <h2>Download your data</h2>
      <p style="font-size:14px;color:var(--text-dim);">A copy of the personal data held about you: profile, memberships, sign-in methods (not secrets), keys you created, invitations you sent and your recent activity.</p>
      <a class="btn" href="/api/customer/account/export" download="my-lummet-data.json">Download (JSON)</a>
    </div>

    <div class="card">
      <h2>Organizations you own</h2>
      <p style="font-size:14px;color:var(--text-dim);">Deleting an organization cancels its subscription, starts a grace period during which you can undo it, then permanently erases its sites, content and data.</p>
      <table>
        <thead><tr><th>Organization</th><th>Status</th><th></th></tr></thead>
        <tbody>${orgRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Delete my account</h2>
      <p style="font-size:14px;">This permanently removes your sign-in, memberships and personal data. Billing records the law requires us to keep are retained without your name. It cannot be undone.</p>
      <p style="font-size:14px;color:var(--text-dim);">If you are the only owner of an organization, delete or hand over that organization first.</p>
      <label for="del-email">Type your email address to confirm</label>
      <input type="email" id="del-email" autocomplete="off" />
      ${isSsoManaged ? `<p style="font-size:13px;color:var(--text-dim);">Your account is managed by your organization's single sign-on.</p>` : `<label for="del-pw">Your password</label><input type="password" id="del-pw" autocomplete="current-password" />`}
      <button class="btn btn-danger" id="del-btn">Delete my account</button>
      <p id="del-msg" style="font-size:13px;margin-top:8px;"></p>
    </div>

    <script nonce="${nonceToken()}">
      var ERR = {
        confirmation_email_mismatch: 'That is not the email address on this account.',
        incorrect_password: 'That password is not correct.',
        sole_owner_of_organizations: 'You are the only owner of an organization. Delete it or transfer ownership first.'
      };
      function post(url, body, done) {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
          .then(function (r) { return r.json(); }).then(done);
      }
      function lummetOrgAction(id, action) {
        post('/api/organizations/' + id + '/' + action, {}, function (d) { if (d.success) location.reload(); else alert(String(d.error || 'failed').replace(/_/g, ' ')); });
      }
      function lummetOrgDelete(id, name) {
        if (!confirm('Delete "' + name + '"? Its subscription is cancelled now and everything is erased after the grace period.')) return;
        lummetOrgAction(id, 'request-deletion');
      }
      document.getElementById('del-btn').addEventListener('click', function () {
        var msg = document.getElementById('del-msg');
        if (!confirm('Permanently delete your account? This cannot be undone.')) return;
        var pw = document.getElementById('del-pw');
        post('/api/customer/account/delete', { confirmEmail: document.getElementById('del-email').value, password: pw ? pw.value : undefined }, function (d) {
          if (d.success) { location.href = '/app/login?deleted=1'; return; }
          msg.style.color = 'var(--danger, red)';
          msg.textContent = ERR[d.error] || String(d.error || 'Could not delete the account').replace(/_/g, ' ');
        });
      });
    </script>
  `;
}
