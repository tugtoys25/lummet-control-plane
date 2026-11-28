// Staff console: Custom Cloudflare hosting. The global switch, per-organization allow/deny, every site in a customer account and
// the recent moves. Data is escaped with h() on the server; the script only sends ids and reloads.
import { renderShell, escapeHtml as h } from "../layout.js";
import { nonceToken, onClick, onSubmit } from "../../csp.js";

const table = (heads, rows, empty) => rows.length
  ? `<table><thead><tr>${heads.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  : `<p style="color:var(--text-dim)">${h(empty)}</p>`;
const dim = (t) => `<div style="color:var(--text-dim);font-size:12px">${h(t)}</div>`;
const badge = (t) => `<span class="role-badge">${h(t)}</span>`;

export async function renderCustomHostingStaffPage(env, admin, { canManage, overview }) {
  const { enabled, sites, accounts, access, transfers } = overview;
  const accountCounts = accounts.map((a) => `${h(a.status)} ${Number(a.n) || 0}`).join(" · ") || "none";

  const switchBox = `
    <div class="card" style="max-width:760px">
      <h2 style="margin-top:0">Feature switch: ${enabled ? badge("on") : badge("off")}</h2>
      <p style="color:var(--text-dim)">When the switch is on, an organization can use custom Cloudflare hosting if its plan includes
      <code>hosting.custom_cloudflare.enabled</code> or staff allowed it below. Switching off (or denying an organization) only stops
      new accounts, new custom-hosted sites and new moves: sites already running in a customer's account keep deploying releases and
      stay manageable. Lummet-hosted sites are never affected.</p>
      ${canManage ? `<form${onSubmit("chSwitch", ["$el"], { prevent: true })} style="display:flex;gap:8px;flex-wrap:wrap">
        <input name="reason" placeholder="Reason (audited)" required minlength="3" style="min-width:280px" />
        <input type="hidden" name="switchTo" value="${enabled ? "off" : "on"}" />
        <button class="btn" type="submit">${enabled ? "Switch off" : "Switch on"}</button>
      </form>` : ""}
      <p style="color:var(--text-dim);font-size:13px">Customer Cloudflare accounts: ${accountCounts}.</p>
    </div>`;

  const accessForm = canManage ? `
    <form${onSubmit("chAccess", ["$el"], { prevent: true })} style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
      <input name="organization" placeholder="Organization id or exact name" required style="min-width:260px" />
      <select name="mode"><option value="allow">Allow (regardless of plan)</option><option value="deny">Deny (regardless of plan)</option><option value="default">Follow the plan</option></select>
      <input name="note" placeholder="Note (optional)" />
      <button class="btn" type="submit">Save</button>
    </form>` : "";
  const accessRows = access.map((a) => [
    `<strong>${h(a.organization_name || a.organization_id)}</strong>${dim(a.organization_id)}`,
    badge(a.mode), h(a.note || ""), h(a.updated_by || ""), h(a.updated_at || ""),
    canManage ? `<button class="btn"${onClick("chAccessSet", [a.organization_id, "default"])}>Follow the plan</button>` : ""
  ]);

  const siteRows = sites.map((s) => [
    `<strong>${h(s.site_name)}</strong>${dim(s.site_id)}`,
    `${h(s.organization_name || "")}${dim(s.organization_id || "")}`,
    `${h(s.account_label || "")}${dim(s.cf_account_id || "")}${s.account_status ? dim(`account ${s.account_status}`) : ""}`,
    `${badge(s.status)} ${badge(s.landing === "custom_domain" ? "custom domain" : "workers.dev")}`,
    `${h(s.primary_domain || s.hostname || "")}${s.domain_status && s.domain_status !== "none" ? dim(`domain ${s.domain_status}`) : ""}`,
    `${h(s.app_version || "")}${s.last_error ? `<div style="color:#e5484d;font-size:12px">${h(s.last_error)}</div>` : ""}`
  ]);

  const transferRows = transfers.map((t) => [
    `<strong>${h(t.site_name || t.site_id)}</strong>${dim(t.organization_name || "")}`,
    `${badge(t.status)}${t.error_message ? `<div style="color:#e5484d;font-size:12px">${h(t.error_message)}</div>` : ""}`,
    `${h(t.source_host || "")} &rarr; ${h(t.hostname || "workers.dev")}`,
    h(t.old_copy_status),
    `${h(t.created_at || "")}${t.completed_at ? dim(`done ${t.completed_at}`) : ""}`,
    canManage ? [
      t.status === "failed" ? `<button class="btn"${onClick("chTransfer", [t.id, "retry"])}>Retry</button>` : "",
      t.status === "completed" && ["kept", "failed"].includes(t.old_copy_status) ? `<button class="btn"${onClick("chTransfer", [t.id, "remove-old-copy"], { confirm: "Delete the Lummet copy (database, cache and media in Lummet's account) this move kept? The site in the customer's account is not touched." })}>Remove Lummet copy</button>` : ""
    ].join(" ") : ""
  ]);

  const script = `<script nonce="${nonceToken()}">
var CH = '/api/platform/custom-hosting';
function chCall(url, body) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) { return r.json(); });
}
function chDone(d) { if (d.success) location.reload(); else alert('Failed: ' + (d.message || d.error || 'unknown')); }
function chSwitch(f) {
  var v = f.elements.switchTo.value;
  if (!confirm(v === 'on' ? 'Switch custom Cloudflare hosting on? Organizations with the plan entitlement or an allow entry can then use it.' : 'Switch custom Cloudflare hosting off? Nobody can add accounts, create custom-hosted sites or start moves. Existing custom-hosted sites keep running.')) return;
  chCall(CH + '/switch', { value: v, reason: f.reason.value }).then(chDone);
}
function chAccess(f) { chCall(CH + '/access', { organization: f.organization.value.trim(), mode: f.mode.value, note: f.note.value }).then(chDone); }
function chAccessSet(org, mode) { chCall(CH + '/access', { organization: org, mode: mode }).then(chDone); }
function chTransfer(id, action) { chCall(CH + '/transfers/' + encodeURIComponent(id) + '/' + action).then(chDone); }
</script>`;

  return renderShell({
    title: "Custom Cloudflare hosting", activeKey: "custom-hosting", admin, env,
    bodyHtml: `<h1>Custom Cloudflare hosting</h1>
      <p style="color:var(--text-dim);max-width:760px">Customers can run sites in their own Cloudflare accounts instead of Lummet's. This is optional and off by default;
      Lummet hosting stays the default for everyone. Customer API tokens and keys are stored encrypted and are never shown here.</p>
      ${switchBox}
      <h2>Organization access</h2>
      <p style="color:var(--text-dim);max-width:760px">Entries here override the plan entitlement for one organization. Without an entry the plan decides.</p>
      ${accessForm}
      ${table(["Organization", "Access", "Note", "By", "Updated", ""], accessRows, "No overrides: every organization follows its plan.")}
      <h2>Sites in customer accounts (${sites.length})</h2>
      ${table(["Site", "Organization", "Cloudflare account", "Hosting", "Address", "Release"], siteRows, "No site runs in a customer account yet.")}
      <h2>Moves to customer accounts</h2>
      ${table(["Site", "Status", "Address", "Lummet copy", "When", ""], transferRows, "No moves yet.")}
      ${script}`
  });
}
