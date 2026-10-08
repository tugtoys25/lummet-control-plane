import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

function actionsFor(site) {
  const actions = [];
  if (site.status === "pending") {
    actions.push(`<button class="btn"${onClick("lummetProvision", [site.id])}>Provision</button>`);
  }
  if (site.status === "failed") {
    actions.push(`<button class="btn"${onClick("lummetRetryProvision", [site.id])}>Retry provisioning</button>`);
  }
  return actions.join(" ") || "—";
}

export function renderSitesPage({ sites, products, canManage }) {
  const rows = sites.length
    ? sites
        .map(
          (site) => `
          <tr id="${escapeHtml(site.id)}">
            <td>${escapeHtml(site.name)}</td>
            <td>${escapeHtml(site.product_name || "")}</td>
            <td><span class="badge badge-${escapeHtml(site.status)}">${escapeHtml(site.status)}</span></td>
            <td class="mono">${escapeHtml(site.primary_domain || "—")}</td>
            <td>${escapeHtml(site.app_version || "—")}</td>
            <td class="actions">${canManage ? actionsFor(site) : "—"}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="6" class="empty">No sites yet — create one below.</td></tr>`;

  const productOptions = products
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join("");

  const createForm = canManage
    ? `
      <div class="card">
        <h2>Create a site</h2>
        <form id="create-site-form">
          <label for="site-name">Site name</label>
          <input type="text" id="site-name" required />
          <label for="site-product">Product</label>
          <select id="site-product" required>${productOptions}</select>
          <button class="btn" type="submit">Create site</button>
        </form>
      </div>`
    : "";

  return `
    <h1>Sites</h1>
    <p class="subtitle">Every site this organization owns, and its current lifecycle status.</p>

    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Product</th><th>Status</th><th>Domain</th><th>Version</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>

    ${createForm}

    <script nonce="${nonceToken()}">
      function lummetActiveOrgId() {
        var el = document.getElementById('org-switcher');
        return el ? el.value : null;
      }

      function lummetProvision(siteId) {
        fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/provision', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) { location.reload(); }
            else { alert('Could not start provisioning: ' + (data.error || 'unknown error')); }
          });
      }

      function lummetRetryProvision(siteId) {
        fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/retry-provisioning', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) { location.reload(); }
            else { alert('Could not retry provisioning: ' + (data.error || 'unknown error')); }
          });
      }

      var createForm = document.getElementById('create-site-form');
      if (createForm) {
        createForm.addEventListener('submit', function (e) {
          e.preventDefault();
          fetch('/api/organizations/' + lummetActiveOrgId() + '/sites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: document.getElementById('site-name').value,
              productId: document.getElementById('site-product').value
            })
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.success) { location.reload(); }
              else { alert('Could not create site: ' + (data.error || 'unknown error')); }
            });
        });
      }
    </script>
  `;
}
