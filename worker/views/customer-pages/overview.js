import { escapeHtml } from "../customer-layout.js";

function trialCountdown(trialEndsAt) {
  if (!trialEndsAt) return null;
  const msLeft = new Date(trialEndsAt).getTime() - Date.now();
  const daysLeft = Math.ceil(msLeft / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) return "Trial has ended";
  return `${daysLeft} day${daysLeft === 1 ? "" : "s"} left in trial`;
}

function renderTwoFactorNotice() {
  return `<section class="card" role="note" aria-labelledby="two-factor-notice" style="border-left:4px solid var(--accent, #1a56db);">
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

function checklistHtml({ subscription, usage }) {
  const steps = [
    ["Choose a plan that includes a site.", !!subscription],
    ["Create your first site from Sites.", false],
    ["Review the generated preview before publishing.", false],
    ["Connect a domain when you are ready.", !!(usage && usage.customDomains && usage.customDomains.used > 0)],
    ["Invite teammates only when needed.", !!(usage && usage.users && usage.users.used > 1)]
  ];
  const done = steps.filter((x) => x[1]).length;
  return `<section class="card" aria-labelledby="first-site-checklist"><h2 id="first-site-checklist">First-site checklist</h2><p class="checklist-progress">${done} of ${steps.length} done</p><ol class="check-list">${steps.map(([t, d]) => `<li class="${d ? "is-done" : ""}"><span class="tick" aria-hidden="true">${d ? "&#10003;" : ""}</span><span>${t}${d ? ' <span class="sr-only">(done)</span>' : ""}</span></li>`).join("")}</ol><p>Checklist guidance only; no site is created automatically.</p></section>`;
}

function usageBar(u) {
  if (!u || u.limit == null || !(u.limit > 0)) return "";
  const pct = Math.min(100, Math.round((u.used / u.limit) * 100));
  return `<div class="usage-bar${pct >= 100 ? " is-full" : pct >= 80 ? " is-warn" : ""}" role="img" aria-label="${pct}% used"><span style="width:${pct}%"></span></div>`;
}

function attentionHtml(items) {
  if (!items.length) return `<section class="card" aria-label="Needs your attention"><div class="ops-head"><h2>Needs your attention</h2></div><div class="ops-allclear"><span class="badge badge-ok">All clear</span><span class="ops-note">Nothing needs your attention right now.</span></div></section>`;
  return `<section class="card" aria-label="Needs your attention"><div class="ops-head"><h2>Needs your attention</h2></div><ul class="ops-attn">${items.slice(0, 6).map((i) => `<li class="is-${i.level}"><span class="badge ${i.level === "danger" ? "badge-danger" : "badge-warn"}">${i.level === "danger" ? "Urgent" : "Check"}</span><span><div class="ops-t">${escapeHtml(i.title)}</div><div class="ops-d">${escapeHtml(i.detail)}</div></span><a class="ops-go" href="${i.href}">Open</a></li>`).join("")}</ul></section>`;
}

function money(cents, cur) { try { return new Intl.NumberFormat("en", { style: "currency", currency: String(cur || "USD").toUpperCase() }).format((cents || 0) / 100); } catch { return `${((cents || 0) / 100).toFixed(2)} ${cur || ""}`; } }
const day = (v) => (v ? escapeHtml(String(v).slice(0, 10)) : "");

function billingHtml(b, plan) {
  const rows = [`<dt>Plan</dt><dd>${escapeHtml(plan ? plan.name : "None")}</dd>`];
  if (b.status === "trialing" && b.trialEnds) rows.push(`<dt>Trial ends</dt><dd>${day(b.trialEnds)}</dd>`);
  else if (b.periodEnd) rows.push(`<dt>${b.cancelAtEnd ? "Ends on" : "Renews on"}</dt><dd>${day(b.periodEnd)}</dd>`);
  if (b.graceEnds && b.status === "past_due") rows.push(`<dt>Pay by</dt><dd>${day(b.graceEnds)}</dd>`);
  rows.push(`<dt>Payment method</dt><dd>${b.method ? escapeHtml((b.method.card_brand || b.method.type || "Card") + (b.method.card_last4 ? " ending " + b.method.card_last4 : "")) : "None saved"}</dd>`);
  const inv = b.invoice;
  const invLine = inv ? `<p class="ops-sub">Latest invoice: ${money(inv.total_cents != null ? inv.total_cents : inv.amount_due_cents, inv.currency)}, <span class="badge ${inv.status === "paid" ? "badge-ok" : inv.status === "open" ? "badge-warn" : "badge-dim"}">${escapeHtml(inv.status)}</span>${inv.hosted_invoice_url && /^https:\/\//.test(inv.hosted_invoice_url) ? ` <a href="${escapeHtml(inv.hosted_invoice_url)}">View</a>` : ""}</p>` : "";
  return `<div class="card"><div class="ops-head"><h2>Billing</h2><a href="/app/billing">Manage</a></div><dl class="ops-kv">${rows.join("")}</dl>${invLine}</div>`;
}

function activityHtml(items) {
  return `<div class="card"><div class="ops-head"><h2>Recent activity</h2></div>${items.length ? `<table><tbody>${items.map((a) => `<tr><td class="ops-note" style="white-space:nowrap">${escapeHtml(String(a.at).slice(0, 16))}</td><td>${escapeHtml(a.text)}${a.ok ? "" : ' <span class="badge badge-danger">Problem</span>'}</td></tr>`).join("")}</tbody></table>` : `<p class="ops-sub">Nothing yet. Updates, domain changes and team actions show up here.</p>`}</div>`;
}

export function renderOverviewPage({ organization, subscription, plan, usage, sites, showTwoFactorNotice = false, extra = null, attention = null, canManage = false }) {
  const statusBadge = subscription
    ? `<span class="badge badge-${escapeHtml(subscription.status)}">${escapeHtml(subscription.status)}</span>`
    : `<span class="badge badge-canceled">no plan</span>`;

  const trialNote = subscription?.status === "trialing" ? trialCountdown(subscription.trial_ends_at) : null;

  // One blue banner at most: the next thing the customer should do.
  const banner = (title, text, href, label) =>
    `<section class="cta-banner" aria-labelledby="next-step-title">
       <div><h2 id="next-step-title">${escapeHtml(title)}</h2><p>${escapeHtml(text)}</p></div>
       <a class="btn" href="${href}">${escapeHtml(label)}</a>
     </section>`;
  const upgradeCta = !subscription
    ? banner("Get started", "This organization has no plan yet — start a trial to create your first site.", "/app/billing", "Choose a plan")
    : sites.length === 0
      ? banner("Create your first site", "Your plan is ready. Create a site to see it live.", "/app/sites", "Create a site")
      : trialNote
        ? banner("Your trial is running", trialNote, "/app/billing", "Choose a plan")
        : "";

  const rowExtra = new Map(((extra && extra.siteRows) || []).map((r) => [r.id, r]));
  const withHealth = !!extra;
  const healthCell = (site) => {
    const r = rowExtra.get(site.id);
    if (!["active", "live"].includes(site.status)) return `<span class="badge badge-dim">—</span>`;
    if (!r || !r.health) return `<span class="badge badge-dim">Not checked</span>`;
    return r.health === "Online" ? `<span class="badge badge-ok">Healthy</span>` : `<span class="badge badge-danger">${escapeHtml(r.health)}</span>`;
  };
  const updateCell = (site) => {
    const d = (rowExtra.get(site.id) || {}).deploy;
    return d ? `${escapeHtml(String(d.completed_at || d.created_at || "").slice(0, 10))}${["failed", "rolled_back"].includes(d.status) ? ' <span class="badge badge-danger">' + escapeHtml(d.status.replace("_", " ")) + "</span>" : ""}` : "—";
  };
  const sitesRows = sites.length
    ? sites
        .map(
          (site) => `
          <tr>
            <td><a href="/app/sites#${escapeHtml(site.id)}">${escapeHtml(site.name)}</a></td>
            <td>${escapeHtml(site.product_name || "")}</td>
            <td><span class="badge badge-${escapeHtml(site.status)}">${escapeHtml(site.status)}</span></td>
            ${withHealth ? `<td>${healthCell(site)}</td>` : ""}
            <td class="mono">${escapeHtml(site.primary_domain || "—")}</td>
            ${withHealth ? `<td>${updateCell(site)}</td>` : ""}
          </tr>`
        )
        .join("")
    : `<tr><td colspan="${withHealth ? 6 : 4}" class="empty">No sites yet.</td></tr>`;

  return `
    <h1>Overview</h1>
    <p class="subtitle">${escapeHtml(organization.name)}</p>

    ${showTwoFactorNotice ? renderTwoFactorNotice() : ""}
    ${sites.length === 0 ? renderGettingStartedGuide() : ""}
    ${upgradeCta}
    ${sites.length === 0 ? checklistHtml({ subscription, usage }) : ""}
    ${attention && (attention.length || sites.length) ? attentionHtml(attention) : ""}

    <div class="grid">
      <div class="card stat">
        <div class="value">${usage.sites.used}${usage.sites.limit != null ? " / " + usage.sites.limit : ""}</div>
        <div class="label">Sites</div>
        ${usageBar(usage.sites)}
      </div>
      <div class="card stat">
        <div class="value">${usage.users.used}${usage.users.limit != null ? " / " + usage.users.limit : ""}</div>
        <div class="label">Team members</div>
        ${usageBar(usage.users)}
      </div>
      <div class="card stat">
        <div class="value">${usage.customDomains.used}${usage.customDomains.limit != null ? " / " + usage.customDomains.limit : ""}</div>
        <div class="label">Custom domains</div>
        ${usageBar(usage.customDomains)}
      </div>
      <div class="card stat">
        <div class="value">${statusBadge}</div>
        <div class="label">${plan ? escapeHtml(plan.name) : "Plan"}${trialNote ? "<br/>" + escapeHtml(trialNote) : ""}</div>
      </div>
    </div>

    <div class="card">
      <h2>Sites</h2>
      <table>
        <thead><tr><th>Name</th><th>Product</th><th>Status</th>${withHealth ? "<th>Health</th>" : ""}<th>Domain</th>${withHealth ? "<th>Last update</th>" : ""}</tr></thead>
        <tbody>${sitesRows}</tbody>
      </table>
    </div>
    ${extra ? `<div class="ops-cols">${canManage && extra.billing ? billingHtml(extra.billing, plan) : ""}${activityHtml(extra.activity || [])}</div>` : ""}
  `;
}

export { trialCountdown };
