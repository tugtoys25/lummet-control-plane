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

/**
 * What the Setup column says about a site's newest first-configuration request (Phase 10 A3). Plain words, no codes:
 * the customer never needs to know what "config_system_off" is. `view` is the customer view from siteSetup.publicView.
 * Returns { text, retry } where retry means "show the Retry button" (only for a request that can still be retried).
 */
export function describeSetup(view, siteStatus) {
  if (!view || view.status === "none") return { text: "—", retry: false };
  const readyForRetry = siteStatus === "active" || siteStatus === "maintenance";
  const what = view.kind === "clone" ? "copy of your site" : (view.presetLabel || "preset");
  switch (view.status) {
    case "applied": return { text: `Applied: ${what}`, retry: false };
    case "pending": return { text: readyForRetry ? `Waiting to apply: ${what}` : `Starts after the first deploy: ${what}`, retry: readyForRetry };
    case "failed": return { text: (Number(view.attempts) >= 6 ? "Needs a retry" : "Could not apply yet, will retry") + `: ${what}`, retry: readyForRetry };
    case "skipped":
      if (view.lastError === "config_system_off") return { text: "Skipped: switched off", retry: false };
      if (view.lastError === "superseded") return { text: "Replaced by a newer choice", retry: false };
      return { text: "Skipped: this site was already set up", retry: false };
    default: return { text: "—", retry: false };
  }
}

function setupSection(options, products) {
  const presets = Array.isArray(options?.presets) ? options.presets : [];
  if (!presets.length) return "";
  const def = options.default || {};
  const defaultLabel = def.label ? `Recommended for you: ${def.label}` : "Recommended for you";
  const presetOptions = [`<option value="" id="site-preset-default">${escapeHtml(defaultLabel)}</option>`]
    .concat(presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.label)}</option>`)).join("");
  const sources = Array.isArray(options.cloneSources) ? options.cloneSources : [];
  const cloneBlock = sources.length
    ? `
          <label for="site-clone">Or copy from my site</label>
          <select id="site-clone" aria-describedby="site-setup-help">
            <option value="">Do not copy</option>
            ${sources.map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.productName ? ` (${escapeHtml(c.productName)})` : ""}</option>`).join("")}
          </select>`
    : "";
  return `
          <label for="site-preset">How should the site start?</label>
          <select id="site-preset" aria-describedby="site-setup-help">${presetOptions}</select>${cloneBlock}
          <p id="site-setup-help" class="subtitle">A starting point decides which parts of the site are switched on (for example news only, or a casino list). You can change everything later in the site's Configuration. If you copy one of your own sites, its settings are copied, not its content or accounts.</p>`;
}

export function renderSitesPage({ sites, products, canManage, setupOptions = null, setupViews = null }) {
  const views = setupViews && typeof setupViews === "object" ? setupViews : {};
  const rows = sites.length
    ? sites
        .map((site) => {
          const setup = describeSetup(Object.prototype.hasOwnProperty.call(views, site.id) ? views[site.id] : null, site.status);
          const retry = canManage && setup.retry ? ` <button class="btn"${onClick("lummetRetrySetup", [site.id])}>Retry</button>` : "";
          return `
          <tr id="${escapeHtml(site.id)}">
            <td>${escapeHtml(site.name)}</td>
            <td>${escapeHtml(site.product_name || "")}</td>
            <td><span class="badge badge-${escapeHtml(site.status)}">${escapeHtml(site.status)}</span></td>
            <td class="mono">${escapeHtml(site.primary_domain || "—")}</td>
            <td>${escapeHtml(site.app_version || "—")}</td>
            <td>${escapeHtml(setup.text)}${retry}</td>
            <td class="actions">${canManage ? actionsFor(site) : "—"}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">No sites yet — create one below.</td></tr>`;

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
          <select id="site-product" required>${productOptions}</select>${setupSection(setupOptions, products)}
          <button class="btn" type="submit">Create site</button>
        </form>
      </div>`
    : "";

  return `
    <h1>Sites</h1>
    <p class="subtitle">Every site this organization owns, and its current lifecycle status.</p>

    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Product</th><th>Status</th><th>Domain</th><th>Version</th><th>Setup</th><th>Actions</th></tr></thead>
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

      function lummetRetrySetup(siteId) {
        fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/setup/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) { location.reload(); }
            else { alert('Could not retry the setup: ' + (data.error || 'unknown error')); }
          });
      }

      function lummetCreateBody() {
        var body = { name: document.getElementById('site-name').value, productId: document.getElementById('site-product').value };
        var p = document.getElementById('site-preset');
        var c = document.getElementById('site-clone');
        if (c && c.value) { body.cloneFromSiteId = c.value; }
        else if (p && p.value) { body.preset = p.value; }
        return body;
      }

      var createForm = document.getElementById('create-site-form');
      var presetSel = document.getElementById('site-preset');
      var cloneSel = document.getElementById('site-clone');
      var productSel = document.getElementById('site-product');
      // A copy and a starting point exclude each other: choosing one clears the other.
      if (presetSel && cloneSel) {
        presetSel.addEventListener('change', function () { if (presetSel.value) { cloneSel.value = ''; } });
        cloneSel.addEventListener('change', function () { if (cloneSel.value) { presetSel.value = ''; } });
      }
      // The recommended starting point depends on the product: ask again when it changes (names only, same organization).
      if (presetSel && productSel) {
        productSel.addEventListener('change', function () {
          fetch('/api/organizations/' + lummetActiveOrgId() + '/site-setup/options?productId=' + encodeURIComponent(productSel.value))
            .then(function (r) { return r.json(); })
            .then(function (data) {
              var d = data && data.success && data.data && data.data.default;
              var opt = document.getElementById('site-preset-default');
              if (d && d.label && opt) { opt.textContent = 'Recommended for you: ' + d.label; }
            })
            .catch(function () {});
        });
      }
      if (createForm) {
        createForm.addEventListener('submit', function (e) {
          e.preventDefault();
          fetch('/api/organizations/' + lummetActiveOrgId() + '/sites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(lummetCreateBody())
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
