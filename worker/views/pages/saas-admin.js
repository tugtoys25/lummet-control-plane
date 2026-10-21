// Staff console screens for the SaaS layer (master prompt section 45).
// Super-admin only — the route layer enforces that; hiding nav is not security.
import * as errorsRepo from "../../repositories/request-errors.js";
import { configIssues } from "../../config-check.js";
import * as alertsModule from "../../alerts.js";
import * as cpBackupModule from "../../cp-backup.js";
import * as keyRotationModule from "../../key-rotation.js";
import { renderShell, escapeHtml as h } from "../layout.js";
import * as staff from "../../staff-saas.js";
import * as tenantTemplate from "../../tenant-template.js";
import * as rolloutsModule from "../../rollouts.js";
import * as staffTokensModule from "../../staff-tokens.js";
import { nonceToken, onClick, onSubmit, onChange } from "../../csp.js";

const money = (c) => (c == null ? "custom" : `$${(c / 100).toFixed(2)}`);
const badge = (s) => `<span class="role-badge">${h(s)}</span>`;
const table = (heads, rows, empty = "Nothing here yet.") =>
  rows.length
    ? `<table><thead><tr>${heads.map((x) => `<th>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`
    : `<p style="color:var(--text-dim)">${h(empty)}</p>`;

// Shared client helper: POST JSON to a staff API, then reload.
const buildScript = () => `<script nonce="${nonceToken()}">
function act(url, body, confirmMsg) {
  if (confirmMsg && !confirm(confirmMsg)) return;
  fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(function (r) { return r.json(); })
    .then(function (d) { if (d.success) location.reload(); else alert('Failed: ' + (d.error || 'unknown')); });
}
// Handlers that used to be inline code. Each is a named function the delegated runtime calls.
function actReason(url, status, label) { var r = prompt(label); if (r) act(url, { status: status, reason: r }); }
function actOverrideForm(f, api, subscriptionId) {
  act(api + '/override', { subscriptionId: subscriptionId, key: f.key.value, valueType: f.vt.value, value: f.value.value, reason: f.reason.value });
}
function actCreditsForm(f, api) { act(api + '/ai-credits', { amount: parseInt(f.amount.value, 10), reason: f.reason.value }); }
function actPromptStripeId(url, current) { var v = prompt('Stripe price id (price_...)', current); if (v !== null) act(url, { stripePriceId: v || null }); }
function actPromptPrice(url, current) { var v = prompt('Price in cents (blank = custom)', current); if (v !== null) act(url, { priceCents: v === '' ? null : parseInt(v, 10) }); }
function actPublishTemplate(f) {
  try { var d = JSON.parse(f.payload.value); act('/api/platform/saas/tenant-template/publish', d); }
  catch (e) { alert('Invalid JSON: ' + e.message); }
}
// Staff API token: shown ONCE, built with textContent so nothing from the response is ever parsed as HTML.
function actCreateStaffToken(f) {
  var scopes = [];
  if (f.publish.checked) scopes.push('release:publish');
  if (f.rollout.checked) scopes.push('rollout:run');
  fetch('/api/platform/saas/staff-tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: f.name.value, scopes: scopes, expiresInDays: parseInt(f.days.value, 10) }) })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.success) { alert('Failed: ' + (d.error || 'unknown')); return; }
      var box = document.getElementById('new-token-box');
      box.textContent = '';
      box.style.display = 'block';
      var a = document.createElement('p'); a.textContent = 'Copy this token now. It is shown only once and cannot be recovered:';
      var c = document.createElement('code'); c.textContent = d.token; c.style.wordBreak = 'break-all'; c.style.userSelect = 'all'; c.style.display = 'block';
      var b = document.createElement('p'); b.textContent = 'Store it as the repository secret LUMMET_STAFF_TOKEN. It expires ' + String(d.expiresAt).slice(0, 10) + '. Reload this page once you have copied it.';
      box.appendChild(a); box.appendChild(c); box.appendChild(b);
    });
}
// While a rollout is running and this page is open, keep it moving (the server also advances it from the maintenance tick).
function rolloutDriver() {
  var el = document.getElementById('rollout-drive');
  if (!el) return;
  var id = el.getAttribute('data-rollout');
  var out = document.getElementById('rollout-progress');
  var last = el.getAttribute('data-progress');
  function again(ms) { setTimeout(tick, ms); }
  function tick() {
    fetch('/api/platform/saas/rollouts/' + encodeURIComponent(id) + '/advance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.success) { if (out) out.textContent = 'Could not advance: ' + (d.error || 'unknown'); return again(15000); }
        if (out) out.textContent = d.progress;
        if (d.done || d.progress !== last) return location.reload();
        again(d.busy ? 6000 : 4000);
      })
      .catch(function () { again(15000); });
  }
  tick();
}
rolloutDriver();
</script>`;

// ---- paging for staff lists ----
const PAGE_SIZE = 50;
const pageNumber = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 1 && n <= 10000 ? n : 1; };
const pageArgs = (page) => ({ limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE });
function paged(rows) { return { rows: rows.slice(0, PAGE_SIZE), hasMore: rows.length > PAGE_SIZE }; }
// Previous / Next links that keep the current filters.
function pager(path, params, page, hasMore) {
  if (page === 1 && !hasMore) return "";
  const link = (p, label) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    if (p > 1) q.set("page", String(p));
    const qs = q.toString();
    return `<a class="btn" href="${path}${qs ? "?" + h(qs) : ""}">${label}</a>`;
  };
  return `<p style="display:flex;gap:12px;align-items:center;margin-top:12px">${page > 1 ? link(page - 1, "&larr; Previous") : ""}<span style="color:var(--text-dim)">Page ${page}</span>${hasMore ? link(page + 1, "Next &rarr;") : ""}</p>`;
}

async function shell(env, admin, title, activeKey, body) {
  return renderShell({ title, activeKey, admin, env, bodyHtml: `<h1>${h(title)}</h1>${body}${buildScript()}` });
}

export async function renderSaasOverview(env, admin) {
  const s = await staff.opsSummary(env);
  const card = (label, v, warn) => `<div class="card" style="min-width:150px"><div style="color:var(--text-dim);font-size:12px">${h(label)}</div><div style="font-size:26px;${warn && v ? "color:#e5484d" : ""}">${h(v)}</div></div>`;
  const issues = configIssues(env);
  const configBanner = issues.length ? `<div class="card" style="border:1px solid #c0392b;margin-bottom:12px"><strong>Production configuration is incomplete</strong>
      <ul style="margin:6px 0 0 18px">${issues.map((i) => `<li><code>${h(i.key)}</code> is missing or invalid: ${h(i.impact)}</li>`).join("")}</ul></div>` : "";
  return shell(env, admin, "SaaS overview", "saas-overview", `
    ${configBanner}
    <div style="display:flex;gap:12px;flex-wrap:wrap">
      ${card("Organizations", s.organizations)}${card("Live subscriptions", s.liveSubscriptions)}
      ${card("MRR (active, monthly)", money(s.monthlyRecurringCents))}
      ${card("Failed jobs", s.failedJobs, true)}${card("Stuck jobs (>30m)", s.stuckJobs, true)}${card("Failed sites", s.failedSites, true)}
      ${card("Emails queued", s.queuedEmails)}${card("Emails failed", s.failedEmails, true)}
    </div>
    <p style="margin-top:16px"><a href="/platform/saas/organizations">Organizations</a> · <a href="/platform/saas/subscriptions">Subscriptions</a> · <a href="/platform/saas/plans">Plans</a> · <a href="/platform/saas/jobs">Jobs</a> · <a href="/platform/saas/email">Email outbox</a></p>
    <p style="color:var(--text-dim);font-size:12px">MRR counts active monthly subscriptions at list price; it ignores coupons, annual plans and unsynced Stripe state, so treat it as an estimate.</p>`);
}

export async function renderOrganizationsPage(env, admin, { q = "", status = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows: orgs, hasMore } = paged(await staff.listOrganizations(env, { q, status, limit: PAGE_SIZE + 1, offset: (page - 1) * PAGE_SIZE }));
  return shell(env, admin, "Organizations", "saas-orgs", `
    <form method="get" style="display:flex;gap:8px;margin-bottom:12px">
      <input name="q" value="${h(q)}" placeholder="name, slug or id" />
      <select name="status"><option value="">all</option>${["active", "suspended", "closed"].map((s) => `<option ${s === status ? "selected" : ""}>${s}</option>`).join("")}</select>
      <button class="btn" type="submit">Search</button></form>
    ${table(["Name", "Status", "Members", "Sites", "Subscription", "Created"], orgs.map((o) => [`<a href="/platform/saas/organizations/${h(o.id)}">${h(o.name)}</a>`, badge(o.status), o.members, o.sites, h(o.subscription || "—"), h(o.created_at)]), "No organizations match.")}${pager("/platform/saas/organizations", { q, status }, page, hasMore)}`);
}

export async function renderOrganizationDetailPage(env, admin, id) {
  const d = await staff.getOrganizationDetail(env, id);
  if (!d) return null;
  const { org } = d;
  const api = `/api/platform/saas/organizations/${h(id)}`;
  const audit = await staff.listStaffAuditForOrg(env, id, 25);
  const limits = ["sites.max", "users.max", "domains.custom.max", "ai.credits_monthly", "ai.enabled", "api.enabled", "white_label.enabled"]
    .map((k) => [h(k), h(String(d.entitlements[k]?.value ?? "—"))]);
  return shell(env, admin, org.name, "saas-orgs", `
    <p>${badge(org.status)} <span style="color:var(--text-dim)">${h(org.id)} · ${h(org.slug)}</span></p>
    <p>${org.status === "active"
      ? `<button class="btn" ${onClick("actReason", [`${api}/status`, "suspended", "Reason for suspension (required)"])}>Suspend organization</button>`
      : org.erased_at ? `<span style="color:var(--text-dim)">Erased ${h(org.erased_at)}. This cannot be undone.</span>`
      : org.scheduled_deletion_at ? `<b>Scheduled for permanent erasure on ${h(org.scheduled_deletion_at)}.</b> <button class="btn"${onClick("act", [`${api}/stop-deletion`, {}, "Stop the scheduled erasure and reactivate this organization?"])}>Stop scheduled deletion</button>`
      : `<button class="btn"${onClick("act", [`${api}/status`, {status: "active"}, "Reactivate this organization?"])}>Reactivate</button>`}</p>
    <h2>Subscriptions</h2>
    ${table(["Plan", "Status", "Trial ends", "Period end", "Subscription id"], d.subscriptions.map((s) => [h(s.plan), badge(s.status), h(s.trial_ends_at || "—"), h(s.current_period_end || "—"), h(s.id)]), "No subscription.")}
    <h2>Effective entitlements</h2>${table(["Key", "Value"], limits)}
    <h2>Overrides</h2>
    ${table(["Key", "Value", "Reason", ""], d.overrides.map((o) => [h(o.key), h(o.value), h(o.reason || ""), `<button class="btn"${onClick("act", [`${api}/override/remove`, {subscriptionId: o.subscription_id, key: o.key}, "Remove override?"])}>Remove</button>`]), "No overrides.")}
    ${d.subscriptions[0] ? `<form${onSubmit("actOverrideForm", ["$el", api, d.subscriptions[0].id], { prevent: true })} style="display:flex;gap:6px;flex-wrap:wrap">
      <input name="key" placeholder="sites.max" required /><select name="vt"><option>number</option><option>boolean</option><option>text</option></select>
      <input name="value" placeholder="value" required /><input name="reason" placeholder="reason (required)" required /><button class="btn">Set override</button></form>` : ""}
    <h2>AI credits</h2><p>Balance: <b>${h(d.aiBalance)}</b></p>
    <form${onSubmit("actCreditsForm", ["$el", api], { prevent: true })} style="display:flex;gap:6px">
      <input name="amount" type="number" min="1" placeholder="credits" required /><input name="reason" placeholder="reason (required)" required /><button class="btn">Grant credits</button></form>
    <h2>Usage this month</h2>${table(["Metric", "Quantity"], Object.entries(d.usage).map(([k, v]) => [h(k), h(v)]), "No metered usage yet.")}
    <h2>Sites</h2>
    ${table(["Name", "Status", "Reason", ""], d.sites.map((s) => [h(s.name), badge(s.status), h(s.suspension_reason || ""),
      s.status === "active" ? `<button class="btn" ${onClick("actReason", [`/api/platform/saas/sites/${s.id}/status`, "suspended", "Reason (required)"])}>Suspend</button>`
      : s.status === "suspended" ? `<button class="btn"${onClick("act", [`/api/platform/saas/sites/${s.id}/status`, {status: "active"}, "Reactivate site?"])}>Reactivate</button>` : ""]), "No sites.")}
    <h2>Team</h2>${table(["Email", "Role", "Joined"], d.members.map((m) => [h(m.email), h(m.role), h(m.created_at)]))}
    <h2>Recent jobs</h2>${table(["Type", "Status", "Progress", "Error", ""], d.jobs.map((j) => [h(j.type), badge(j.status), `${h(j.progress)}%`, h(j.error_message || ""), `<a href="/platform/saas/jobs/${h(j.id)}">view</a>`]), "No jobs.")}
    <h2>Audit (latest 25)</h2>${table(["When", "Actor", "Action", "Resource", "OK"], audit.map((a) => [h(a.created_at), h(a.actor_type || ""), h(a.action || ""), h(`${a.resource || ""} ${a.resource_id || ""}`), a.success ? "✓" : `✗ ${h(a.error_message || "")}`]), "No audit rows.")}`);
}

export async function renderSubscriptionsPage(env, admin, { status = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows, hasMore } = paged(await staff.listSubscriptions(env, { status, ...pageArgs(page) }));
  return shell(env, admin, "Subscriptions", "saas-subs", `
    <form method="get" style="margin-bottom:12px"><select name="status" ${onChange("lummetSubmitForm", ["$el"])}><option value="">all</option>${["trialing", "active", "past_due", "paused", "canceled", "expired", "suspended"].map((s) => `<option ${s === status ? "selected" : ""}>${s}</option>`).join("")}</select></form>
    ${table(["Organization", "Plan", "Status", "Trial ends", "Period end"], rows.map((s) => [`<a href="/platform/saas/organizations/${h(s.organization_id)}">${h(s.organization)}</a>`, h(s.plan), badge(s.status), h(s.trial_ends_at || "—"), h(s.current_period_end || "—")]))}${pager("/platform/saas/subscriptions", { status }, page, hasMore)}`);
}

export async function renderPlansPage(env, admin) {
  const plans = await staff.listPlansCatalog(env);
  return shell(env, admin, "Plans & pricing", "saas-plans", `
    <p style="color:var(--text-dim)">Editing a price changes what NEW checkouts charge only if the Stripe price id is updated to match; existing subscribers keep their Stripe price.</p>
    ${table(["Product", "Plan", "Price", "Period", "Trial", "Status", "Stripe price id", "Live subs", ""], plans.map((p) => [h(p.product), h(p.name), money(p.price_cents), h(p.billing_period), h(p.trial_days), badge(p.status), h(p.stripe_price_id || "— not set —"),
      h(p.live_subscriptions),
      `<button class="btn" ${onClick("actPromptStripeId", [`/api/platform/saas/plans/${p.id}`, p.stripe_price_id || ""])}>Stripe id</button>
       <button class="btn" ${onClick("actPromptPrice", [`/api/platform/saas/plans/${p.id}`, String(p.price_cents ?? "")])}>Price</button>
       <button class="btn"${onClick("act", [`/api/platform/saas/plans/${p.id}`, {status: (p.status === "active" ? "retired" : "active")}, `${p.status === "active" ? "Retire" : "Reactivate"} this plan?`])}>${p.status === "active" ? "Retire" : "Activate"}</button>`]))}`);
}

export async function renderJobsPage(env, admin, { status = "", type = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows: jobs, hasMore } = paged(await staff.listJobs(env, { status, type, ...pageArgs(page) }));
  return shell(env, admin, "Jobs", "saas-jobs", `
    <form method="get" style="display:flex;gap:8px;margin-bottom:12px"><select name="status"><option value="">all</option>${["queued", "running", "failed", "success", "cancelled"].map((s) => `<option ${s === status ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input name="type" value="${h(type)}" placeholder="type" /><button class="btn">Filter</button></form>
    ${table(["Type", "Organization", "Status", "Progress", "Error", "Created", ""], jobs.map((j) => [h(j.type), h(j.organization || "—"), badge(j.status) + (j.dead_lettered_at ? " " + badge("dead-lettered") : ""), `${h(j.progress)}%`, h(j.error_message || ""), h(j.created_at), `<a href="/platform/saas/jobs/${h(j.id)}">view</a>`]), "No jobs.")}${pager("/platform/saas/jobs", { status, type }, page, hasMore)}`);
}

export async function renderJobDetailPage(env, admin, id) {
  const d = await staff.getJobDetail(env, id);
  if (!d) return null;
  const { job, history } = d;
  const canRetry = job.status === "failed" && ["tenant_provisioning", "deployment"].includes(job.type) && job.site_id;
  return shell(env, admin, `Job ${job.type}`, "saas-jobs", `
    <p>${badge(job.status)} ${h(job.progress)}% · ${h(job.id)}</p>
    ${job.error_message ? `<div class="flash flash-error">${h(job.error_message)}</div>` : ""}
    ${job.dead_lettered_at ? `<div class="flash flash-error">Dead-lettered: ${h(job.dead_reason || "")}. The system will not retry it again by itself (${h(job.auto_retries)} automatic attempts made). Retry gives it a fresh set.</div>` : (job.auto_retries ? `<p style="color:var(--text-dim)">${h(job.auto_retries)} automatic attempt(s) so far.</p>` : "")}
    ${canRetry ? `<button class="btn"${onClick("act", [`/api/platform/saas/jobs/${job.id}/retry`, {}, "Retry this job?"])}>Retry</button>` : ""}
    <h2>Steps</h2>${table(["#", "Step", "Status", "Attempts", "Error"], job.steps.map((s) => [h(s.step_order), h(s.step_key), badge(s.status), h(s.attempt), h(s.error_message || "")]))}
    <h2>Runs</h2>${table(["Run", "Trigger", "Status", "Started", "Finished", "Error"], history.runs.map((r) => [h(r.run_number), h(r.trigger), badge(r.status), h(r.started_at), h(r.finished_at || ""), h(r.error_message || "")]), "No runs recorded.")}
    <h2>Log</h2><pre style="white-space:pre-wrap;font-size:12px">${history.logs.map((l) => h(`${l.created_at} [${l.level}] ${l.message}`)).join("\n") || "empty"}</pre>`);
}

export async function renderEmailPage(env, admin) {
  const [s, failed] = await Promise.all([staff.opsSummary(env), staff.listFailedEmails(env)]);
  return shell(env, admin, "Email outbox", "saas-email", `
    <p>${Object.entries(s.email).map(([k, v]) => `${badge(k)} ${h(v)}`).join(" &nbsp; ") || "Outbox empty."}</p>
    <p><button class="btn"${onClick("act", ["/api/platform/saas/email/flush", {}])}>Deliver queued now</button></p>
    <h2>Failed</h2>${table(["To", "Template", "Attempts", "Error", "When"], failed.map((f) => [h(f.to_email), h(f.template), h(f.attempts), h(f.last_error || ""), h(f.created_at)]), "No failed emails.")}`);
}


function renderStaffTokensSection(tokens) {
  return `<h2>Staff API tokens (CI)</h2>
    <p style="color:var(--text-dim)">A token lets an unattended job (a GitHub Actions run) publish releases and start rollouts without a browser session. It works only for the release API, only for the access ticked below, and expires. Only a hash is stored: the token is shown once when you create it. Revoking takes effect immediately.</p>
    ${table(["Name", "Prefix", "Access", "Status", "Last used", "Expires", ""], tokens.map((t) => [h(t.name), h(t.token_prefix), h(t.scopes.join(", ")), badge(t.status), h(t.last_used_at || "never"), h(t.expires_at || "never"),
      t.status === "active" ? `<button class="btn btn-danger"${onClick("act", [`/api/platform/saas/staff-tokens/${t.id}/revoke`, {}, `Revoke token ${t.token_prefix}? Anything using it stops working immediately.`])}>Revoke</button>` : ""]), "No tokens yet.")}
    <div class="card">
      <h3>New token</h3>
      <form${onSubmit("actCreateStaffToken", ["$el"], { prevent: true })}>
        <label>Name</label><input name="name" required maxlength="80" placeholder="GitHub Actions: lummet-tenant" />
        <label><input type="checkbox" name="publish" checked /> Publish releases</label>
        <label><input type="checkbox" name="rollout" /> Run rollouts</label>
        <label>Expires in (days, at most ${h(staffTokensModule.MAX_EXPIRY_DAYS)})</label><input name="days" type="number" min="1" max="${h(staffTokensModule.MAX_EXPIRY_DAYS)}" value="${h(staffTokensModule.DEFAULT_EXPIRY_DAYS)}" />
        <button class="btn" style="margin-top:8px">Create token</button>
      </form>
      <div id="new-token-box" class="card" style="display:none;margin-top:12px"></div>
    </div>`;
}

export async function renderTenantTemplatePage(env, admin) {
  const releases = await tenantTemplate.listReleases(env);
  const tokens = await staffTokensModule.listStaffTokens(env);
  return shell(env, admin, "Tenant template releases", "saas-releases", `
    <p style="color:var(--text-dim)">The shared build every newly-provisioned site automatically deploys.
    Publish a new release with the output of <code>scripts/build-tenant-worker.mjs</code>
    (see DEPLOYMENT.md). No release published yet means new sites stop at "provisioned" instead of going live.</p>
    ${table(["Version", "Status", "Migrations", "Size", "Notes", "Published", ""], releases.map((r) => [h(r.version), badge(r.status), h(r.migration_count), h(Math.round(r.size_bytes / 1024) + " KB"), h(r.notes || ""), h(r.created_at),
      r.status !== "active" ? `<button class="btn"${onClick("act", [`/api/platform/saas/tenant-template/${r.version}/activate`, {}, `Make ${r.version} the active release for all new sites?`])}>Activate</button>` : "current"]), "No releases published yet.")}
    <h2>Publish a new release</h2>
    <p style="color:var(--text-dim)">Paste the JSON produced by <code>node scripts/build-tenant-worker.mjs</code> — it already has the right shape.</p>
    <form${onSubmit("actPublishTemplate", ["$el"], { prevent: true })}>
      <textarea name="payload" rows="8" style="width:100%;font-family:monospace" placeholder='{"version":"2024.06.01","scriptContent":"...","migrations":[{"name":"0001_x.sql","sql":"..."}],"notes":"..."}'></textarea>
      <button class="btn" style="margin-top:8px">Publish</button>
    </form>
    ${renderStaffTokensSection(tokens)}`);
}

export async function renderCouponsPage(env, admin) {
  const coupons = await staff.listCoupons(env);
  const discount = (c) => (c.percent_off != null ? `${h(c.percent_off)}% off` : `${money(c.amount_off_cents)} off`);
  const uses = (c) => `${h(c.redemption_count)}${c.max_redemptions != null ? ` / ${h(c.max_redemptions)}` : ""}`;
  return shell(env, admin, "Coupons", "saas-coupons", `
    <p style="color:var(--text-dim)">The discount itself is a Stripe coupon you create in Stripe first; paste its id here. Lummet checks expiry, the redemption limit, one-use-per-organization and (when set) the organization the code is reserved for before sending a customer to Stripe. Anyone else using a reserved code is told it is invalid. A use is counted when checkout completes.</p>
    ${table(["Code", "Discount", "Duration", "Uses", "Expires", "Scope", "Status", "Stripe coupon", ""], coupons.map((c) => [
      h(c.code), discount(c), h(c.duration), uses(c), h(c.expires_at || "never"),
      c.organization_id ? orgLink(c.organization_id, c.organization_name || c.organization_id) : "any organization", badge(c.status), h(c.provider_coupon_id),
      `<button class="btn"${onClick("act", [`/api/platform/saas/coupons/${c.id}`, {status: (c.status === "active" ? "disabled" : "active")}, `${c.status === "active" ? "Disable" : "Enable"} ${c.code}?`])}>${c.status === "active" ? "Disable" : "Enable"}</button>`
    ]), "No coupons yet.")}
    <div class="card">
      <h2>New coupon</h2>
      <form id="coupon-form">
        <label>Code</label><input id="cp-code" placeholder="LAUNCH20" required />
        <label>Stripe coupon id</label><input id="cp-provider" required />
        <label>Percent off (or leave blank and use amount)</label><input id="cp-percent" type="number" min="1" max="100" step="any" />
        <label>Amount off in cents (or leave blank and use percent)</label><input id="cp-amount" type="number" min="1" />
        <label>Duration (must match the Stripe coupon)</label>
        <select id="cp-duration"><option>once</option><option>repeating</option><option>forever</option></select>
        <label>Maximum redemptions (blank = unlimited)</label><input id="cp-max" type="number" min="1" />
        <label>Expires (blank = never)</label><input id="cp-expires" type="date" />
        <label>Only this organization (organization id; blank = any organization)</label><input id="cp-org" maxlength="64" />
        <label>Note</label><input id="cp-note" maxlength="300" />
        <button class="btn" type="submit">Create coupon</button>
      </form>
    </div>
    <script nonce="${nonceToken()}">
      document.getElementById('coupon-form').addEventListener('submit', function (e) {
        e.preventDefault();
        function v(id) { return document.getElementById(id).value.trim(); }
        act('/api/platform/saas/coupons', {
          code: v('cp-code'), providerCouponId: v('cp-provider'),
          percentOff: v('cp-percent') || null, amountOffCents: v('cp-amount') || null,
          duration: v('cp-duration'), maxRedemptions: v('cp-max') || null,
          expiresAt: v('cp-expires') ? v('cp-expires') + 'T23:59:59Z' : null, organizationId: v('cp-org') || null, note: v('cp-note') || null
        });
      });
    </script>`);
}

// ---- Operational screens (roadmap 1.4) ----
const orgLink = (id, name) => `<a href="/platform/saas/organizations/${h(id)}">${h(name || "—")}</a>`;
const statusFilter = (status, options) => `<form method="get" style="display:flex;gap:8px;margin-bottom:12px"><select name="status"><option value="">all</option>${options.map((o) => `<option ${o === status ? "selected" : ""}>${o}</option>`).join("")}</select><button class="btn">Filter</button></form>`;

export async function renderDomainsAdminPage(env, admin, { status = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows, hasMore } = paged(await staff.listAllDomains(env, { status, ...pageArgs(page) }));
  const zones = page === 1 ? await staff.listAllZones(env, { status: ["pending", "active", "failed", "expired"].includes(status) ? status : "", limit: 50 }) : [];
  const zoneSection = zones.length ? `<h3>Delegated domains (nameserver flow)</h3>${table(["Domain", "Site", "Organization", "Zone", "Nameservers seen", "Last checked", "Checks", "Note"],
    zones.map((z) => [h(z.zone_name), h(z.site), orgLink(z.organization_id, z.organization), badge(z.status), z.nameservers_detected_at ? "yes" : "no", h(z.last_checked_at || ""), h(z.check_count), h(z.failure_reason || (z.status === "pending" && z.expires_at ? `expires ${String(z.expires_at).slice(0, 10)}` : ""))]), "")}<h3>Hostnames</h3>` : "";
  return shell(env, admin, "Domains", "saas-domains", `${zoneSection}${statusFilter(status, ["awaiting_nameservers", "pending", "dns_verified", "ssl_pending", "active", "failed", "expired", "removed"])}
    ${table(["Hostname", "Connected by", "Site", "Organization", "Status", "SSL", "Primary", "Added"], rows.map((d) => [h(d.hostname), h({ nameservers: "nameservers", cname: "CNAME + TXT" }[d.method] || "TXT (earlier)"), h(d.site), orgLink(d.organization_id, d.organization), badge(d.status) + (d.failure_reason ? ` <span class="muted">${h(String(d.failure_reason).slice(0, 80))}</span>` : ""), badge(d.ssl_status), d.is_primary ? "yes" : "", h(d.created_at)]), "No domains.")}${pager("/platform/saas/domains", { status }, page, hasMore)}`);
}

const ROLLOUT_ITEM_BADGE = { pending: "waiting", running: "deploying", succeeded: "updated", skipped: "skipped", failed: "failed" };

function renderRolloutSection(d) {
  const intro = `<p style="color:var(--text-dim)">Publishing a release only stores it: sites keep running what they have until a deployment replaces it. A rollout deploys the active release to every live site <strong>one at a time</strong>. It waits for each site's health check before starting the next, <strong>stops at the first failure</strong> (the remaining sites are not touched, and a site that failed keeps serving its old version), and skips sites already on the release or not live. Details: docs/TENANT_RELEASES.md.</p>`;
  if (!d.active) return `<h2>Release rollout</h2>${intro}<p style="color:var(--text-dim)">No tenant release has been published yet, so there is nothing to roll out.</p>`;
  const fleet = d.fleet.length ? d.fleet.map((r) => `${h(r.version || "no version recorded")}: ${h(r.n)}`).join(" &middot; ") : "no live sites";
  const summary = `<p>Active release <strong>${h(d.active.version)}</strong> (published ${h(d.active.created_at || "")}). Live sites: ${h(d.totalLive)}, on the active release: ${h(d.onActive)}, behind: <strong>${h(d.outdated)}</strong>.<br><span style="color:var(--text-dim)">By version: ${fleet}</span></p>`;
  let controls = "";
  if (d.running) {
    controls = `<p><span id="rollout-progress">${h(d.shown ? d.shown.progress : "")}</span> <button class="btn btn-danger"${onClick("act", [`/api/platform/saas/rollouts/${d.running.id}/cancel`, {}, "Cancel this rollout? Sites not yet updated will stay on their current version. A deployment already under way finishes on its own."])}>Cancel rollout</button></p>
      <div id="rollout-drive" data-rollout="${h(d.running.id)}" data-progress="${h(d.shown ? d.shown.progress : "")}" style="display:none"></div>
      <p style="color:var(--text-dim)">This page keeps the rollout moving while it is open; it also continues from the scheduled maintenance tick if you close it.</p>`;
  } else if (d.outdated > 0) {
    controls = `<p><button class="btn"${onClick("act", ["/api/platform/saas/rollouts", {}, `Roll out ${d.active.version} to ${d.outdated} site(s), one at a time? It stops at the first failure.`])}>Roll out ${h(d.active.version)} to ${h(d.outdated)} site${d.outdated === 1 ? "" : "s"}</button></p>`;
  } else {
    controls = `<p style="color:var(--text-dim)">Every live site is on the active release.</p>`;
  }
  let shown = "";
  if (d.shown) {
    const r = d.shown;
    const failedControls = r.status === "failed"
      ? `<p><button class="btn"${onClick("act", [`/api/platform/saas/rollouts/${r.rolloutId}/resume`, {}, "Try the failed site again and continue with the rest?"])}>Resume</button> <button class="btn btn-danger"${onClick("act", [`/api/platform/saas/rollouts/${r.rolloutId}/cancel`, {}, "Cancel this rollout? The remaining sites stay on their current version."])}>Cancel rollout</button></p>` : "";
    shown = `<h3>${d.running ? "Current rollout" : "Latest rollout"}: ${h(r.version)} ${badge(r.status)}</h3>
      <p style="color:var(--text-dim)">Started ${h(r.createdAt || "")} by ${h(r.startedBy || "")}${r.completedAt ? `, finished ${h(r.completedAt)}` : ""}. ${h(r.progress)}.${r.error ? ` <strong>${h(r.error)}</strong>` : ""}</p>${failedControls}
      ${table(["Site", "Status", "Detail", "Started", "Finished"], r.items.map((i) => [h(i.site_name || i.site_slug || i.site_id), badge(ROLLOUT_ITEM_BADGE[i.status] || i.status), h(i.detail || ""), h(i.started_at || ""), h(i.completed_at || "")]), "No sites.")}`;
  }
  const history = d.recent.length > 1 ? `<h3>Earlier rollouts</h3>${table(["Version", "Status", "Sites", "Started by", "Started", "Note"], d.recent.slice(1).map((r) => [h(r.version), badge(r.status), h(r.total), h(r.startedBy || ""), h(r.createdAt), h(r.error || "")]), "")}` : "";
  return `<h2>Release rollout</h2>${intro}${summary}${controls}${shown}${history}`;
}

export async function renderDeploymentsAdminPage(env, admin, { status = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows, hasMore } = paged(await staff.listAllDeployments(env, { status, ...pageArgs(page) }));
  const rollout = page === 1 && !status ? renderRolloutSection(await rolloutsModule.dashboard(env)) + "<h2>Deployments</h2>" : "";
  return shell(env, admin, "Deployments", "saas-deployments", `${rollout}${statusFilter(status, ["queued", "building", "migrating", "deploying", "checking", "active", "failed", "rolled_back"])}
    ${table(["Site", "Organization", "Version", "Type", "Status", "By", "Started", "Error"], rows.map((d) => [h(d.site), orgLink(d.organization_id, d.organization), h(d.version) + (d.is_current ? " (current)" : ""), d.is_rollback ? "rollback" : "deploy", badge(d.status), h(d.actor_type), h(d.created_at), h(d.error_message || "")]), "No deployments.")}${pager("/platform/saas/deployments", { status }, page, hasMore)}`);
}

export async function renderWebhooksAdminPage(env, admin, { status = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows, hasMore } = paged(await staff.listAllWebhooks(env, { status, ...pageArgs(page) }));
  return shell(env, admin, "Webhooks", "saas-webhooks", `<p style="color:var(--text-dim)">Sorted by failed deliveries in the last 7 days. Disabling stops all future deliveries to that endpoint; the customer can see the status but must re-enable it themselves through support.</p>
    ${statusFilter(status, ["active", "disabled"])}
    ${table(["Endpoint", "Organization", "Events", "Status", "Failed / total (7d)", ""], rows.map((w) => [h(w.url), orgLink(w.organization_id, w.organization), h(w.event_types.join(", ")), badge(w.status), `${h(w.failed_7d)} / ${h(w.total_7d)}`,
      `<button class="btn"${onClick("act", [`/api/platform/saas/webhooks/${w.id}/status`, {status: (w.status === "active" ? "disabled" : "active")}, `${w.status === "active" ? "Disable" : "Enable"} this webhook?`])}>${w.status === "active" ? "Disable" : "Enable"}</button>`]), "No webhooks.")}${pager("/platform/saas/webhooks", { status }, page, hasMore)}`);
}

export async function renderApiKeysAdminPage(env, admin, { status = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows, hasMore } = paged(await staff.listAllApiKeys(env, { status, ...pageArgs(page) }));
  return shell(env, admin, "API keys", "saas-apikeys", `<p style="color:var(--text-dim)">Only the short key prefix is stored and shown; the full token cannot be recovered. Revoking takes effect immediately and cannot be undone.</p>
    ${statusFilter(status, ["active", "revoked"])}
    ${table(["Name", "Prefix", "Organization", "Access", "Status", "Last used", "Expires", ""], rows.map((k) => [h(k.name), h(k.key_prefix), orgLink(k.organization_id, k.organization), h(k.scopes.join(", ")), badge(k.status), h(k.last_used_at || "never"), h(k.expires_at || "never"),
      k.status === "active" ? `<button class="btn btn-danger"${onClick("act", [`/api/platform/saas/api-keys/${k.id}/revoke`, {}, `Revoke key ${k.key_prefix}? This cannot be undone.`])}>Revoke</button>` : ""]), "No API keys.")}${pager("/platform/saas/api-keys", { status }, page, hasMore)}`);
}

export async function renderBackupsAdminPage(env, admin, { status = "", page: rawPage } = {}) {
  const page = pageNumber(rawPage);
  const { rows, hasMore } = paged(await staff.listAllBackups(env, { status, ...pageArgs(page) }));
  const size = (b) => (b == null ? "—" : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  return shell(env, admin, "Backups", "saas-backups", `${statusFilter(status, ["running", "complete", "partial", "failed", "expired"])}
    ${table(["Site", "Organization", "Kind", "Status", "Size", "Integrity", "Created", "Error"], rows.map((b) => [h(b.site || "deleted site"), b.organization_id ? orgLink(b.organization_id, b.organization) : "—", h(b.kind), badge(b.status), size(b.size_bytes), h(b.verified_at ? b.verification_status : "not verified"), h(b.created_at), h(b.error_message || "")]), "No backups.")}${pager("/platform/saas/backups", { status }, page, hasMore)}`);
}

export async function renderOpsAlertsPage(env, admin) {
  const rows = await alertsModule.listAlertState(env);
  const channels = [env.ALERT_WEBHOOK_URL ? "chat webhook" : null, env.ALERT_EMAIL ? "email" : null].filter(Boolean);
  return shell(env, admin, "Alerts", "saas-alerts", `
    <p style="color:var(--text-dim)">${channels.length
      ? `Alerts go to: ${h(channels.join(" and "))}. A problem notifies once when it starts, reminds every ${h(alertsModule.REMINDER_HOURS)} hours while it lasts, and notifies when it clears.`
      : "No alert channel is configured, so no alerts are being sent. Set ALERT_WEBHOOK_URL and/or ALERT_EMAIL."}
      ${env.ALERT_CHECK_TOKEN ? "" : " The external trigger endpoint is off because ALERT_CHECK_TOKEN is not set."}</p>
    <button class="btn"${onClick("act", ["/api/platform/saas/alerts/check", {}, "Run the alert check now?"])}>Run check now</button>
    ${table(["Check", "Firing", "Last count", "First seen", "Last notified"], rows.map((r) => [h(r.key), r.firing ? badge("failed") : badge("active"), h(r.last_count), h(r.first_seen_at || "—"), h(r.last_notified_at || "—")]), "Nothing has fired yet.")}`);
}

export async function renderServerErrorsPage(env, admin) {
  const [recent, summary] = await Promise.all([errorsRepo.listRecent(env, 100), errorsRepo.summaryLastHours(env, 24)]);
  return shell(env, admin, "Server errors", "saas-errors", `
    <p style="color:var(--text-dim)">Every response with a 5xx status, and every unhandled exception, with the request reference shown to the person (header
      <code>X-Request-Id</code>). Only the route (ids replaced), status and the error's own message are kept, for 14 days. An alert fires when
      ${h(5)} or more happen within 15 minutes.</p>
    <h2>Last 24 hours, by route</h2>
    ${table(["Route", "Status", "Count", "Last seen"], summary.map((r) => [h(r.route), h(r.status), h(r.n), h(r.last_seen)]), "No server errors in the last 24 hours.")}
    <h2>Most recent</h2>
    ${table(["When", "Request", "Route", "Status", "Error"], recent.map((r) => [h(r.created_at), `<code>${h(r.request_id)}</code>`, h(`${r.method} ${r.route}`), h(r.status), h(r.error_name ? `${r.error_name}: ${r.message || ""}` : "—")]), "Nothing recorded.")}`);
}

export async function renderCpBackupsPage(env, admin) {
  const rows = await cpBackupModule.listControlPlaneBackups(env);
  const size = (b) => (b == null ? "—" : b < 1048576 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const intro = env.BACKUPS
    ? `A copy of this platform's own database (organizations, subscriptions, billing, audit logs) is exported encrypted to storage about once a day, and the last ${h(cpBackupModule.KEEP_COMPLETE_BACKUPS)} are kept. It is not a point-in-time snapshot, and it can only be read with CREDENTIAL_KEK, so keep a separate copy of that key. Sessions and one-time tokens are not included.`
    : "Backup storage (the BACKUPS bucket) is not configured, so no database backups are being made.";
  return shell(env, admin, "Control-plane DB backups", "saas-cpbackups", `
    <p style="color:var(--text-dim)">${intro}</p>
    ${env.BACKUPS ? `<button class="btn"${onClick("act", ["/api/platform/saas/cp-backups", {}, "Create a database backup now?"])}>Back up now</button>` : ""}
    ${table(["Created", "Status", "Parts", "Size", "Integrity", ""], rows.map((b) => [h(b.created_at), badge(b.status), h(b.part_count), size(b.size_bytes),
      h(b.verified_at ? b.verification_status : "not verified") + (b.error_message ? `<br><small>${h(b.error_message)}</small>` : ""),
      b.status === "complete" ? `<button class="btn"${onClick("act", [`/api/platform/saas/cp-backups/${b.id}/verify`, {}, "Verify this backup? This reads every stored part."])}>Verify</button>` : ""]), "No backups yet.")}`);
}

export async function renderKeyRotationPage(env, admin) {
  let st;
  try { st = await keyRotationModule.rotationStatus(env); } catch (_) {
    return shell(env, admin, "Key rotation", "saas-keyrotation", `<div class="card"><p>CREDENTIAL_KEK is not configured or is not a valid key, so nothing can be encrypted or read.</p></div>`);
  }
  const verdict = !st.previousKeyId
    ? (st.rowsUnderOtherKeys === 0 ? "No rotation in progress. Everything is under the current key." : "CREDENTIAL_KEK_PREVIOUS is not set, but some values were written with a different key and cannot be read. See docs/KEY_ROTATION.md.")
    : st.safeToRemovePrevious ? "Everything is under the current key and no retained backup needs the old one. CREDENTIAL_KEK_PREVIOUS can be removed now."
    : `Rotation in progress. Do NOT remove CREDENTIAL_KEK_PREVIOUS yet: ${h(st.rowsUnderOtherKeys)} stored value(s) and ${h(st.backupsUnderOtherKeys)} retained backup(s) still need it.`;
  return shell(env, admin, "Key rotation", "saas-keyrotation", `
    <p style="color:var(--text-dim)">Current key id: <strong>${h(st.activeKeyId)}</strong>. Previous key id: <strong>${h(st.previousKeyId || "not set")}</strong>. Key ids are a short fingerprint, not the key.</p>
    <div class="card"><p>${verdict}</p></div>
    ${st.previousKeyId ? `<button class="btn"${onClick("act", ["/api/platform/saas/key-rotation/run", {}, `Re-encrypt up to ${keyRotationModule.DEFAULT_BATCH} values under the current key?`])}>Re-encrypt now</button> <small>Repeat until nothing remains.</small>` : ""}
    ${table(["Stored in", "Values", "Under current key", "Under another key"], st.tables.map((t) => [h(t.table), h(t.total), h(t.underActiveKey), h(t.underOtherKey)]), "")}
    <p style="color:var(--text-dim)">Database backups checked: ${h(st.backupsChecked)}; still using another key: ${h(st.backupsUnderOtherKeys)}. Those age out as new backups replace them (the newest ${h(cpBackupModule.KEEP_COMPLETE_BACKUPS)} are kept).</p>`);
}
