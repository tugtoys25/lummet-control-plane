import { escapeHtml } from "../customer-layout.js";
import { nonceToken } from "../../csp.js";

// Release 2.6.0.25 (round H.5): the organization sessions page for owners and admins (blueprint I-25).
// It only drives the existing API, which does every check again on the server:
//   GET  /api/organizations/:id/sessions           (admin or owner; cursor paging)
//   POST /api/organizations/:id/sessions/revoke    (admin or owner; written reason; audited)
// Served only while CUSTOMER_SESSION_ADMIN is shadow or on, and only after the organization 2FA policy and IP allowlist have been applied,
// so a restricted session never reaches it. No session id is ever in the HTML or the API response: rows carry an opaque handle.
// All dynamic text is written with textContent, never innerHTML.
export const SESSIONS_PAGE_PATH = "/app/sessions";

const SCRIPT = () => `
<script nonce="${nonceToken()}">
(function(){
  var root = document.getElementById('sessions-root');
  var mode = root.getAttribute('data-mode');
  var $ = function(id){ return document.getElementById(id); };
  function orgId(){ var s = $('org-switcher'); return (s && s.value) || root.getAttribute('data-org'); }
  function say(kind, text){ var f = $('sessions-flash'); f.textContent = ''; var d = document.createElement('div'); d.className = 'flash flash-' + kind; d.textContent = text; f.appendChild(d); }
  function cell(tr, text){ var td = document.createElement('td'); td.textContent = text; tr.appendChild(td); return td; }
  function when(v){ return v ? String(v).replace('T', ' ').slice(0, 16) : ''; }
  var cursor = null;
  function reasonText(){ return ($('sessions-reason').value || '').trim(); }
  function revoke(body, label){
    var reason = reasonText();
    if (reason.length < 5) { say('error', 'Write a reason of at least 5 characters first. It is recorded in the audit log.'); $('sessions-reason').focus(); return; }
    body.reason = reason;
    fetch('/api/organizations/' + encodeURIComponent(orgId()) + '/sessions/revoke', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ return r.json().then(function(d){ return { status: r.status, data: d }; }); })
      .then(function(r){
        var d = r.data || {};
        if (d.success && d.shadow) { say('success', 'Dry run: ' + d.wouldRevoke + ' session(s) would have been ended. Nobody was signed out because this feature is not switched on yet.'); return; }
        if (d.success) { say('success', label + ': ' + d.revoked + ' session(s) ended. The person is told by email.'); load(true); return; }
        var msgs = { forbidden: 'Only an owner or admin can end sessions.', reason_required: 'A reason of 5 to 500 characters is required.', session_not_found: 'That session is already gone.', cannot_revoke_owner_session: 'Only an owner can end an owner\\'s session.', use_logout_for_own_session: 'To end your own session, use Sign out.' };
        say('error', msgs[d.error] || 'Could not end the session. Try again.');
      });
  }
  function row(s){
    var tr = document.createElement('tr');
    cell(tr, s.fullName || s.email);
    cell(tr, s.email);
    cell(tr, s.role);
    cell(tr, when(s.createdAt));
    cell(tr, when(s.expiresAt));
    var act = document.createElement('td');
    if (s.current) { act.textContent = 'This session'; }
    else {
      var b1 = document.createElement('button'); b1.type = 'button'; b1.className = 'btn btn-secondary'; b1.textContent = 'End this session';
      b1.addEventListener('click', function(){ revoke({ handle: s.handle }, 'Ended'); });
      var b2 = document.createElement('button'); b2.type = 'button'; b2.className = 'btn btn-secondary'; b2.style.marginLeft = '6px'; b2.textContent = 'End all for this person';
      b2.addEventListener('click', function(){ revoke({ userId: s.userId }, 'Ended all'); });
      act.appendChild(b1); act.appendChild(b2);
    }
    tr.appendChild(act);
    return tr;
  }
  function load(reset){
    if (reset) { cursor = null; $('sessions-body').textContent = ''; }
    var url = '/api/organizations/' + encodeURIComponent(orgId()) + '/sessions?limit=50' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    fetch(url).then(function(r){
      if (r.status === 401) { location.href = '/app/login'; return null; }
      return r.json().then(function(d){ return { status: r.status, data: d }; });
    }).then(function(r){
      if (!r) return;
      if (!r.data.success) { say('error', r.status === 403 ? 'Only an owner or admin can see sessions.' : 'Could not load sessions.'); return; }
      var body = $('sessions-body');
      (r.data.data || []).forEach(function(s){ body.appendChild(row(s)); });
      cursor = r.data.nextCursor || null;
      $('sessions-more').hidden = !cursor;
      $('sessions-empty').hidden = body.children.length > 0;
    });
  }
  $('sessions-more').addEventListener('click', function(){ load(false); });
  load(true);
})();
</script>`;

/** GET /app/sessions. `mode` is the CUSTOMER_SESSION_ADMIN rollout (shadow or on); the caller has already checked the role. */
export function renderSessionsPage({ mode, organizationId }) {
  const shadowNotice = mode === "shadow"
    ? `<div class="flash flash-info">Preview: ending a session here is a dry run. It records an audit entry and tells you how many sessions would have ended, but signs nobody out.</div>`
    : "";
  return `
    <h1>Sessions</h1>
    <p class="subtitle">People signed in to this organization right now. Ending a session signs that person out on that device on their next request.</p>
    ${shadowNotice}
    <div id="sessions-flash"></div>
    <div id="sessions-root" data-mode="${escapeHtml(mode)}" data-org="${escapeHtml(organizationId || "")}">
      <div class="card">
        <label for="sessions-reason">Reason (required, 5 to 500 characters, recorded in the audit log)</label>
        <input type="text" id="sessions-reason" maxlength="500" autocomplete="off" />
        <p style="font-size:13px;color:var(--text-dim);margin-top:8px;">Only sessions that are active in this organization are listed. The person gets an email saying an administrator ended their session; the email does not include your reason.</p>
      </div>
      <div class="card">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Signed in (UTC)</th><th>Expires (UTC)</th><th></th></tr></thead>
          <tbody id="sessions-body"></tbody>
        </table>
        <p id="sessions-empty" class="empty" hidden>No active sessions.</p>
        <button type="button" class="btn btn-secondary" id="sessions-more" hidden>Load more</button>
      </div>
    </div>` + SCRIPT();
}
