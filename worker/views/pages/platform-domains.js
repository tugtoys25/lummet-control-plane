// Staff console: Platform domains. Server-rendered table plus a small script. Everything that comes from data is escaped
// with h() on the server or inserted with textContent in the browser: no innerHTML with data.
import { renderShell, escapeHtml as h } from "../layout.js";
import { nonceToken, onClick, onSubmit } from "../../csp.js";

const STATUS_HELP = {
  pending: "Added, not yet verified. Cannot be used.",
  verifying: "Checks are running.",
  active: "Verified. New sites can run on it.",
  disabled: "Switched off for new sites. Existing sites keep running.",
  failed: "A check failed. See the last check for the fix."
};
const badge = (s) => `<span class="role-badge" title="${h(STATUS_HELP[s] || "")}">${h(s)}</span>`;
const short = (id) => (id ? `${String(id).slice(0, 6)}…${String(id).slice(-4)}` : "—");
const table = (heads, rows, empty) => rows.length
  ? `<table><thead><tr>${heads.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<p style="color:var(--text-dim)">${h(empty)}</p>`;

function sitesCell(d) {
  const parts = Object.entries(d.siteCounts || {}).map(([s, n]) => `${h(s)} ${n}`).join(" · ");
  return `<strong>${d.siteTotal}</strong>${parts ? `<div style="color:var(--text-dim);font-size:12px">${parts}</div>` : ""}<button class="btn"${onClick("pdSites", [d.id, d.hostname])}>Sites</button>`;
}

function actionsCell(d, i, last) {
  const b = (label, fn, args, extra = "") => `<button class="btn"${onClick(fn, args)}${extra}>${label}</button>`;
  const out = [b("Re-run checks", "pdVerify", [d.id, false]), b("Last check", "pdShowCheck", [d.id])];
  if (d.status === "active" && !d.is_default) out.push(b("Set default", "pdDefault", [d.id, d.hostname]));
  if (!d.is_default) out.push(d.status === "disabled" ? b("Enable", "pdToggle", [d.id, "enable"]) : b("Disable", "pdToggle", [d.id, "disable"]));
  out.push(b("Rename", "pdRename", [d.id, d.label]));
  out.push(b(d.allow_customer_choice ? "Customers: on" : "Customers: off", "pdChoice", [d.id, !d.allow_customer_choice]));
  out.push(b("Entitlement", "pdEntitlement", [d.id, d.entitlement_key || ""]));
  if (i > 0) out.push(b("&uarr;", "pdMove", [d.id, -1]));
  if (!last) out.push(b("&darr;", "pdMove", [d.id, 1]));
  if (!d.is_default) out.push(b("Remove", "pdRemove", [d.id, d.hostname]));
  return `<div style="display:flex;gap:4px;flex-wrap:wrap">${out.join("")}</div>`;
}

export async function renderPlatformDomainsPage(env, admin, { canManage, domains }) {
  const order = domains.map((d) => d.id);
  const rows = domains.map((d, i) => [
    `<strong>${h(d.hostname)}</strong><div style="color:var(--text-dim);font-size:12px">${h(d.label)}</div>`,
    `${badge(d.status)}${d.is_default ? ` <span class="role-badge">default</span>` : ""}`,
    `<code>${h(short(d.cf_zone_id))}</code>`,
    sitesCell(d),
    `${d.allow_customer_choice ? "on" : "off"}${d.entitlement_key ? `<div style="color:var(--text-dim);font-size:12px">needs ${h(d.entitlement_key)}</div>` : ""}`,
    h(d.last_check_at || "never"),
    canManage ? actionsCell(d, i, i === domains.length - 1) : `<button class="btn"${onClick("pdShowCheck", [d.id])}>Last check</button>`
  ]);
  const wizard = canManage ? `
    <h2>Add a domain</h2>
    <p style="color:var(--text-dim);max-width:720px">The domain must already be a zone in the platform Cloudflare account (this screen never creates zones). Adding it runs five checks: the zone, the token's permissions, a proxied wildcard record, the certificate, and a live routing test. It can only be used once all five pass.</p>
    <form${onSubmit("pdAdd", ["$el"], { prevent: true })} style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
      <input name="hostname" placeholder="example.com" required autocomplete="off" />
      <input name="label" placeholder="Label shown to people (optional)" />
      <button class="btn" type="submit">Add and run checks</button>
    </form>` : `<p style="color:var(--text-dim)">You have read-only access to Platform domains.</p>`;
  const script = `<script nonce="${nonceToken()}">
var PD = '/api/platform/domains';
var pdOrder = ${JSON.stringify(order)};
function pdCall(method, url, body) {
  return fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json(); });
}
function pdFail(d) { alert('Failed: ' + (d.detail || d.error || 'unknown')); }
function pdDone(d) { if (d.success) location.reload(); else pdFail(d); }
function pdText(parent, tag, text, style) { var e = document.createElement(tag); e.textContent = text; if (style) e.style.cssText = style; parent.appendChild(e); return e; }
var PD_COLOURS = { ok: '#2e9e5b', warn: '#d98e04', fail: '#e5484d', skipped: '#8a8f98' };
var PD_MARKS = { ok: '\\u2714', warn: '!', fail: '\\u2716', skipped: '\\u2013' };
function pdShowSteps(title, steps, domainId, needsConfirmation) {
  var box = document.getElementById('pd-steps');
  box.textContent = '';
  pdText(box, 'h3', title);
  steps.forEach(function (s) {
    var row = document.createElement('div');
    row.className = 'card';
    row.style.cssText = 'margin:6px 0;border-left:4px solid ' + (PD_COLOURS[s.state] || '#8a8f98');
    pdText(row, 'strong', PD_MARKS[s.state] + ' ' + s.label, 'color:' + (PD_COLOURS[s.state] || 'inherit'));
    if (s.detail) pdText(row, 'div', s.detail);
    if (s.fix) pdText(row, 'div', 'Fix: ' + s.fix, 'color:var(--text-dim);font-size:13px');
    box.appendChild(row);
  });
  if (needsConfirmation === 'create_wildcard' && domainId) {
    var btn = pdText(box, 'button', 'Create the wildcard record and continue');
    btn.className = 'btn';
    btn.addEventListener('click', function () { if (confirm('Create a proxied wildcard DNS record in this domain\\u2019s Cloudflare zone?')) pdVerify(domainId, true); });
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function pdVerify(id, createWildcard) {
  var box = document.getElementById('pd-steps'); box.textContent = 'Running checks\\u2026 (this calls Cloudflare and can take a few seconds)';
  pdCall('POST', PD + '/' + encodeURIComponent(id) + '/verify', { createWildcard: !!createWildcard }).then(function (d) {
    if (!d.steps) { box.textContent = ''; return pdFail(d); }
    pdShowSteps(d.passed ? 'All checks passed: the domain is active. Reload the page to see it.' : 'Checks did not all pass', d.steps, id, d.needsConfirmation);
  }).catch(function () { box.textContent = 'Could not reach the server.'; });
}
function pdShowCheck(id) {
  pdCall('GET', PD + '/' + encodeURIComponent(id)).then(function (d) {
    if (!d.success) return pdFail(d);
    var c = d.data.last_check;
    if (!c) { document.getElementById('pd-steps').textContent = 'No checks have been run yet.'; return; }
    pdShowSteps('Last check: ' + c.at + (c.passed ? ' (passed)' : ' (not passed)'), c.steps, null, null);
  });
}
function pdAdd(f) {
  pdCall('POST', PD, { hostname: f.hostname.value, label: f.label.value }).then(function (d) {
    if (!d.success) return pdFail(d);
    pdVerify(d.data.id, false);
  });
}
function pdDefault(id, host) { if (confirm('Make ' + host + ' the default? New sites choose it unless the customer picks another. Existing sites are not changed.')) pdCall('POST', PD + '/' + encodeURIComponent(id) + '/default', { confirm: true }).then(pdDone); }
function pdToggle(id, what) { pdCall('POST', PD + '/' + encodeURIComponent(id) + '/' + what).then(pdDone); }
function pdRename(id, current) { var v = prompt('Label shown to people:', current); if (v && v.trim()) pdCall('PATCH', PD + '/' + encodeURIComponent(id), { label: v.trim() }).then(pdDone); }
function pdChoice(id, on) { pdCall('PATCH', PD + '/' + encodeURIComponent(id), { allowCustomerChoice: on }).then(pdDone); }
function pdEntitlement(id, current) { var v = prompt('Entitlement key an organisation needs to pick this domain (leave empty for none):', current); if (v !== null) pdCall('PATCH', PD + '/' + encodeURIComponent(id), { entitlementKey: v.trim() }).then(pdDone); }
function pdMove(id, delta) {
  var i = pdOrder.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= pdOrder.length) return;
  pdOrder.splice(j, 0, pdOrder.splice(i, 1)[0]);
  pdCall('POST', PD + '/reorder', { ids: pdOrder }).then(pdDone);
}
function pdRemove(id, host) {
  var v = prompt('Type ' + host + ' to remove it. It is refused while any site uses it.');
  if (v) pdCall('DELETE', PD + '/' + encodeURIComponent(id), { confirmHostname: v }).then(pdDone);
}
function pdSites(id, host) {
  var box = document.getElementById('pd-sites'); box.textContent = 'Loading\\u2026';
  pdCall('GET', PD + '/' + encodeURIComponent(id) + '/sites').then(function (d) {
    box.textContent = '';
    if (!d.success) return pdFail(d);
    pdText(box, 'h3', 'Sites on ' + host + ' (' + d.data.length + (d.data.length === 100 ? '+, first 100' : '') + ')');
    if (!d.data.length) { pdText(box, 'p', 'No sites.', 'color:var(--text-dim)'); return; }
    d.data.forEach(function (s) { pdText(box, 'div', s.name + ' \\u00b7 ' + s.slug + ' \\u00b7 ' + s.status + (s.organization_name ? ' \\u00b7 ' + s.organization_name : '') + (s.primary_domain ? ' \\u00b7 ' + s.primary_domain : '')); });
  });
}
</script>`;
  return renderShell({
    title: "Platform domains", activeKey: "platform-domains", admin, env,
    bodyHtml: `<h1>Platform domains</h1>
      <p style="color:var(--text-dim);max-width:760px">The domains a new site can run on (<code>&lt;slug&gt;.&lt;domain&gt;</code>). The default is used when a customer does not choose. Disabling a domain stops new sites choosing it; sites already on it keep running. Customers can never connect any of these as their own custom domain.</p>
      ${table(["Domain", "Status", "Zone", "Sites", "Customer choice", "Last check", canManage ? "Actions" : ""], rows, "No platform domains yet.")}
      <div id="pd-sites" style="margin:12px 0"></div>
      ${wizard}
      <div id="pd-steps" aria-live="polite" style="margin-top:12px"></div>${script}`
  });
}
