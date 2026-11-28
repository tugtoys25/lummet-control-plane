// Customer portal: Cloudflare hosting (/app/cloud-hosting). The organization's own Cloudflare accounts, their domains, the sites that
// run in them, moving a Lummet-hosted site into one, and the full guide. Server-rendered; every value from data is escaped with
// escapeHtml() here or set with textContent in the browser. No secret is ever part of this page: accounts come as accountView()
// (token hint only), and the forms send secrets to the API without echoing them back.
import { escapeHtml } from "../layout.js";
import { nonceToken, onClick, onSubmit, onChange } from "../../csp.js";
import { CAPABILITIES } from "../../custom-hosting.js";

const h = escapeHtml;
const badge = (t, tone = "") => `<span class="role-badge"${tone ? ` style="${tone === "bad" ? "background:#fde8e8;color:#b42318" : tone === "good" ? "background:#e6f4ea;color:#067647" : "background:#fff4e5;color:#8a5300"}"` : ""}>${h(t)}</span>`;
const STATUS_TONE = { verified: "good", invalid: "bad", disabled: "bad", unverified: "warn", active: "good", transferring: "warn", pending: "warn", failed: "bad", completed: "good", running: "warn", queued: "warn", cancelled: "" };
const STEP_LABEL = {
  validate: "Check the account and destination", create_resources: "Create database, cache and media bucket in your account",
  copy_media: "Copy media files", copy_kv: "Copy cached data", deploy_target: "Deploy the site in your account",
  cutover: "Final window: pause the site, copy the database and the latest changes, check the copy, switch over"
};
const fmtBytes = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n > 1024 ? `${Math.round(n / 1024)} KB` : `${n || 0} B`);

function permissionList(a) {
  return `<ul style="margin:4px 0 0 16px;padding:0;font-size:13px">${a.permissions.map((p) => {
    const mark = p.ok === true ? "\u2713" : p.ok === false ? "\u2717" : "?";
    const color = p.ok === true ? "var(--success, #067647)" : p.ok === false ? (p.required ? "var(--danger, #b42318)" : "#8a5300") : "inherit";
    const note = p.ok === false && p.code === "r2_not_enabled" ? " (R2 is not enabled on this account)" : p.ok === false && !p.required ? " (optional)" : "";
    return `<li style="color:${color}">${mark} ${h(p.label || p.key)}${h(note)}</li>`;
  }).join("")}</ul>`;
}

function accountCard(a, { canManage, enabled }) {
  const ready = a.status === "verified" && a.workersSubdomain;
  return `
    <div class="card" id="acct-${h(a.id)}" style="margin:10px 0">
      <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:flex-start">
        <div>
          <h3 style="margin:0">${h(a.label)} ${badge(a.status, STATUS_TONE[a.status])}</h3>
          <div class="subtitle">Account <span class="mono">${h(a.accountId)}</span>${a.accountName ? ` \u00b7 ${h(a.accountName)}` : ""} \u00b7 token ${h(a.tokenHint || "\u2026")}${a.lastVerifiedAt ? ` \u00b7 checked ${h(a.lastVerifiedAt)}` : ""}</div>
          <div class="subtitle">workers.dev: ${a.workersSubdomain ? `<span class="mono">${h(a.workersSubdomain)}.workers.dev</span>` : `<strong>none yet</strong>`}
            \u00b7 R2 access keys: ${a.r2AccessKeyId ? `<span class="mono">${h(a.r2AccessKeyId)}</span>${a.r2SecretSaved ? "" : " (secret missing)"}` : "not set"}
            \u00b7 email: ${a.emailFrom ? h(a.emailFrom) : "not set"} \u00b7 sites: ${Number(a.siteCount) || 0}</div>
          ${a.lastError ? `<p style="color:var(--danger, #b42318);margin:6px 0">${h(a.lastError)}</p>` : ""}
          ${permissionList(a)}
        </div>
        ${canManage ? `<div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn" type="button"${onClick("chVerify", [a.id])}>Check again</button>
          ${a.workersSubdomain ? "" : `<button class="btn" type="button"${onClick("chClaimSub", [a.id])}>Set up workers.dev</button>`}
          <button class="btn" type="button"${onClick("chToggle", [`edit-${a.id}`])}>Edit</button>
          <button class="btn" type="button"${onClick("chZones", [a.id])}>Domains</button>
          <button class="btn btn-danger" type="button"${onClick("chRemove", [a.id, a.label], { confirm: `Remove the Cloudflare account "${a.label}" from Lummet? Nothing is deleted in Cloudflare. This is refused while a site runs on it.` })}>Remove</button>
        </div>` : ""}
      </div>
      ${ready ? "" : `<p class="subtitle" style="margin:6px 0">This account cannot host sites until every required permission shows \u2713 and it has a workers.dev subdomain. See <a href="#guide-token">the guide</a>.</p>`}
      ${canManage ? `
      <form id="edit-${h(a.id)}" style="display:none;border-top:1px solid var(--border, #ddd);margin-top:8px;padding-top:8px"${onSubmit("chSaveEdit", ["$el", a.id], { prevent: true })}>
        <label>Name</label><input name="label" value="${h(a.label)}" maxlength="80" />
        <label>New API token (leave empty to keep the current one)</label><input name="apiToken" type="password" autocomplete="new-password" spellcheck="false" />
        <label>R2 access key ID</label><input name="r2AccessKeyId" class="mono" maxlength="32" placeholder="${a.r2AccessKeyId ? "leave empty to keep" : ""}" autocomplete="off" />
        <label>R2 secret access key</label><input name="r2SecretAccessKey" type="password" autocomplete="new-password" placeholder="${a.r2SecretSaved ? "leave empty to keep" : ""}" />
        <label>R2 jurisdiction</label><select name="r2Jurisdiction">${["default", "eu", "fedramp"].map((j) => `<option value="${j}"${a.r2Jurisdiction === j ? " selected" : ""}>${j}</option>`).join("")}</select>
        <label>Email sender address (for the site's emails, optional)</label><input name="emailFrom" value="${h(a.emailFrom || "")}" maxlength="254" />
        <label>Resend API key (leave empty to keep)</label><input name="emailApiKey" type="password" autocomplete="new-password" />
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="removeR2Keys" style="width:auto" /> Remove the R2 access keys</label>
        <label style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="removeEmail" style="width:auto" /> Remove the email settings</label>
        <button class="btn" type="submit">Save</button> <span class="subtitle">Changes to R2 or email are applied to the sites on this account with an automatic redeploy.</span>
      </form>` : ""}
      <div id="zones-${h(a.id)}" style="display:none;border-top:1px solid var(--border, #ddd);margin-top:8px;padding-top:8px">
        <div class="zone-list subtitle">Loading\u2026</div>
        ${canManage && enabled ? `<form style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"${onSubmit("chAddZone", ["$el", a.id], { prevent: true })}>
          <input name="domain" placeholder="example.com" required autocomplete="off" spellcheck="false" style="flex:1;min-width:200px" />
          <button class="btn" type="submit">Connect a domain to this account</button>
        </form>
        <p class="subtitle">Connecting adds the domain to your Cloudflare account. You then change its nameservers at your registrar to the two shown, and press Check.</p>` : ""}
      </div>
    </div>`;
}

function accountOptions(accounts) {
  return accounts.map((a) => {
    const usable = a.status === "verified" && a.workersSubdomain;
    return `<option value="${h(a.id)}" data-sub="${h(a.workersSubdomain || "")}"${usable ? "" : " disabled"}>${h(a.label)} (${h(a.accountName || a.accountId)})${usable ? "" : " \u2014 not ready"}</option>`;
  }).join("");
}

function destinationFields(prefix, accounts, { fixedAccount = null } = {}) {
  return `
        ${fixedAccount ? `<input type="hidden" name="accountId" value="${h(fixedAccount)}" />` : `<label>Cloudflare account</label>
        <select name="accountId" required${onChange("chDestChanged", ["$el"])}><option value="">Choose\u2026</option>${accountOptions(accounts)}</select>`}
        <label>Where the site answers</label>
        <select name="landing"${onChange("chDestChanged", ["$el"])}>
          <option value="workers_dev">Cloudflare workers.dev address</option>
          <option value="custom_domain">A domain in this Cloudflare account</option>
        </select>
        <div class="dest-domain" style="display:none">
          <label>Domain</label><select name="zoneId"><option value="">Choose the account first</option></select>
          <label>Subdomain (empty = the domain itself)</label><input name="subdomain" maxlength="63" placeholder="www" autocomplete="off" spellcheck="false" />
        </div>`;
}

function transferBlock(site, t, { canManage }) {
  if (!t) return "";
  const steps = t.steps.map((s) => `<li>${s.status === "success" ? "\u2713" : s.status === "running" ? "\u2026" : s.status === "failed" ? "\u2717" : "\u25cb"} ${h(STEP_LABEL[s.key] || s.key)}${s.error ? ` <span style="color:var(--danger, #b42318)">${h(s.error)}</span>` : ""}</li>`).join("");
  const copied = `Copied so far: ${t.copied.media} media files (${fmtBytes(t.copied.mediaBytes)}), ${t.copied.kv} cache entries${t.copied.database ? ", the database" : ""}.${t.copied.mediaSkippedTooLarge ? ` ${t.copied.mediaSkippedTooLarge} media files over 95 MB were not copied: upload them again in the site after the move.` : ""}`;
  const open = ["queued", "running", "failed"].includes(t.status);
  return `
      <div class="transfer" data-site="${h(site.id)}" data-status="${h(t.status)}" style="margin-top:8px">
        <strong>Move to your Cloudflare account:</strong> ${badge(t.status, STATUS_TONE[t.status])} ${t.paused ? `<span class="subtitle">(continuing)</span>` : ""}
        <ol style="margin:4px 0 4px 18px;padding:0;font-size:13px">${steps}</ol>
        <div class="subtitle">${h(copied)}</div>
        ${t.error ? `<p style="color:var(--danger, #b42318)">${h(t.error)}</p>` : ""}
        ${t.status === "completed" ? `<p class="subtitle">Finished ${h(t.completedAt || "")}. The site now answers at <span class="mono">${h(t.newHost || site.primary_domain || "")}</span>${t.sourceHost ? `; its old address <span class="mono">${h(t.sourceHost)}</span> ${t.redirectUntil ? `redirects to it until ${h(String(t.redirectUntil).slice(0, 10))} and stays reserved for this site` : "is no longer served"}` : ""}.
          ${t.oldCopy === "kept" || t.oldCopy === "failed" ? `A safety copy of the old database, cache and media stays in Lummet's account until you remove it.` : t.oldCopy === "removed" ? "The old Lummet copy has been removed." : ""}</p>` : ""}
        ${t.frozen ? `<p class="subtitle">The site is in maintenance for the final copy (a few minutes). It serves again as soon as the move finishes or is stopped.</p>` : ""}
        ${t.needsConfirmation ? `<p style="color:var(--danger, #b42318)">The move is paused: ${t.skippedMedia.length} media file(s) are too large to copy automatically${t.skippedMedia.length ? ` (<span class="mono">${h(t.skippedMedia.slice(0, 5).map((o) => o.key).join(", "))}</span>)` : ""}. Copy them into the new bucket yourself, then confirm; or cancel the move. The site was not touched.</p>
        ${canManage ? `<button class="btn" type="button"${onClick("chConfirmSkipped", [site.id], { confirm: "Continue the move WITHOUT these files? They will not exist in the new copy until you copy them into the new bucket yourself." })}>Continue without these files</button>` : ""}` : ""}
        ${canManage && open ? `<button class="btn" type="button"${onClick("chCancelMove", [site.id], { confirm: "Cancel this move? What it created in your Cloudflare account is removed; the site keeps running on Lummet exactly as before." })}>Cancel the move</button>` : ""}
        ${canManage && t.status === "completed" && (t.oldCopy === "kept" || t.oldCopy === "failed") ? `<button class="btn btn-danger" type="button"${onClick("chRemoveOld", [site.id], { confirm: "Delete the old copy of this site's database, cache and media from Lummet's account? The site in your Cloudflare account is not touched. This cannot be undone." })}>Remove the old Lummet copy</button>` : ""}
      </div>`;
}

function siteRow(site, { accounts, canManage, enabled }) {
  const hv = site.hosting || { mode: "lummet" };
  const t = site.transfer;
  const custom = hv.mode === "custom";
  const head = `<h3 style="margin:0">${h(site.name)} ${custom ? badge(hv.status === "transferring" ? "moving to your account" : "your Cloudflare account", hv.status === "transferring" ? "warn" : "good") : badge("Lummet hosting")}</h3>
      <div class="subtitle">Address <span class="mono">${h(site.primary_domain || "\u2014")}</span> \u00b7 status ${h(site.status)}${custom && hv.account ? ` \u00b7 account ${h(hv.account.label)}` : ""}</div>`;
  let body = "";
  if (custom && hv.status === "active") {
    const vars = (hv.variables || []).map((v) => `<li><span class="mono">${h(v.name)}</span> = ${v.secret ? `<em>secret</em> ${h(v.hint || "")}` : `<span class="mono">${h(v.value ?? "")}</span>`}${canManage ? ` <button class="btn" type="button"${onClick("chVarRemove", [site.id, v.name], { confirm: `Remove ${v.name}? The site is redeployed without it.` })}>Remove</button>` : ""}</li>`).join("");
    body = `
      <div class="subtitle">${hv.landing === "custom_domain" ? `Domain <span class="mono">${h(hv.hostname)}</span> \u00b7 ${h(hv.domainStatus)}${hv.domainError ? ` \u00b7 <span style="color:var(--danger, #b42318)">${h(hv.domainError)}</span>` : ""}` : "Answers on workers.dev"} \u00b7 Turnstile ${hv.turnstile ? "created" : "not created"}</div>
      ${hv.lastError ? `<p style="color:var(--danger, #b42318)">Last deploy problem: ${h(hv.lastError)}</p>` : ""}
      ${canManage ? `<details style="margin-top:6px"><summary>Change where it answers</summary>
        <form data-account="${h(hv.account?.id || "")}"${onSubmit("chChangeDomain", ["$el", site.id], { prevent: true })}>${destinationFields("d", accounts, { fixedAccount: hv.account?.id || "" })}
          <button class="btn" type="submit">Save and redeploy</button>
          <p class="subtitle">The old custom domain is detached from the Worker first; the DNS record Cloudflare created for it goes with it.</p>
        </form></details>
      <details style="margin-top:6px"><summary>Environment variables and secrets (${(hv.variables || []).length})</summary>
        <p class="subtitle">Extra values for the site's Worker, set through the Cloudflare API on every release. Platform names (SITE_URL, DB, TURNSTILE_\u2026) are reserved.</p>
        <ul style="font-size:13px">${vars || "<li>None.</li>"}</ul>
        <form style="display:flex;gap:6px;flex-wrap:wrap;align-items:center"${onSubmit("chVarAdd", ["$el", site.id], { prevent: true })}>
          <input name="name" placeholder="NAME" pattern="[A-Z][A-Z0-9_]{0,63}" required class="mono" style="width:180px" />
          <input name="value" placeholder="value" required style="flex:1;min-width:160px" type="password" autocomplete="off" />
          <label style="display:flex;gap:4px;align-items:center"><input type="checkbox" name="secret" checked style="width:auto" /> secret</label>
          <button class="btn" type="submit">Add and redeploy</button>
        </form></details>` : ""}`;
  } else if (!custom && enabled && canManage && site.status === "active" && !(t && ["queued", "running", "failed"].includes(t.status))) {
    body = `<details style="margin-top:6px"><summary>Move this site to my Cloudflare account</summary>
        <p class="subtitle">The site keeps running on Lummet while its database, cache and media are copied and a copy is deployed and checked in your account;
        only then does it switch. Media and data written during the move may not be carried over, so move at a quiet time. Custom domains connected on Lummet must be removed first.</p>
        <form${onSubmit("chMove", ["$el", site.id, site.name], { prevent: true })}>${destinationFields("m", accounts)}
          <button class="btn" type="submit">Start the move</button>
        </form></details>`;
  }
  return `<div class="card site-hosting" style="margin:10px 0">${head}${body}${transferBlock(site, t, { canManage })}</div>`;
}

function guide() {
  const perms = CAPABILITIES.map((c) => `<li><strong>${h(c.label)}</strong>${c.required ? "" : " (optional)"}: ${h(c.why)}.</li>`).join("");
  return `
    <h2 id="guide">Guide: hosting sites in your own Cloudflare account</h2>
    <div class="card guide">
      <details open><summary><strong>What this does</strong></summary>
        <p>Every site can run either on Lummet hosting (the default: nothing to set up) or in a Cloudflare account you own. For a site in your account,
        Lummet creates and manages its Worker, D1 database, KV cache, R2 media bucket, Turnstile widget, secrets, environment variables, cron schedule and routing
        through the Cloudflare API with the token you save here, and ships every release to it automatically, the same way as for Lummet-hosted sites.
        You can save several Cloudflare accounts and spread sites across them; several sites can share one domain on different subdomains.</p></details>

      <details id="guide-account"><summary><strong>1. Prepare your Cloudflare account and find the account ID</strong></summary>
        <ol><li>Sign in at dash.cloudflare.com (create a free account if you have none).</li>
        <li>Open <em>Workers &amp; Pages</em> once: Cloudflare then offers a <em>workers.dev</em> subdomain for the account. Pick one, or let Lummet set it up with <em>Set up workers.dev</em>.</li>
        <li>Your <strong>account ID</strong> is shown on the account home page (right-hand column, "Account ID") and in the URL after <span class="mono">dash.cloudflare.com/</span>. It is 32 letters and digits.</li></ol></details>

      <details id="guide-token"><summary><strong>2. Create the API token, and which permissions it needs</strong></summary>
        <ol><li>Go to <em>My Profile \u2192 API Tokens \u2192 Create Token \u2192 Create Custom Token</em> (or <em>Manage Account \u2192 Account API Tokens</em>).</li>
        <li>Add these <strong>Account</strong> permissions for your account: Workers Scripts: Edit, D1: Edit, Workers KV Storage: Edit, Workers R2 Storage: Edit, Turnstile: Edit, and Account Settings: Read (optional, shows the account name).</li>
        <li>To use your own domains also add <strong>Zone</strong> permissions: Zone: Read, DNS: Edit, Workers Routes: Edit, for all zones or the ones you will use. To connect new domains from Lummet, add Zone: Edit.</li>
        <li>Create the token, copy it once, and paste it here. Lummet checks it with Cloudflare before saving, stores it encrypted, and never shows it again (only its last four characters).</li></ol>
        <p>What each permission is used for:</p><ul>${perms}</ul>
        <p>After saving, each permission is tested against your account and shown with \u2713 or \u2717. Press <em>Check again</em> after you change the token's permissions in Cloudflare.</p></details>

      <details id="guide-r2"><summary><strong>3. R2: enable it, the R2 plan, and the media access keys</strong></summary>
        <ol><li>R2 must be enabled once per account: open <em>R2 Object Storage</em> in the Cloudflare dashboard and subscribe. R2 has a free monthly allowance (storage, Class A and Class B operations) and is then billed by usage
        with no egress fees; Cloudflare asks for a payment method to activate it even on the free allowance. Without it, creating the site's media bucket fails with "R2 is not enabled".</li>
        <li>Lummet creates one bucket per site and binds it to the site's Worker, so media works without extra keys.</li>
        <li>Optional <strong>R2 access keys</strong> (S3 API) let the site and its tools reach media through the S3-compatible API: in <em>R2 \u2192 Manage R2 API Tokens \u2192 Create API token</em>, choose <em>Object Read &amp; Write</em>
        (all buckets, or the site buckets <span class="mono">lummet-site-\u2026-media</span>), and copy the Access Key ID and Secret Access Key. Save them on the account here; Lummet checks them, then passes them to the site as encrypted secrets.</li>
        <li>If your data must stay in the EU (or FedRAMP), choose that jurisdiction on the account so the S3 endpoint matches.</li></ol></details>

      <details id="guide-domains"><summary><strong>4. Custom domains and subdomains</strong></summary>
        <ol><li>A domain must be an active zone in the same Cloudflare account. If it already is, it appears in the list under <em>Domains</em>.</li>
        <li>If not, use <em>Connect a domain to this account</em>: the domain is added to your Cloudflare account and two nameservers are shown. Set them at your registrar, then press <em>Check</em>; it becomes usable once Cloudflare reports it active (minutes to a day).</li>
        <li>When creating a site (or later, under <em>Change where it answers</em>) pick the domain and an optional subdomain. Lummet attaches the Worker to that hostname as a Workers Custom Domain; Cloudflare creates the DNS record and certificate.</li>
        <li>One domain can serve many sites on different subdomains, and different accounts can each have their own domains. A hostname can only serve one site.</li></ol></details>

      <details id="guide-create"><summary><strong>5. Choosing the hosting when you create a site</strong></summary>
        <p>On <a href="/app/sites">Sites</a>, the <em>Where to host</em> list shows the Lummet domains and <em>Custom Cloudflare hosting</em>. Choose the latter, pick a saved account (or add one right there), then
        workers.dev or one of your domains. The address is shown before you create the site. Everything is validated before anything is created: an unverified account, an inactive domain or a taken hostname is refused.</p></details>

      <details id="guide-releases"><summary><strong>6. Releases and automated deployments</strong></summary>
        <p>New releases reach sites in your account exactly like Lummet-hosted sites, automatically or when you deploy. Every deploy sets the site's bindings, secrets, variables, Turnstile keys and base URL through the API, so
        nothing has to be configured by hand after a release. A deploy problem in your account (for example an expired token) only affects your sites; it is shown here and on Deployments, and other sites keep updating.</p></details>

      <details id="guide-move"><summary><strong>7. Moving an existing site to your account</strong></summary>
        <p>Under <em>Sites</em> below, use <em>Move this site to my Cloudflare account</em>. The site keeps running on Lummet while its media, cache and database are copied, a copy is deployed and health-checked in your account;
        then it switches over, its old Lummet address stops serving it and its new address becomes the site's address. A safety copy of the old data stays in Lummet's account until you remove it. You can cancel a move until it switches.
        Media files over 95 MB are not copied automatically. Remove custom domains connected on Lummet before moving, and connect them in your Cloudflare account afterwards.</p></details>

      <details id="guide-security"><summary><strong>8. Security</strong></summary>
        <p>Tokens and keys are encrypted at rest and are never shown, logged or sent back to the browser. Only admins of this organization can add, change or remove accounts. Lummet's own Turnstile and email keys are never placed in your account: each site gets
        its own Turnstile widget, and emails use the Resend key you save on the account (optional). Removing an account from Lummet never deletes anything in Cloudflare; it is refused while a site runs on it.</p></details>

      <details id="guide-troubleshooting"><summary><strong>9. Troubleshooting</strong></summary>
        <ul>
          <li><strong>Token is not valid</strong>: the token was revoked, expired or copied incompletely. Create a new one and save it under <em>Edit</em>.</li>
          <li><strong>A permission shows \u2717</strong>: edit the token in Cloudflare, add the permission for this account (and zones), then <em>Check again</em>.</li>
          <li><strong>R2 is not enabled</strong>: subscribe to R2 in the Cloudflare dashboard (step 3), then <em>Check again</em> and retry the deploy.</li>
          <li><strong>No workers.dev subdomain</strong>: press <em>Set up workers.dev</em>, or open Workers &amp; Pages in Cloudflare once.</li>
          <li><strong>Domain not active</strong>: the nameservers at your registrar are not Cloudflare's yet; it can take up to 24 hours. Press <em>Check</em>.</li>
          <li><strong>Hostname already serves another site</strong>: choose another subdomain, or move the other site first.</li>
          <li><strong>Deploy failed on the custom domain but workers.dev works</strong>: the certificate for a new domain can take a few minutes; the site is checked on workers.dev, so it is live, and the domain follows.</li>
          <li><strong>A move failed</strong>: the error is shown on the step that failed; it is retried automatically a few times. The site keeps running on Lummet. Fix the cause (often a permission or R2) and it continues, or cancel it.</li>
        </ul></details>
    </div>`;
}

export function renderCloudHostingPage({ access, accounts, sites, canManage, organizationId }) {
  const enabled = !!access.enabled;
  const notice = enabled ? "" : `<div class="card" style="border-left:4px solid #d98e04"><p style="margin:0">Adding Cloudflare accounts and moving sites is not available for this organization right now.
      Sites already running in your Cloudflare accounts keep working and receiving releases, and you can still manage them here.</p></div>`;
  const addForm = canManage && enabled ? `
    <div class="card">
      <h2 style="margin-top:0">Add a Cloudflare account</h2>
      <form id="ch-add-account"${onSubmit("chAddAccount", ["$el"], { prevent: true })}>
        <label>Name for this account</label><input name="label" required maxlength="80" placeholder="e.g. Brand A production" />
        <label>Cloudflare account ID</label><input name="accountId" required maxlength="32" class="mono" autocomplete="off" spellcheck="false" />
        <label>API token</label><input name="apiToken" required type="password" autocomplete="new-password" spellcheck="false" />
        <details><summary>Media access keys and email (optional)</summary>
          <label>R2 access key ID</label><input name="r2AccessKeyId" maxlength="32" class="mono" autocomplete="off" />
          <label>R2 secret access key</label><input name="r2SecretAccessKey" type="password" autocomplete="new-password" />
          <label>R2 jurisdiction</label><select name="r2Jurisdiction"><option value="default">default</option><option value="eu">eu</option><option value="fedramp">fedramp</option></select>
          <label>Email sender address</label><input name="emailFrom" maxlength="254" placeholder="no-reply@yourdomain.com" />
          <label>Resend API key</label><input name="emailApiKey" type="password" autocomplete="new-password" />
        </details>
        <button class="btn" type="submit">Check with Cloudflare and save</button>
        <p class="subtitle" id="ch-add-status" aria-live="polite">The token is checked before it is saved, then stored encrypted. See <a href="#guide-token">which permissions it needs</a>.</p>
      </form>
    </div>` : "";
  const accountCards = accounts.length ? accounts.map((a) => accountCard(a, { canManage, enabled })).join("") : `<p class="subtitle">No Cloudflare accounts saved yet.</p>`;
  const siteCards = sites.length ? sites.map((s) => siteRow(s, { accounts, canManage, enabled })).join("") : `<p class="subtitle">No sites yet.</p>`;
  const running = sites.some((s) => s.transfer && ["queued", "running"].includes(s.transfer.status));

  const script = `<script nonce="${nonceToken()}">
var CH_ORG = ${JSON.stringify(String(organizationId || ""))};
function chApi(p) { return '/api/organizations/' + encodeURIComponent(CH_ORG) + p; }
function chCall(method, p, body) {
  return fetch(chApi(p), { method: method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(function (r) { return r.json(); });
}
function chErr(d) { return (d && (d.message || d.error)) || 'unknown error'; }
function chDone(d) { if (d && d.success) { location.reload(); } else { alert('That did not work: ' + chErr(d)); } }
function chToggle(id) { var el = document.getElementById(id); if (el) { el.style.display = el.style.display === 'none' ? '' : 'none'; } }
function chVal(f, n) { var el = f.elements[n]; return el ? String(el.value || '').trim() : ''; }
function chAddAccount(f) {
  var st = document.getElementById('ch-add-status');
  var body = { label: chVal(f, 'label'), accountId: chVal(f, 'accountId'), apiToken: chVal(f, 'apiToken') };
  ['r2AccessKeyId', 'r2SecretAccessKey', 'emailFrom', 'emailApiKey'].forEach(function (k) { var v = chVal(f, k); if (v) { body[k] = v; } });
  if (body.r2AccessKeyId || body.r2SecretAccessKey) { body.r2Jurisdiction = chVal(f, 'r2Jurisdiction') || 'default'; }
  st.textContent = 'Checking with Cloudflare\\u2026';
  chCall('POST', '/cloud-hosting/accounts', body).then(function (d) {
    f.elements.apiToken.value = ''; f.elements.r2SecretAccessKey.value = ''; f.elements.emailApiKey.value = '';
    if (d.success) { location.reload(); } else { st.textContent = 'Not saved: ' + chErr(d); }
  }).catch(function () { st.textContent = 'Could not reach the server.'; });
}
function chVerify(id) { chCall('POST', '/cloud-hosting/accounts/' + encodeURIComponent(id) + '/verify').then(chDone); }
function chClaimSub(id) {
  var v = prompt('Choose the workers.dev subdomain for this Cloudflare account (letters, digits and dashes). Cloudflare allows one per account.');
  if (v) { chCall('POST', '/cloud-hosting/accounts/' + encodeURIComponent(id) + '/subdomain', { subdomain: v.trim().toLowerCase() }).then(chDone); }
}
function chRemove(id) { chCall('DELETE', '/cloud-hosting/accounts/' + encodeURIComponent(id)).then(function (d) {
  if (d.success) { location.reload(); return; }
  if (d.error === 'account_in_use') { alert('Sites still run on this account: ' + (d.sites || []).map(function (s) { return s.name; }).join(', ') + '. Delete or move them first.'); return; }
  alert('That did not work: ' + chErr(d));
}); }
function chSaveEdit(f, id) {
  var body = {};
  ['label', 'apiToken', 'r2AccessKeyId', 'r2SecretAccessKey', 'emailFrom', 'emailApiKey'].forEach(function (k) { var v = chVal(f, k); if (v) { body[k] = v; } });
  body.r2Jurisdiction = chVal(f, 'r2Jurisdiction') || 'default';
  if (f.elements.removeR2Keys.checked) { body.removeR2Keys = true; }
  if (f.elements.removeEmail.checked) { body.removeEmail = true; }
  chCall('PATCH', '/cloud-hosting/accounts/' + encodeURIComponent(id), body).then(chDone);
}
function chText(parent, tag, text, css) { var e = document.createElement(tag); e.textContent = text; if (css) { e.style.cssText = css; } parent.appendChild(e); return e; }
function chZones(id) {
  var box = document.getElementById('zones-' + id);
  box.style.display = '';
  var list = box.querySelector('.zone-list');
  list.textContent = 'Loading domains\\u2026';
  chCall('GET', '/cloud-hosting/accounts/' + encodeURIComponent(id) + '/zones').then(function (d) {
    list.textContent = '';
    if (!d.success) { chText(list, 'span', 'Could not read the domains: ' + chErr(d)); return; }
    if (!d.data.length) { chText(list, 'span', 'No domains in this Cloudflare account yet.'); return; }
    d.data.forEach(function (z) {
      var row = chText(list, 'div', '', 'margin:4px 0');
      chText(row, 'strong', z.name + ' ');
      chText(row, 'span', z.active ? 'active' : ('not active (' + z.status + ')' + (z.nameServers && z.nameServers.length ? ': set the nameservers to ' + z.nameServers.join(' and ') : '')));
      if (!z.active) {
        var b = chText(row, 'button', 'Check'); b.className = 'btn'; b.type = 'button'; b.style.marginLeft = '6px';
        b.addEventListener('click', function () { chCall('POST', '/cloud-hosting/accounts/' + encodeURIComponent(id) + '/zones/' + encodeURIComponent(z.id) + '/check').then(function (r) {
          if (!r.success) { alert('Could not check: ' + chErr(r)); return; }
          alert(r.data.active ? z.name + ' is active and can be used now.' : z.name + ' is not active yet. Nameservers: ' + (r.data.nameServers || []).join(', '));
          chZones(id);
        }); });
      }
    });
  });
}
function chAddZone(f, id) {
  chCall('POST', '/cloud-hosting/accounts/' + encodeURIComponent(id) + '/zones', { domain: chVal(f, 'domain') }).then(function (d) {
    if (!d.success) { alert('Could not connect the domain: ' + chErr(d)); return; }
    alert(d.data.name + ' was added to your Cloudflare account. Set its nameservers at your registrar to: ' + (d.data.nameServers || []).join(' and ') + ', then press Check.');
    f.reset(); chZones(id);
  });
}
function chDestChanged(el) {
  var f = el.form, landing = f.elements.landing.value;
  var dom = f.querySelector('.dest-domain');
  dom.style.display = landing === 'custom_domain' ? '' : 'none';
  if (landing !== 'custom_domain') { return; }
  var acc = f.elements.accountId.value, sel = f.elements.zoneId;
  if (!acc) { return; }
  if (sel.getAttribute('data-for') === acc) { return; }
  sel.setAttribute('data-for', acc);
  while (sel.options.length) { sel.remove(0); }
  var first = document.createElement('option'); first.value = ''; first.textContent = 'Loading\\u2026'; sel.appendChild(first);
  chCall('GET', '/cloud-hosting/accounts/' + encodeURIComponent(acc) + '/zones').then(function (d) {
    first.textContent = d.success ? (d.data.length ? 'Choose a domain\\u2026' : 'No domains in this account') : ('Could not read domains: ' + chErr(d));
    if (!d.success) { sel.removeAttribute('data-for'); return; }
    d.data.forEach(function (z) { var o = document.createElement('option'); o.value = z.id; o.textContent = z.name + (z.active ? '' : ' (not active yet)'); o.disabled = !z.active; sel.appendChild(o); });
  });
}
function chDest(f) {
  var out = { accountId: chVal(f, 'accountId'), landing: chVal(f, 'landing') };
  if (out.landing === 'custom_domain') { out.zoneId = chVal(f, 'zoneId'); out.subdomain = chVal(f, 'subdomain').toLowerCase(); if (!out.zoneId) { alert('Choose the domain.'); return null; } }
  return out;
}
function chMove(f, siteId, name) {
  var body = chDest(f); if (!body) { return; }
  if (!body.accountId) { alert('Choose the Cloudflare account.'); return; }
  if (!confirm('Move ' + name + ' to your Cloudflare account? It keeps running on Lummet until the move finishes.')) { return; }
  chCall('POST', '/sites/' + encodeURIComponent(siteId) + '/hosting/transfer', body).then(chDone);
}
function chChangeDomain(f, siteId) {
  var body = chDest(f); if (!body) { return; }
  chCall('POST', '/sites/' + encodeURIComponent(siteId) + '/hosting/domain', body).then(chDone);
}
function chVarAdd(f, siteId) {
  chCall('POST', '/sites/' + encodeURIComponent(siteId) + '/hosting/variables', { variables: [{ name: chVal(f, 'name'), value: f.elements.value.value, secret: !!f.elements.secret.checked }] }).then(chDone);
}
function chVarRemove(siteId, name) { chCall('POST', '/sites/' + encodeURIComponent(siteId) + '/hosting/variables', { variables: [{ name: name, value: null }] }).then(chDone); }
function chCancelMove(siteId) { chCall('POST', '/sites/' + encodeURIComponent(siteId) + '/hosting/transfer/cancel').then(chDone); }
function chConfirmSkipped(siteId) { chCall('POST', '/sites/' + encodeURIComponent(siteId) + '/hosting/transfer/confirm-skipped').then(chDone); }
function chRemoveOld(siteId) { chCall('POST', '/sites/' + encodeURIComponent(siteId) + '/hosting/transfer/remove-old-copy').then(chDone); }
(function () {
  if (!${running ? "true" : "false"}) { return; }
  // A running move: ask for its state every few seconds (that also lets a paused move continue) and reload when it changes.
  var boxes = Array.prototype.slice.call(document.querySelectorAll('.transfer'));
  setInterval(function () {
    boxes.forEach(function (b) {
      chCall('GET', '/sites/' + encodeURIComponent(b.getAttribute('data-site')) + '/hosting/transfer').then(function (d) {
        if (d.success && d.data && d.data.status !== b.getAttribute('data-status')) { location.reload(); }
      }).catch(function () {});
    });
  }, 6000);
})();
</script>`;

  return `
    <h1>Cloudflare hosting</h1>
    <p class="subtitle">Run sites in your own Cloudflare accounts instead of Lummet hosting. Optional: Lummet hosting stays the default, and each site can use either. <a href="#guide">Read the guide</a></p>
    ${notice}
    <h2>Your Cloudflare accounts</h2>
    ${accountCards}
    ${addForm}
    <h2>Sites</h2>
    ${siteCards}
    ${guide()}
    ${script}`;
}
