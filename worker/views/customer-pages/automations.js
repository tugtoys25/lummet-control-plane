// =====================================================
// CUSTOMER AUTOMATIONS PAGE (roadmap 1.1)
//
// Simple rules: when an event happens, run one action. The backend
// also supports conditions and several actions per rule; existing
// rules that use them are listed accurately, but this form creates
// the common single-action, no-condition case.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick } from "../../csp.js";

const TRIGGER_LABEL = {
  "site.created": "A site is created",
  "site.provisioned": "A site finishes setting up",
  "site.deployed": "A site is deployed",
  "site.failed": "A site fails",
  "domain.verified": "A domain is verified",
  "subscription.changed": "The subscription changes",
  "payment.failed": "A payment fails",
  "usage.limit_reached": "A usage limit is reached",
  "report.completed": "A report finishes",
  "tracking_link.unhealthy": "A tracking link becomes unhealthy"
};

const ACTION_LABEL = {
  notify_owners: "Email owners and admins",
  create_alert: "Create an alert in the portal",
  disable_tracking_link: "Disable that tracking link (reversible)",
  count_usage: "Count the run in usage"
};

function describeConditions(conditions) {
  if (!conditions || !conditions.length) return "Always";
  return conditions.map((c) => `${c.field} ${c.op} ${Array.isArray(c.value) ? c.value.join("|") : c.value}`).join(", ");
}

function ruleRow(r) {
  const paused = r.status === "paused";
  return `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(TRIGGER_LABEL[r.trigger_event] || r.trigger_event)}</td>
      <td>${escapeHtml(describeConditions(r.conditions))}</td>
      <td>${escapeHtml((r.actions || []).map((a) => ACTION_LABEL[a.type] || a.type).join(", "))}</td>
      <td><span class="badge ${paused ? "badge-suspended" : "badge-active"}">${paused ? "Paused" : "Active"}</span></td>
      <td class="actions">
        <button class="btn"${onClick("lummetRuleToggle", [r.id, (paused ? "resume" : "pause")])}>${paused ? "Resume" : "Pause"}</button>
        <button class="btn btn-danger"${onClick("lummetRuleDelete", [r.id])}>Delete</button>
      </td>
    </tr>`;
}

function runRow(r) {
  const cls = r.status === "success" ? "badge-active" : r.status === "failed" ? "badge-failed" : "badge-suspended";
  return `<tr><td>${escapeHtml(r.created_at || "")}</td><td>${escapeHtml(r.rule_name || "")}</td><td><span class="badge ${cls}">${escapeHtml(r.status)}</span></td></tr>`;
}

export function renderAutomationsPage({ rules, runs, enabled, canManage, triggers, actions }) {
  if (!canManage) {
    return `<h1>Automations</h1><div class="card"><p class="empty">Only organization admins can manage automations.</p></div>`;
  }
  const upgrade = enabled ? "" : `<div class="flash">Automations aren't included in your current plan. <a href="/app/billing">View plans</a></div>`;

  const triggerOptions = (triggers || Object.keys(TRIGGER_LABEL)).map((t) => `<option value="${escapeHtml(t)}">${escapeHtml(TRIGGER_LABEL[t] || t)}</option>`).join("");
  const actionOptions = (actions || Object.keys(ACTION_LABEL)).map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(ACTION_LABEL[a] || a)}</option>`).join("");

  const form = enabled
    ? `<div class="card">
        <h2>New rule</h2>
        <form id="rule-form">
          <label for="rule-name">Name</label>
          <input type="text" id="rule-name" placeholder="Tell me when a payment fails" required />
          <label for="rule-trigger">When</label>
          <select id="rule-trigger">${triggerOptions}</select>
          <label for="rule-action">Then</label>
          <select id="rule-action">${actionOptions}</select>
          <label for="rule-health">Only for tracking links that are (when the trigger is a tracking link)</label>
          <select id="rule-health"><option value="">any unhealthy state</option><option value="broken">broken</option><option value="timeout">timing out</option><option value="restricted">restricted</option><option value="warning">warning</option></select>
          <label for="rule-message">Message (optional)</label>
          <input type="text" id="rule-message" maxlength="500" />
          <label for="rule-max">Maximum runs per hour</label>
          <input type="number" id="rule-max" min="1" max="100" value="10" />
          <button class="btn" type="submit">Create rule</button>
        </form>
      </div>`
    : "";

  return `
    <h1>Automations</h1>
    <p class="subtitle">Run an action automatically when something happens in your organization.</p>
    ${upgrade}
    <div class="card">
      <h2>Rules</h2>
      <table>
        <thead><tr><th>Name</th><th>When</th><th>If</th><th>Then</th><th>Status</th><th></th></tr></thead>
        <tbody>${rules.length ? rules.map(ruleRow).join("") : `<tr><td colspan="6" class="empty">No rules yet.</td></tr>`}</tbody>
      </table>
    </div>
    ${form}
    <div class="card">
      <h2>Recent runs</h2>
      <table>
        <thead><tr><th>Time</th><th>Rule</th><th>Result</th></tr></thead>
        <tbody>${runs.length ? runs.map(runRow).join("") : `<tr><td colspan="3" class="empty">No runs yet.</td></tr>`}</tbody>
      </table>
    </div>
    <script nonce="${nonceToken()}">
      function lummetActiveOrgId() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }
      function base() { return '/api/organizations/' + lummetActiveOrgId() + '/automations'; }
      function send(method, url, body, failLabel) {
        fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (data.success) location.reload(); else alert(failLabel + ': ' + (data.error || 'unknown error')); });
      }
      var form = document.getElementById('rule-form');
      if (form) form.addEventListener('submit', function (e) {
        e.preventDefault();
        var message = document.getElementById('rule-message').value.trim();
        var action = { type: document.getElementById('rule-action').value };
        if (message && action.type !== 'count_usage' && action.type !== 'disable_tracking_link') action.params = { message: message };
        var conditions = [];
        var cond = document.getElementById('rule-health');
        if (cond && cond.value && document.getElementById('rule-trigger').value === 'tracking_link.unhealthy') conditions.push({ field: 'healthStatus', op: 'eq', value: cond.value });
        send('POST', base(), {
          name: document.getElementById('rule-name').value,
          triggerEvent: document.getElementById('rule-trigger').value,
          conditions: conditions, actions: [action],
          maxRunsPerHour: parseInt(document.getElementById('rule-max').value, 10) || 10
        }, 'Could not create the rule');
      });
      function lummetRuleToggle(id, action) { send('POST', base() + '/' + id + '/' + action, {}, 'Could not update the rule'); }
      function lummetRuleDelete(id) {
        if (!confirm('Delete this rule?')) return;
        send('DELETE', base() + '/' + id, null, 'Could not delete the rule');
      }
    </script>
  `;
}
