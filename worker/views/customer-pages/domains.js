// =====================================================
// CUSTOMER DOMAINS PAGE (master prompt section 20; roadmap 1.1)
//
// The backend (worker/domains.js + its routes in index.js) already
// existed and was already tested before this page — this closes the
// "no UI reaches it" gap only. Same visual/JS conventions as
// sites.js: a status badge per row, fetch-based actions, reload on
// success.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

const STATUS_LABEL = {
  pending: "Pending verification",
  dns_verified: "DNS verified",
  ssl_pending: "SSL pending",
  active: "Active",
  failed: "Failed",
  removed: "Removed"
};

function actionsFor(domain, canManage) {
  if (!canManage) return "—";
  const actions = [];
  if (domain.status === "pending") {
    actions.push(`<button class="btn"${onClick("lummetDomainAction", [domain.id, "verify"])}>Check DNS</button>`);
  }
  if (domain.status === "dns_verified" || (domain.status === "ssl_pending" && domain.ssl_status !== "active")) {
    actions.push(`<button class="btn"${onClick("lummetDomainAction", [domain.id, "request-ssl"])}>Request SSL</button>`);
    actions.push(`<button class="btn"${onClick("lummetDomainAction", [domain.id, "check-ssl"])}>Check SSL</button>`);
  }
  if (domain.status === "active" && !domain.is_primary) {
    actions.push(`<button class="btn"${onClick("lummetDomainAction", [domain.id, "set-primary"])}>Set primary</button>`);
  }
  actions.push(`<button class="btn btn-danger"${onClick("lummetRemoveDomain", [domain.id])}>Remove</button>`);
  return actions.join(" ");
}

export function renderDomainsPage({ sites, domainsBySite, canManage }) {
  const siteOptions = sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");

  const sections = sites.length
    ? sites.map((site) => {
        const rows = (domainsBySite[site.id] || []).length
          ? domainsBySite[site.id].map((d) => `
            <tr id="domain-${escapeHtml(d.id)}">
              <td class="mono">${escapeHtml(d.hostname)}${d.is_primary ? ' <span class="badge">primary</span>' : ""}</td>
              <td><span class="badge badge-${escapeHtml(d.status)}">${escapeHtml(STATUS_LABEL[d.status] || d.status)}</span></td>
              <td>${escapeHtml(d.ssl_status)}</td>
              <td class="actions">${actionsFor(d, canManage)}</td>
            </tr>`).join("")
          : `<tr><td colspan="4" class="empty">No domains yet for this site.</td></tr>`;
        return `
          <div class="card">
            <h2>${escapeHtml(site.name)}</h2>
            <table>
              <thead><tr><th>Domain</th><th>Status</th><th>SSL</th><th>Actions</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>`;
      }).join("")
    : `<div class="card"><p class="empty">Create a site first, then come back here to add a custom domain.</p></div>`;

  const addForm = canManage && sites.length
    ? `
      <div class="card">
        <h2>Add a domain</h2>
        <form id="add-domain-form">
          <label for="domain-site">Site</label>
          <select id="domain-site" required>${siteOptions}</select>
          <label for="domain-hostname">Domain</label>
          <input type="text" id="domain-hostname" placeholder="www.example.com" required />
          <button class="btn" type="submit">Add domain</button>
        </form>
        <div id="dns-instructions"></div>
      </div>`
    : "";

  return `
    <h1>Domains</h1>
    <p class="subtitle">Connect your own domain to a site. Add it, point a TXT record at it, then request SSL once DNS verifies.</p>

    ${sections}
    ${addForm}

    <script nonce="${nonceToken()}">
      function lummetActiveOrgId() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }

      function lummetDomainAction(domainId, action) {
        fetch('/api/organizations/' + lummetActiveOrgId() + '/domains/' + domainId + '/' + action, { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) location.reload();
            else alert('Could not complete "' + action + '": ' + (data.error || 'unknown error'));
          });
      }

      function lummetRemoveDomain(domainId) {
        if (!confirm('Remove this domain? It will stop serving this site once removed.')) return;
        fetch('/api/organizations/' + lummetActiveOrgId() + '/domains/' + domainId, { method: 'DELETE' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) location.reload();
            else alert('Could not remove domain: ' + (data.error || 'unknown error'));
          });
      }

      var addForm = document.getElementById('add-domain-form');
      if (addForm) {
        addForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var siteId = document.getElementById('domain-site').value;
          var hostname = document.getElementById('domain-hostname').value;
          fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/domains', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hostname: hostname })
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!data.success) { alert('Could not add domain: ' + (data.error || 'unknown error')); return; }
              var box = document.getElementById('dns-instructions');
              var i = data.dnsInstructions;
              box.innerHTML = '<div class="flash flash-success">Add this record, then click "Check DNS" on the row below once it has propagated:<br>' +
                '<code>' + i.type + ' ' + i.name + ' &rarr; ' + i.value + '</code></div>';
              setTimeout(function () { location.reload(); }, 2500);
            });
        });
      }
    </script>
  `;
}
