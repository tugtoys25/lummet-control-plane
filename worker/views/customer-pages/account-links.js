import { renderAuthShell } from "../layout.js";
import { nonceToken } from "../../csp.js";

// Pages reached from emailed links. GET never mutates: the token is only
// submitted by an explicit button press (protects against link scanners).
const SCRIPT = (endpoint, fields, okMsg, redirectTo) => `
<script nonce="${nonceToken()}">
(function(){
  var p = new URLSearchParams(location.search);
  var uid = p.get('uid') || '', token = p.get('token') || '';
  history.replaceState(null, '', location.pathname); // keep token out of history/referrers
  document.getElementById('go').addEventListener('click', function(e){
    e.preventDefault();
    var body = { userId: uid, token: token };
    ${fields}
    fetch('${endpoint}', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
      .then(function(r){ return r.json(); })
      .then(function(d){
        var f = document.getElementById('flash');
        if (d.success) { f.innerHTML = '<div class="flash flash-success">${okMsg}</div>'; setTimeout(function(){ location.href='${redirectTo}'; }, 1200); }
        else { f.innerHTML = '<div class="flash flash-error">This link is invalid or has expired.</div>'; }
      });
  });
})();
</script>`;

export function renderVerifyEmailPage() {
  return renderAuthShell({
    title: "Verify email",
    bodyHtml: `<div id="flash"></div><p>Confirm your email address to finish setting up your account.</p>
      <button class="btn" id="go" style="width:100%;">Verify my email</button>` + SCRIPT("/api/customer/email/verify", "", "Email verified.", "/app/login")
  });
}

export function renderResetPasswordPage() {
  return renderAuthShell({
    title: "Choose a new password",
    bodyHtml: `<div id="flash"></div>
      <label for="np">New password (12+ characters)</label>
      <input type="password" id="np" minlength="12" required />
      <button class="btn" id="go" style="width:100%;">Set password</button>` +
      SCRIPT("/api/customer/password/reset", "body.newPassword = document.getElementById('np').value;", "Password updated.", "/app/login")
  });
}

export function renderForgotPasswordPage() {
  return renderAuthShell({
    title: "Reset password",
    bodyHtml: `<div id="flash"></div>
      <label for="em">Email</label><input type="email" id="em" required />
      <button class="btn" id="go" style="width:100%;">Send reset link</button>
      <p style="font-size:13px;text-align:center;margin-top:16px;"><a href="/app/login">Back to login</a></p>
      <script nonce="${nonceToken()}">document.getElementById('go').addEventListener('click',function(e){e.preventDefault();
        fetch('/api/customer/password/forgot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:document.getElementById('em').value})})
        .then(function(){document.getElementById('flash').innerHTML='<div class="flash flash-success">If that email has an account, a reset link is on its way.</div>';});});</script>`
  });
}

export function renderInvitationPage() {
  return renderAuthShell({
    title: "Accept invitation",
    bodyHtml: `<div id="flash"></div><p>Log in with the email address this invitation was sent to, then accept.</p>
      <button class="btn" id="go" style="width:100%;">Accept invitation</button>
      <p style="font-size:13px;text-align:center;margin-top:16px;"><a href="/app/login">Log in / create account</a></p>
      <script nonce="${nonceToken()}">(function(){var t=new URLSearchParams(location.search).get('token')||'';history.replaceState(null,'',location.pathname);
        document.getElementById('go').addEventListener('click',function(e){e.preventDefault();
          fetch('/api/invitations/'+encodeURIComponent(t)+'/accept',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
            var f=document.getElementById('flash');
            if(d.success){location.href='/app/overview';}
            else{f.innerHTML='<div class="flash flash-error">'+(d.error==='unauthorized'?'Please log in first.':d.error==='invitation_email_mismatch'?'This invitation was sent to a different email address.':'This invitation is invalid or expired.')+'</div>';}});});})();</script>`
  });
}
