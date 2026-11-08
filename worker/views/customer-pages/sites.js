import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";
import { liveAttrs, SITE_TRANSIENT } from "../../live.js";

// A site can be deleted from any state except deleting/deleted, including one stuck in provisioning (its other jobs are cancelled first).
const DELETABLE = new Set(["pending", "provisioning", "provisioned", "configuring", "deploying", "active", "suspended", "maintenance", "failed"]);

function actionsFor(site) {
  const actions = [];
  if (site.status === "pending") {
    actions.push(`<button class="btn"${onClick("lummetProvision", [site.id])}>Provision</button>`);
  }
  if (site.status === "failed") {
    actions.push(`<button class="btn"${onClick("lummetRetryProvision", [site.id])}>Retry provisioning</button>`);
  }
  if (site.status === "active") {
    actions.push(`<button class="btn"${onClick("lummetPauseSite", [site.id, site.name])}>Pause site</button>`);
  } else if (site.status === "suspended") {
    actions.push(site.suspended_by === "customer_user"
      ? `<button class="btn"${onClick("lummetResumeSite", [site.id])}>Resume site</button>`
      : `<span class="subtitle">Suspended by Lummet</span>`);
  }
  if (DELETABLE.has(site.status)) {
    actions.push(`<button class="btn btn-danger"${onClick("lummetOpenDelete", [site.id, site.name, site.primary_domain || ""])}>Delete</button>`);
  } else if (site.status === "deleting") {
    actions.push(`<span class="subtitle">Deleting…</span>`);
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

/** The table rows. Used by the page and by the live-rows endpoint, so a refresh can never show something the page would not. */
export function renderSiteRows({ sites, canManage, setupViews = null, siteHosts = {} }) {
  const views = setupViews && typeof setupViews === "object" ? setupViews : {};
  return sites.length
    ? sites
        .map((site) => {
          const setup = describeSetup(Object.prototype.hasOwnProperty.call(views, site.id) ? views[site.id] : null, site.status);
          const retry = canManage && setup.retry ? ` <button class="btn"${onClick("lummetRetrySetup", [site.id])}>Retry</button>` : "";
          return `
          <tr id="${escapeHtml(site.id)}">
            <td>${escapeHtml(site.name)}</td>
            <td>${escapeHtml(site.product_name || "")}</td>
            <td><span class="badge badge-${escapeHtml(site.status)}">${escapeHtml(site.status === "suspended" && site.suspended_by === "customer_user" ? "paused" : site.status)}</span></td>
            <td class="mono">${escapeHtml(site.primary_domain || siteHosts[site.id] || "—")}</td>
            <td>${escapeHtml(site.app_version || "—")}</td>
            <td>${escapeHtml(setup.text)}${retry}</td>
            <td class="actions">${canManage ? actionsFor(site) : "—"}</td>
          </tr>`;
        })
        .join("")
    : `<tr><td colspan="7" class="empty">No sites yet — create one below.</td></tr>`;
}

/** True while any site is in flight (being set up, deployed or deleted) or has a first setup waiting to apply: the page refreshes itself quickly. */
export function sitesAreBusy(sites, setupViews = null) {
  const views = setupViews && typeof setupViews === "object" ? setupViews : {};
  return sites.some((s) => SITE_TRANSIENT.has(s.status) || (s.status === "active" && views[s.id]?.status === "pending"));
}

export function renderSitesPage({ sites, products, canManage, setupOptions = null, setupViews = null, platformDomains = [], siteHosts = {}, organizationId = null }) {
  const rows = renderSiteRows({ sites, canManage, setupViews, siteHosts });
  const liveSrc = organizationId ? `/api/organizations/${encodeURIComponent(organizationId)}/sites/live-rows` : null;

  const productOptions = products
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join("");


  const domainList = Array.isArray(platformDomains) ? platformDomains : [];
  const domainBlock = domainList.length
    ? `
          ${domainList.length > 1
            ? `<label for="site-domain">Domain</label>
          <select id="site-domain">${domainList.map((d) => `<option value="${escapeHtml(d.id)}" data-host="${escapeHtml(d.hostname)}"${d.isDefault ? " selected" : ""}>${escapeHtml(d.label)} (.${escapeHtml(d.hostname)})</option>`).join("")}</select>`
            : `<input type="hidden" id="site-domain" value="${escapeHtml(domainList[0].id)}" data-host="${escapeHtml(domainList[0].hostname)}" />`}
          `
    : "";

  const addressBlock = `
          <label for="site-subdomain">Site address</label>
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
            <input type="text" id="site-subdomain" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="40" aria-describedby="site-address-status" style="flex:1;min-width:140px" />
            <span id="site-address-suffix" class="mono"></span>
          </div>
          <p id="site-address-status" class="subtitle" aria-live="polite"></p>
          <div id="site-address-suggest" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px"></div>`;

  const createForm = canManage
    ? `
      <div class="card">
        <h2>Create a site</h2>
        <form id="create-site-form">
          <label for="site-name">Site name</label>
          <input type="text" id="site-name" required />
          <label for="site-product">Product</label>
          <select id="site-product" required>${productOptions}</select>${domainBlock}${addressBlock}${setupSection(setupOptions, products)}
          <button class="btn" type="submit">Create site</button>
        </form>
      </div>`
    : "";

  const deleteDialog = canManage
    ? `
    <dialog id="delete-site-dialog" aria-labelledby="delete-site-title" style="max-width:520px;width:calc(100% - 32px)">
      <h2 id="delete-site-title">Delete this site?</h2>
      <p>This permanently deletes <strong id="delete-site-name"></strong> and everything on it: its content, database, media files and stored backups. Its custom domains are disconnected. <strong>This cannot be undone.</strong></p>
      <p>Its address <span class="mono" id="delete-site-host"></span> becomes available to anyone once the deletion finishes, usually within a few minutes.</p>
      <label for="delete-site-confirm">Type <strong id="delete-site-name-again"></strong> to confirm</label>
      <input type="text" id="delete-site-confirm" autocomplete="off" spellcheck="false" />
      <p id="delete-site-error" class="subtitle" role="alert"></p>
      <button type="button" class="btn" id="delete-site-cancel">Cancel</button>
      <button type="button" class="btn btn-danger" id="delete-site-go" disabled>Delete site permanently</button>
    </dialog>`
    : "";
  const deleting = sites.some((x) => x.status === "deleting");

  return `
    <h1>Sites</h1>
    <p class="subtitle">Every site this organization owns, and its current lifecycle status.</p>

    ${deleting ? `<p class="subtitle">Sites marked <strong>deleting</strong> are being removed. This takes a few minutes; their addresses become available again when it finishes.</p>` : ""}
    <div class="card">
      <table>
        <thead><tr><th>Name</th><th>Product</th><th>Status</th><th>Domain</th><th>Version</th><th>Setup</th><th>Actions</th></tr></thead>
        <tbody id="sites-live"${liveSrc ? liveAttrs(liveSrc, rows) : ""}>${rows}</tbody>
      </table>
    </div>

    ${createForm}
    ${deleteDialog}

    <script nonce="${nonceToken()}">
      function lummetActiveOrgId() {
        var el = document.getElementById('org-switcher');
        return el ? el.value : null;
      }

      function lummetProvision(siteId) {
        fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/provision', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) { lummetRefreshRows(); }
            else { alert('Could not start provisioning: ' + (data.error || 'unknown error')); }
          });
      }

      function lummetRetryProvision(siteId) {
        fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/retry-provisioning', { method: 'POST' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) { lummetRefreshRows(); }
            else { alert('Could not retry provisioning: ' + (data.error || 'unknown error')); }
          });
      }

      function lummetRetrySetup(siteId) {
        fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + siteId + '/setup/retry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.success) { lummetRefreshRows(); }
            else { alert('Could not retry the setup: ' + (data.error || 'unknown error')); }
          });
      }

      function lummetCreateBody() {
        var body = { name: document.getElementById('site-name').value, productId: document.getElementById('site-product').value };
        var dom = document.getElementById('site-domain');
        if (dom && dom.value) { body.platformDomainId = dom.value; }
        var sub = document.getElementById('site-subdomain');
        if (sub && sub.value) { body.subdomain = sub.value; }
        var p = document.getElementById('site-preset');
        var c = document.getElementById('site-clone');
        if (c && c.value) { body.cloneFromSiteId = c.value; }
        else if (p && p.value) { body.preset = p.value; }
        return body;
      }


      // ---- Site address: follows the site name until the customer types their own, and is checked live against the database. ----
      // A taken address is never changed for the customer: they see that it is taken, and pick another word or another domain.
      function lummetSlug(n) { return String(n || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 40).replace(/-+$/, ''); }
      var addrTouched = false, addrOk = null, addrSeq = 0, addrTimer = null;
      function lummetDomainEl() { return document.getElementById('site-domain'); }
      function lummetDomainOpt() { var d = lummetDomainEl(); return d ? (d.tagName === 'SELECT' ? d.options[d.selectedIndex] : d) : null; }
      function lummetDomainHost() { var o = lummetDomainOpt(); return o ? (o.getAttribute('data-host') || '') : ''; }
      function lummetAddrStatus(text, kind) {
        var out = document.getElementById('site-address-status');
        if (!out) { return; }
        out.textContent = text || '';
        out.style.color = kind === 'bad' ? 'var(--danger, #b42318)' : kind === 'good' ? 'var(--success, #067647)' : '';
      }
      function lummetChip(text, onPick) {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn'; b.textContent = text;
        b.addEventListener('click', onPick);
        return b;
      }
      function lummetRenderSuggestions(d) {
        var box = document.getElementById('site-address-suggest');
        if (!box) { return; }
        while (box.firstChild) { box.removeChild(box.firstChild); }
        var subEl = document.getElementById('site-subdomain');
        (d.suggestions || []).forEach(function (s) {
          box.appendChild(lummetChip(s.host || s.label, function () { subEl.value = s.label; addrTouched = true; lummetCheckAddress(); }));
        });
        (d.otherDomains || []).forEach(function (o) {
          box.appendChild(lummetChip('Keep ' + d.label + ' on ' + o.hostname, function () {
            var dom = lummetDomainEl();
            if (dom && dom.tagName === 'SELECT') { dom.value = o.id; }
            lummetAfterDomainChange();
          }));
        });
      }
      function lummetApplyCheck(d) {
        var host = d.host || ((d.label || '') + '.' + lummetDomainHost());
        addrOk = !!d.available;
        if (d.available) { lummetAddrStatus('\u2713 ' + host + ' is available.', 'good'); }
        else if (d.reason === 'taken') {
          var hasAlt = (d.suggestions && d.suggestions.length) || (d.otherDomains && d.otherDomains.length);
          lummetAddrStatus('\u2717 ' + host + ' has already been taken. Try another name' + (hasAlt ? ', or pick one of these:' : '.'), 'bad');
        } else { lummetAddrStatus('\u2717 ' + (d.message || 'That address cannot be used.'), 'bad'); }
        lummetRenderSuggestions(d);
      }
      function lummetCheckAddress() {
        var subEl = document.getElementById('site-subdomain');
        var suffix = document.getElementById('site-address-suffix');
        if (!subEl) { return; }
        if (suffix) { var h = lummetDomainHost(); suffix.textContent = h ? '.' + h : ''; }
        var label = subEl.value;
        lummetRenderSuggestions({});
        if (!label) { addrOk = null; lummetAddrStatus(''); return; }
        var seq = ++addrSeq;
        addrOk = null;
        lummetAddrStatus('Checking\u2026');
        var dom = lummetDomainEl();
        var q = '?label=' + encodeURIComponent(label) + (dom && dom.value ? '&platformDomainId=' + encodeURIComponent(dom.value) : '');
        fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/name-check' + q)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (seq !== addrSeq) { return; }
            if (data && data.success) { lummetApplyCheck(data.data); }
            else { addrOk = null; lummetAddrStatus(''); }
          })
          .catch(function () { if (seq === addrSeq) { addrOk = null; lummetAddrStatus(''); } });
      }
      function lummetCheckSoon() { clearTimeout(addrTimer); addrOk = null; addrTimer = setTimeout(lummetCheckAddress, 300); }
      function lummetAfterDomainChange() { lummetCheckAddress(); }
      (function () {
        var dom = lummetDomainEl();
        var nameEl = document.getElementById('site-name');
        var subEl = document.getElementById('site-subdomain');
        if (!subEl) { return; }
        if (dom) { dom.addEventListener('change', lummetAfterDomainChange); }
        if (nameEl) { nameEl.addEventListener('input', function () { if (!addrTouched) { subEl.value = lummetSlug(nameEl.value); lummetCheckSoon(); } }); }
        subEl.addEventListener('input', function () { addrTouched = true; subEl.value = subEl.value.toLowerCase().replace(/\s+/g, '-'); lummetCheckSoon(); });
        var suffix = document.getElementById('site-address-suffix');
        if (suffix) { var h = lummetDomainHost(); suffix.textContent = h ? '.' + h : ''; }
      })();

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
          if (addrOk === false) { var se = document.getElementById('site-subdomain'); if (se) { se.focus(); } return; }
          fetch('/api/organizations/' + lummetActiveOrgId() + '/sites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(lummetCreateBody())
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.success) { location.reload(); }
              else if (data.reason) { lummetApplyCheck({ available: false, reason: data.reason, message: data.message, label: data.label, host: data.host, suggestions: data.suggestions, otherDomains: data.otherDomains }); var se2 = document.getElementById('site-subdomain'); if (se2) { se2.focus(); } }
              else { alert('Could not create site: ' + (data.error === 'invalid_platform_domain' ? 'that domain is not available. Choose another.' : (data.error || 'unknown error'))); }
            });
        });
      }

      // ---- Delete a site: typed-name confirmation, enforced again by the server. ----
      var delState = { id: null, name: '' };
      function lummetOpenDelete(siteId, siteName, host) {
        var dlg = document.getElementById('delete-site-dialog');
        if (!dlg) { return; }
        delState = { id: siteId, name: String(siteName) };
        ['delete-site-name', 'delete-site-name-again'].forEach(function (id) { document.getElementById(id).textContent = delState.name; });
        document.getElementById('delete-site-host').textContent = host || '';
        document.getElementById('delete-site-confirm').value = '';
        document.getElementById('delete-site-error').textContent = '';
        document.getElementById('delete-site-go').disabled = true;
        if (typeof dlg.showModal === 'function') { dlg.showModal(); } else { dlg.setAttribute('open', ''); }
        document.getElementById('delete-site-confirm').focus();
      }
      (function () {
        var dlg = document.getElementById('delete-site-dialog');
        if (!dlg) { return; }
        var input = document.getElementById('delete-site-confirm');
        var go = document.getElementById('delete-site-go');
        var err = document.getElementById('delete-site-error');
        function close() { if (typeof dlg.close === 'function') { dlg.close(); } else { dlg.removeAttribute('open'); } }
        document.getElementById('delete-site-cancel').addEventListener('click', close);
        input.addEventListener('input', function () { go.disabled = input.value.trim() !== delState.name.trim(); });
        var MSG = { confirmation_required: 'The name you typed does not match.', site_busy: 'This site is still being set up. Wait until that finishes or fails, then delete it.', site_already_deleting: 'This site is already being deleted.', site_not_found: 'This site no longer exists.' };
        go.addEventListener('click', function () {
          go.disabled = true; err.textContent = '';
          fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + encodeURIComponent(delState.id), {
            method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmName: input.value })
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.success) {
                close();
                if (data.requiresApproval) { alert('Deletion requested. Another admin of this organization must approve it before anything is removed.'); }
                lummetRefreshRows();
              } else { err.textContent = MSG[data.error] || ('Could not delete the site: ' + (data.error || 'unknown error')); go.disabled = false; }
            })
            .catch(function () { err.textContent = 'Could not reach the server. Try again.'; go.disabled = false; });
        });
      })();

      // After an action, fetch the rows again right now (no page reload, no flash); fall back to a reload if the live runtime is missing.
      function lummetRefreshRows() {
        var tb = document.getElementById('sites-live');
        if (window.lummetLiveRefresh && tb && tb.getAttribute('data-live-src')) { window.lummetLiveRefresh(tb); } else { location.reload(); }
      }
      // ---- Pause / resume a live site (a pause takes it offline without deleting anything). ----
      var PAUSE_MSG = { already_paused: 'This site is already paused.', site_not_live: 'Only a live site can be paused.', suspended_by_lummet: 'Lummet suspended this site, so it cannot be resumed here. Contact support.', organization_not_active: 'Your organization is not active, so sites cannot be resumed. Check billing.', not_paused: 'This site is not paused.', site_not_found: 'This site no longer exists.' };
      function lummetSiteAction(siteId, action, okReload) {
        return fetch('/api/organizations/' + lummetActiveOrgId() + '/sites/' + encodeURIComponent(siteId) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (data.success) { if (okReload) { lummetRefreshRows(); } } else { alert(PAUSE_MSG[data.error] || ('Could not complete that: ' + (data.error || 'unknown error'))); } })
          .catch(function () { alert('Could not reach the server. Try again.'); });
      }
      function lummetPauseSite(siteId, siteName) {
        if (confirm('Pause ' + siteName + '? Visitors will no longer see the site until you resume it. Nothing is deleted.')) { lummetSiteAction(siteId, 'pause', true); }
      }
      function lummetResumeSite(siteId) { lummetSiteAction(siteId, 'resume', true); }
    </script>
  `;
}
