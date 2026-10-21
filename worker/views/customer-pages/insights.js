// =====================================================
// CUSTOMER INSIGHT PAGES (v7F): analytics, reports, campaigns, tenant alerts, notifications, search, content.
//
// The JSON endpoints behind these already existed and were tested (tenant-portal.js proxies the site's own Super API;
// search.js; automation_alerts). This closes the "no page reaches them" gap. Pages only call those endpoints; every
// access check (membership, role, entitlement, site ownership) stays on the server, the page just explains the result.
// Handlers use the v7E data-attribute helpers; scripts carry the response nonce.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick, onSubmit, BROWSER_HELPER } from "../../csp.js";

const e = escapeHtml;

/** Client helpers shared by every page here. Only server-chosen strings are ever put in markup via esc(). */
const SHARED_SCRIPT = `
      ${BROWSER_HELPER}
      function lummetOrg() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }
      function esc(s) { return lummetEscAttr(s == null ? '' : s); }
      function val(id) { var el = document.getElementById(id); return el ? el.value : ''; }
      function enc(s) { return encodeURIComponent(s); }
      function api(path, opts) {
        return fetch('/api/organizations/' + lummetOrg() + path, opts).then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) { d.__status = r.status; return d; });
        });
      }
      function failure(d) { return '<div class="flash flash-error">' + esc(d.message || d.error || 'Something went wrong') + '</div>'; }
      function num(v) { return v == null || v === '' ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
      function rowsOf(d) { return d.rows || d.series || d.data || []; }
      function table(rows, cols) {
        if (!rows.length) return '<p class="subtitle">Nothing to show yet.</p>';
        return '<table><thead><tr>' + cols.map(function (c) { return '<th>' + esc(c[1]) + '</th>'; }).join('') + '</tr></thead><tbody>' +
          rows.map(function (r) { return '<tr>' + cols.map(function (c) { return '<td>' + (c[2] ? c[2](r) : esc(r[c[0]] == null ? '—' : r[c[0]])) + '</td>'; }).join('') + '</tr>'; }).join('') +
          '</tbody></table>';
      }
`;

function siteSelect(sites, id = "site") {
  const deployed = sites.filter((s) => s.tenant_id);
  if (!deployed.length) return null;
  return `<label>Site <select id="${id}">${deployed.map((s) => `<option value="${e(s.id)}">${e(s.name)}</option>`).join("")}</select></label>`;
}

const NO_SITE = `<div class="card"><p>None of your sites is live yet, so there is nothing to show. A site appears here as soon as it has finished setting up.</p></div>`;
const upgrade = (what) => `<div class="card"><p><strong>${e(what)} is not included in your plan.</strong> Upgrade under <a href="/app/billing">Billing</a> to use it.</p></div>`;

export function renderInsightAnalytics({ sites, entitled, canDisable = false }) {
  if (!entitled) return `<h1>Analytics</h1>${upgrade("Analytics")}`;
  const sel = siteSelect(sites);
  if (!sel) return `<h1>Analytics</h1>${NO_SITE}`;
  const today = new Date(); const from = new Date(today.getTime() - 29 * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  return `<h1>Analytics</h1>
  <p class="subtitle">Performance of one site. Revenue is never added up across currencies, so enter a currency to see the daily series.</p>
  <div class="card"><div class="filters">
    ${sel}
    <label>From <input type="date" id="start" value="${ymd(from)}" /></label>
    <label>To <input type="date" id="end" value="${ymd(today)}" /></label>
    <label>Group by <select id="dim">${["casino", "offer", "tracking_link", "partner", "program", "campaign", "review", "news", "page"].map((d) => `<option value="${d}">${d.replace("_", " ")}</option>`).join("")}</select></label>
    <label>Currency <input id="currency" maxlength="3" size="4" placeholder="EUR" /></label>
    <button class="btn btn-primary"${onClick("lummetLoadAnalytics")}>Load</button>
  </div></div>
  <div id="out"></div>
  <script nonce="${nonceToken()}">${SHARED_SCRIPT}
    var CAN_DISABLE = ${canDisable ? "true" : "false"};
    function disableAllButton(links) {
      var ids = links.filter(function (l) { return l.status !== 'disabled' && l.status !== 'unknown'; }).map(function (l) { return l.id; });
      return ids.length ? '<p><button class="btn"' + lummetAttrs('click', 'lummetDisableLinks', [ids.slice(0, 50)], { confirm: 'Disable ' + Math.min(ids.length, 50) + ' tracking link(s)? You can switch them back on in the site dashboard.' }) + '>Disable all listed (' + Math.min(ids.length, 50) + ')</button></p>' : '';
    }
    function lummetDisableLinks(ids) {
      api('/sites/' + enc(val('site')) + '/tracking-links/disable', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids }) }).then(function (d) {
        if (d.success === false || d.__status >= 400) { alert(d.message || d.error || 'Could not disable the links'); return; }
        if (d.failed) alert(d.disabled + ' disabled, ' + d.failed + ' could not be changed.');
        lummetLoadAnalytics();
      });
    }
    function lummetLoadAnalytics() {
      var out = document.getElementById('out'); out.innerHTML = '<p class="subtitle">Loading…</p>';
      var site = val('site'), range = '?start_date=' + enc(val('start')) + '&end_date=' + enc(val('end'));
      var cur = val('currency').toUpperCase();
      var calls = [api('/sites/' + enc(site) + '/analytics/overview' + range + '&dimension_type=' + enc(val('dim')) + (cur ? '&currency=' + enc(cur) : '')),
        api('/sites/' + enc(site) + '/analytics/tracking-health')];
      if (cur) calls.push(api('/sites/' + enc(site) + '/analytics/revenue' + range + '&currency=' + enc(cur)));
      Promise.all(calls).then(function (res) {
        var html = '';
        html += '<div class="card"><h3>By ' + esc(val('dim').replace('_', ' ')) + '</h3>' + (res[0].success === false || res[0].__status >= 400 ? failure(res[0]) :
          table(rowsOf(res[0]), [['name', 'Name', function (r) { return esc(r.name || r.dimensionId); }], ['views', 'Views', function (r) { return num(r.views); }], ['clicks', 'Clicks', function (r) { return num(r.clicks); }],
            ['conversions', 'Conversions', function (r) { return num(r.conversions); }], ['revenue', 'Revenue', function (r) { return num(r.revenue); }], ['commission', 'Commission', function (r) { return num(r.commission); }]])) + '</div>';
        html += '<div class="card"><h3>Tracking links</h3>' + (res[1].success === false || res[1].__status >= 400 ? failure(res[1]) :
          '<p>' + Object.keys(res[1].counts || {}).map(function (k) { return esc(k) + ': ' + num(res[1].counts[k]); }).join(' · ') + '</p>' +
          table(res[1].unhealthy_links || [], [['name', 'Link'], ['status', 'Status'],
            ['id', '', function (r) { return CAN_DISABLE && r.status !== 'disabled' && r.status !== 'unknown' ? '<button class="btn"' + lummetAttrs('click', 'lummetDisableLinks', [[r.id]], { confirm: 'Disable this tracking link? You can switch it back on in the site dashboard.' }) + '>Disable</button>' : ''; }]]) +
          (CAN_DISABLE ? disableAllButton(res[1].unhealthy_links || []) : '')) + '</div>';
        if (res[2]) html += '<div class="card"><h3>Daily revenue (' + esc(cur) + ')</h3>' + (res[2].success === false || res[2].__status >= 400 ? failure(res[2]) :
          table(rowsOf(res[2]), [['date', 'Date'], ['views', 'Views', function (r) { return num(r.views); }], ['clicks', 'Clicks', function (r) { return num(r.clicks); }], ['conversions', 'Conversions', function (r) { return num(r.conversions); }], ['revenue', 'Revenue', function (r) { return num(r.revenue); }]])) + '</div>';
        out.innerHTML = html;
      });
    }
  </script>`;
}

export function renderInsightReports({ sites, entitled, canRun }) {
  if (!entitled) return `<h1>Reports</h1>${upgrade("Reports")}`;
  const sel = siteSelect(sites);
  if (!sel) return `<h1>Reports</h1>${NO_SITE}`;
  return `<h1>Reports</h1>
  <p class="subtitle">Saved reports of the selected site${canRun ? "" : " (running a report needs the analyst role or above)"}.</p>
  <div class="card"><div class="filters">${sel}<button class="btn"${onClick("lummetLoadReports")}>Refresh</button></div></div>
  <div id="out"></div><div id="run-result"></div>
  <script nonce="${nonceToken()}">${SHARED_SCRIPT}
    var CAN_RUN = ${canRun ? "true" : "false"};
    function lummetLoadReports() {
      var out = document.getElementById('out'); out.innerHTML = '<p class="subtitle">Loading…</p>';
      api('/sites/' + enc(val('site')) + '/reports').then(function (d) {
        if (d.success === false || d.__status >= 400) { out.innerHTML = failure(d); return; }
        out.innerHTML = '<div class="card">' + table(rowsOf(d), [['name', 'Name'], ['status', 'Status'], ['created_at', 'Created'],
          ['id', '', function (r) { return CAN_RUN ? '<button class="btn"' + lummetAttrs('click', 'lummetRunReport', [String(r.id)]) + '>Run now</button>' : ''; }]]) + '</div>';
      });
    }
    function lummetRunReport(id) {
      var box = document.getElementById('run-result'); box.innerHTML = '<p class="subtitle">Running…</p>';
      api('/sites/' + enc(val('site')) + '/reports/' + enc(id) + '/run', { method: 'POST' }).then(function (d) {
        box.innerHTML = (d.success === false || d.__status >= 400) ? failure(d) : '<div class="flash flash-success">The report ran.</div>';
      });
    }
    lummetLoadReports();
  </script>`;
}

export function renderInsightCampaigns({ sites, entitled, canCreate }) {
  if (!entitled) return `<h1>Campaigns</h1>${upgrade("Campaigns")}`;
  const sel = siteSelect(sites);
  if (!sel) return `<h1>Campaigns</h1>${NO_SITE}`;
  return `<h1>Campaigns</h1>
  <p class="subtitle">Campaigns of the selected site.</p>
  <div class="card"><div class="filters">${sel}<button class="btn"${onClick("lummetLoadCampaigns")}>Refresh</button></div></div>
  <div id="out"></div>
  ${canCreate ? `<div class="card"><h3>New campaign</h3>
    <form id="new-campaign"${onSubmit("lummetCreateCampaign", ["$ev"], { prevent: true })}>
      <label>Name <input id="cname" required maxlength="120" /></label>
      <button class="btn btn-primary" type="submit">Create</button>
    </form><div id="create-result"></div></div>` : ""}
  <script nonce="${nonceToken()}">${SHARED_SCRIPT}
    function lummetLoadCampaigns() {
      var out = document.getElementById('out'); out.innerHTML = '<p class="subtitle">Loading…</p>';
      api('/sites/' + enc(val('site')) + '/campaigns').then(function (d) {
        out.innerHTML = (d.success === false || d.__status >= 400) ? failure(d) :
          '<div class="card">' + table(rowsOf(d), [['name', 'Name'], ['status', 'Status'], ['start_date', 'Starts'], ['end_date', 'Ends']]) + '</div>';
      });
    }
    function lummetCreateCampaign() {
      var box = document.getElementById('create-result');
      api('/sites/' + enc(val('site')) + '/campaigns', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: val('cname') }) }).then(function (d) {
        if (d.success === false || d.__status >= 400) { box.innerHTML = failure(d); return; }
        document.getElementById('cname').value = ''; box.innerHTML = '<div class="flash flash-success">Campaign created.</div>'; lummetLoadCampaigns();
      });
    }
    lummetLoadCampaigns();
  </script>`;
}

export function renderInsightAlerts({ sites, entitled, canAck }) {
  if (!entitled) return `<h1>Alerts</h1>${upgrade("Alerts")}`;
  const sel = siteSelect(sites);
  if (!sel) return `<h1>Alerts</h1>${NO_SITE}`;
  return `<h1>Alerts</h1>
  <p class="subtitle">Open alerts raised by the selected site's own rules (for example a tracking link going unhealthy).</p>
  <div class="card"><div class="filters">${sel}<button class="btn"${onClick("lummetLoadAlerts")}>Refresh</button></div></div>
  <div id="out"></div>
  <script nonce="${nonceToken()}">${SHARED_SCRIPT}
    var CAN_ACK = ${canAck ? "true" : "false"};
    function lummetLoadAlerts() {
      var out = document.getElementById('out'); out.innerHTML = '<p class="subtitle">Loading…</p>';
      api('/sites/' + enc(val('site')) + '/alerts').then(function (d) {
        if (d.success === false || d.__status >= 400) { out.innerHTML = failure(d); return; }
        out.innerHTML = '<div class="card">' + table(rowsOf(d), [['rule_name', 'Rule'], ['metric', 'Metric'], ['status', 'Status'], ['triggered_at', 'Raised'],
          ['id', '', function (r) { return CAN_ACK ? '<button class="btn"' + lummetAttrs('click', 'lummetAckAlert', [String(r.id)]) + '>Acknowledge</button>' : ''; }]]) + '</div>';
      });
    }
    function lummetAckAlert(id) {
      api('/sites/' + enc(val('site')) + '/alerts/' + enc(id) + '/acknowledge', { method: 'POST' }).then(function (d) {
        if (d.success === false || d.__status >= 400) alert(d.message || d.error || 'Could not acknowledge'); else lummetLoadAlerts();
      });
    }
    lummetLoadAlerts();
  </script>`;
}

export function renderInsightNotifications({ items, status, canManage }) {
  const rows = items.map((n) => `<tr>
      <td>${e(n.message)}</td><td>${e(n.rule_name || "—")}</td><td>${e(n.status)}</td><td>${e(n.created_at)}</td>
      <td>${canManage && n.status === "open" ? `<button class="btn"${onClick("lummetNotify", [n.id, "acknowledge"])}>Acknowledge</button> ` : ""}${canManage && n.status !== "resolved" ? `<button class="btn"${onClick("lummetNotify", [n.id, "resolve"])}>Resolve</button>` : ""}</td></tr>`).join("");
  return `<h1>Notifications</h1>
  <p class="subtitle">Messages from your automations. ${status === "open" ? `<a href="/app/notifications?status=all">Show all</a>` : `<a href="/app/notifications">Show open only</a>`}</p>
  <div class="card">${items.length ? `<table><thead><tr><th>Message</th><th>Rule</th><th>Status</th><th>Raised</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : `<p>No notifications${status === "open" ? " need your attention" : ""}.</p>`}</div>
  <script nonce="${nonceToken()}">${SHARED_SCRIPT}
    function lummetNotify(id, action) {
      api('/notifications/' + enc(id) + '/' + action, { method: 'POST' }).then(function (d) {
        if (d.success) location.reload(); else alert(d.error || 'Could not update the notification');
      });
    }
  </script>`;
}

export function renderInsightSearch({ query, results }) {
  const none = !results || (!results.sites.length && !results.domains.length && !results.members.length);
  const section = (title, rows) => rows.length ? `<div class="card"><h3>${e(title)}</h3><ul>${rows.join("")}</ul></div>` : "";
  return `<h1>Search</h1>
  <form method="get" action="/app/search"><input name="q" value="${e(query || "")}" placeholder="Site, domain or team member" maxlength="100" />
    <button class="btn btn-primary" type="submit">Search</button></form>
  ${!query ? "" : none ? `<p class="subtitle">No results for “${e(query)}”.</p>` : `
    ${section("Sites", results.sites.map((s) => `<li><a href="/app/sites">${e(s.name)}</a> <span class="subtitle">${e(s.slug)} · ${e(s.status)}</span></li>`))}
    ${section("Domains", results.domains.map((d) => `<li><a href="/app/domains">${e(d.hostname)}</a> <span class="subtitle">${e(d.site_name)} · ${e(d.status)}</span></li>`))}
    ${section("Team", results.members.map((m) => `<li><a href="/app/team">${e(m.full_name || m.email)}</a> <span class="subtitle">${e(m.email)} · ${e(m.role)}</span></li>`))}`}`;
}

export function renderInsightContent({ sites, email, canManage }) {
  const rows = sites.map((s) => {
    const live = s.tenant_id && s.status === "active" && s.primary_domain;
    const base = live ? `https://${s.primary_domain}` : null;
    const links = base
      ? `<a href="${e(base)}/en/dashboard" rel="noopener" target="_blank">Open dashboard</a> · <a href="${e(base)}/en/" rel="noopener" target="_blank">View site</a>`
      : "Available when the site is live";
    const form = base && canManage
      ? `<form class="dash-pw"${onSubmit("lummetSetDashboardPassword", ["$el", s.id], { prevent: true })}>
           <input type="password" name="password" minlength="12" maxlength="200" autocomplete="new-password" placeholder="Dashboard password (12+ characters)" required />
           <button class="btn" type="submit">Set dashboard password</button> <span class="dash-msg subtitle"></span></form>`
      : "";
    return `<tr><td>${e(s.name)}</td><td>${e(s.status)}</td><td>${links}${form}</td></tr>`;
  }).join("");
  return `<h1>Content</h1>
  <p class="subtitle">Pages, news, reviews, SEO, media and affiliate content are edited in each site's own dashboard.</p>
  <div class="card">${sites.length ? `<table><thead><tr><th>Site</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : "<p>You have no sites yet.</p>"}</div>
  <p class="subtitle">${canManage
    ? `Sign in to a site's dashboard with <strong>${e(email || "your email address")}</strong> and the password you set here. Setting it again replaces the password and signs you out of that dashboard.`
    : "Ask an organization admin to set up your dashboard access."}</p>
  <script nonce="${nonceToken()}">${SHARED_SCRIPT}
    function lummetSetDashboardPassword(form, siteId) {
      var msg = form.querySelector('.dash-msg'); var pw = form.elements.password;
      msg.textContent = 'Saving…';
      api('/sites/' + enc(siteId) + '/dashboard-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw.value }) }).then(function (d) {
        pw.value = '';
        msg.textContent = d.success ? 'Saved. You can sign in to the dashboard now.' :
          ({ password_length: 'Use 12 to 200 characters.', site_not_live: 'The site is not live yet.', rate_limited: 'Too many attempts. Try again later.', forbidden: 'Only organization admins can do this.' }[d.error] || 'Could not save. Try again.');
      });
    }
  </script>`;
}
