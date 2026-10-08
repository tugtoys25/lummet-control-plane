// =====================================================
// CUSTOMER USAGE & AI PAGE (master prompt sections 8, 16; roadmap 1.1)
//
// Backend (usage.js, ai-credits.js, ai-gateway.js + their routes in
// index.js) already existed and was already tested — this closes the
// "no UI reaches it" gap only.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken } from "../../csp.js";

function limitRow(label, used, limit) {
  const limitLabel = limit === null || limit === undefined ? "unlimited" : escapeHtml(String(limit));
  const over = typeof limit === "number" && used >= limit;
  return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(String(used))}</td><td>${limitLabel}</td><td>${over ? '<span class="badge badge-failed">at limit</span>' : ""}</td></tr>`;
}

export function renderUsagePage({ snapshot, monthly, aiCredits, aiLimit, tasks, ledger, canManage }) {
  const usageRows = [
    limitRow("Sites", snapshot.sites.used, snapshot.sites.limit),
    limitRow("Team members", snapshot.users.used, snapshot.users.limit),
    limitRow("Custom domains", snapshot.customDomains.used, snapshot.customDomains.limit)
  ].join("");

  const meteredRows = Object.keys(monthly).length
    ? Object.entries(monthly).map(([metric, qty]) => `<tr><td>${escapeHtml(metric)}</td><td>${escapeHtml(String(qty))}</td></tr>`).join("")
    : `<tr><td colspan="2" class="empty">No metered activity yet this month.</td></tr>`;

  const taskOptions = Object.entries(tasks).map(([key, credits]) => `<option value="${escapeHtml(key)}">${escapeHtml(key)} (${credits} credit${credits === 1 ? "" : "s"})</option>`).join("");

  const aiSection = snapshot.features.aiEnabled
    ? `
      <div class="card">
        <h2>AI</h2>
        <p>Credit balance: <b>${escapeHtml(String(aiCredits))}</b>${aiLimit.limit != null ? ` / ${escapeHtml(String(aiLimit.limit))} this month` : ""}</p>
        ${canManage ? `
        <form id="ai-run-form">
          <label for="ai-task">Task</label>
          <select id="ai-task">${taskOptions}</select>
          <label for="ai-input">Input</label>
          <textarea id="ai-input" rows="4" placeholder="Paste the text/title/topic this task needs — see the task name for which."></textarea>
          <button class="btn" type="submit">Run</button>
        </form>
        <div id="ai-result"></div>
        <h3>Recent activity</h3>
        <table>
          <thead><tr><th>When</th><th>Kind</th><th>Amount</th><th>Task</th></tr></thead>
          <tbody>${ledger.length ? ledger.map((l) => `<tr><td>${escapeHtml(l.created_at)}</td><td>${escapeHtml(l.kind)}</td><td>${escapeHtml(String(l.amount))}</td><td>${escapeHtml(l.task || "—")}</td></tr>`).join("") : '<tr><td colspan="4" class="empty">No AI activity yet.</td></tr>'}</tbody>
        </table>` : ""}
      </div>`
    : `<div class="card"><h2>AI</h2><p class="empty">Not included on your current plan. <a href="/app/billing">Upgrade</a> to unlock AI-assisted tools.</p></div>`;

  return `
    <h1>Usage</h1>
    <p class="subtitle">What this organization is using against its plan's limits this month.</p>

    <div class="card">
      <table>
        <thead><tr><th>Resource</th><th>Used</th><th>Limit</th><th></th></tr></thead>
        <tbody>${usageRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Metered activity this month</h2>
      <table>
        <thead><tr><th>Metric</th><th>Quantity</th></tr></thead>
        <tbody>${meteredRows}</tbody>
      </table>
    </div>

    ${aiSection}

    <script nonce="${nonceToken()}">
      function lummetActiveOrgId() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }
      var aiForm = document.getElementById('ai-run-form');
      if (aiForm) {
        aiForm.addEventListener('submit', function (e) {
          e.preventDefault();
          var task = document.getElementById('ai-task').value;
          var text = document.getElementById('ai-input').value;
          var input = task === 'seo_meta' ? { title: text, summary: text } : task === 'draft_article' ? { topic: text } : { text: text };
          var resultBox = document.getElementById('ai-result');
          resultBox.innerHTML = 'Running...';
          fetch('/api/organizations/' + lummetActiveOrgId() + '/ai/run', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: task, input: input })
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (!data.success) { resultBox.innerHTML = '<div class="flash flash-error">' + (data.error || 'unknown error') + '</div>'; return; }
              resultBox.innerHTML = '<div class="flash flash-success">Used ' + data.creditsCharged + ' credit(s).</div><pre>' + data.text.replace(/</g, '&lt;') + '</pre>';
              setTimeout(function () { location.reload(); }, 2000);
            });
        });
      }
    </script>
  `;
}
