import { renderCustomerAuthShell } from "../customer-auth-shell.js";
import { nonceToken } from "../../csp.js";

// Pages reached from emailed links, in the same look as the customer login (2.6.0.24). GET never mutates: the token is
// only submitted by an explicit button press (protects against link scanners). Messages are written with textContent.
const SAY = `function say(kind, text){ var f = document.getElementById('flash'); f.textContent = ''; var d = document.createElement('div'); d.className = 'flash flash-' + kind; d.setAttribute('role', kind === 'error' ? 'alert' : 'status'); d.textContent = text; f.appendChild(d); }`;
const FLASH = `<div id="flash" role="status" aria-live="polite"></div>`;
const BACK = `<p class="auth-alt"><a href="/app/login">Back to login</a></p>`;

const SCRIPT = (endpoint, fields, okMsg, redirectTo) => `
<script nonce="${nonceToken()}">
(function(){
  ${SAY}
  var p = new URLSearchParams(location.search);
  var uid = p.get('uid') || '', token = p.get('token') || '';
  history.replaceState(null, '', location.pathname); // keep token out of history/referrers
  var go = document.getElementById('go');
  go.addEventListener('click', function(e){
    e.preventDefault();
    go.disabled = true;
    var body = { userId: uid, token: token };
    ${fields}
    fetch('${endpoint}', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        if (d.success) { say('success', '${okMsg}'); setTimeout(function(){ location.href='${redirectTo}'; }, 1200); }
        else { go.disabled = false; say('error', 'This link is invalid or has expired.'); }
      })
      .catch(function(){ go.disabled = false; say('error', 'Could not reach the server.'); });
  });
})();
</script>`;

export function renderVerifyEmailPage() {
  return renderCustomerAuthShell({
    title: "Verify email",
    bodyHtml: `<h1>Verify your email</h1>
      <p class="auth-sub">Confirm your email address to finish setting up your account.</p>
      ${FLASH}
      <button class="auth-btn" id="go" type="button">Verify my email</button>` + SCRIPT("/api/customer/email/verify", "", "Email verified.", "/app/login")
  });
}

export function renderResetPasswordPage() {
  return renderCustomerAuthShell({
    title: "Choose a new password",
    bodyHtml: `<h1>Choose a new password</h1>
      <p class="auth-sub">Pick something you have not used before.</p>
      ${FLASH}
      <label for="np">New password (12+ characters)</label>
      <input type="password" id="np" autocomplete="new-password" minlength="12" required />
      <button class="auth-btn" id="go" type="button">Set password</button>` +
      SCRIPT("/api/customer/password/reset", "body.newPassword = document.getElementById('np').value;", "Password updated.", "/app/login")
  });
}

export function renderForgotPasswordPage({ turnstileSiteKey = "" } = {}) {
  return renderCustomerAuthShell({
    title: "Reset password",
    bodyHtml: `<h1>Forgot your password?</h1>
      <p class="auth-sub">Enter your email and we will send you a link to choose a new one.</p>
      ${FLASH}
      <label for="em">Email</label>
      <input type="email" id="em" autocomplete="email" required autofocus />
      ${turnstileSiteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile auth-turnstile" data-sitekey="${String(turnstileSiteKey).replace(/[^\w.-]/g, "")}"></div>` : ""}
      <button class="auth-btn" id="go" type="button">Send reset link</button>
      ${BACK}
      <script nonce="${nonceToken()}">(function(){
        ${SAY}
        var go = document.getElementById('go');
        go.addEventListener('click', function(e){
          e.preventDefault(); go.disabled = true;
          fetch('/api/customer/password/forgot', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: document.getElementById('em').value, turnstileToken: ((document.querySelector('[name=cf-turnstile-response]') || {}).value || '') }) })
            .then(function(r){ if (r.status === 422 || r.status === 503) { say('error', 'Please complete the security check and try again.'); } else { say('success', 'If that email has an account, a reset link is on its way.'); } go.disabled = false; try { if (window.turnstile) window.turnstile.reset(); } catch (e) {} })
            .catch(function(){ go.disabled = false; say('error', 'Could not reach the server.'); });
        });
      })();</script>`
  });
}

export function renderInvitationPage() {
  return renderCustomerAuthShell({
    title: "Accept invitation",
    bodyHtml: `<h1>You are invited</h1>
      <p class="auth-sub">Log in with the email address this invitation was sent to, then accept.</p>
      ${FLASH}
      <button class="auth-btn" id="go" type="button">Accept invitation</button>
      <p class="auth-alt"><a href="/app/login">Log in / create account</a></p>
      <script nonce="${nonceToken()}">(function(){
        ${SAY}
        var t = new URLSearchParams(location.search).get('token') || '';
        history.replaceState(null, '', location.pathname);
        var go = document.getElementById('go');
        go.addEventListener('click', function(e){
          e.preventDefault(); go.disabled = true;
          fetch('/api/invitations/' + encodeURIComponent(t) + '/accept', { method:'POST' }).then(function(r){ return r.json(); }).then(function(d){
            if (d.success) { location.href = '/app/overview'; return; }
            go.disabled = false;
            say('error', d.error === 'unauthorized' ? 'Please log in first.' : d.error === 'invitation_email_mismatch' ? 'This invitation was sent to a different email address.' : 'This invitation is invalid or expired.');
          }).catch(function(){ go.disabled = false; say('error', 'Could not reach the server.'); });
        });
      })();</script>`
  });
}

/**
 * Shown instead of any portal page to a signed-in person whose organization requires 2FA and who has none (Round 6.4A).
 * Static and script-free on purpose. Sign-out is a plain link to the existing login page, which signs the old session out when a new
 * sign-in replaces it; enrolling uses the existing /api/customer/2fa routes (there is no portal page for 2FA setup yet, see OPEN_ITEMS).
 */
export function renderOrg2faRequiredPage({ enrollPath = null } = {}) {
  return renderCustomerAuthShell({
    title: "Two-factor authentication required",
    bodyHtml: `<h1>Two-factor required</h1>
      <div class="flash flash-error" role="alert">An organization you belong to requires two-factor authentication.</div>
      <p>Your account has no active authenticator factor, so this session can only be used to set one up. Once two-factor authentication is active on your account, sign in again to continue.</p>${enrollPath ? `<a class="btn" href="${enrollPath}">Set up two-factor authentication</a>` : ""}
      ${BACK}`
  });
}

/** Round 6.4C: shown at /app/* when the active organization's IP allowlist denies the address. It names no organization and shows no data. */
export function renderOrgIpDeniedPage() {
  return renderCustomerAuthShell({
    title: "Access not allowed from this network",
    bodyHtml: `<h1>Network not allowed</h1>
      <div class="flash flash-error" role="alert">This organization only allows access from approved networks, and this network is not one of them.</div>
      <p>Sign in from an approved network, or ask an owner of the organization to update the allowed networks. If every owner is locked out, contact support.</p>
      ${BACK}`
  });
}
