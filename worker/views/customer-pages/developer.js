// =====================================================
// CUSTOMER DEVELOPER PAGE: API keys + webhooks (roadmap 1.1)
//
// Secrets (a new API token, a webhook signing secret) are only ever
// returned once by the backend, so this page shows them in a
// dismissible notice right after creation/rotation and never again.
// Admin-only: the backing routes require the admin role.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick, BROWSER_HELPER } from "../../csp.js";

const SCOPE_LABEL = {
  "sites:read": "Read sites",
  "domains:read": "Read domains",
  "analytics:read": "Read analytics",
  "usage:read": "Read usage"
};

export const API_KEY_SCOPES = Object.keys(SCOPE_LABEL);

function keyRow(k) {
  const revoked = k.status === "revoked";
  return `
    <tr>
      <td>${escapeHtml(k.name)}</td>
      <td class="mono">${escapeHtml(k.key_prefix)}…</td>
      <td>${escapeHtml((k.scopes || []).join(", "))}</td>
      <td><span class="badge ${revoked ? "badge-failed" : "badge-active"}">${revoked ? "Revoked" : "Active"}</span></td>
      <td>${escapeHtml(k.last_used_at || "Never")}</td>
      <td class="actions">${revoked ? "" : `<button class="btn btn-danger"${onClick("lummetRevokeKey", [k.id])}>Revoke</button>`}</td>
    </tr>`;
}

function webhookRow(w) {
  return `
    <tr>
      <td class="mono">${escapeHtml(w.url)}</td>
      <td>${escapeHtml((w.event_types || []).join(", "))}</td>
      <td><span class="badge ${w.status === "active" ? "badge-active" : "badge-suspended"}">${escapeHtml(w.status)}</span></td>
      <td class="actions">
        <button class="btn"${onClick("lummetWebhookDeliveries", [w.id])}>Deliveries</button>
        <button class="btn"${onClick("lummetRotateSecret", [w.id])}>New secret</button>
        <button class="btn btn-danger"${onClick("lummetDeleteWebhook", [w.id])}>Delete</button>
      </td>
    </tr>`;
}

export function renderDeveloperPage({ apiKeys, webhooks, eventTypes, canManage }) {
  if (!canManage) {
    return `
      <h1>API keys &amp; webhooks</h1>
      <div class="card"><p class="empty">Only organization admins can manage API keys and webhooks. Ask an admin if you need access.</p></div>`;
  }

  const scopeBoxes = API_KEY_SCOPES.map((s) =>
    `<label><input type="checkbox" class="key-scope" value="${escapeHtml(s)}" checked /> ${escapeHtml(SCOPE_LABEL[s])}</label>`).join("<br>");
  const eventBoxes = (eventTypes || []).map((e) =>
    `<label><input type="checkbox" class="hook-event" value="${escapeHtml(e)}" checked /> ${escapeHtml(e)}</label>`).join("<br>");

  return `
    <h1>API keys &amp; webhooks</h1>
    <p class="subtitle">Keys let your own code read your Lummet data. Webhooks send you a signed request when something changes.</p>

    <div id="secret-notice"></div>

    <div class="card">
      <h2>API keys</h2>
      <table>
        <thead><tr><th>Name</th><th>Key</th><th>Access</th><th>Status</th><th>Last used</th><th></th></tr></thead>
        <tbody>${apiKeys.length ? apiKeys.map(keyRow).join("") : `<tr><td colspan="6" class="empty">No API keys yet. Create one below.</td></tr>`}</tbody>
      </table>
      <form id="key-form">
        <label for="key-name">Key name</label>
        <input type="text" id="key-name" placeholder="Reporting script" required />
        <label>Access</label>
        ${scopeBoxes}
        <br><button class="btn" type="submit">Create key</button>
      </form>
    </div>

    <div class="card">
      <h2>Webhooks</h2>
      <table>
        <thead><tr><th>URL</th><th>Events</th><th>Status</th><th></th></tr></thead>
        <tbody>${webhooks.length ? webhooks.map(webhookRow).join("") : `<tr><td colspan="4" class="empty">No webhooks yet. Add an HTTPS endpoint below.</td></tr>`}</tbody>
      </table>
      <div id="deliveries"></div>
      <form id="hook-form">
        <label for="hook-url">Endpoint URL</label>
        <input type="url" id="hook-url" placeholder="https://example.com/lummet-webhook" required />
        <label>Events</label>
        ${eventBoxes}
        <br><button class="btn" type="submit">Add webhook</button>
      </form>
    </div>

    <script nonce="${nonceToken()}">
      ${BROWSER_HELPER}
      function lummetActiveOrgId() { var el = document.getElementById('org-switcher'); return el ? el.value : null; }
      function base() { return '/api/organizations/' + lummetActiveOrgId(); }
      function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
      function checked(cls) { return Array.prototype.slice.call(document.querySelectorAll('.' + cls + ':checked')).map(function (el) { return el.value; }); }

      function showSecret(label, value) {
        document.getElementById('secret-notice').innerHTML =
          '<div class="flash flash-success">' + esc(label) + ' Copy it now; it will not be shown again.<br><code>' + esc(value) + '</code></div>';
        window.scrollTo(0, 0);
      }

      function call(method, url, body, onOk, failLabel) {
        fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
          .then(function (r) { return r.json(); })
          .then(function (data) { if (data.success) onOk(data); else alert(failLabel + ': ' + (data.error || 'unknown error')); });
      }

      document.getElementById('key-form').addEventListener('submit', function (e) {
        e.preventDefault();
        call('POST', base() + '/api-keys', { name: document.getElementById('key-name').value, scopes: checked('key-scope') },
          function (data) { showSecret('API key created.', data.token); setTimeout(function () { /* keep notice visible; list refreshes on next load */ }, 0); },
          'Could not create the key');
      });

      function lummetRevokeKey(id) {
        if (!confirm('Revoke this key? Anything using it will stop working immediately.')) return;
        call('DELETE', base() + '/api-keys/' + id, null, function () { location.reload(); }, 'Could not revoke the key');
      }

      document.getElementById('hook-form').addEventListener('submit', function (e) {
        e.preventDefault();
        call('POST', base() + '/webhooks', { url: document.getElementById('hook-url').value, eventTypes: checked('hook-event') },
          function (data) { showSecret('Webhook added. Signing secret:', data.secret); },
          'Could not add the webhook');
      });

      function lummetRotateSecret(id) {
        if (!confirm('Create a new signing secret? The old one stops working immediately.')) return;
        call('POST', base() + '/webhooks/' + id + '/rotate-secret', null, function (data) { showSecret('New signing secret:', data.secret); }, 'Could not rotate the secret');
      }

      var CAN_MANAGE = ${canManage ? 'true' : 'false'};
      function lummetDeleteWebhook(id) {
        if (!confirm('Delete this webhook?')) return;
        call('DELETE', base() + '/webhooks/' + id, null, function () { location.reload(); }, 'Could not delete the webhook');
      }

      function lummetRedeliver(webhookId, deliveryId) {
        call('POST', base() + '/webhooks/' + webhookId + '/deliveries/' + deliveryId + '/redeliver', null, function () { lummetWebhookDeliveries(webhookId); }, 'Could not re-send the delivery');
      }

      function lummetWebhookDeliveries(id) {
        fetch(base() + '/webhooks/' + id + '/deliveries').then(function (r) { return r.json(); }).then(function (data) {
          var box = document.getElementById('deliveries');
          if (!data.success) { box.innerHTML = '<div class="flash flash-error">Could not load deliveries.</div>'; return; }
          if (!data.data.length) { box.innerHTML = '<p class="empty">No deliveries yet for this webhook.</p>'; return; }
          box.innerHTML = '<table><thead><tr><th>Event</th><th>Status</th><th>Attempt</th><th>Next attempt</th><th>Response</th><th>Sent</th><th></th></tr></thead><tbody>' +
            data.data.map(function (d) {
              var resend = (CAN_MANAGE && (d.status === 'failed' || d.status === 'dead'))
                ? '<button type="button" class="btn"' + lummetAttrs('click', 'lummetRedeliver', [id, d.id]) + '>Re-send</button>' : '';
              var next = d.next_attempt_at ? esc(d.next_attempt_at) : (d.status === 'dead' ? 'gave up' : '');
              return '<tr><td>' + esc(d.event_type) + '</td><td>' + esc(d.status) + '</td><td>' + esc(d.attempt || 1) + '</td><td>' + next + '</td><td>' + esc(d.response_code || d.error_message || '') + '</td><td>' + esc(d.created_at) + '</td><td>' + resend + '</td></tr>';
            }).join('') + '</tbody></table>' +
            '<p class="muted">A failed delivery is retried automatically with growing waits (up to 6 attempts), always with the same body and delivery id, so treat a repeated id as a duplicate.</p>';
        });
      }
    </script>
  `;
}
