// =====================================================
// CUSTOMER BACKUPS PAGE (roadmap 1.1)
//
// Admin+ can create, verify and download; restore is owner-only (the
// route enforces it too). Restore overwrites content on the target
// site, so it sits behind an explicit confirmation naming the site.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

const STATUS_LABEL = { running: "Running", complete: "Complete", partial: "Partial", failed: "Failed", expired: "Expired" };

function statusBadge(status) {
  const cls = status === "complete" ? "badge-active" : status === "failed" || status === "expired" ? "badge-failed" : "badge-suspended";
  return `<span class="badge ${cls}">${escapeHtml(STATUS_LABEL[status] || status)}</span>`;
}

function sizeLabel(bytes) {
  if (bytes == null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function verifyLabel(b) {
  if (!b.verified_at) return "Not verified";
  return b.verification_status === "ok" ? "Verified" : `Check failed (${escapeHtml(b.verification_status || "unknown")})`;
}

function row(b, siteName, isOwner) {
  const downloadable = b.status === "complete" || b.status === "partial";
  return `
    <tr>
      <td>${escapeHtml(b.created_at || "")}</td>
      <td>${escapeHtml(siteName)}</td>
      <td>${statusBadge(b.status)}${b.error_message ? `<br><small>${escapeHtml(b.error_message)}</small>` : ""}</td>
      <td>${escapeHtml(sizeLabel(b.size_bytes))}</td>
      <td>${verifyLabel(b)}</td>
      <td class="actions">
        ${downloadable ? `<button class="btn"${onClick("lummetBackupVerify", [b.id])}>Verify</button>
        <a class="btn" href="#" data-download="${escapeHtml(b.id)}" ${onClick("lummetBackupDownload", ["$el"])}>Download</a>` : ""}
        ${downloadable && isOwner ? `<button class="btn btn-danger"${onClick("lummetBackupRestore", [b.id, b.site_id])}>Restore</button>` : ""}
      </td>
    </tr>`;
}

export function renderBackupsPage({ sites, backups, enabled, isOwner, canManage }) {
  if (!canManage) {
    return `<h1>Backups</h1><div class="card"><p class="empty">Only organization admins can manage backups.</p></div>`;
  }
  const names = Object.fromEntries(sites.map((s) => [s.id, s.name]));
  const siteOptions = sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");

  const upgrade = enabled ? "" : `<div class="flash">Backups aren't included in your current plan. You can still see and download existing backups. <a href="/app/billing">View plans</a></div>`;

  const createForm = enabled && sites.length
    ? `<div class="card">
        <h2>Create a backup</h2>
        <form id="backup-form">
          <label for="backup-site">Site</label>
          <select id="backup-site" required>${siteOptions}</select>
          <button class="btn" type="submit">Back up now</button>
        </form>
      </div>`
    : "";

  const rows = backups.length
    ? backups.map((b) => row(b, names[b.site_id] || "Deleted site", isOwner)).join("")
    : `<tr><td colspan="6" class="empty">No backups yet.</td></tr>`;

  return `
    <h1>Backups</h1>
    <p class="subtitle">A backup saves a site's content. Verify it to confirm it is intact, or download a copy.</p>
    ${upgrade}
    ${createForm}
    <div class="card">
      <h2>Backup history</h2>
      <table>
        <thead><tr><th>Created</th><th>Site</th><th>Status</th><th>Size</th><th>Integrity</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <script nonce="${nonceToken()}">
      var SITE_NAMES = ${JSON.stringify(names).replace(/</g, "\\u003c")};
      function lummetActiveOrgId() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }
      function base() { return '/api/organizations/' + lummetActiveOrgId(); }
      function post(url, body, failLabel) {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (data.success) location.reload(); else alert(failLabel + ': ' + (data.error || 'unknown error')); });
      }
      var form = document.getElementById('backup-form');
      if (form) form.addEventListener('submit', function (e) {
        e.preventDefault();
        post(base() + '/backups', { siteId: document.getElementById('backup-site').value }, 'Could not create the backup');
      });
      function lummetBackupVerify(id) { post(base() + '/backups/' + id + '/verify', {}, 'Could not verify the backup'); }
      function lummetBackupDownload(a) { a.href = base() + '/backups/' + a.getAttribute('data-download') + '/download'; return true; }
      function lummetBackupRestore(id, siteId) {
        var name = SITE_NAMES[siteId] || 'this site';
        if (!confirm('Restore this backup to "' + name + '"? Current content on the site will be overwritten.')) return;
        post(base() + '/backups/' + id + '/restore', { targetSiteId: siteId }, 'Could not restore the backup');
      }
    </script>
  `;
}
