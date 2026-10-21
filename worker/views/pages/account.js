// =====================================================
// ACCOUNT — self-service password change
// Used both for the forced "you have a temp password,
// change it" flow (must_change_password = 1) and for a
// voluntary change any admin can trigger later from the
// topbar link in layout.js.
// =====================================================

import { renderShell, escapeHtml } from "../layout.js";
import { changeOwnPassword } from "../../auth.js";
import { nonceToken } from "../../csp.js";

export async function renderChangePasswordPage(env, admin, error) {
  const forced = admin.must_change_password === 1;

  const body = `
    <h1>Change password</h1>
    <p class="subtitle">Account · ${escapeHtml(admin.email)}</p>
    ${forced
      ? `<div class="flash flash-error">You're signed in with a temporary password. Set a real one before continuing.</div>`
      : ""}
    ${error ? `<div class="flash flash-error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/account/password" class="card" style="max-width:420px;">
      <div class="form-group">
        <label>Current password</label>
        <input type="password" name="current_password" required autocomplete="current-password" />
      </div>
      <div class="form-group">
        <label>New password</label>
        <input type="password" name="new_password" required minlength="12" autocomplete="new-password" />
        <span style="font-size:12px;color:var(--text-dim);">At least 12 characters.</span>
      </div>
      <div class="form-group">
        <label>Confirm new password</label>
        <input type="password" name="confirm_password" required minlength="12" autocomplete="new-password" />
      </div>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button type="submit" class="btn btn-primary">Save new password</button>
        ${forced ? "" : `<a class="btn btn-secondary" href="/dashboard">Cancel</a>`}
      </div>
    </form>`;

  return renderShell({ title: "Change password", activeKey: "account-password", admin, bodyHtml: body, env });
}

export async function submitChangePassword(env, admin, form) {
  const newPassword = form.new_password || "";
  const confirmPassword = form.confirm_password || "";

  if (newPassword !== confirmPassword) {
    return { ok: false, status: 422, error: "passwords_do_not_match" };
  }

  return changeOwnPassword(env, admin.id, form.current_password, newPassword);
}


// =====================================================
// ACCOUNT: two-factor authentication
// =====================================================
export async function renderTwoFactorPage(env, admin, { status, required }) {
  let inner;
  if (status.enabled) {
    inner = `
      <div class="flash flash-success">Two-factor authentication is on. You have ${escapeHtml(String(status.backupCodesLeft))} unused backup code(s).</div>
      <div class="card" style="max-width:480px;">
        <h2>Turn it off</h2>
        <p style="font-size:13px;color:var(--text-dim);">Enter a current code or a backup code to confirm.</p>
        <div class="form-group"><label>Authenticator code</label><input type="text" id="off-code" inputmode="numeric" autocomplete="one-time-code" /></div>
        <div class="form-group"><label>or backup code</label><input type="text" id="off-backup" autocomplete="off" /></div>
        <button class="btn btn-secondary" id="off-btn">Turn off two-factor</button>
      </div>`;
  } else {
    inner = `
      ${required ? `<div class="flash flash-error">Your organization requires two-factor authentication. Set it up to continue using the console.</div>` : ""}
      <div class="card" style="max-width:520px;">
        <h2>Set up an authenticator app</h2>
        <p style="font-size:13px;color:var(--text-dim);">Use Google Authenticator, 1Password, Authy or similar. Add an account manually with the key below, then enter the 6-digit code it shows.</p>
        <button class="btn btn-primary" id="setup-btn">Generate a key</button>
        <div id="setup-box" style="display:none;margin-top:12px;">
          <p>Key: <code id="setup-secret"></code></p>
          <p style="font-size:12px;word-break:break-all;color:var(--text-dim);">Or open this link on your phone: <a id="setup-link" href="#">setup link</a></p>
          <div class="form-group"><label>6-digit code</label><input type="text" id="confirm-code" inputmode="numeric" autocomplete="one-time-code" /></div>
          <button class="btn btn-primary" id="confirm-btn">Turn on two-factor</button>
        </div>
        <div id="codes-box" style="display:none;margin-top:12px;"></div>
      </div>`;
  }
  const body = `
    <h1>Two-factor authentication</h1>
    <p class="subtitle">Account · ${escapeHtml(admin.email)}</p>
    ${inner}
    <script nonce="${nonceToken()}">
      function post(url, body, ok) {
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
          .then(function (r) { return r.json(); }).then(function (d) { if (d.success) ok(d); else alert((d.error || 'Something went wrong').replace(/_/g, ' ')); });
      }
      var $ = function (id) { return document.getElementById(id); };
      if ($('setup-btn')) $('setup-btn').onclick = function () {
        post('/api/account/2fa/setup', {}, function (d) {
          $('setup-secret').textContent = d.secret; $('setup-link').href = d.otpauthUrl; $('setup-box').style.display = 'block'; $('setup-btn').style.display = 'none';
        });
      };
      if ($('confirm-btn')) $('confirm-btn').onclick = function () {
        post('/api/account/2fa/confirm', { code: $('confirm-code').value }, function (d) {
          $('setup-box').style.display = 'none';
          var box = $('codes-box'); box.style.display = 'block';
          box.innerHTML = '<div class="flash flash-success">Two-factor is on. Save these backup codes now. Each works once and they will not be shown again.</div><pre></pre><a class="btn btn-primary" href="/">Continue</a>';
          box.querySelector('pre').textContent = d.backupCodes.join('\\n');
        });
      };
      if ($('off-btn')) $('off-btn').onclick = function () {
        post('/api/account/2fa/disable', { code: $('off-code').value, backupCode: $('off-backup').value }, function () { location.reload(); });
      };
    </script>`;
  return await renderShell({ title: "Two-factor authentication", activeKey: "", admin, bodyHtml: body, env });
}
