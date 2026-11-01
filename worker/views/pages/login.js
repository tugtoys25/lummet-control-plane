import { renderAuthShell, escapeHtml } from "../layout.js";

// Staff console sign-in. Same look as the customer login (renderCustomerAuthShell, audience "staff"), plus the
// "Are you a customer? Log in here" link to /app/login. Form fields, names and the POST contract are unchanged.
export function renderLoginPage({ mode, error, challengeId, turnstileSiteKey = "" }) {
  const flash = error
    ? `<div class="flash flash-error" role="alert">${escapeHtml(error)}</div>`
    : "";

  if (mode === "mfa") {
    return renderAuthShell({
      audience: "staff",
      title: "Two-factor code",
      bodyHtml: `
        <h1>Two-factor code</h1>
        <p class="auth-sub">Enter the 6-digit code from your authenticator app, or one of your backup codes.</p>
        ${flash}
        <form method="POST" action="/login">
          <input type="hidden" name="mode" value="mfa" />
          <input type="hidden" name="challenge_id" value="${escapeHtml(challengeId || "")}" />
          <label for="code">Authenticator code</label>
          <input type="text" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" autofocus />
          <label for="backup_code">Or a backup code</label>
          <input type="text" id="backup_code" name="backup_code" autocomplete="off" />
          <button class="btn" type="submit">Verify</button>
        </form>
      `
    });
  }

  if (mode === "bootstrap") {
    return renderAuthShell({
      audience: "staff",
      title: "Set up",
      bodyHtml: `
        <h1>Set up Lummet</h1>
        <p class="auth-sub">No Lummet administrator exists yet. Create the first one &mdash; this form only works once.</p>
        ${flash}
        <form method="POST" action="/login">
          <input type="hidden" name="mode" value="bootstrap" />
          <label for="email">Email</label>
          <input type="email" id="email" name="email" autocomplete="email" required autofocus />
          <label for="password">Password (12+ characters)</label>
          <input type="password" id="password" name="password" autocomplete="new-password" minlength="12" required />
          <button class="btn" type="submit">Create admin account</button>
        </form>
      `
    });
  }

  return renderAuthShell({
    audience: "staff",
    title: "Log in",
    bodyHtml: `
      <h1>Staff sign in</h1>
      <p class="auth-sub">Lummet central control plane.</p>
      ${flash}
      <form method="POST" action="/login">
        <input type="hidden" name="mode" value="login" />
        <label for="email">Email</label>
        <input type="email" id="email" name="email" autocomplete="username" required autofocus />
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autocomplete="current-password" required />
        ${turnstileSiteKey ? `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><div class="cf-turnstile auth-turnstile" data-sitekey="${escapeHtml(turnstileSiteKey)}"></div>` : ""}
        <button class="btn" type="submit">Log in</button>
      </form>
    `
  });
}
