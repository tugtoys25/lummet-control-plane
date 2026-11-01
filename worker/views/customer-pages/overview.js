import { escapeHtml } from "../customer-layout.js";

function trialCountdown(trialEndsAt) {
  if (!trialEndsAt) return null;
  const msLeft = new Date(trialEndsAt).getTime() - Date.now();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) return "Trial has ended";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in trial`;
}

function renderTwoFactorNotice() {
  return `<section class="card" role="note" aria-labelledby="two-factor-notice" style="border-left:4px solid var(--accent, #6d5efc);">
      <h2 id="two-factor-notice" style="margin-top:0;">Strengthen your account security</h2>
      <p style="color:var(--text-dim);font-size:14px;margin:0 0 12px;">Two-factor authentication adds a second check when you sign in, so your account and your sites stay protected even if your password is exposed. Setup takes about two minutes with any authenticator app.</p>
      <a class="btn" href="/app/security/2fa">Set up two-factor authentication</a>
    </section>`;
}

function renderGettingStartedGuide() {
  return `<details class="card" id="getting-started-guide">
      <summary style="cursor:pointer;font-weight:600;">See the getting-started summary and get your first site live in 7 minutes!</summary>
      <div style="margin-top:14px;font-size:14px;line-height:1.55;">
        <h2 style="margin:0 0 4px;">GET YOUR WEBSITE LIVE</h2>
        <p style="color:var(--text-dim);margin:0 0 12px;">Follow these steps. It usually takes 5 to 10 minutes.</p>
        <h3>1. Register and verify your email</h3>
        <ul>
          <li>Create your account with your email and a password.</li>
          <li>Open the verification email we send you and click the link. Check spam if you don't see it.</li>
        </ul>
        <h3>2. Choose a plan and pay</h3>
        <ul>
          <li>Pick the plan that fits you on <a href="/app/billing">Billing</a>.</li>
          <li>Choose how to pay: click start free trial, or checkout and subscribe by card or crypto.</li>
        </ul>
        <p style="margin:8px 0 4px;"><strong>Paying with crypto:</strong></p>
        <ul>
          <li>Select "Pay with crypto" at checkout (<a href="/app/billing">Billing</a>).</li>
          <li>Choose your coin and network.</li>
          <li>Send the exact amount to the address or QR code shown, on the same network, before the timer ends.</li>
          <li>Wait for the payment to be confirmed. Your plan switches on automatically once it is.</li>
          <li>Sending too little, the wrong coin or the wrong network can delay or lose your payment. If it is still pending after your wallet shows it was sent, contact support with your transaction ID.</li>
        </ul>
        <h3>3. Create your site</h3>
        <ul>
          <li>Go to <a href="/app/sites">Sites</a> and click "Create site".</li>
          <li>Give it a name and confirm.</li>
        </ul>
        <h3>4. Provision and wait until it is Live</h3>
        <ul>
          <li>On <a href="/app/sites">Sites</a>, click "Provision". We build your site's own space and install everything for you.</li>
          <li>Wait until the status changes to "Live". You can leave the page and come back.</li>
        </ul>
        <h3>5. Create your site password</h3>
        <ul>
          <li>Open the site's <a href="/app/content">Content</a> section.</li>
          <li>Create a site password.</li>
          <li>This password is separate from your Lummet account password. Keep it safe.</li>
        </ul>
        <h3>6. Visit and manage your site</h3>
        <ul>
          <li>Open the default web address shown for your site on <a href="/app/sites">Sites</a>.</li>
          <li>Sign in with your dashboard email and the site password you just set.</li>
          <li>Manage your fully built site.</li>
        </ul>
        <h3>7. Use your own domain (optional)</h3>
        <ul>
          <li>Go to <a href="/app/domains">Domains</a> and choose your site.</li>
          <li>Enter the domain you own, for example yourbrand.com.</li>
          <li>Copy the two nameservers we show you.</li>
          <li>Log in where you bought the domain, open its Nameservers or DNS settings and replace the current ones with ours.</li>
          <li>Wait for the change to take effect. This can take a few minutes to 48 hours. Your site shows "Live" when it is connected.</li>
          <li>Don't change the nameservers back at your registrar while the domain is connected, or your site will stop loading. Disconnect the domain in Lummet first.</li>
        </ul>
        <h3>Need help?</h3>
        <ul>
          <li>Stuck on provisioning or domain status for over 24 hours? Contact support with your domain name.</li>
          <li>Crypto payment pending? Send your transaction ID.</li>
        </ul>
      </div>
    </details>`;
}

export function renderOverviewPage({ organization, subscription, plan, usage, sites, showTwoFactorNotice = false }) {
  const statusBadge = subscription
    ? `<span class="badge badge-${escapeHtml(subscription.status)}">${escapeHtml(subscription.status)}</span>`
    : `<span class="badge badge-canceled">no plan</span>`;

  const trialNote = subscription?.status === "trialing" ? trialCountdown(subscription.trial_ends_at) : null;

  const upgradeCta = !subscription
    ? `<div class="card">
         <h2>Get started</h2>
         <p style="color:var(--text-dim);font-size:14px;">This organization has no plan yet — start a trial to create your first site.</p>
         <a class="btn" href="/app/billing">Choose a plan</a>
       </div>`
    : "";

  const sitesRows = sites.length
    ? sites
        .map(
          (site) => `
          <tr>
            <td><a href="/app/sites#${escapeHtml(site.id)}">${escapeHtml(site.name)}</a></td>
            <td>${escapeHtml(site.product_name || "")}</td>
            <td><span class="badge badge-${escapeHtml(site.status)}">${escapeHtml(site.status)}</span></td>
            <td class="mono">${escapeHtml(site.primary_domain || "—")}</td>
          </tr>`
        )
        .join("")
    : `<tr><td colspan="4" class="empty">No sites yet.</td></tr>`;

  return `
    <h1>Overview</h1>
    <p class="subtitle">${escapeHtml(organization.name)}</p>

    ${showTwoFactorNotice ? renderTwoFactorNotice() : ""}
    ${sites.length === 0 ? renderGettingStartedGuide() : ""}
    ${upgradeCta}
    ${sites.length === 0 ? `<section class="card" aria-labelledby="first-site-checklist"><h2 id="first-site-checklist">First-site checklist</h2><ol><li>Choose a plan that includes a site.</li><li>Create your first site from Sites.</li><li>Review the generated preview before publishing.</li><li>Connect a domain when you are ready.</li><li>Invite teammates only when needed.</li></ol><p>Checklist guidance only; no site is created automatically.</p></section>` : ""}

    <div class="grid">
      <div class="card stat">
        <div class="value">${usage.sites.used}${usage.sites.limit != null ? " / " + usage.sites.limit : ""}</div>
        <div class="label">Sites</div>
      </div>
      <div class="card stat">
        <div class="value">${usage.users.used}${usage.users.limit != null ? " / " + usage.users.limit : ""}</div>
        <div class="label">Team members</div>
      </div>
      <div class="card stat">
        <div class="value">${usage.customDomains.used}${usage.customDomains.limit != null ? " / " + usage.customDomains.limit : ""}</div>
        <div class="label">Custom domains</div>
      </div>
      <div class="card stat">
        <div class="value">${statusBadge}</div>
        <div class="label">${plan ? escapeHtml(plan.name) : "Plan"}${trialNote ? "<br/>" + escapeHtml(trialNote) : ""}</div>
      </div>
    </div>

    <div class="card">
      <h2>Sites</h2>
      <table>
        <thead><tr><th>Name</th><th>Product</th><th>Status</th><th>Domain</th></tr></thead>
        <tbody>${sitesRows}</tbody>
      </table>
    </div>
  `;
}

export { trialCountdown };
