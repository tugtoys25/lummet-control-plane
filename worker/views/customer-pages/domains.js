// =====================================================
// CUSTOMER DOMAINS PAGE (master prompt section 20; roadmap 1.1; v1 nameserver flow)
//
// Two kinds of rows live here:
//   * Delegated domains (v1, the default): the customer enters their root domain, gets the two Cloudflare nameservers
//     to set at their registrar, and this page tracks the rest — nameservers detected, Cloudflare confirmation,
//     connecting the site, HTTPS certificate, live — refreshing itself while anything is still in progress.
//   * Earlier TXT-verified domains (method "txt"): still listed with their old actions.
//
// All data from the database is escaped here; the page script only ever builds DOM nodes with textContent, never
// innerHTML from server data.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

const STATUS_LABEL = {
  awaiting_nameservers: "Waiting for nameservers",
  pending: "Pending verification",
  dns_verified: "Connecting",
  ssl_pending: "Issuing HTTPS certificate",
  active: "Live",
  failed: "Failed",
  removed: "Removed"
};

export const PHASE_LABEL = {
  awaiting_nameservers: "Waiting for your nameserver change",
  awaiting_dns: "Waiting for your DNS records",
  nameservers_detected: "Nameservers detected, waiting for Cloudflare",
  attaching: "Connecting your site",
  issuing_certificates: "Issuing the HTTPS certificate",
  live: "Live",
  failed: "Failed",
  expired: "Expired"
};

const ERROR_MESSAGES = {
  invalid_domain: "That does not look like a valid domain. Enter it like example.com.",
  domain_reserved: "That domain cannot be connected.",
  not_a_root_domain: "Enter the main domain (example.com), not a subdomain.",
  domain_unavailable: "That domain is already set up on another Cloudflare account. Remove it there first, or contact support.",
  domain_already_connected: "That domain is already connected to a site on Lummet.",
  hostname_already_in_use: "That domain or its www address is already connected to a site on Lummet.",
  domain_limit_reached: "Your plan's custom domain limit is reached. Upgrade your plan or remove a domain first.",
  site_not_ready: "Your site is still being set up. Try again once it is active.",
  nameservers_still_delegated: "This domain still uses the Lummet nameservers. Removing it now would take your website AND email offline. Change the nameservers back at your registrar first.",
  hostname_managed_by_lummet: "That address is managed by Lummet and cannot be edited here.",
  record_exists: "That record already exists.",
  record_outside_domain: "That name is outside your domain.",
  invalid_record_content: "The record value is not valid for that type.",
  invalid_record_priority: "Enter a priority between 0 and 65535.",
  cname_at_root_not_allowed: "A CNAME cannot be set on the main domain itself.",
  unsupported_record_type: "That record type is not supported here.",
  provider_error: "The DNS provider did not accept that just now. Please try again in a minute.",
  forbidden: "You need to be an administrator to do that.",
  rate_limited: "Please wait a moment and try again.",
  apex_needs_nameservers: "That is a main domain. Choose \"Whole domain\" to connect it, or enter a subdomain such as shop.example.com.",
  domain_belongs_to_another_account: "That domain is already connected to another Lummet account.",
  zone_belongs_to_another_site: "That domain's DNS is already managed for a different site in your account. Add the subdomain from that site's settings, or remove the domain there first.",
  custom_hostnames_not_configured: "Connecting a single subdomain is not available yet on this platform. Please contact support.",
  subdomain_flow_disabled: "Connecting a single subdomain is turned off on this platform. Connect the whole domain instead, or contact support."
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

const STEP_ICON = { done: "&#10003;", current: "&#9679;", todo: "&#9675;", failed: "&#10007;" };

function stepsHtml(progress) {
  return `<ol class="domain-steps">${progress.steps.map((st) => `
    <li class="domain-step domain-step-${escapeHtml(st.state)}">
      <span class="domain-step-icon">${STEP_ICON[st.state] || ""}</span>
      <span class="domain-step-label">${escapeHtml(st.label)}</span>
      ${st.detail ? `<span class="domain-step-detail">${escapeHtml(st.detail)}</span>` : ""}
    </li>`).join("")}</ol>`;
}

function nameserverBox(zone) {
  const rows = zone.name_servers.map((ns) => `
      <div class="ns-row"><code class="mono">${escapeHtml(ns)}</code>
        <button class="btn"${onClick("lummetCopy", [ns])}>Copy</button></div>`).join("");
  return `
    <div class="domain-instructions">
      <h3>Set these nameservers at your registrar</h3>
      <div class="ns-list">${rows}</div>
      <ol class="domain-howto">
        <li>Sign in where you bought the domain (GoDaddy, Namecheap, Google Domains, Cloudflare Registrar, your hosting company, &hellip;).</li>
        <li>Open the domain's <b>Nameservers</b> (sometimes called <b>DNS</b> or <b>DNS servers</b>) settings.</li>
        <li>Choose <b>Custom nameservers</b> and <b>replace</b> the existing ones with the two above (remove any others).</li>
        <li>Save. It can take a few minutes, and up to 48 hours. This page updates by itself, so you can leave it open.</li>
      </ol>
      <p class="muted"><b>DNSSEC turned on?</b> If your registrar has DNSSEC enabled for this domain, switch it off (remove the DS record) before changing nameservers, or the domain will stop resolving for many visitors. DNSSEC is not set up for domains connected this way.</p>
      <p class="muted"><b>Using email on this domain?</b> Open <i>DNS records</i> below first and make sure your email records (MX and TXT) are listed. Moving nameservers moves <i>all</i> of the domain's DNS to Lummet; anything missing stops working.</p>
    </div>`;
}

function hostnameRows(zone, hostnames, canManage) {
  return hostnames.map((h) => {
    const bits = [];
    if (canManage && h.status === "active" && !h.is_primary) bits.push(`<button class="btn"${onClick("lummetDomainAction", [h.id, "set-primary"])}>Set primary</button>`);
    if (canManage) bits.push(`<button class="btn btn-danger"${onClick("lummetRemoveDomain", [h.id])}>Remove</button>`);
    const live = h.status === "active" ? `<a href="https://${escapeHtml(h.hostname)}/" target="_blank" rel="noopener">${escapeHtml(h.hostname)}</a>` : escapeHtml(h.hostname);
    return `<tr id="domain-${escapeHtml(h.id)}">
      <td class="mono">${live}${h.is_primary ? ' <span class="badge">primary</span>' : ""}</td>
      <td><span class="badge badge-${escapeHtml(h.status)}">${escapeHtml(STATUS_LABEL[h.status] || h.status)}</span>${h.failure_reason ? `<div class="muted">${escapeHtml(String(h.failure_reason).slice(0, 120))}</div>` : ""}</td>
      <td>${escapeHtml(h.ssl_status)}</td>
      <td class="actions">${bits.join(" ") || "—"}</td></tr>`;
  }).join("");
}


function subdomainCard(v, canManage) {
  const { domain, instructions, progress, events } = v;
  const phase = progress.phase;
  const inProgress = !["live", "failed"].includes(phase);
  const expires = domain.expires_at ? new Date(String(domain.expires_at)).toISOString().slice(0, 10) : null;
  const rows = (instructions || []).map((r) => `
      <tr><td>${escapeHtml(r.type)}</td><td class="mono">${escapeHtml(r.name)}</td>
        <td class="mono">${escapeHtml(r.value)}</td>
        <td><button class="btn"${onClick("lummetCopy", [r.value])}>Copy</button></td></tr>
      ${r.note ? `<tr><td></td><td colspan="3" class="muted">${escapeHtml(r.note)}</td></tr>` : ""}`).join("");
  const records = inProgress && instructions && instructions.length ? `
    <div class="domain-instructions">
      <h3>Add these DNS records at your DNS provider</h3>
      <table><thead><tr><th>Type</th><th>Name</th><th>Value</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <p class="muted">Your DNS provider may want just the first part of the name (for example <span class="mono">shop</span> instead of <span class="mono">shop.example.com</span>). Records can take a few minutes to appear. This page updates by itself.</p>
      ${expires && phase === "awaiting_dns" ? `<p class="muted">If the records are not found by ${escapeHtml(expires)}, this request is cancelled automatically.</p>` : ""}
    </div>` : "";
  const actions = canManage ? `
      <div class="domain-zone-actions">
        ${inProgress ? `<button class="btn"${onClick("lummetCheckSubdomain", [domain.id])}>Check now</button>` : ""}
        <button class="btn btn-danger"${onClick("lummetRemoveDomain", [domain.id])}>${phase === "failed" ? "Dismiss" : "Remove"}</button>
      </div>` : "";
  const failed = phase === "failed" ? `<div class="flash flash-error">Connecting this subdomain stopped: ${escapeHtml(String(domain.failure_reason || "unknown reason").replace(/_/g, " "))}. Dismiss it and add it again once the DNS records are in place.</div>` : "";
  const note = domain.failure_reason && phase !== "failed" ? `<p class="muted">${escapeHtml(String(domain.failure_reason).slice(0, 140))}</p>` : "";
  const recent = (events || []).slice(0, 6).map((e) => `<li><span class="muted">${escapeHtml(String(e.created_at || "").slice(0, 16))}</span> ${escapeHtml(String(e.kind).replace(/_/g, " "))}${e.detail ? ` &mdash; ${escapeHtml(e.detail)}` : ""}</li>`).join("");
  const host = phase === "live" ? `<a href="https://${escapeHtml(domain.hostname)}/" target="_blank" rel="noopener">${escapeHtml(domain.hostname)}</a>` : escapeHtml(domain.hostname);
  return `
    <div class="card domain-zone" data-zone-id="${escapeHtml(domain.id)}" data-kind="subdomain" data-phase="${escapeHtml(phase)}">
      <div class="domain-zone-head">
        <h2 class="mono">${host}</h2>${domain.is_primary ? ' <span class="badge">primary</span>' : ""}
        <span class="badge badge-${escapeHtml(phase)}">${escapeHtml(PHASE_LABEL[phase] || phase)}</span>
      </div>
      ${stepsHtml(progress)}
      ${failed}${note}${records}${actions}
      ${recent ? `<details class="domain-history"><summary>Activity</summary><ul>${recent}</ul></details>` : ""}
    </div>`;
}

function zoneCard(v, canManage) {
  const { zone, hostnames, progress, events } = v;
  const phase = progress.phase;
  const inProgress = !["live", "failed", "expired"].includes(phase);
  const waiting = phase === "awaiting_nameservers" || phase === "nameservers_detected";
  const expires = zone.expires_at ? new Date(String(zone.expires_at)).toISOString().slice(0, 10) : null;

  const manage = canManage ? `
      <div class="domain-zone-actions">
        ${inProgress ? `<button class="btn"${onClick("lummetCheckZone", [zone.id])}>Check now</button>` : ""}
        <button class="btn"${onClick("lummetToggleRecords", [zone.id])}>DNS records</button>
        <button class="btn btn-danger"${onClick("lummetRemoveZone", [zone.id, zone.status])}>${phase === "expired" || phase === "failed" ? "Dismiss" : "Remove domain"}</button>
      </div>` : "";

  const recent = (events || []).slice(0, 6).map((e) => `<li><span class="muted">${escapeHtml(String(e.created_at || "").slice(0, 16))}</span> ${escapeHtml(e.kind.replace(/_/g, " "))}${e.detail ? ` &mdash; ${escapeHtml(e.detail)}` : ""}</li>`).join("");

  const failedNote = phase === "failed" ? `<div class="flash flash-error">Setting up this domain stopped: ${escapeHtml(zone.failure_reason || "unknown reason")}. Dismiss it and add the domain again, or contact support.</div>` : "";
  const expiredNote = phase === "expired" ? `<div class="flash flash-error">The nameservers were not changed in time, so this request was cancelled and nothing was changed on your domain. You can add it again at any time.</div>` : "";

  return `
    <div class="card domain-zone" data-zone-id="${escapeHtml(zone.id)}" data-phase="${escapeHtml(phase)}">
      <div class="domain-zone-head">
        <h2 class="mono">${escapeHtml(zone.zone_name)}</h2>
        <span class="badge badge-${escapeHtml(phase)}">${escapeHtml(PHASE_LABEL[phase] || phase)}</span>
      </div>
      ${stepsHtml(progress)}
      ${failedNote}${expiredNote}
      ${waiting ? nameserverBox(zone) : ""}
      ${waiting && expires ? `<p class="muted">If the nameservers are not changed by ${escapeHtml(expires)}, this request is cancelled automatically.</p>` : ""}
      ${hostnames.length && !["expired"].includes(phase) ? `
      <table>
        <thead><tr><th>Address</th><th>Status</th><th>HTTPS</th><th>Actions</th></tr></thead>
        <tbody>${hostnameRows(zone, hostnames, canManage)}</tbody>
      </table>` : ""}
      ${manage}
      <div class="domain-records" id="records-${escapeHtml(zone.id)}" hidden></div>
      ${recent ? `<details class="domain-history"><summary>Activity</summary><ul>${recent}</ul></details>` : ""}
    </div>`;
}

export function renderDomainsPage({ sites, domainsBySite, zonesBySite = {}, subdomainsBySite = {}, canManage }) {
  const siteOptions = sites.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");

  const sections = sites.length
    ? sites.map((site) => {
        const zones = zonesBySite[site.id] || [];
        const legacy = domainsBySite[site.id] || [];
        const subs = subdomainsBySite[site.id] || [];
        const zoneCards = zones.map((v) => zoneCard(v, canManage)).join("") + subs.map((v) => subdomainCard(v, canManage)).join("");
        const legacyTable = legacy.length ? `
          <div class="card">
            <h3>Other domains</h3>
            <table>
              <thead><tr><th>Domain</th><th>Status</th><th>SSL</th><th>Actions</th></tr></thead>
              <tbody>${legacy.map((d) => `
                <tr id="domain-${escapeHtml(d.id)}">
                  <td class="mono">${escapeHtml(d.hostname)}${d.is_primary ? ' <span class="badge">primary</span>' : ""}</td>
                  <td><span class="badge badge-${escapeHtml(d.status)}">${escapeHtml(STATUS_LABEL[d.status] || d.status)}</span></td>
                  <td>${escapeHtml(d.ssl_status)}</td>
                  <td class="actions">${actionsFor(d, canManage)}</td>
                </tr>`).join("")}</tbody>
            </table>
          </div>` : "";
        const empty = !zones.length && !subs.length && !legacy.length ? `<div class="card"><p class="empty">No custom domain on ${escapeHtml(site.name)} yet. Your site is available at <span class="mono">${escapeHtml(site.primary_domain || "its Lummet address")}</span>.</p></div>` : "";
        return `<h2 class="domain-site-title">${escapeHtml(site.name)}</h2>${zoneCards}${legacyTable}${empty}`;
      }).join("")
    : `<div class="card"><p class="empty">Create a site first, then come back here to add a custom domain.</p></div>`;

  const addForm = canManage && sites.length
    ? `
      <div class="card">
        <h2>Connect your domain</h2>
        <form id="add-zone-form">
          <label for="zone-site">Site</label>
          <select id="zone-site" required>${siteOptions}</select>
          <fieldset class="domain-mode">
            <label><input type="radio" name="zone-mode" value="whole" checked /> <b>Whole domain</b> (example.com) &mdash; you change the domain's nameservers once; the site goes live on <b>example.com</b> and <b>www.example.com</b>, HTTPS included.</label>
            <label><input type="radio" name="zone-mode" value="sub" /> <b>One subdomain</b> (shop.example.com) &mdash; your DNS stays where it is (any provider, including your own Cloudflare account). You add a CNAME and a TXT record. If the domain is already connected to this site, it is added there instantly.</label>
          </fieldset>
          <label for="zone-domain">Your domain or subdomain</label>
          <input type="text" id="zone-domain" placeholder="example.com or shop.example.com" autocomplete="off" required />
          <button class="btn" type="submit">Connect</button>
        </form>
        <div id="zone-add-result"></div>
      </div>`
    : "";

  return `
    <h1>Domains</h1>
    <p class="subtitle">Put your site on your own domain. Add the whole domain and change its nameservers, or connect a single subdomain with two DNS records. We take care of the rest, and progress shows here.</p>

    ${sections}
    ${addForm}


    <script nonce="${nonceToken()}">
      var LUMMET_DOMAIN_MESSAGES = ${JSON.stringify(ERROR_MESSAGES)};
      function lummetActiveOrgId() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }
      function lummetMsg(code) { return LUMMET_DOMAIN_MESSAGES[code] || code || 'unknown error'; }
      function lummetApi(method, path, body) {
        var opts = { method: method, headers: {} };
        if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
        return fetch('/api/organizations/' + lummetActiveOrgId() + path, opts).then(function (r) { return r.json().catch(function () { return { success: false, error: 'bad_response' }; }); });
      }
      function lummetNode(tag, text, cls) { var n = document.createElement(tag); if (text !== undefined && text !== null) n.textContent = String(text); if (cls) n.className = cls; return n; }

      function lummetCopy(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(function () {});
      }

      /* ---- earlier TXT-verified domains and hostname rows ---- */
      function lummetDomainAction(domainId, action) {
        lummetApi('POST', '/domains/' + domainId + '/' + action).then(function (data) {
          if (data.success) location.reload(); else alert('Could not complete this: ' + lummetMsg(data.error));
        });
      }
      function lummetRemoveDomain(domainId) {
        if (!confirm('Remove this address? It will stop serving your site.')) return;
        lummetApi('DELETE', '/domains/' + domainId).then(function (data) {
          if (data.success) location.reload(); else alert('Could not remove it: ' + lummetMsg(data.error));
        });
      }

      /* ---- delegated domains ---- */
      var zoneForm = document.getElementById('add-zone-form');
      if (zoneForm) {
        zoneForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var siteId = document.getElementById('zone-site').value;
          var domain = document.getElementById('zone-domain').value;
          var mode = (document.querySelector('input[name="zone-mode"]:checked') || {}).value;
          var box = document.getElementById('zone-add-result');
          box.textContent = 'Setting up ' + domain + '\u2026';
          var call = mode === 'sub'
            ? lummetApi('POST', '/sites/' + siteId + '/subdomains', { hostname: domain })
            : lummetApi('POST', '/sites/' + siteId + '/domain-zones', { domain: domain });
          call.then(function (data) {
            if (!data.success) { box.textContent = ''; alert('Could not add it: ' + lummetMsg(data.error)); return; }
            location.reload();
          });
        });
      }

      function lummetCheckSubdomain(domainId) {
        lummetApi('POST', '/subdomains/' + domainId + '/check').then(function (data) {
          if (!data.success) { alert('Could not check just now: ' + lummetMsg(data.error)); return; }
          location.reload();
        });
      }

      function lummetCheckZone(zoneId) {
        lummetApi('POST', '/domain-zones/' + zoneId + '/check').then(function (data) {
          if (!data.success) { alert('Could not check just now: ' + lummetMsg(data.error)); return; }
          location.reload();
        });
      }

      function lummetRemoveZone(zoneId, status) {
        var warn = status === 'active'
          ? 'Remove this domain from Lummet?\\n\\nBefore you do: change the nameservers back at your registrar. If you do not, the whole domain (website AND email) stops working.\\n\\nHave you changed them back, or do you want to remove it anyway?'
          : 'Remove this domain request?';
        if (!confirm(warn)) return;
        lummetApi('DELETE', '/domain-zones/' + zoneId).then(function (data) {
          if (data.success) { location.reload(); return; }
          if (data.error === 'nameservers_still_delegated') {
            if (confirm(lummetMsg(data.error) + '\\n\\nRemove it anyway?')) {
              lummetApi('DELETE', '/domain-zones/' + zoneId + '?acknowledge=1').then(function (d2) {
                if (d2.success) location.reload(); else alert('Could not remove it: ' + lummetMsg(d2.error));
              });
            }
            return;
          }
          alert('Could not remove it: ' + lummetMsg(data.error));
        });
      }

      /* ---- DNS records (so email and other services keep working after the move) ---- */
      function lummetToggleRecords(zoneId) {
        var box = document.getElementById('records-' + zoneId);
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false;
        lummetLoadRecords(zoneId);
      }

      function lummetLoadRecords(zoneId) {
        var box = document.getElementById('records-' + zoneId);
        box.textContent = 'Loading DNS records\u2026';
        lummetApi('GET', '/domain-zones/' + zoneId + '/records').then(function (data) {
          box.textContent = '';
          if (!data.success) { box.appendChild(lummetNode('p', 'Could not load the records: ' + lummetMsg(data.error))); return; }
          box.appendChild(lummetNode('h3', 'DNS records'));
          box.appendChild(lummetNode('p', 'These are the records Lummet will serve for your domain. Anything your domain needs (email, verification codes, other services) must be listed here before you change the nameservers.', 'muted'));

          if (data.scanned && data.scanned.length) {
            var found = lummetNode('div', null, 'flash flash-success');
            found.appendChild(lummetNode('span', 'We found ' + data.scanned.length + ' existing record(s) for your domain. '));
            var imp = lummetNode('button', 'Import them', 'btn');
            imp.type = 'button';
            imp.addEventListener('click', function () {
              lummetApi('POST', '/domain-zones/' + zoneId + '/records/import').then(function (d) {
                if (d.success) lummetLoadRecords(zoneId); else alert('Could not import: ' + lummetMsg(d.error));
              });
            });
            found.appendChild(imp);
            box.appendChild(found);
          }

          var table = document.createElement('table');
          var head = table.createTHead().insertRow();
          ['Type', 'Name', 'Value', ''].forEach(function (h) { head.appendChild(lummetNode('th', h)); });
          var body = table.createTBody();
          if (!data.records.length) {
            var er = body.insertRow(); var ec = er.insertCell(); ec.colSpan = 4; ec.textContent = 'No records yet.';
          }
          data.records.forEach(function (r) {
            var row = body.insertRow();
            row.insertCell().textContent = r.type;
            row.insertCell().textContent = r.name;
            row.insertCell().textContent = (r.priority !== null && r.priority !== undefined ? r.priority + ' ' : '') + r.content;
            var cell = row.insertCell();
            if (r.managed) { cell.textContent = 'managed by Lummet'; }
            else {
              var del = lummetNode('button', 'Delete', 'btn btn-danger'); del.type = 'button';
              del.addEventListener('click', function () {
                if (!confirm('Delete this ' + r.type + ' record?')) return;
                lummetApi('DELETE', '/domain-zones/' + zoneId + '/records/' + encodeURIComponent(r.id)).then(function (d) {
                  if (d.success) lummetLoadRecords(zoneId); else alert('Could not delete: ' + lummetMsg(d.error));
                });
              });
              cell.appendChild(del);
            }
          });
          box.appendChild(table);

          var form = document.createElement('form');
          var type = document.createElement('select');
          ['A', 'AAAA', 'CNAME', 'MX', 'TXT'].forEach(function (t) { var o = lummetNode('option', t); o.value = t; type.appendChild(o); });
          var name = document.createElement('input'); name.placeholder = 'Name (@ for the main domain)'; name.required = true;
          var content = document.createElement('input'); content.placeholder = 'Value'; content.required = true;
          var prio = document.createElement('input'); prio.placeholder = 'Priority (MX)'; prio.type = 'number'; prio.min = '0'; prio.max = '65535'; prio.style.width = '8rem';
          var add = lummetNode('button', 'Add record', 'btn'); add.type = 'submit';
          [type, name, content, prio, add].forEach(function (n) { form.appendChild(n); });
          form.addEventListener('submit', function (e) {
            e.preventDefault();
            var payload = { type: type.value, name: name.value, content: content.value };
            if (type.value === 'MX') payload.priority = Number(prio.value);
            lummetApi('POST', '/domain-zones/' + zoneId + '/records', payload).then(function (d) {
              if (d.success) lummetLoadRecords(zoneId); else alert('Could not add the record: ' + lummetMsg(d.error));
            });
          });
          box.appendChild(form);
        });
      }

      /* ---- live progress: while a domain is in progress, look again every 30 seconds (a real check runs every 60) ---- */
      (function () {
        var cards = Array.prototype.slice.call(document.querySelectorAll('.domain-zone')).filter(function (c) {
          var p = c.getAttribute('data-phase'); return p !== 'live' && p !== 'failed' && p !== 'expired';
        });
        if (!cards.length) return;
        var ticks = 0;
        setInterval(function () {
          if (document.hidden) return;
          ticks += 1;
          cards.forEach(function (card) {
            var id = card.getAttribute('data-zone-id');
            var base = card.getAttribute('data-kind') === 'subdomain' ? '/subdomains/' : '/domain-zones/';
            var call = ticks % 2 === 0 ? lummetApi('POST', base + id + '/check') : lummetApi('GET', base + id);
            call.then(function (data) {
              if (data && data.success && data.progress && data.progress.phase !== card.getAttribute('data-phase')) location.reload();
            });
          });
        }, 30000);
      })();
    </script>
  `;
}
