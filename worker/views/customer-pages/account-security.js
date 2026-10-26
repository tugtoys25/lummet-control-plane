import { renderAuthShell } from "../layout.js";
import { nonceToken } from "../../csp.js";

// Round 2fa-enroll: authenticator enrollment for a signed-in customer. It calls the existing /api/customer/2fa/* routes.
// Nothing secret is in the HTML: the secret is fetched after the person presses the button and is shown once.
// All dynamic text is written with textContent, never innerHTML.
const SCRIPT = () => `
<script nonce="${nonceToken()}">
(function(){
  var $ = function(id){ return document.getElementById(id); };
  function say(kind, text){ var f = $('flash'); f.textContent = ''; var d = document.createElement('div'); d.className = 'flash flash-' + kind; d.textContent = text; f.appendChild(d); }
  function post(path, body){ return fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) }).then(function(r){ return r.json().then(function(d){ return { status: r.status, data: d }; }); }); }
  fetch('/api/customer/2fa/status').then(function(r){ if (r.status === 401) { location.href = '/app/login'; return null; } return r.json(); }).then(function(d){
    if (!d) return;
    if (d.data && d.data.enabled) { $('start').hidden = true; say('success', 'Two-factor authentication is already active on your account.'); $('done').hidden = false; }
  });
  $('start').addEventListener('click', function(e){
    e.preventDefault(); $('start').disabled = true;
    post('/api/customer/2fa/setup').then(function(r){
      if (!r.data.success) { $('start').disabled = false; say('error', r.data.error === 'already_enabled' ? 'Two-factor authentication is already active.' : 'Could not start setup. Try again.'); return; }
      $('secret').textContent = r.data.secret; $('otpauth').textContent = r.data.otpauthUrl;
      $('step2').hidden = false; $('start').hidden = true; $('code').focus();
    });
  });
  $('confirm').addEventListener('click', function(e){
    e.preventDefault();
    post('/api/customer/2fa/confirm', { code: $('code').value.split(' ').join('') }).then(function(r){
      if (!r.data.success) { say('error', 'That code was not accepted. Check the time on your device and try the next code.'); return; }
      $('step2').hidden = true; var list = $('codes'); list.textContent = '';
      (r.data.backupCodes || []).forEach(function(c){ var li = document.createElement('li'); li.textContent = c; list.appendChild(li); });
      $('step3').hidden = false; $('done').hidden = false; say('success', 'Two-factor authentication is now active.');
    });
  });
})();
</script>`;

/** GET /app/security/2fa (flag CUSTOMER_2FA_ENROLL_PAGE=on). Static HTML, safe to serve to a policy-restricted session. */
export function renderCustomer2faEnrollPage() {
  return renderAuthShell({
    title: "Set up two-factor authentication",
    bodyHtml: `<div id="flash"></div>
      <p>Use an authenticator app (any app that supports time-based codes) to protect your account.</p>
      <button class="btn" id="start" style="width:100%;">Start setup</button>
      <div id="step2" hidden>
        <p>Add this key to your authenticator app, then enter the 6-digit code it shows.</p>
        <p style="font-size:13px;">Setup key: <code id="secret"></code></p>
        <p style="font-size:12px;word-break:break-all;">App link: <code id="otpauth"></code></p>
        <label for="code">6-digit code</label>
        <input type="text" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" />
        <button class="btn" id="confirm" style="width:100%;margin-top:12px;">Confirm and turn on</button>
      </div>
      <div id="step3" hidden>
        <p><strong>Save these backup codes now.</strong> Each works once if you lose your device. They are not shown again.</p>
        <ul id="codes"></ul>
      </div>
      <p id="done" hidden style="font-size:13px;text-align:center;margin-top:16px;"><a href="/app/overview">Continue to your account</a></p>` + SCRIPT()
  });
}
