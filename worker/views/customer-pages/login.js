import { escapeHtml } from "../layout.js";
import { renderCustomerAuthShell } from "../customer-auth-shell.js";
import { nonceToken, onClick } from "../../csp.js";

// Client-side fetch against /api/customer/signup and /api/customer/login
// (both already built and tested in Phase 1) rather than a server-side
// form POST — no new server-side parsing/adapter code needed, and the
// exact same validated path every JSON API consumer already uses.
export function renderCustomerLoginPage({ turnstileSiteKey = "", initialView = "login" } = {}) {
  return renderCustomerAuthShell({
    title: "Log in",
    bodyHtml: `
      <div id="flash" class="auth-flash" role="status" aria-live="polite"></div>
      ${turnstileSiteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile auth-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}" data-callback="lummetTurnstileSuccess"></div>` : ""}
      <input type="hidden" id="turnstile-token" value="" />

      <div id="login-view">
        <h1>Welcome back</h1>
        <p class="auth-sub">Log in to your Lummet account.</p>
        <form id="login-form">
          <label for="login-email">Email</label>
          <input type="email" id="login-email" autocomplete="email" required autofocus />
          <label for="login-password">Password</label>
          <input type="password" id="login-password" autocomplete="current-password" required />
          <button class="auth-btn" type="submit">Log in</button>
        </form>
        <p class="auth-alt">
          New here? <a href="#"${onClick("showSignup", [], {prevent: true})}>Create an account</a><span class="sep" aria-hidden="true">&middot;</span><a href="/app/forgot-password">Forgot password?</a>
        </p>
      </div>

      <div id="signup-view" style="display:none;">
        <h1>Create your account</h1>
        <p class="auth-sub">Set up your organization in a minute.</p>
        <form id="signup-form">
          <label for="signup-org">Organization name</label>
          <input type="text" id="signup-org" autocomplete="organization" required />
          <label for="signup-email">Email</label>
          <input type="email" id="signup-email" autocomplete="email" required />
          <label for="signup-password">Password (12+ characters)</label>
          <input type="password" id="signup-password" autocomplete="new-password" minlength="12" required />
          <button class="auth-btn" type="submit">Create account</button>
        </form>
        <p class="auth-alt">
          Already have an account? <a href="#"${onClick("showLogin", [], {prevent: true})}>Log in</a>
        </p>
      </div>

      <script nonce="${nonceToken()}">
        // Preserve the pricing choice through account creation and later verification/login.
        // The plan is only an intent hint; billing revalidates plan status and price server-side.
        var signupIntent = (function () {
          var q = new URLSearchParams(location.search);
          var plan = q.get('plan'); var period = q.get('period');
          if (plan && /^[A-Za-z0-9_-]{1,100}$/.test(plan) && ['monthly','annual'].indexOf(period) >= 0) {
            var intent = { planId: plan, period: period }; localStorage.setItem('lummetSignupIntent', JSON.stringify(intent)); return intent;
          }
          try { return JSON.parse(localStorage.getItem('lummetSignupIntent') || 'null'); } catch (_) { return null; }
        })();
        function intentDestination() {
          return signupIntent && signupIntent.planId ? '/app/billing?plan=' + encodeURIComponent(signupIntent.planId) + '&period=' + encodeURIComponent(signupIntent.period) : '/app/overview';
        }
        function lummetTurnstileSuccess(token) { var field = document.getElementById('turnstile-token'); if (field) field.value = token || ''; }
        function flash(message, kind) {
          var box = document.getElementById('flash');
          box.textContent = '';
          if (!message) return;
          var d = document.createElement('div');
          d.className = 'flash flash-' + kind;
          d.textContent = message;
          box.appendChild(d);
        }
        function busy(form, on) {
          var b = form.querySelector('button[type=submit]');
          if (b) b.disabled = !!on;
        }
        function showSignup() {
          document.getElementById('login-view').style.display = 'none';
          document.getElementById('signup-view').style.display = 'block';
          flash('');
        }
        function showLogin() {
          document.getElementById('signup-view').style.display = 'none';
          document.getElementById('login-view').style.display = 'block';
          flash('');
        }

        document.getElementById('login-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var form = e.target; busy(form, true);
          fetch('/api/customer/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              email: document.getElementById('login-email').value,
              password: document.getElementById('login-password').value,
              turnstileToken: (document.getElementById('turnstile-token') || {}).value || ''
            })
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.success) { location.href = intentDestination(); }
              else { busy(form, false); flash('Could not log in — check your email and password.', 'error'); }
            })
            .catch(function () { busy(form, false); flash('Could not reach the server.', 'error'); });
        });

        document.getElementById('signup-form').addEventListener('submit', function (e) {
          e.preventDefault();
          var form = e.target; busy(form, true);
          fetch('/api/customer/signup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              organizationName: document.getElementById('signup-org').value,
              email: document.getElementById('signup-email').value,
              password: document.getElementById('signup-password').value,
              planId: signupIntent && signupIntent.planId || null,
              billingPeriod: signupIntent && signupIntent.period || null,
              turnstileToken: (document.getElementById('turnstile-token') || {}).value || ''
            })
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.success) { location.href = intentDestination(); }
              else { busy(form, false); flash('Could not create your account — ' + (data.error || 'please check your details') + '.', 'error'); }
            })
            .catch(function () { busy(form, false); flash('Could not reach the server.', 'error'); });
        });
        ${initialView === "signup" ? "showSignup();" : ""}
      </script>
    `
  });
}

export { escapeHtml };
