// =====================================================
// CUSTOMER INTEGRATIONS PAGE: connect Slack, Discord, Microsoft Teams or Telegram.
// Admin-only (the backing routes require the admin role). The destination address is a secret: it is sent once, stored encrypted and
// never shown again, only its host is.
// =====================================================
import { escapeHtml } from "../customer-layout.js";
import { nonceToken, onClick, onSubmit, BROWSER_HELPER } from "../../csp.js";
import { PROVIDERS, EVENT_TYPES } from "../../integrations.js";

const EVENT_LABEL = {
  "site.created": "A site is created", "site.provisioned": "A site finishes setting up", "site.deployed": "A site is deployed", "site.failed": "A site fails",
  "site.deleted": "A site is deleted", "domain.verified": "A domain is verified", "subscription.changed": "The subscription changes", "payment.failed": "A payment fails",
};

function row(i) {
  const ok = i.last_status === "ok", failed = i.last_status === "failed";
  const result = i.last_sent_at ? `${ok ? "Delivered" : "Failed"}${failed && i.last_error ? ` (${escapeHtml(i.last_error)})` : ""} · ${escapeHtml(i.last_sent_at)}` : "Nothing sent yet";
  return `<tr>
    <td><strong>${escapeHtml(i.name)}</strong><br><span class="muted">${escapeHtml(i.provider_label)} · ${escapeHtml(i.target_hint)}</span></td>
    <td>${escapeHtml(i.event_types.map((e) => EVENT_LABEL[e] || e).join(", "))}</td>
    <td><span class="badge ${i.status === "active" ? "badge-active" : "badge-suspended"}">${i.status === "active" ? "Active" : "Paused"}</span><br><span class="muted">${result}</span></td>
    <td class="actions">
      <button class="btn"${onClick("lummetIntTest", [i.id])}>Send test</button>
      <button class="btn"${onClick("lummetIntToggle", [i.id, i.status === "active" ? "disabled" : "active"])}>${i.status === "active" ? "Pause" : "Resume"}</button>
      <button class="btn btn-danger"${onClick("lummetIntDelete", [i.id])}>Remove</button>
    </td></tr>`;
}

export function renderIntegrationsPage({ integrations, canManage }) {
  if (!canManage) return `<h1>Integrations</h1><div class="card"><p class="empty">Only organization admins can manage integrations. Ask an admin if you need access.</p></div>`;
  const cards = Object.entries(PROVIDERS).map(([id, p]) => `
    <div class="card" style="flex:1 1 220px;min-width:220px">
      <h3>${escapeHtml(p.label)}</h3><p class="muted">${escapeHtml(p.help)}</p>
      <button class="btn btn-primary"${onClick("lummetIntConnect", [id])}>Connect</button>
    </div>`).join("");
  const events = EVENT_TYPES.map((e) => `<label><input type="checkbox" class="int-event" value="${escapeHtml(e)}" checked /> ${escapeHtml(EVENT_LABEL[e] || e)}</label>`).join("<br>");
  return `
    <h1>Integrations</h1>
    <p class="subtitle">Send a short message to your team chat when something happens on your sites or account. Connect a tool, choose the events, press Send test.</p>
    <div id="int-notice"></div>
    <div style="display:flex;flex-wrap:wrap;gap:12px">${cards}</div>

    <div class="card" id="int-form-card" style="display:none">
      <h2 id="int-form-title">Connect</h2>
      <form id="int-form"${onSubmit("lummetIntSave", [], { prevent: true })}>
        <label for="int-name">Name</label><input type="text" id="int-name" maxlength="60" placeholder="Team alerts" />
        <div id="int-url-wrap"><label for="int-url">Webhook address</label><input type="url" id="int-url" autocomplete="off" /></div>
        <div id="int-bot-wrap" style="display:none">
          <label for="int-token">Bot token</label><input type="password" id="int-token" autocomplete="off" />
          <label for="int-chat">Chat id or @channel</label><input type="text" id="int-chat" autocomplete="off" />
        </div>
        <label>Send a message when</label>${events}
        <p class="muted">The address or token is stored encrypted and is not shown again. Only messages about your own organization are sent.</p>
        <button class="btn btn-primary" type="submit">Connect</button> <button class="btn" type="button"${onClick("lummetIntCancel", [])}>Cancel</button>
      </form>
    </div>

    <div class="card"><h2>Connected</h2>
      <table><thead><tr><th>Integration</th><th>Events</th><th>Status</th><th></th></tr></thead>
      <tbody>${integrations.length ? integrations.map(row).join("") : `<tr><td colspan="4" class="empty">Nothing connected yet. Choose a tool above.</td></tr>`}</tbody></table>
    </div>

    <script nonce="${nonceToken()}">
      ${BROWSER_HELPER}
      var PROVIDERS = ${JSON.stringify(Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, field: v.field, placeholder: v.placeholder }]))).replace(/</g, "\\u003c")};
      var current = null;
      function base() { var el = document.getElementById('org-switcher'); return '/api/organizations/' + (el ? el.value : ''); }
      function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }
      function notice(kind, msg) { document.getElementById('int-notice').innerHTML = '<div class="flash flash-' + kind + '">' + esc(msg) + '</div>'; window.scrollTo(0, 0); }
      var ERRORS = { invalid_url: 'That is not a valid https address.', url_not_for_provider: 'That address does not belong to this tool. Copy it again from the tool.', invalid_bot_token: 'The bot token looks wrong.', invalid_chat_id: 'The chat id looks wrong.', invalid_event_types: 'Choose at least one event.', too_many_integrations: 'You have reached the limit of integrations.', http_400: 'The tool rejected the message. Check the address.', http_404: 'The tool says this address no longer exists.', http_401: 'The tool refused the credentials.', http_403: 'The tool refused the credentials.', network_error: 'The tool could not be reached.' };
      function why(code) { return ERRORS[code] || code || 'unknown error'; }
      function call(method, url, body, ok) {
        fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
          .then(function (r) { return r.json(); }).then(function (d) { if (d.success) ok(d); else notice('error', why(d.error)); })
          .catch(function () { notice('error', 'Could not reach the server.'); });
      }
      function lummetIntConnect(id) {
        current = id; var p = PROVIDERS[id];
        document.getElementById('int-form-card').style.display = '';
        document.getElementById('int-form-title').textContent = 'Connect ' + p.label;
        document.getElementById('int-url-wrap').style.display = p.field === 'url' ? '' : 'none';
        document.getElementById('int-bot-wrap').style.display = p.field === 'bot' ? '' : 'none';
        document.getElementById('int-url').placeholder = p.placeholder || '';
        document.getElementById('int-name').value = p.label;
        document.getElementById('int-form-card').scrollIntoView({ block: 'nearest' });
      }
      function lummetIntCancel() { current = null; document.getElementById('int-form-card').style.display = 'none'; }
      function checkedEvents() { return Array.prototype.slice.call(document.querySelectorAll('.int-event:checked')).map(function (e) { return e.value; }); }
      function lummetIntSave() {
        if (!current) return;
        var target = PROVIDERS[current].field === 'url' ? { url: document.getElementById('int-url').value } : { botToken: document.getElementById('int-token').value, chatId: document.getElementById('int-chat').value };
        call('POST', base() + '/integrations', { provider: current, name: document.getElementById('int-name').value, eventTypes: checkedEvents(), target: target }, function () { location.reload(); });
      }
      function lummetIntTest(id) { call('POST', base() + '/integrations/' + id + '/test', null, function () { notice('success', 'Test message sent. Check your chat.'); setTimeout(function () { location.reload(); }, 1200); }); }
      function lummetIntToggle(id, status) { call('PATCH', base() + '/integrations/' + id, { status: status }, function () { location.reload(); }); }
      function lummetIntDelete(id) { if (!confirm('Remove this integration? Messages stop immediately.')) return; call('DELETE', base() + '/integrations/' + id, null, function () { location.reload(); }); }
    </script>`;
}
