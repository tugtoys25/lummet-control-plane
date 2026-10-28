import { withRetryAfter } from "./rate-limit-response.js";
import * as siteAccess from "./site-access.js";
import * as storageSync from "./storage-sync.js";
import { platformAccessGate } from "./cloudflare-access-jwt.js";
// =====================================================
// LUMMET CONTROL PLANE — WORKER ENTRY POINT
//
// JSON API (unchanged from Phase 2/3):
//   POST /api/auth/bootstrap   (only while zero admins exist)
//   POST /api/auth/login
//   POST /api/auth/logout
//   GET  /api/tenants
//   POST /api/tenants
//   GET  /api/tenants/:id
//   PUT  /api/tenants/:id
//   DELETE /api/tenants/:id
//   POST /api/tenants/:id/enable
//   POST /api/tenants/:id/disable
//   POST /api/tenants/:id/rotate-credential
//   POST /api/tenants/:id/test-connection
//   GET  /api/tenants/:id/capabilities
//   POST /api/tenants/:id/switch   (sets active tenant on session)
//   DELETE /api/session/active-tenant  (clears active tenant on session)
//
// Public marketing site (unauthenticated, rendered from D1 by
// worker/public-site/, templates + assets in public/):
//   GET  /            (public homepage, same for everyone, signed in or not)
//   GET  /session-status  ({ signedIn } for the header link; never cached)
//   GET  /brands, /brands/:slug, /updates, /updates/:slug,
//        /insights, /insights/:slug, /partners, /authors/:slug
//   GET/POST /contact, /demo, /forms/:key
//   GET  /p/:slug, /about, /security, /privacy, /terms
//   GET  /sitemap.xml, /robots.txt, /static/*
//
// Dashboard pages (Phase 4, new):
//   GET/POST /login
//   GET  /dashboard    (authenticated staff dashboard)
//   GET  /tenants
//   GET/POST /tenants/new
//   GET  /tenants/health
//   GET  /tenants/deployments
//   GET  /tenants/:id
//   GET  /content/:resource
//   GET  /system/:resource
//   GET  /platform/api
//   GET  /platform/credentials
//   GET  /platform/audit-logs
//   GET  /platform/capabilities
//
// Everything except bootstrap/login/logout requires a valid
// lummet_session cookie (see auth.js). This is a completely
// separate identity system from any tenant's own auth. Page
// routes redirect unauthenticated visitors to /login; API
// routes return a JSON 401.
// =====================================================

import { observe } from "./observability.js";
import * as healthRepo from "./repositories/health.js";
import * as requestErrorsRepo from "./repositories/request-errors.js";
import * as organizationsRepo from "./repositories/organizations.js";
import * as tenantLinks from "./tenant-links.js";
import * as automationSweep from "./automation-sweep.js";
import * as tenantAdmin from "./tenant-admin.js";
import * as notificationsRepo from "./repositories/notifications.js";
import { renderInsightAnalytics, renderInsightReports, renderInsightCampaigns, renderInsightAlerts, renderInsightNotifications, renderInsightSearch, renderInsightContent } from "./views/customer-pages/insights.js";
import { finalizeResponse, handleCspReport, nonceToken } from "./csp.js";
import { hstsHeaderValue } from "./hsts.js";
import { installConsoleRedaction } from "./redact.js";
import { captureException } from "./error-tracking.js";
import * as auth from "./auth.js";
import * as registry from "./registry.js";
import { logAudit } from "./audit.js";
import * as billingLifecycleRepo from "./repositories/billing-lifecycle.js";
import { getFromTenant } from "./client.js";
import { isSuperAdmin, canAccessTenant, hasPermission, setPermission, setTenantAccess, listAccessibleTenants } from "./rbac.js";

// Phase 1 — customer/organization SaaS foundation (master prompt
// sections 6-13). A completely separate identity system from
// `auth.js`/`admin` above — see customer-auth.js's header comment.
import * as customerAuth from "./customer-auth.js";
import * as orgSecurityPolicy from "./org-security-policy.js";
import * as organizations from "./organizations.js";
import * as sites from "./sites.js";
import * as plans from "./plans.js";
import * as entitlementsService from "./entitlements.js";
import { roleAtLeast } from "./customer-rbac.js";

// Phase 2-7 — billing, provisioning, domains, deployments, customer
// portal UI, developer platform, and enterprise features. Ported
// forward onto this codebase's AI/newsroom-era control plane; see
// docs/SAAS_MERGE_NOTES.md for what changed vs. the original phase
// branches.
import { billing } from "./billing.js";
import * as billingLifecycle from "./billing-lifecycle.js";
import { evaluateWriteGate, evaluateServeGate, refusalFor, resolveAccess } from "./access.js";
import { effectiveNow, cardRequiredTrial } from "./billing-config.js";
import * as scheduler from "./scheduler.js";
import { reconcileSubscriptions, resolveDrift, listDrift } from "./phase3-source-of-truth.js";
import { stripeRequest } from "./billing-stripe.js";
import { provisioning } from "./provisioning.js";
import * as jobsModule from "./jobs.js";
import * as jobRunner from "./job-runner.js";
import { domains } from "./domains.js";
import { zoneDomains } from "./zone-domains.js";
import { deployments } from "./deployments.js";
import { tenantPortal } from "./tenant-portal.js";
import { getUsageSnapshot } from "./usage.js";
import * as commercial from "./commercial.js";
import * as commercialRepo from "./repositories/commercial.js";
import { renderCustomerShell } from "./views/customer-layout.js";
import { renderCustomerLoginPage } from "./views/customer-pages/login.js";
import { renderOverviewPage } from "./views/customer-pages/overview.js";
import { renderSitesPage } from "./views/customer-pages/sites.js";
import { renderAccountPage } from "./views/customer-pages/account.js";
import { renderBillingPage } from "./views/customer-pages/billing.js";
import { renderDomainsPage } from "./views/customer-pages/domains.js";
import { renderUsagePage } from "./views/customer-pages/usage.js";
import { renderTeamPage } from "./views/customer-pages/team.js";
import { renderDeploymentsPage as renderCustomerDeploymentsPage } from "./views/customer-pages/deployments.js";
import { renderDeveloperPage } from "./views/customer-pages/developer.js";
import { renderBackupsPage } from "./views/customer-pages/backups.js";
import { renderAutomationsPage } from "./views/customer-pages/automations.js";
import { renderOrgSettingsPage } from "./views/customer-pages/settings.js";
import * as apiKeys from "./api-keys.js";
import * as webhooksModule from "./webhooks.js";
import { searchOrganization } from "./search.js";
import { exportOrganizationData } from "./export.js";
import * as totp from "./totp.js";
import * as branding from "./branding.js";
import * as changeRequests from "./change-requests.js";
import { listOrganizationAuditLog } from "./audit-log.js";
import * as customerSessions from "./customer-sessions.js";
import * as customerAuditCsv from "./customer-audit-csv.js";
import { getSiteHealthReport } from "./site-health.js";
import * as webauthn from "./webauthn.js";
import * as sso from "./sso.js";
import * as ssoDomains from "./sso-domains.js";
import { escapeHtml } from "./views/layout.js";
import { getBalance as getAiBalance, listLedger as listAiLedger } from "./ai-credits.js";
import { runAiTask, workersAiProvider, TASKS as AI_TASKS } from "./ai-gateway.js";
import { getMonthlyUsage, checkUsageLimit, recordUsage } from "./usage.js";
import * as staffSaas from "./staff-saas.js";
import * as revenueAnalytics from "./revenue-analytics.js";
import {
  renderSaasOverview, renderRevenueAnalyticsPage, renderOrganizationsPage, renderOrganizationDetailPage, renderSubscriptionsPage,
  renderPlansPage, renderJobsPage, renderJobDetailPage, renderEmailPage, renderNotificationsPage, renderTenantTemplatePage, renderCouponsPage, renderOpsAlertsPage, renderServerErrorsPage, renderCpBackupsPage, renderKeyRotationPage, renderReconciliationPage, renderDomainsAdminPage, renderDeploymentsAdminPage, renderWebhooksAdminPage, renderApiKeysAdminPage, renderBackupsAdminPage
} from "./views/pages/saas-admin.js";
import { backups } from "./backups.js";
import * as tenantTemplate from "./tenant-template.js";
import * as staffTokens from "./staff-tokens.js";
import * as rollouts from "./rollouts.js";
import * as automations from "./automations.js";
import { queueEmail, flushOutbox, portalLink, emailConfigured } from "./email.js";
import * as billingNotifications from "./billing-notifications.js";
import { listPlanPrices as planPriceList } from "./plan-prices.js";
import * as planChangeRepo from "./repositories/plan-change-intents.js";
import { BILLING_KINDS } from "./billing-email-templates.js";
import { listForStaff as notificationRepoList, NOTIFICATION_STATES as notificationRepoStates } from "./repositories/billing-notifications.js";
import * as billingReminders from "./billing-reminders.js";
import { handleResendWebhook } from "./resend-webhook.js";
import * as alerts from "./alerts.js";
import { runSyntheticMonitors } from "./synthetic-monitors.js";
import * as cpBackup from "./cp-backup.js";
import * as keyRotation from "./key-rotation.js";
import * as erasure from "./erasure.js";
import * as staff2fa from "./staff-2fa.js";
import { customer2faEnrollMode, ENROLL_PAGE_PATH } from "./customer-2fa-enroll.js";
import { renderCustomer2faEnrollPage } from "./views/customer-pages/account-security.js";
import { renderVerifyEmailPage, renderResetPasswordPage, renderForgotPasswordPage, renderInvitationPage, renderOrg2faRequiredPage, renderOrgIpDeniedPage } from "./views/customer-pages/account-links.js";

import { renderLoginPage } from "./views/pages/login.js";
import { renderDashboardHome } from "./views/pages/dashboard.js";
import { handlePublicRoute } from "./public-site/router.js";
import {
  renderTenantsList,
  renderAddTenantForm,
  renderTenantCreatedPage,
  renderHealthPage,
  renderDeploymentsPage,
  renderTenantDetail
} from "./views/pages/tenants.js";
import {
  renderAuditLogsPage,
  renderCredentialsPage,
  renderCapabilitiesPage,
  renderApiReferencePage
} from "./views/pages/platform.js";
import { renderResourcePlaceholder } from "./views/pages/placeholder.js";
import { getResourceConfig } from "./resources.js";
import {
  renderResourceList,
  renderResourceForm,
  submitCreate,
  submitUpdate,
  submitDelete,
  submitToggleField
} from "./views/pages/crud.js";
import {
  renderSettingsPage,
  submitSettings,
  submitCreateAdRule,
  submitUpdateAdRule,
  submitDeleteAdRule
} from "./views/pages/settings.js";
import { renderMediaUploadForm, submitMediaUpload, submitMediaFromUrl } from "./views/pages/media.js";
import {
  renderPermissionsMatrix,
  submitSetPermission,
  renderUserItemAccess,
  submitSetItemScope,
  submitSetItemAssignment
} from "./views/pages/permissions.js";
import {
  renderReviewBlocksPage,
  submitCreateReviewBlock,
  submitUpdateReviewBlock,
  submitDeleteReviewBlock
} from "./views/pages/review-blocks.js";
import {
  renderNewsroomTagsPage,
  submitNewsroomMeta,
  submitNewsroomRelations
} from "./views/pages/newsroom-tags.js";
import { renderReportsPage, submitCreateReport, submitRunReport, fetchReportColumnOptions } from "./views/pages/reports.js";
import { submitAnalyticsRun } from "./views/pages/analytics.js";
import { renderAlertsPage, submitCreateAlertRule, submitAcknowledgeAlert } from "./views/pages/alerts.js";
import { renderAnalyticsPage } from "./views/pages/analytics.js";
import { renderSeoMetaPage, submitSaveSeoMeta, submitDeleteSeoMeta } from "./views/pages/seo-meta.js";
import {
  renderIntegrationsPage,
  submitCreatePostbackConfig, submitUpdatePostbackConfig, submitRotatePostbackToken, submitArchivePostbackConfig,
  submitCreateProviderAdapter, submitUpdateProviderAdapter, submitArchiveProviderAdapter
} from "./views/pages/integrations.js";
import { renderSupportPage, submitReplyInquiry, submitUpdateSubmissionStatus, submitSendNotification } from "./views/pages/support.js";
import {
  renderAiToolsPage,
  submitGenerateReview, submitGenerateSeoCopy, submitGenerateFaqs,
  submitGenerateSchema, submitGenerateOutline, submitImproveContent, submitSuggestInternalLinks
} from "./views/pages/ai-tools.js";
import { renderNewsletterPage, submitAddSubscriber, submitUnsubscribe } from "./views/pages/newsletter.js";
import { renderAiChatPage } from "./views/pages/ai-chat.js";
import { handleChatMessage, listConversations, getOwnedConversation, getMessages, attachPendingPreviews } from "./ai/chat.js";
import { confirmPendingOperation } from "./ai/confirm.js";
import { runHealthChecks, pruneOldAuditLogs } from "./cron.js";
import { getCmsResourceConfig } from "./cms-resources.js";
import {
  renderCmsList,
  renderCmsForm,
  submitCmsCreate,
  submitCmsUpdate,
  submitCmsDelete,
  renderSiteSettingsPage,
  submitSiteSettings
} from "./views/pages/cms.js";
import {
  renderAdminsList,
  renderNewAdminForm,
  renderAdminCreatedPage,
  renderAdminDetail,
  submitCreateAdmin,
  submitSetRole,
  submitSetStatus,
  submitDeleteAdmin,
  submitSetTenantAccess,
  submitSetPermission as submitSetAdminPermission
} from "./views/pages/admins.js";
import { renderTwoFactorPage, renderChangePasswordPage, submitChangePassword } from "./views/pages/account.js";
import { runBackfillTick as runRevenueBackfillTick } from "./revenue.js";
import { runDailyRevenueJob } from "./revenue-job.js";
import {
  renderCountryPagesList,
  renderCountryPageForm,
  renderCategoryCountriesList,
  renderCategoryCountryForm,
  submitCreateSeoPage,
  submitUpdateSeoPage,
  submitDeleteSeoPage,
  proxySearchCountries,
  proxyEligibleCasinos,
  submitGenerateCategoryCountryDraft
} from "./views/pages/seo-pages.js";
import {
  renderCountriesList,
  renderCountryForm,
  renderCategoriesList,
  renderCategoryForm,
  submitCreateHubPage,
  submitUpdateHubPage,
  submitDeleteHubPage,
  proxyHubEligibleCasinos
} from "./views/pages/hub-pages.js";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

/**
 * Round 6.4A: the answer for a customer session that an organization policy blocks (no 2FA, but a member of an organization that
 * requires it). Null when the session is fine. 403 with a stable code, never 401, so a client does not loop back to the login page.
 */
function orgPolicyDenied(policy) {
  return policy && policy.blocked ? json({ success: false, error: policy.reason || "org_2fa_required" }, 403) : null;
}

/**
 * Round 6.4C: the answer when an organization's IP allowlist denies this request. Null when the request may proceed. 403 with a stable code.
 * Shadow mode only logs (no address, no list) that it would have denied. Called after membership is proven, for exactly one organization.
 */
async function orgIpDenied(env, request, organizationId) {
  const verdict = await orgSecurityPolicy.evaluateOrgIpAccess(env, request, organizationId);
  if (verdict.wouldDeny && !verdict.denied) console.log(JSON.stringify({ msg: "org_ip_allowlist_would_deny", organizationId, mode: verdict.mode }));
  return verdict.denied ? json({ success: false, error: verdict.reason || "ip_not_allowed" }, 403) : null;
}

function html(content, status = 200, extraHeaders = {}) {
  return new Response(content, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders }
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, { status: 302, headers: { Location: location, ...extraHeaders } });
}

async function hashIP(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  if (!ip) return null;
  const data = new TextEncoder().encode(ip);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function matchPath(pattern, path) {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

async function parseForm(request) {
  const formData = await request.formData();
  const out = {};
  for (const [key, value] of formData.entries()) out[key] = value;
  return out;
}

// Headers added to every response (security review 2.1). The console and portal
// are never meant to be embedded in another site (clickjacking), and pages that
// carry one-time tokens in their URL (email verification, password reset,
// invitations) must not leak them to other sites through the Referer header.
const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  // Content-Security-Policy is set per response by finalizeResponse() (csp.js): HTML pages get a nonce-based
  // script-src, everything else the baseline. See docs/CSP.md.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

function withSecurityHeaders(response, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  // Strict-Transport-Security (Round 6.3C): the default value is unchanged; HSTS_PRELOAD=on adds preload. Set by the
  // Worker for every response type; a stronger value on a response (never weaker) is kept.
  headers.set("Strict-Transport-Security", hstsHeaderValue(env, headers.get("Strict-Transport-Security")));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * How a rollout starts the deployment job of the site it is on. With a JOB_QUEUE binding the job goes on the
 * durable queue. Without one: an interactive caller (the staff page, the CI script: both wait for the answer)
 * runs the job to the end inside the request, so it is not cut off 30 seconds after the response; the
 * maintenance tick (a pinger that wants a quick reply) hands it to waitUntil and the job sweep covers a loss.
 */
function makeRolloutDispatch(env, ctx, { inline }) {
  const queued = !!env.JOB_QUEUE && typeof env.JOB_QUEUE.send === "function";
  return async (jobId) => {
    if (inline && !queued) { await jobRunner.runJobById(env, jobId).catch(() => {}); return; }
    await jobRunner.dispatchJob(env, ctx, jobId);
  };
}

/**
 * Starts a deployment of the site's current published release, used after a custom domain becomes the site's primary
 * address so the Worker learns its new URL. Best effort: the domain is already live whether or not this succeeds.
 */
function makeDomainRedeploy(env, ctx) {
  return async (siteId) => {
    const release = await tenantTemplate.getCurrentRelease(env);
    if (!release.ok) return;
    const result = await deployments.startDeployment(env, {
      siteId, version: release.version, migrations: release.migrations, scriptContent: release.scriptContent, actorType: "system"
    });
    if (result.ok) await jobRunner.dispatchJob(env, ctx, result.jobId);
  };
}


async function renderPhase5StaffPage(env, admin, kind) {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const title={quotes:'Quotes', 'customer-360':'Customer 360', dunning:'Dunning queue', approvals:'Refund / credit approvals', 'catalog-drift':'Catalog & drift', tax:'Tax registration checklist','webhook-replay':'Failed webhook replay'}[kind]||'Phase 5 operations';
  let body=`<h1>${esc(title)}</h1><p>Phase 5 operations screen. Every mutation requires staff authentication, a reason and an audit entry.</p>`;
  if(kind==='quotes') body+=`<p><a href="/platform/saas/organizations">Organizations</a> · <a href="/platform/saas/reconciliation">Drift</a></p><div id="quote-list">Loading…</div><script nonce="${nonceToken()}">fetch('/api/platform/saas/quotes?limit=50').then(r=>r.json()).then(j=>{document.getElementById('quote-list').innerHTML='<pre>'+JSON.stringify(j.data||j,null,2).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c]})+'</pre>'})</script>`;
  if(kind==='customer-360') body+=`<p>Enter an organization id to inspect plan, state, invoices, timeline, overrides, credits and staff notes.</p><form method="get"><label>Organization ID <input name="organization" required value=""></label></form>`;
  if(kind==='dunning') body+=`<p>Actions: extend grace, resend notice, and request a comp. Each requires a reason; a comp only voids one open invoice after a second staff member approves it.</p><div id="dunning">Loading…</div><script nonce="${nonceToken()}">function __esc(t){return String(t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}fetch('/api/platform/saas/dunning?limit=100').then(r=>r.json()).then(j=>document.getElementById('dunning').innerHTML='<pre>'+__esc(JSON.stringify(j.data||j,null,2))+'</pre>')</script>`;
  if(kind==='approvals') body+=`<p>Pending refunds, credits and dunning comps require a second staff member. Self-approval is rejected by the database.</p><div id="approvals">Loading…</div><script nonce="${nonceToken()}">function __esc(t){return String(t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}fetch('/api/platform/saas/approvals?status=pending').then(r=>r.json()).then(j=>document.getElementById('approvals').innerHTML='<pre>'+__esc(JSON.stringify(j.data||j,null,2))+'</pre>')</script>`;
  if(kind==='catalog-drift') body+=`<p><a href="/platform/saas/plans">Catalog</a> · <a href="/platform/saas/reconciliation">Reconciliation findings</a>. Provider price IDs remain owner-verified.</p>`;
  if(kind==='tax') body+=`<div id="tax">Loading…</div><script nonce="${nonceToken()}">function __esc(t){return String(t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}fetch('/api/platform/saas/tax-checklist').then(r=>r.json()).then(j=>document.getElementById('tax').innerHTML='<pre>'+__esc(JSON.stringify(j.data||j,null,2))+'</pre>')</script>`;
  if(kind==='webhook-replay') body+=`<div id="failed-webhooks">Loading…</div><script nonce="${nonceToken()}">function __esc(t){return String(t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}fetch('/api/platform/saas/webhooks/failed').then(r=>r.json()).then(j=>document.getElementById('failed-webhooks').innerHTML='<pre>'+__esc(JSON.stringify(j.data||j,null,2))+'</pre>')</script>`;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><main style="max-width:1100px;margin:2rem auto;font:16px system-ui;padding:0 1rem">${body}</main></html>`;
}

export default {
  async fetch(request, env, ctx) {
    installConsoleRedaction(env);     // LOG_REDACTION=on only; a no-op by default
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    const holder = { error: null };
    let response = await handleRequest(request, env, ctx, requestId, holder);
    response = withRetryAfter(response, request, env);
    const seen = await observe(env, ctx, { requestId, method: request.method.toUpperCase(), pathname: new URL(request.url).pathname, status: response.status, startedAt, error: holder.error });
    response = withSecurityHeaders(await finalizeResponse(response, env), env);
    // Request id for support ("quote this"), and the time the Worker spent, for anyone watching the network tab.
    const headers = new Headers(response.headers);
    headers.set("X-Request-Id", requestId);
    headers.set("Server-Timing", `app;dur=${seen ? seen.durationMs : Date.now() - startedAt}`);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },

  async scheduled(event, env, ctx) {
    installConsoleRedaction(env);
    try {
      return await runScheduled(event, env, ctx);
    } catch (error) {
      // Reported (scrubbed, ERROR_TRACKING only) and re-thrown, so Cloudflare keeps its own record of the failed run.
      const report = captureException(env, ctx, error, { requestId: null, method: "", route: "scheduled", status: "", eventKind: "scheduled" });
      if (ctx && ctx.waitUntil) ctx.waitUntil(report); else await report;
      throw error;
    }
  },

  // Cloudflare Queues consumer for background jobs. Only used when a JOB_QUEUE queue is bound
  // (see docs/DURABLE_JOBS.md); without it jobs run via ctx.waitUntil and the sweep.
  async queue(batch, env) {
    installConsoleRedaction(env);
    return jobRunner.handleQueueBatch(batch, env);
  }
};

async function handleRequest(request, env, ctx, requestId = crypto.randomUUID(), holder = {}) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    const isApiRoute = path.startsWith("/api/");

    // Liveness for uptime monitors: no auth, no data, nothing about the deployment. 200 only if the database answers.
    if ((method === "GET" || method === "HEAD") && path === "/api/health") {
      try {
        await healthRepo.ping(env);
        return json({ ok: true }, 200);
      } catch (error) {
        holder.error = error;
        return json({ ok: false }, 503);
      }
    }

    // CSP violation reports (browsers send these on their own, possibly with cookies): log and drop, no auth, no state.
    if (method === "POST" && path === "/api/csp-report") return handleCspReport(request, env);

    // Round 6.3B: Cloudflare Access is an additional perimeter for /platform/* and /api/platform/*. Staff sessions, 2FA and
    // RBAC still apply after it. PLATFORM_ACCESS_JWT_MODE=off (default) changes nothing; enforce fails closed.
    const accessRefusal = await platformAccessGate(request, env, path);
    if (accessRefusal) return json({ success: false, error: accessRefusal.error }, accessRefusal.status);

    try {
      // ---------------------------------------------
      // CSRF guard (security review 2.1). Session cookies are SameSite, but customer
      // sites live on sibling subdomains of the platform domain, and SameSite treats
      // those as "same site", so a malicious customer site could otherwise make a
      // visiting admin's browser send state-changing requests here. Any unsafe
      // request that carries cookies must come from this exact origin. Cookie-less
      // callers (Stripe webhooks, API keys, the pinger, tenant Workers) are unaffected
      // because a CSRF request is only dangerous when the browser attaches a session.
      // ---------------------------------------------
      if (!["GET", "HEAD", "OPTIONS"].includes(method) && request.headers.get("Cookie")) {
        const origin = request.headers.get("Origin");
        const fetchSite = request.headers.get("Sec-Fetch-Site");
        let bad = false;
        if (origin && origin !== "null") { try { bad = new URL(origin).host !== url.host; } catch (_) { bad = true; } }
        else if (origin === "null") bad = fetchSite !== "same-origin"; // no-referrer makes browsers send Origin: null on same-origin form posts                                   // sandboxed/opaque origins
        else if (fetchSite && !["same-origin", "none"].includes(fetchSite)) bad = true;
        if (bad) { console.warn("csrf_blocked", JSON.stringify({ origin, fetchSite, host: url.host })); return json({ success: false, error: "cross_site_request_blocked" }, 403); }
      }

      // ---------------------------------------------
      // Unauthenticated JSON auth routes
      // ---------------------------------------------

      if (method === "POST" && path === "/api/auth/bootstrap") {
        const body = await request.json().catch(() => ({}));
        const result = await auth.bootstrapFirstAdmin(env, body.email, body.password);

        await logAudit(env, {
          adminId: result.ok ? result.adminId : null,
          endpoint: path, method,
          resource: "lummet_admin", action: "bootstrap",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? `email:${result.email}` : result.error,
          requestId, ipHash: await hashIP(request)
        });

        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true });
      }

      if (method === "POST" && path === "/api/auth/login") {
        const result = await auth.login(request, env);

        await logAudit(env, {
          adminId: result.adminId || null,
          endpoint: path, method,
          resource: "lummet_admin", action: "login",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? `email:${result.email}` : `email:${result.email || "unknown"} reason:${result.error}`,
          requestId, ipHash: await hashIP(request)
        });

        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        // Password was right but the account has 2FA: no session yet.
        if (result.mfaRequired) return json({ success: true, mfaRequired: true, challengeId: result.challengeId });
        return json({ success: true }, 200, { "Set-Cookie": result.cookie });
      }

      if (method === "POST" && path === "/api/auth/login/mfa") {
        const body = await request.json().catch(() => ({}));
        const result = await auth.completeAdminMfaLogin(env, body.challengeId, { code: body.code, backupCode: body.backupCode }, await auth.hashIPForRateLimit(request));
        await logAudit(env, {
          adminId: result.adminId || null, endpoint: path, method,
          resource: "lummet_admin", action: "login_mfa",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? (result.usedBackupCode ? "backup_code_used" : null) : `reason:${result.error}`,
          requestId, ipHash: await hashIP(request)
        });
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true }, 200, { "Set-Cookie": result.cookie });
      }

      if (method === "POST" && path === "/api/auth/logout") {
        const result = await auth.logout(request, env);

        await logAudit(env, {
          adminId: result.adminId,
          endpoint: path, method,
          resource: "lummet_admin", action: "logout",
          success: true, statusCode: 200,
          requestId, ipHash: await hashIP(request)
        });

        return json({ success: true }, 200, { "Set-Cookie": result.cookie });
      }

      // ---------------------------------------------
      // STRIPE WEBHOOK (Phase 2 — master prompt section 14)
      //
      // Deliberately unauthenticated (Stripe is not a Lummet
      // admin or customer session) and placed before every
      // other gate — billing.handleWebhook() is what actually
      // authenticates the request, via HMAC signature
      // verification against the raw body (see
      // billing-stripe.js's verifyAndParseWebhook). Never
      // reads request.json() itself for this reason.
      // ---------------------------------------------

      if (method === "POST" && path === "/api/email/webhook/resend") {
        // Authenticated by the Svix signature over the raw body (resend-webhook.js), never by a session.
        const result = await handleResendWebhook(request, env);
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true });
      }

      if (method === "POST" && path === "/api/billing/webhook/stripe") {
        const result = await billing.handleWebhook(request, env);

        await logAudit(env, {
          actorType: "system",
          endpoint: path, method, resource: "billing_webhook", action: "receive",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? (result.duplicate ? "duplicate_event_ignored" : null) : result.error,
          requestId, ipHash: await hashIP(request)
        });

        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true });
      }

      // ---------------------------------------------
      // Login page (unauthenticated, HTML)
      // ---------------------------------------------

      if (path === "/login") {
        const existingAdmin = await auth.getCurrentAdmin(request, env);
        if (existingAdmin && method === "GET") {
          return redirect("/dashboard");
        }

        const bootstrapMode = !(await auth.hasAnyAdmins(env));

        if (method === "GET") {
          return html(renderLoginPage({ mode: bootstrapMode ? "bootstrap" : "login" }));
        }

        if (method === "POST") {
          const form = await parseForm(request);
          const pageIpHash = await hashIP(request);
          const authIpHash = await auth.hashIPForRateLimit(request);

          if (form.mode === "bootstrap") {
            const result = await auth.bootstrapFirstAdmin(env, form.email, form.password);

            await logAudit(env, {
              adminId: result.ok ? result.adminId : null,
              endpoint: path, method,
              resource: "lummet_admin", action: "bootstrap",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? `email:${result.email}` : result.error,
              requestId, ipHash: pageIpHash
            });

            if (!result.ok) {
              return html(
                renderLoginPage({ mode: "bootstrap", error: describeAuthError(result.error) })
              );
            }
            // Log the freshly bootstrapped admin straight in.
            const loginResult = await auth.authenticateAdmin(env, form.email, form.password, authIpHash);

            await logAudit(env, {
              adminId: loginResult.adminId || null,
              endpoint: path, method,
              resource: "lummet_admin", action: "login",
              success: loginResult.ok, statusCode: loginResult.ok ? 200 : loginResult.status,
              errorMessage: loginResult.ok ? `email:${loginResult.email}` : `email:${loginResult.email || "unknown"} reason:${loginResult.error}`,
              requestId, ipHash: pageIpHash
            });

            if (!loginResult.ok) return redirect("/login");
            return redirect("/dashboard", { "Set-Cookie": loginResult.cookie });
          }

          if (form.mode === "mfa") {
            const mfa = await auth.completeAdminMfaLogin(env, form.challenge_id, { code: form.code, backupCode: form.backup_code }, authIpHash);
            await logAudit(env, {
              adminId: mfa.adminId || null, endpoint: path, method,
              resource: "lummet_admin", action: "login_mfa",
              success: mfa.ok, statusCode: mfa.ok ? 200 : mfa.status,
              errorMessage: mfa.ok ? (mfa.usedBackupCode ? "backup_code_used" : null) : `reason:${mfa.error}`,
              requestId, ipHash: pageIpHash
            });
            if (mfa.ok) return redirect("/dashboard", { "Set-Cookie": mfa.cookie });
            const dead = ["invalid_challenge", "challenge_expired", "too_many_attempts", "account_disabled"].includes(mfa.error);
            if (dead) return html(renderLoginPage({ mode: "login", error: describeAuthError(mfa.error === "too_many_attempts" ? "too_many_attempts" : "mfa_restart") }));
            return html(renderLoginPage({ mode: "mfa", challengeId: form.challenge_id, error: describeAuthError(mfa.error) }));
          }

          const loginResult = await auth.authenticateAdmin(env, form.email, form.password, authIpHash);

          await logAudit(env, {
            adminId: loginResult.adminId || null,
            endpoint: path, method,
            resource: "lummet_admin", action: "login",
            success: loginResult.ok, statusCode: loginResult.ok ? 200 : loginResult.status,
            errorMessage: loginResult.ok ? `email:${loginResult.email}${loginResult.mfaRequired ? " mfa_pending" : ""}` : `email:${loginResult.email || "unknown"} reason:${loginResult.error}`,
            requestId, ipHash: pageIpHash
          });

          if (!loginResult.ok) {
            return html(
              renderLoginPage({ mode: "login", error: describeAuthError(loginResult.error) })
            );
          }
          if (loginResult.mfaRequired) return html(renderLoginPage({ mode: "mfa", challengeId: loginResult.challengeId }));
          return redirect("/dashboard", { "Set-Cookie": loginResult.cookie });
        }
      }

      // ---------------------------------------------
      // GET /session-status — tells the public site whether the visitor
      // is a signed-in staff member, so the header can show "Dashboard"
      // instead of "Sign in". Public pages are shared in the edge cache
      // and cannot differ per visitor, so this tiny per-visitor answer
      // is fetched separately. It returns only { signedIn: boolean },
      // is never cached, and does not touch the database when there is
      // no session cookie.
      // ---------------------------------------------
      if ((method === "GET" || method === "HEAD") && path === "/session-status") {
        const hasCookie = /(?:^|;\s*)lummet_session=/.test(request.headers.get("Cookie") || "");
        const signedIn = hasCookie ? Boolean(await auth.getCurrentAdmin(request, env)) : false;
        return new Response(JSON.stringify({ signedIn }), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store",
            "Vary": "Cookie",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      // ---------------------------------------------
      // Public marketing site (HTML)
      //
      // Everyone, signed in or not, sees the same public pages; the staff
      // dashboard lives at /dashboard and below (still requires a session),
      // the customer portal at /app, and the SaaS APIs under /api/.
      // The public site lives in worker/public-site/ (router.js). It owns
      // "/", /brands, /updates, /insights, /partners, /authors/:slug,
      // /contact, /demo, /forms/:key, /p/:slug, /about /security /privacy
      // /terms, /sitemap.xml, /robots.txt and /static/*. It returns null for
      // any path it does not own, so every route below is still reached.
      // ---------------------------------------------
      {
        const publicResponse = await handlePublicRoute({
          request,
          env,
          ctx
        });
        if (publicResponse) return publicResponse;
      }

      // ---------------------------------------------
      // CUSTOMER / ORGANIZATION API (Phase 1 — SaaS
      // foundation, master prompt sections 6-13).
      //
      // A completely separate identity system from the
      // Lummet staff session gate just below — placed here,
      // above it, exactly like /api/auth/* and /login above,
      // since none of this should ever require (or accept) a
      // Lummet admin session.
      // ---------------------------------------------

      if (method === "POST" && path === "/api/customer/signup") {
        // Every signup creates an org + trial and sends an email: cap per IP.
        if (!(await customerAuth.throttle(env, request, "customer_signup", 10))) {
          return json({ success: false, error: "too_many_attempts" }, 429);
        }
        const result = await customerAuth.signUp(request, env);
        await logAudit(env, {
          actorType: "customer_user",
          customerUserId: result.ok ? result.userId : null,
          organizationId: result.ok ? result.organizationId : null,
          endpoint: path, method, resource: "customer_user", action: "signup",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? null : result.error,
          requestId, ipHash: await hashIP(request)
        });
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        const verifyQueued = await queueEmail(env, {
          to: result.email, template: "verify_email", organizationId: result.organizationId,
          vars: { link: portalLink(env, "/app/verify-email", { uid: result.userId, token: result.emailVerificationToken }) }
        });
        if (verifyQueued.ok) ctx.waitUntil(flushOutbox(env, { fetchImpl: typeof env.EMAIL_FETCH === "function" ? env.EMAIL_FETCH : fetch }).catch(() => {}));
        return json({ success: true, organizationId: result.organizationId }, 200, { "Set-Cookie": result.cookie });
      }

      if (method === "POST" && path === "/api/customer/login") {
        const result = await customerAuth.login(request, env);
        await logAudit(env, {
          actorType: "customer_user", customerUserId: result.userId || null,
          endpoint: path, method, resource: "customer_user", action: result.mfaRequired ? "login_mfa_challenge" : (result.twoFactorEnrollmentRequired ? "login_org_2fa_enrollment_only" : "login"),
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? (result.twoFactorEnrollmentRequired ? result.reason : null) : result.error,
          requestId, ipHash: await hashIP(request)
        });
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        if (result.mfaRequired) return json({ success: true, mfaRequired: true, challengeId: result.challengeId });
        // Round 6.4A: password verified, but an organization requires 2FA and this person has none. The cookie is a restricted session:
        // it reaches only the 2FA setup routes and logout until a factor is active.
        if (result.twoFactorEnrollmentRequired) return json({ success: true, twoFactorEnrollmentRequired: true, reason: result.reason }, 200, { "Set-Cookie": result.cookie });
        return json({ success: true }, 200, { "Set-Cookie": result.cookie });
      }

      if (method === "POST" && path === "/api/customer/mfa/complete") {
        const body = await request.json().catch(() => ({}));
        const result = await customerAuth.completeMfaLogin(env, body.challengeId, { code: body.code, backupCode: body.backupCode });
        await logAudit(env, {
          actorType: "customer_user", customerUserId: result.userId || null,
          endpoint: path, method, resource: "customer_user", action: "login_mfa_complete",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? null : result.error,
          requestId, ipHash: await hashIP(request)
        });
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true }, 200, { "Set-Cookie": result.cookie });
      }

      // ---------------------------------------------
      // WebAuthn/passkey passwordless login (Phase 7).
      // Unauthenticated by design — this IS the login. Registering
      // or managing a credential requires an existing session; see
      // the /api/customer/webauthn/ block further down.
      // ---------------------------------------------

      if (method === "POST" && path === "/api/customer/webauthn/login/options") {
        const body = await request.json().catch(() => ({}));
        const result = await webauthn.generateLoginOptions(env, body.email);
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true, options: result.options });
      }

      if (method === "POST" && path === "/api/customer/webauthn/login/verify") {
        const body = await request.json().catch(() => ({}));
        const result = await webauthn.completePasswordlessLogin(env, body.credential);
        await logAudit(env, {
          actorType: "customer_user", customerUserId: result.userId || null,
          endpoint: path, method, resource: "customer_user", action: "login_webauthn",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? null : result.error,
          requestId, ipHash: await hashIP(request)
        });
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true }, 200, { "Set-Cookie": result.cookie });
      }

      // ---------------------------------------------
      // SSO / OIDC (Phase 7). The redirect leg and the IdP callback
      // are both unauthenticated by design — this IS the login,
      // same as WebAuthn above. Configuring SSO for an organization
      // requires an existing admin session; see the org-scoped
      // block further down.
      // ---------------------------------------------

      const ssoLoginMatch = path.match(/^\/api\/sso\/([^/]+)\/login$/);
      if (method === "GET" && ssoLoginMatch) {
        const [, organizationId] = ssoLoginMatch;
        const redirectUri = new URL("/api/sso/callback", request.url).toString();
        const result = await sso.startLogin(env, organizationId, redirectUri);
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return redirect(result.authorizationUrl);
      }

      if (method === "GET" && path === "/api/sso/callback") {
        const params = new URL(request.url).searchParams;
        const result = await sso.completeLogin(env, { state: params.get("state"), code: params.get("code") });
        await logAudit(env, {
          actorType: "customer_user", customerUserId: result.userId || null,
          endpoint: path, method, resource: "customer_user", action: "login_sso",
          success: result.ok, statusCode: result.ok ? 200 : result.status,
          errorMessage: result.ok ? null : result.error,
          requestId, ipHash: await hashIP(request)
        });
        if (!result.ok) {
          return html(`<h1>Sign-in failed</h1><p>${escapeHtml(result.error)}</p><p><a href="/app/login">Back to login</a></p>`, result.status);
        }
        return redirect("/app/overview", { "Set-Cookie": result.cookie });
      }

      if (method === "POST" && path === "/api/customer/logout") {
        const result = await customerAuth.logout(request, env);
        return json({ success: true }, 200, { "Set-Cookie": result.cookie });
      }

      if (method === "POST" && path === "/api/customer/password/forgot") {
        const body = await request.json().catch(() => ({}));
        // Response is identical whether or not the email exists —
        // requestPasswordReset() never reveals that to the caller.
        // Email-bombing guard: per-IP cap, and a per-address cap so one
        // victim's inbox can't be flooded from many IPs. Over-limit requests
        // get the SAME generic response (no oracle) but send nothing.
        const addr = String(body.email || "").trim().toLowerCase();
        const ipOk = await customerAuth.throttle(env, request, "customer_forgot", 5);
        const recentForAddr = await env.LUMMET_DB.prepare(
          `SELECT COUNT(*) n FROM email_outbox WHERE to_email = ? AND template = 'password_reset' AND created_at >= datetime('now','-1 hour')`
        ).bind(addr).first();
        if (!ipOk || recentForAddr.n >= 3) return json({ success: true });
        const reset = await customerAuth.requestPasswordReset(env, body.email);
        if (reset.sent) {
          const q = await queueEmail(env, {
            to: String(body.email).trim().toLowerCase(), template: "password_reset",
            vars: { link: portalLink(env, "/app/reset-password", { uid: reset.userId, token: reset.token }) }
          });
          if (q.ok) ctx.waitUntil(flushOutbox(env, { fetchImpl: typeof env.EMAIL_FETCH === "function" ? env.EMAIL_FETCH : fetch }).catch(() => {}));
        }
        return json({ success: true });
      }

      if (method === "POST" && path === "/api/customer/password/reset") {
        const body = await request.json().catch(() => ({}));
        const result = await customerAuth.resetPassword(env, body.userId, body.token, body.newPassword);
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true });
      }

      if (method === "POST" && path === "/api/customer/email/verify") {
        const body = await request.json().catch(() => ({}));
        const result = await customerAuth.verifyEmail(env, body.userId, body.token);
        if (!result.ok) return json({ success: false, error: result.error }, result.status);
        return json({ success: true });
      }

      if (method === "POST") {
        const acceptParams = matchPath("/api/invitations/:token/accept", path);
        if (acceptParams) {
          const { customer: invitedCustomer, policy: invitedPolicy } = await customerAuth.getCustomerSession(request, env);
          if (!invitedCustomer) return json({ success: false, error: "unauthorized" }, 401);
          const invitedDenied = orgPolicyDenied(invitedPolicy);
          if (invitedDenied) return invitedDenied;

          if (!(await customerAuth.throttle(env, request, "invitation_accept", 10))) return json({ success: false, error: "too_many_attempts" }, 429);
          const result = await organizations.acceptInvitation(env, acceptParams.token, invitedCustomer.id);
          const inviteIpHash = await hashIP(request);
          await logAudit(env, {
            actorType: "customer_user", customerUserId: invitedCustomer.id,
            organizationId: result.ok ? result.organizationId : null,
            endpoint: path, method, resource: "organization_invitation", action: "accept",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash: inviteIpHash
          });
          if (result.ok && result.seatLimitShadow) await logAudit(env, {
            actorType: "customer_user", customerUserId: invitedCustomer.id, organizationId: result.organizationId,
            endpoint: path, method, resource: "billing_gate", action: "seat_limit_shadow", success: true,
            statusCode: 200, errorMessage: result.seatLimitShadow.reason, requestId, ipHash: inviteIpHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, organizationId: result.organizationId });
        }
      }

      // ---------------------------------------------
      // Personal data rights (roadmap 1.3): export and erase my own account.
      // ---------------------------------------------
      if (path === "/api/customer/account/export" || path === "/api/customer/account/delete") {
        const { customer: acctCustomer, policy: acctPolicy } = await customerAuth.getCustomerSession(request, env);
        if (!acctCustomer) return json({ success: false, error: "unauthorized" }, 401);
        const acctDenied = orgPolicyDenied(acctPolicy);
        if (acctDenied) return acctDenied;
        const acctIpHash = await hashIP(request);

        if (method === "GET" && path === "/api/customer/account/export") {
          const data = await erasure.exportUserData(env, acctCustomer.id);
          await logAudit(env, {
            actorType: "customer_user", customerUserId: acctCustomer.id, endpoint: path, method,
            resource: "customer_user", resourceId: acctCustomer.id, action: "export", success: true, statusCode: 200, requestId, ipHash: acctIpHash
          });
          return new Response(JSON.stringify(data, null, 2), { status: 200, headers: { "Content-Type": "application/json", "Content-Disposition": 'attachment; filename="my-lummet-data.json"', "Cache-Control": "no-store" } });
        }

        if (method === "POST" && path === "/api/customer/account/delete") {
          const body = await request.json().catch(() => ({}));
          const result = await erasure.requestUserErasure(env, acctCustomer.id, { password: body.password, confirmEmail: body.confirmEmail });
          await logAudit(env, {
            actorType: "customer_user", customerUserId: acctCustomer.id, endpoint: path, method,
            resource: "customer_user", resourceId: acctCustomer.id, action: "erase",
            success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error, requestId, ipHash: acctIpHash
          });
          if (!result.ok) return json({ success: false, error: result.error, organizations: result.organizations }, result.status);
          return json({ success: true }, 200, { "Set-Cookie": (await customerAuth.logout(request, env)).cookie });
        }
        return json({ success: false, error: "method_not_allowed" }, 405);
      }

      // ---------------------------------------------
      // Two-factor authentication (Phase 7 — master prompt
      // section 40). User-scoped, not organization-scoped —
      // requires a valid customer session but no org membership
      // check, since it's a property of the account itself.
      // ---------------------------------------------

      if (path.startsWith("/api/customer/2fa/")) {
        // Round 6.4A: deliberately NOT refused for a session an organization policy restricts. These routes are the only way out of it.
        const { customer: mfaCustomer } = await customerAuth.getCustomerSession(request, env);
        if (!mfaCustomer) return json({ success: false, error: "unauthorized" }, 401);
        const mfaIpHash = await hashIP(request);

        if (method === "GET" && path === "/api/customer/2fa/status") {
          return json({ success: true, data: await totp.getTotpStatus(env, mfaCustomer.id) });
        }

        if (method === "POST" && path === "/api/customer/2fa/setup") {
          const result = await totp.startTotpSetup(env, mfaCustomer.id);
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          // Secret shown once — same pattern as every other
          // generated secret in this codebase.
          return json({ success: true, secret: result.secret, otpauthUrl: result.otpauthUrl });
        }

        if (method === "POST" && path === "/api/customer/2fa/confirm") {
          const body = await request.json().catch(() => ({}));
          const result = await totp.confirmTotpSetup(env, mfaCustomer.id, body.code);
          await logAudit(env, {
            actorType: "customer_user", customerUserId: mfaCustomer.id,
            endpoint: path, method, resource: "customer_totp", action: "enable",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash: mfaIpHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, backupCodes: result.backupCodes });
        }

        if (method === "POST" && path === "/api/customer/2fa/disable") {
          const body = await request.json().catch(() => ({}));
          const result = await totp.disableTotp(env, mfaCustomer.id, { code: body.code, backupCode: body.backupCode });
          await logAudit(env, {
            actorType: "customer_user", customerUserId: mfaCustomer.id,
            endpoint: path, method, resource: "customer_totp", action: "disable",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash: mfaIpHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true });
        }

        return json({ success: false, error: "not_found" }, 404);
      }

      // ---------------------------------------------
      // WebAuthn/passkey management (Phase 7). Requires a
      // customer session — registering a NEW credential for
      // yourself, or removing one. The unauthenticated login
      // ceremony routes are above, near /api/customer/login.
      // ---------------------------------------------

      if (path.startsWith("/api/customer/webauthn/")) {
        const { customer: webauthnCustomer, policy: webauthnPolicy } = await customerAuth.getCustomerSession(request, env);
        if (!webauthnCustomer) return json({ success: false, error: "unauthorized" }, 401);
        const webauthnDenied = orgPolicyDenied(webauthnPolicy);
        if (webauthnDenied) return webauthnDenied;
        const webauthnIpHash = await hashIP(request);

        if (method === "GET" && path === "/api/customer/webauthn/credentials") {
          return json({ success: true, data: await webauthn.listCredentials(env, webauthnCustomer.id) });
        }

        if (method === "POST" && path === "/api/customer/webauthn/register/options") {
          const result = await webauthn.generateRegistrationOptions(env, webauthnCustomer.id);
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, options: result.options });
        }

        if (method === "POST" && path === "/api/customer/webauthn/register/verify") {
          const body = await request.json().catch(() => ({}));
          const result = await webauthn.verifyRegistration(env, webauthnCustomer.id, body.credential, body.nickname);
          await logAudit(env, {
            actorType: "customer_user", customerUserId: webauthnCustomer.id,
            endpoint: path, method, resource: "webauthn_credential", action: "register",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash: webauthnIpHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, credentialId: result.credentialId });
        }

        const webauthnDeleteMatch = path.match(/^\/api\/customer\/webauthn\/credentials\/([^/]+)$/);
        if (method === "DELETE" && webauthnDeleteMatch) {
          const [, credentialRowId] = webauthnDeleteMatch;
          const result = await webauthn.deleteCredential(env, webauthnCustomer.id, credentialRowId);
          await logAudit(env, {
            actorType: "customer_user", customerUserId: webauthnCustomer.id,
            endpoint: path, method, resource: "webauthn_credential", resourceId: credentialRowId, action: "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash: webauthnIpHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true });
        }

        return json({ success: false, error: "not_found" }, 404);
      }

      // Everything from here down under /api/organizations,
      // /api/sites, and /api/products requires a valid customer
      // session — never a Lummet admin session (rule: never mix
      // staff and customer identity, master prompt section 6).
      if (path.startsWith("/api/organizations") || path.startsWith("/api/sites") || path === "/api/products") {
        const { customer, policy: customerPolicy } = await customerAuth.getCustomerSession(request, env);
        if (!customer) return json({ success: false, error: "unauthorized" }, 401);
        const customerDenied = orgPolicyDenied(customerPolicy);
        if (customerDenied) return customerDenied;
        const customerIpHash = await hashIP(request);

        /** Loads this customer's membership on organizationId and enforces a minimum role. */
        async function requireOrgRole(organizationId, minRole) {
          const membership = await organizations.getMembership(env, organizationId, customer.id);
          if (!membership || !roleAtLeast(membership.role, minRole)) {
            return json({ success: false, error: "forbidden" }, 403);
          }
          return null;
        }

        if (method === "GET" && path === "/api/organizations") {
          const orgs = await organizations.listOrganizationsForUser(env, customer.id);
          return json({ success: true, data: orgs });
        }

        if (method === "POST" && path === "/api/organizations") {
          const body = await request.json().catch(() => ({}));
          const result = await organizations.createOrganization(env, { name: body.name, ownerUserId: customer.id });
          await logAudit(env, {
            actorType: "customer_user", customerUserId: customer.id,
            organizationId: result.ok ? result.organizationId : null,
            endpoint: path, method, resource: "organization", action: "create",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, organizationId: result.organizationId });
        }

        if (method === "GET" && path === "/api/products") {
          return json({ success: true, data: await plans.listProducts(env) });
        }

        // Everything below takes an :id path segment. Handled with a
        // single regex rather than repeated matchPath() calls, since
        // most of these sub-resources have variable-depth suffixes
        // (e.g. "/members/:userId/role") that matchPath's fixed
        // segment-count matching doesn't fit.
        const orgMatch = path.match(/^\/api\/organizations\/([^/]+)(\/.*)?$/);
        const siteMatch = !orgMatch ? path.match(/^\/api\/sites\/([^/]+)$/) : null;

        if (orgMatch) {
          const organizationId = orgMatch[1];
          const subPath = orgMatch[2] || "";

          // Every route below requires SOME membership; specific
          // actions additionally call requireOrgRole() for a minimum
          // role above viewer.
          const membership = await organizations.getMembership(env, organizationId, customer.id);
          if (!membership) return json({ success: false, error: "forbidden" }, 403);

          // Round 6.4C: this organization's IP allowlist, for EVERY route below (including sessions, which stay available to people on an allowed
          // address only). Dark while ORG_IP_ALLOWLIST=off. Account-level routes (sign-in, 2FA setup, logout) are not organization routes and are unaffected.
          const ipDenied = await orgIpDenied(env, request, organizationId);
          if (ipDenied) return ipDenied;

          // Round 6.4B: organization sessions (list, revoke). Dark (404) while CUSTOMER_SESSION_ADMIN=off. Placed BEFORE the suspension and billing
          // write gates on purpose: ending someone's access is a containment action that must keep working when an organization is suspended
          // or past due. The service does its own role gate (admin or owner), org scoping, reason check and audit.
          if (subPath === "/sessions" && method === "GET") {
            const q = new URL(request.url).searchParams;
            const listed = await customerSessions.listSessions(env, { organizationId, actorUserId: customer.id, actorSessionId: customer.sessionId, limit: q.get("limit"), cursor: q.get("cursor") });
            if (!listed.ok) return json({ success: false, error: listed.error }, listed.status);
            return json({ success: true, data: listed.data, nextCursor: listed.nextCursor });
          }
          if (subPath === "/sessions/revoke" && method === "POST") {
            const body = await request.json().catch(() => ({}));
            const revoked = await customerSessions.revokeSessions(env, {
              organizationId, actorUserId: customer.id, actorSessionId: customer.sessionId, handle: body.handle, userId: body.userId, reason: body.reason,
              requestId, ipHash: customerIpHash, endpoint: path, method
            });
            if (!revoked.ok) return json({ success: false, error: revoked.error }, revoked.status);
            return json({ success: true, revoked: revoked.revoked, ...(revoked.shadow ? { shadow: true, wouldRevoke: revoked.wouldRevoke } : {}) });
          }

          // Staff-suspended or closed organizations become read-only: every
          // mutation is refused (a suspended org can still log in, look at
          // its data, and switch org, so support can talk to the customer) —
          // except the two actions that exist specifically to get OUT of
          // that state: reactivating, and cancelling a scheduled deletion.
          const SUSPENSION_GATE_EXEMPT = new Set(["/switch", "/reactivate", "/cancel-deletion", "/request-deletion"]);
          if (method !== "GET" && !SUSPENSION_GATE_EXEMPT.has(subPath)) {
            const orgRow = await organizations.getOrganization(env, organizationId);
            if (!orgRow || orgRow.status !== "active") {
              return json({ success: false, error: "organization_suspended" }, 403);
            }
            // Billing write gate (Phase 1.4): off = inert, shadow = log what would be refused, enforce = refuse.
            const gate = await evaluateWriteGate(env, { organizationId, method, subPath, now: effectiveNow(env, request) });
            if (gate.blocked) return json({ success: false, ...refusalFor(gate.access) }, 402);
          }

          if (method === "POST" && subPath === "/switch") {
            await customerAuth.setActiveOrganization(env, customer.sessionId, organizationId);
            return json({ success: true });
          }

          if (method === "GET" && subPath === "/members") {
            return json({ success: true, data: await organizations.listMembers(env, organizationId) });
          }

          // Round 6.4C: IP allowlist and SSO requirement stub. Owner only for changes; the service audits every change and refusal.
          if (subPath === "/ip-allowlist" && (method === "GET" || method === "PUT")) {
            if (method === "GET") {
              const read = await orgSecurityPolicy.readIpAllowlist(env, { organizationId, actorUserId: customer.id });
              if (!read.ok) return json({ success: false, error: read.error }, read.status);
              return json({ success: true, data: read.data, enforcement: read.enforcement });
            }
            const body = await request.json().catch(() => ({}));
            const changed = await orgSecurityPolicy.setIpAllowlist(env, {
              organizationId, actorUserId: customer.id, ipAllowlist: body.ipAllowlist, reason: body.reason,
              request, requestId, ipHash: customerIpHash, endpoint: path, method
            });
            if (!changed.ok) return json({ success: false, error: changed.error }, changed.status);
            return json({ success: true, changed: changed.changed, data: changed.data, enforcement: changed.enforcement });
          }
          if (subPath === "/sso-requirement" && method === "PUT") {
            const body = await request.json().catch(() => ({}));
            const changed = await orgSecurityPolicy.setRequireSso(env, {
              organizationId, actorUserId: customer.id, requireSso: body.requireSso, reason: body.reason,
              requestId, ipHash: customerIpHash, endpoint: path, method
            });
            if (!changed.ok) return json({ success: false, error: changed.error }, changed.status);
            return json({ success: true, changed: changed.changed, data: changed.policy, enforced: changed.enforced, status: changed.status });
          }

          // Round 6.4A: organization security policy (org-wide 2FA). Dark (404) while ORG_SECURITY_POLICY=off. Reading needs membership;
          // changing it is owner only, needs a written reason, and is audited by the service whether it succeeds or is refused.
          if (subPath === "/security-policy" && (method === "GET" || method === "PUT")) {
            if (method === "GET") {
              const read = await orgSecurityPolicy.readPolicy(env, { organizationId, actorUserId: customer.id });
              if (!read.ok) return json({ success: false, error: read.error }, read.status);
              return json({ success: true, data: read.policy, enforcement: read.enforcement });
            }
            const body = await request.json().catch(() => ({}));
            const changed = await orgSecurityPolicy.setRequire2fa(env, {
              organizationId, actorUserId: customer.id, require2fa: body.require2fa, reason: body.reason,
              requestId, ipHash: customerIpHash, endpoint: path, method
            });
            if (!changed.ok) return json({ success: false, error: changed.error }, changed.status);
            return json({ success: true, changed: changed.changed, data: changed.policy, enforcement: changed.enforcement, membersWithout2fa: changed.membersWithout2fa });
          }

          // Organization lifecycle (master prompt section 7, roadmap 1.2):
          // transfer ownership, deactivate/reactivate, request/cancel a
          // scheduled deletion. All owner-only, all audited, and none of
          // this bypasses the organization-suspended read-only gate above
          // for anything except these specific self-service actions the
          // owner needs even while closed (reactivate, cancel deletion).
          if (method === "POST" && subPath === "/transfer-ownership") {
            const guard = await requireOrgRole(organizationId, "owner");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const result = await organizations.transferOwnership(env, organizationId, { fromUserId: customer.id, toUserId: String(body.toUserId || "") });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization", resourceId: organizationId, action: "transfer_ownership",
              success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error,
              requestId, ipHash: customerIpHash
            });
            return result.ok ? json({ success: true }) : json({ success: false, error: result.error }, result.status);
          }

          if (method === "POST" && (subPath === "/deactivate" || subPath === "/reactivate" || subPath === "/request-deletion" || subPath === "/cancel-deletion")) {
            const membership = await organizations.getMembership(env, organizationId, customer.id);
            if (!membership || membership.role !== "owner") return json({ success: false, error: "forbidden" }, 403);
            const action = subPath.slice(1).replace("-", "_");
            const result = await (
              subPath === "/deactivate" ? organizations.deactivateOrganization(env, organizationId, customer.id) :
              subPath === "/reactivate" ? organizations.reactivateOrganization(env, organizationId, customer.id) :
              subPath === "/request-deletion" ? organizations.requestDeletion(env, organizationId, customer.id, { billingService: billing, deleteNow: (await request.clone().json().catch(() => ({}))).deleteNow === true }) :
              organizations.cancelScheduledDeletion(env, organizationId, customer.id, { billingService: billing })
            );
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization", resourceId: organizationId, action,
              success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error,
              requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, scheduledDeletionAt: result.scheduledDeletionAt, alreadyScheduled: result.alreadyScheduled || false, billingEndsAt: result.billingEndsAt || null, billingCancelQueued: !!result.billingCancelQueued });
          }

          if (method === "GET" && subPath === "/invitations") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            return json({ success: true, data: await organizations.listPendingInvitations(env, organizationId) });
          }

          if (method === "POST" && subPath === "/invitations") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            if (!(await customerAuth.throttle(env, request, "organization_invitation", 10))) return json({ success: false, error: "too_many_attempts" }, 429);

            const body = await request.json().catch(() => ({}));
            const result = await organizations.createInvitation(env, {
              organizationId, email: body.email, role: body.role, invitedBy: customer.id
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization_invitation", action: "create",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (result.ok && result.seatLimitShadow) await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId, endpoint: path, method,
              resource: "billing_gate", resourceId: result.invitationId, action: "seat_limit_shadow",
              success: true, statusCode: 200, errorMessage: result.seatLimitShadow.reason, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error, ...(result.error === "seat_limit_reached" ? { message: result.message, limit: result.limit, used: result.used } : {}) }, result.status);
            const org = await organizations.getOrganization(env, organizationId).catch(() => null);
            const invQueued = await queueEmail(env, {
              to: String(body.email).trim().toLowerCase(), template: "invitation", organizationId,
              vars: { link: portalLink(env, "/app/invitation", { token: result.token }), organizationName: (org && org.name) || "an organization", role: body.role }
            });
            if (invQueued.ok) ctx.waitUntil(flushOutbox(env, { fetchImpl: typeof env.EMAIL_FETCH === "function" ? env.EMAIL_FETCH : fetch }).catch(() => {}));
            // Token is only returned when email delivery is not configured,
            // so the inviter can share the link manually; otherwise it goes
            // only to the invitee's inbox.
            return json({ success: true, invitationId: result.invitationId, emailQueued: !!invQueued.ok, ...(emailConfigured(env) ? {} : { token: result.token }) });
          }

          const roleMatch = subPath.match(/^\/members\/([^/]+)\/role$/);
          if (method === "POST" && roleMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const targetUserId = roleMatch[1];
            const body = await request.json().catch(() => ({}));
            const result = await organizations.updateMemberRole(env, organizationId, targetUserId, body.role);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization_user", resourceId: targetUserId, action: "update_role",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true });
          }

          const removeMatch = subPath.match(/^\/members\/([^/]+)$/);
          if (method === "DELETE" && removeMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const targetUserId = removeMatch[1];
            const result = await organizations.removeMember(env, organizationId, targetUserId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization_user", resourceId: targetUserId, action: "remove",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true });
          }

          if (method === "GET" && subPath === "/entitlements") {
            return json({ success: true, data: await entitlementsService.resolveForOrganization(env, organizationId) });
          }

          if (method === "GET" && subPath === "/usage") {
            return json({ success: true, data: { ...(await getUsageSnapshot(env, organizationId)), monthly: await getMonthlyUsage(env, organizationId), aiCredits: await getAiBalance(env, organizationId), aiLimit: await checkUsageLimit(env, organizationId, "ai_credits") } });
          }

          // AI credits + gateway (master prompt section 16)
          if (method === "GET" && subPath === "/ai/credits") {
            return json({ success: true, data: { balance: await getAiBalance(env, organizationId), tasks: Object.fromEntries(Object.entries(AI_TASKS).map(([k, v]) => [k, v.credits])) } });
          }
          if (method === "GET" && subPath === "/ai/ledger") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            return json({ success: true, data: await listAiLedger(env, organizationId) });
          }
          if (method === "POST" && subPath === "/ai/run") {
            const guard = await requireOrgRole(organizationId, "editor");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            let aiSiteId = null;
            if (body.siteId) {
              const aiSite = await sites.getSite(env, String(body.siteId));
              if (!aiSite || aiSite.organization_id !== organizationId) return json({ success: false, error: "site_not_found" }, 404);
              aiSiteId = aiSite.id;
            }
            const result = await runAiTask(env, { organizationId, siteId: aiSiteId, userId: customer.id, task: body.task, input: body.input || {}, provider: workersAiProvider(env) });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "ai_task", resourceId: body.task, action: "run",
              success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error,
              requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, text: result.text, creditsCharged: result.creditsCharged });
          }

          // Backups (master prompt section 23) — admin+, plan-gated, org-scoped
          if (subPath === "/backups" || subPath.startsWith("/backups/")) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const bAudit = async (action, resourceId, result) => {
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "site_backup", resourceId, action,
                success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
            };
            if (method === "GET" && subPath === "/backups") {
              return json({ success: true, data: await backups.listBackups(env, organizationId, url.searchParams.get("siteId")) });
            }
            if (method === "POST" && subPath === "/backups") {
              if (!(await entitlementsService.requireEntitlement(env, organizationId, "backups.enabled"))) return json({ success: false, error: "backups_not_enabled" }, 403);
              const b = await request.json().catch(() => ({}));
              const r = await backups.createBackup(env, { organizationId, siteId: String(b.siteId || ""), createdBy: customer.id });
              await bAudit("create", r.backupId || b.siteId, r);
              if (!r.ok) return json({ success: false, error: r.error }, r.status);
              await recordUsage(env, { organizationId, siteId: b.siteId, userId: customer.id, metric: "backups", quantity: 1, idempotencyKey: `backup:${r.backupId}` });
              return json({ success: true, backupId: r.backupId, status: r.status, sizeBytes: r.sizeBytes, resources: r.resources });
            }
            const one = subPath.match(/^\/backups\/([^/]+)(\/verify|\/download|\/restore)?$/);
            if (one) {
              const backupId = one[1], action = one[2];
              if (method === "POST" && action === "/verify") { const r = await backups.verifyBackup(env, organizationId, backupId); await bAudit("verify", backupId, r); return r.ok ? json({ success: true }) : json({ success: false, error: r.error }, r.status); }
              if (method === "GET" && action === "/download") {
                const r = await backups.downloadBackup(env, organizationId, backupId);
                await bAudit("download", backupId, r);
                if (!r.ok) return json({ success: false, error: r.error }, r.status);
                return new Response(r.body, { status: 200, headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="${r.filename}"`, "Cache-Control": "no-store" } });
              }
              if (method === "POST" && action === "/restore") {
                const ownerGuard = await requireOrgRole(organizationId, "owner");
                if (ownerGuard) return ownerGuard;
                if (!(await entitlementsService.requireEntitlement(env, organizationId, "backups.enabled"))) return json({ success: false, error: "backups_not_enabled" }, 403);
                const b = await request.json().catch(() => ({}));
                const r = await backups.restoreBackup(env, { organizationId, backupId, targetSiteId: String(b.targetSiteId || ""), requestedBy: customer.id });
                await bAudit("restore", backupId, r);
                return r.ok ? json({ success: true, restoreId: r.restoreId, status: r.status, result: r.result }) : json({ success: false, error: r.error }, r.status);
              }
            }
          }

          // Automations (master prompt section 29) — admin+, plan-gated
          if (subPath === "/automations" || subPath.startsWith("/automations/")) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const aAudit = async (action, resourceId, result) => logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "automation_rule", resourceId, action,
              success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (method === "GET" && subPath === "/automations") return json({ success: true, data: await automations.listRules(env, organizationId), triggers: automations.TRIGGER_EVENTS, actions: Object.keys(automations.ACTIONS) });
            if (method === "GET" && subPath === "/automations/runs") return json({ success: true, data: await automations.listRuns(env, organizationId) });
            if (method === "POST" && subPath === "/automations") {
              const b = await request.json().catch(() => ({}));
              const r = await automations.createRule(env, organizationId, b, customer.id);
              await aAudit("create", r.ruleId || null, r);
              return r.ok ? json({ success: true, ruleId: r.ruleId }) : json({ success: false, error: r.error }, r.status);
            }
            const rule = subPath.match(/^\/automations\/([^/]+)(\/pause|\/resume)?$/);
            if (rule && method === "POST" && rule[2]) {
              const r = await automations.setRuleStatus(env, organizationId, rule[1], rule[2] === "/pause" ? "paused" : "active");
              await aAudit(rule[2].slice(1), rule[1], r);
              return r.ok ? json({ success: true }) : json({ success: false, error: r.error }, r.status);
            }
            if (rule && method === "DELETE" && !rule[2]) {
              const r = await automations.deleteRule(env, organizationId, rule[1]);
              await aAudit("delete", rule[1], r);
              return r.ok ? json({ success: true }) : json({ success: false, error: r.error }, r.status);
            }
          }

          if (method === "POST" && subPath === "/trial") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            // CARD_REQUIRED_TRIAL=on: a trial starts only through Stripe Checkout, which collects the card up front.
            if (cardRequiredTrial(env)) {
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "subscription", action: "start_trial",
                success: false, statusCode: 409, errorMessage: "card_required_for_trial", requestId, ipHash: customerIpHash
              });
              return json({ success: false, error: "card_required_for_trial" }, 409);
            }

            const body = await request.json().catch(() => ({}));
            const result = await plans.startTrialSubscription(env, organizationId, body.planId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "subscription", action: "start_trial",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, subscriptionId: result.subscriptionId, trialEndsAt: result.trialEndsAt });
          }

          // -------------------------------------------
          // Billing (Phase 2). /checkout and /cancel/resume/
          // change-plan require admin+; /invoices is readable
          // by any member (viewers included — visibility into
          // what the org is being charged is not a write).
          // -------------------------------------------

          // Phase 5: usage history and commercial workflow APIs.
          if (method === "GET" && subPath === "/usage/snapshots") {
            // GET is read-only. Daily snapshots are written by the scheduled sweep.
            return json({ success: true, data: await commercial.listUsageSnapshots(env, organizationId) });
          }
          if (method === "GET" && subPath === "/billing/addons") {
            return json({ success: true, data: await commercial.listActiveAddons(env) });
          }
          if (method === "GET" && subPath === "/billing/credit-packs") {
            return json({ success: true, data: await commercial.listActiveCreditPacks(env) });
          }
          if (method === "POST" && subPath === "/billing/credit-packs/checkout") {
            const guard = await requireOrgRole(organizationId, "billing");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const portalOrigin = (env.PORTAL_BASE_URL || url.origin).replace(/\/$/, "");
            const result = await commercial.startCreditPackCheckout(env, organizationId, String(body.packId || ""), portalOrigin, String(body.idempotencyKey || ""));
            await logAudit(env, { actorType: "customer_user", customerUserId: customer.id, organizationId, endpoint: path, method, resource: "credit_pack_checkout", action: "create", success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash });
            return result.ok ? json({ success: true, checkoutUrl: result.checkoutUrl }) : json({ success: false, error: result.error }, result.status);
          }
          if (method === "POST" && subPath === "/billing/save-offer") {
            const guard = await requireOrgRole(organizationId, "admin"); if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const sub = await commercial.latestActiveSubscriptionId(env,organizationId);
            if (!sub) return json({success:false,error:'no_active_subscription'},409);
            const result = await commercial.beginSaveOffer(env,organizationId,sub.id,String(body.offerKey||''),body.detail);
            await logAudit(env,{actorType:'customer_user',customerUserId:customer.id,organizationId,endpoint:path,method,resource:'billing_save_offer',resourceId:result.offer?.id||null,action:'show',success:result.ok,statusCode:result.ok? 200:result.status||400,requestId,ipHash:customerIpHash});
            return result.ok ? json({success:true,data:result}) : json({success:false,error:result.error},result.status||400);
          }
          if (method === "POST" && subPath === "/billing/addons/change") {
            const guard = await requireOrgRole(organizationId, "admin"); if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const result = await commercial.changeAddon(env,organizationId,String(body.addonId||''),body.quantity,{requestKey:String(body.idempotencyKey||'')});
            await logAudit(env,{actorType:'customer_user',customerUserId:customer.id,organizationId,endpoint:path,method,resource:'subscription_addon',resourceId:body.addonId||null,action:'change',success:result.ok,statusCode:result.ok? 200:result.status||400,errorMessage:result.ok?null:result.error,requestId,ipHash:customerIpHash});
            return result.ok ? json({success:true,data:result}) : json({success:false,error:result.error},result.status||400);
          }
          if (method === "POST" && subPath === "/billing/save-offer/complete") {
            const guard = await requireOrgRole(organizationId, "admin"); if (guard) return guard;
            const body = await request.json().catch(() => ({})); const result=await commercial.completeSaveOffer(env,String(body.offerId||''),String(body.status||'accepted'));
            return result.ok ? json({success:true}) : json({success:false,error:result.error},result.status||400);
          }
          if (method === "POST" && subPath === "/billing/cancellation-feedback") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const result = await commercial.recordCancellationFeedback(env, {
              organizationId, subscriptionId: body.subscriptionId || null, reason: body.reason,
              detail: body.detail, offerShown: body.offerShown || null, offerAccepted: body.offerAccepted === true
            });
            await logAudit(env, { actorType: "customer_user", customerUserId: customer.id, organizationId, endpoint: path, method, resource: "cancellation_feedback", action: "create", success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash });
            return result.ok ? json({ success: true }) : json({ success: false, error: result.error }, result.status);
          }
          const quoteAcceptMatch = subPath.match(/^\/billing\/quotes\/([^/]+)\/accept$/);
          if (method === "POST" && quoteAcceptMatch) {
            const guard = await requireOrgRole(organizationId, "billing");
            if (guard) return guard;
            const result = await commercial.acceptQuote(env, quoteAcceptMatch[1], { organizationId, userId: customer.id });
            await logAudit(env, { actorType: "customer_user", customerUserId: customer.id, organizationId, endpoint: path, method, resource: "quote", resourceId: quoteAcceptMatch[1], action: "accept", success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash });
            return result.ok ? json({ success: true, data: result }) : json({ success: false, error: result.error }, result.status);
          }

          if (subPath === "/billing/profile" && method === "GET") {
            const guard = await requireOrgRole(organizationId, "billing");
            if (guard) return guard;
            return json({ success: true, data: await billing.getBillingProfile(env, organizationId) });
          }
          if (subPath === "/billing/profile" && method === "PUT") {
            const guard = await requireOrgRole(organizationId, "billing");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const result = await billing.updateBillingProfile(env, organizationId, body, { actorUserId: customer.id });
            await logAudit(env, { actorType: "customer_user", customerUserId: customer.id, organizationId, endpoint: path, method, resource: "billing_profile", action: "update", success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash });
            return result.ok ? json({ success: true, data: result.profile }) : json({ success: false, error: result.error }, result.status);
          }

          if (method === "POST" && subPath === "/billing/coupon/validate") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const checked = await billing.validateCoupon(env, organizationId, body.code);
            if (!checked.ok) return json({ success: false, error: checked.error }, 422);
            return json({ success: true, coupon: checked.summary });
          }

          if (method === "POST" && subPath === "/billing/checkout") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const body = await request.json().catch(() => ({}));
            // Security: Stripe sends the customer back to these URLs after paying, so they
            // are built here and any value in the request body is ignored. Otherwise a caller
            // could point the post-payment redirect at a look-alike site.
            const portalOrigin = (env.PORTAL_BASE_URL || url.origin).replace(/\/$/, "");
            const result = await billing.startCheckout(env, {
              organizationId, planId: body.planId,
              successUrl: `${portalOrigin}/app/billing?checkout=success`,
              cancelUrl: `${portalOrigin}/app/billing?checkout=canceled`,
              couponCode: body.couponCode
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "billing_checkout", action: "create",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            // The pricing-page choice has done its job once checkout exists; stop sending later logins back to it.
            if (cardRequiredTrial(env)) { try { await commercialRepo.clearCustomerSignupIntent(env, customer.id); } catch (_) {} }
            return json({ success: true, checkoutUrl: result.checkoutUrl });
          }

          if (method === "POST" && subPath === "/billing/portal") {
            const guard = await requireOrgRole(organizationId, "billing");
            if (guard) return guard;
            // Built server-side like checkout URLs: the return target is never taken from the request.
            const portalOrigin = (env.PORTAL_BASE_URL || url.origin).replace(/\/$/, "");
            const result = await billing.openBillingPortal(env, organizationId, { returnUrl: `${portalOrigin}/app/billing` });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "billing_portal", action: "open",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, portalUrl: result.portalUrl });
          }

          if (method === "POST" && subPath === "/billing/cancel") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const body = await request.json().catch(() => ({}));
            const result = await billing.cancelSubscription(env, organizationId, {
              atPeriodEnd: true, actorUserId: customer.id
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "subscription", action: "cancel",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, canceledImmediately: result.canceledImmediately });
          }

          if (method === "POST" && subPath === "/billing/pause") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const result = await billing.pauseSubscription(env, organizationId, { resumesAt: body.resumesAt, actorUserId: customer.id });
            await logAudit(env, { actorType: "customer_user", customerUserId: customer.id, organizationId, endpoint: path, method, resource: "subscription", action: "pause", success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash });
            return result.ok ? json({ success: true, resumesAt: result.resumesAt }) : json({ success: false, error: result.error }, result.status);
          }
          if (method === "POST" && subPath === "/billing/pause/resume") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const result = await billing.resumePausedSubscription(env, organizationId, { actorUserId: customer.id });
            await logAudit(env, { actorType: "customer_user", customerUserId: customer.id, organizationId, endpoint: path, method, resource: "subscription", action: "resume_pause", success: result.ok, statusCode: result.ok ? 200 : result.status, errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash });
            return result.ok ? json({ success: true }) : json({ success: false, error: result.error }, result.status);
          }

          if (method === "POST" && subPath === "/billing/resume") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const result = await billing.resumeSubscription(env, organizationId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "subscription", action: "resume",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true });
          }

          if (method === "POST" && subPath === "/billing/change-plan") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const body = await request.json().catch(() => ({}));
            const result = await billing.changePlan(env, organizationId, body.planId, { actorUserId: customer.id });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "subscription", action: "change_plan",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error, blockers: result.blockers || [] }, result.status);
            // pending: the change was sent to the provider and takes effect when its webhook confirms it (BILLING_ENFORCE=enforce).
            return json({ success: true, ...(result.pending ? { pending: true, intentId: result.intentId || null, direction: result.direction || null, scheduled: !!result.scheduled, effectiveAt: result.effectiveAt || null } : {}) });
          }

          if (method === "GET" && subPath === "/billing/invoices") {
            const guard = await requireOrgRole(organizationId, "billing");
            if (guard) return guard;
            return json({ success: true, data: await billing.listInvoices(env, organizationId) });
          }

          if (method === "GET" && subPath === "/sites") {
            return json({ success: true, data: await sites.listSitesForOrganization(env, organizationId) });
          }

          if (method === "POST" && subPath === "/sites") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            // Enforced here, not just left to the customer's own
            // judgment — "sites.max" is a real entitlement check
            // (master prompt section 12), not a UI-only limit.
            const maxSites = await entitlementsService.checkEntitlement(env, organizationId, "sites.max");
            const currentCount = await sites.countActiveSitesForOrganization(env, organizationId);
            if (typeof maxSites === "number" && currentCount >= maxSites) {
              return json({ success: false, error: "site_limit_reached", limit: maxSites }, 403);
            }

            const body = await request.json().catch(() => ({}));
            const result = await sites.createSite(env, {
              organizationId, name: body.name, productId: body.productId, actorUserId: customer.id
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "site", resourceId: result.ok ? result.siteId : null, action: "create",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, siteId: result.siteId, slug: result.slug });
          }

          // -------------------------------------------
          // Automated provisioning (Phase 3). Kicking off or
          // retrying a job returns immediately (202) — the job
          // itself runs via ctx.waitUntil(), not inline in this
          // request (master prompt section 17).
          // -------------------------------------------

          const provisionMatch = subPath.match(/^\/sites\/([^/]+)\/(provision|retry-provisioning)$/);
          if (method === "POST" && provisionMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const [, siteId, action] = provisionMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            const result =
              action === "provision"
                ? await provisioning.startProvisioning(env, siteId, { actorUserId: customer.id })
                : await provisioning.retryProvisioning(env, siteId, { actorUserId: customer.id });

            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "site", resourceId: siteId,
              action: action === "provision" ? "provisioning_start" : "provisioning_retry",
              success: result.ok, statusCode: result.ok ? 202 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);

            // Through the Queue when JOB_QUEUE is bound, otherwise ctx.waitUntil (job-runner.js). runJob()
            // records its own failure onto the job and moves the site to "failed"; the maintenance sweep
            // picks the job up again if this Worker is evicted or the step fails.
            await jobRunner.dispatchJob(env, ctx, result.jobId);

            return json({ success: true, jobId: result.jobId }, 202);
          }

          const jobsListMatch = subPath.match(/^\/sites\/([^/]+)\/jobs$/);
          if (method === "GET" && jobsListMatch) {
            const [, siteId] = jobsListMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }
            return json({ success: true, data: await jobsModule.listJobsForSite(env, siteId) });
          }

          // -------------------------------------------
          // Domains (Phase 4). List/add readable by any member;
          // verify/SSL/primary/remove require admin+.
          // -------------------------------------------

          const domainsListMatch = subPath.match(/^\/sites\/([^/]+)\/domains$/);
          if (domainsListMatch) {
            const [, siteId] = domainsListMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            if (method === "GET") {
              return json({ success: true, data: await domains.listDomainsForSite(env, siteId) });
            }

            if (method === "POST") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;

              const body = await request.json().catch(() => ({}));
              const result = await domains.addDomain(env, { siteId, hostname: body.hostname, actorUserId: customer.id });
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "domain", action: "create",
                success: result.ok, statusCode: result.ok ? 200 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error }, result.status);
              return json({ success: true, domainId: result.domainId, dnsInstructions: result.dnsInstructions });
            }
          }

          // -------------------------------------------
          // Custom domains by nameserver delegation (v1; docs/CUSTOM_DOMAINS.md). Reading is open to any member;
          // everything that changes DNS or routing needs admin+. Every call is scoped to this organization inside
          // the service (a zone of another organization answers 404).
          // -------------------------------------------
          const zonesListMatch = subPath.match(/^\/sites\/([^/]+)\/domain-zones$/);
          if (zonesListMatch) {
            const [, siteId] = zonesListMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) return json({ success: false, error: "not_found" }, 404);
            if (method === "GET") return json({ success: true, data: await zoneDomains.listForSite(env, siteId) });
            if (method === "POST") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              const body = await request.json().catch(() => ({}));
              const result = await zoneDomains.addZone(env, { siteId, domain: body.domain, actorUserId: customer.id, organizationId });
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "domain_zone", resourceId: result.ok ? result.zoneId : null, action: "create",
                success: result.ok, statusCode: result.ok ? 200 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error, ...(result.limit !== undefined ? { limit: result.limit } : {}) }, result.status);
              const { ok, ...data } = result;
              return json({ success: true, ...data }, 201);
            }
          }

          // Single subdomains (v1.1): inside an already-delegated zone of this site, or kept at the customer's own DNS
          // with a CNAME + TXT record. Same permissions and audit as the zone routes above.
          const subListMatch = subPath.match(/^\/sites\/([^/]+)\/subdomains$/);
          if (subListMatch) {
            const [, siteId] = subListMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) return json({ success: false, error: "not_found" }, 404);
            if (method === "GET") return json({ success: true, data: await zoneDomains.listSubdomainsForSite(env, siteId) });
            if (method === "POST") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              const body = await request.json().catch(() => ({}));
              const result = await zoneDomains.addSubdomain(env, { siteId, hostname: body.hostname, actorUserId: customer.id, organizationId, redeploy: makeDomainRedeploy(env, ctx) });
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "domain", resourceId: result.ok ? result.domainId : null, action: "create_subdomain",
                success: result.ok, statusCode: result.ok ? 201 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error, ...(result.limit !== undefined ? { limit: result.limit } : {}) }, result.status);
              const { ok, ...data } = result;
              return json({ success: true, ...data }, 201);
            }
          }

          const subCheckMatch = subPath.match(/^\/subdomains\/([^/]+)\/check$/);
          const subReadMatch = subPath.match(/^\/subdomains\/([^/]+)$/);
          if ((subCheckMatch && method === "POST") || (subReadMatch && method === "GET")) {
            const domainId = (subCheckMatch || subReadMatch)[1];
            if (subCheckMatch) {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
            }
            const result = subCheckMatch
              ? await zoneDomains.checkSubdomain(env, domainId, { manual: true, organizationId, redeploy: makeDomainRedeploy(env, ctx) })
              : await (async () => {
                  const row = await domains.getDomain(env, domainId);
                  const rowSite = row ? await sites.getSite(env, row.site_id) : null;
                  if (!row || row.method !== "cname" || !rowSite || rowSite.organization_id !== organizationId) return { ok: false, status: 404, error: "not_found" };
                  return { ok: true, ...(await zoneDomains.subdomainView(env, domainId)) };
                })();
            if (subCheckMatch) {
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "domain", resourceId: domainId, action: "check",
                success: result.ok, statusCode: result.ok ? 200 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
            }
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            const { ok, ...data } = result;
            return json({ success: true, ...data });
          }

          const zoneMatch = subPath.match(/^\/domain-zones\/([^/]+)(?:\/(check|records)(?:\/([^/]+))?)?$/);
          if (zoneMatch) {
            const [, zoneId, zoneAction, zoneSub] = zoneMatch;
            const isRead = method === "GET";
            if (!isRead) {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
            }
            const audit = async (action, result) => logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "domain_zone", resourceId: zoneId, action,
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            const done = (result) => {
              if (!result.ok) return json({ success: false, error: result.error }, result.status);
              const { ok, ...data } = result;
              return json({ success: true, ...data });
            };

            if (!zoneAction && isRead) {
              const detail = await zoneDomains.view(env, zoneId);
              const zoneSite = detail ? await sites.getSite(env, detail.zone.site_id) : null;
              if (!detail || !zoneSite || zoneSite.organization_id !== organizationId) return json({ success: false, error: "not_found" }, 404);
              return json({ success: true, ...detail });
            }
            if (!zoneAction && method === "DELETE") {
              const acknowledge = new URL(request.url).searchParams.get("acknowledge") === "1";
              const result = await zoneDomains.removeZone(env, zoneId, { organizationId, actorUserId: customer.id, acknowledgeOutage: acknowledge });
              await audit("remove", result);
              return done(result);
            }
            if (zoneAction === "check" && method === "POST" && !zoneSub) {
              const result = await zoneDomains.checkZone(env, zoneId, { manual: true, organizationId, redeploy: makeDomainRedeploy(env, ctx) });
              await audit("check", result);
              return done(result);
            }
            if (zoneAction === "records" && !zoneSub && isRead) return done(await zoneDomains.listRecords(env, zoneId, { organizationId }));
            if (zoneAction === "records" && !zoneSub && method === "POST") {
              const body = await request.json().catch(() => ({}));
              const result = await zoneDomains.addRecord(env, zoneId, body, { organizationId, actorUserId: customer.id });
              await audit("record_add", result);
              return done(result);
            }
            if (zoneAction === "records" && zoneSub === "import" && method === "POST") {
              const result = await zoneDomains.importScanned(env, zoneId, { organizationId, actorUserId: customer.id });
              await audit("record_import", result);
              return done(result);
            }
            if (zoneAction === "records" && zoneSub && zoneSub !== "import" && method === "DELETE") {
              const result = await zoneDomains.deleteRecord(env, zoneId, zoneSub, { organizationId, actorUserId: customer.id });
              await audit("record_remove", result);
              return done(result);
            }
          }

          const domainActionMatch = subPath.match(/^\/domains\/([^/]+)\/(verify|request-ssl|check-ssl|set-primary)$/);
          if (method === "POST" && domainActionMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const [, domainId, action] = domainActionMatch;
            const domainRow = await domains.getDomain(env, domainId);
            const domainSite = domainRow ? await sites.getSite(env, domainRow.site_id) : null;
            if (!domainRow || !domainSite || domainSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            let result;
            if (action === "verify") result = await domains.verifyDns(env, domainId);
            else if (action === "request-ssl") result = await domains.requestSsl(env, domainId);
            else if (action === "check-ssl") result = await domains.checkSsl(env, domainId);
            else result = await domains.setPrimary(env, domainRow.site_id, domainId);

            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "domain", resourceId: domainId, action,
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            const { ok, ...resultData } = result;
            return json({ success: true, ...resultData });
          }

          const domainDeleteMatch = subPath.match(/^\/domains\/([^/]+)$/);
          if (method === "DELETE" && domainDeleteMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const [, domainId] = domainDeleteMatch;
            const domainRow = await domains.getDomain(env, domainId);
            const domainSite = domainRow ? await sites.getSite(env, domainRow.site_id) : null;
            if (!domainRow || !domainSite || domainSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            const result = domainRow.method && domainRow.method !== "txt"
              ? await zoneDomains.removeAnyHostname(env, domainRow, { actorUserId: customer.id })
              : await domains.removeDomain(env, domainId, { actorUserId: customer.id });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "domain", resourceId: domainId, action: "remove",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true });
          }

          // -------------------------------------------
          // Deployments (Phase 4). Starting a deployment or a
          // rollback returns 202 immediately, same waitUntil()
          // pattern as provisioning above.
          // -------------------------------------------

          const deploymentsListMatch = subPath.match(/^\/sites\/([^/]+)\/deployments$/);
          if (deploymentsListMatch) {
            const [, siteId] = deploymentsListMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            if (method === "GET") {
              return json({ success: true, data: await deployments.listDeploymentsForSite(env, siteId) });
            }

            if (method === "POST") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;

              // Security: the deployed script and migrations come ONLY from the
              // platform's published release. Anything a customer puts in the
              // request body is ignored, otherwise a customer could run
              // arbitrary code in the shared tenant Worker.
              const release = await tenantTemplate.getCurrentRelease(env);
              if (!release.ok) return json({ success: false, error: release.error }, release.status || 409);
              const result = await deployments.startDeployment(env, {
                siteId, version: release.version, migrations: release.migrations, scriptContent: release.scriptContent, actorUserId: customer.id
              });
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "deployment", resourceId: result.ok ? result.deploymentId : null, action: "create",
                success: result.ok, statusCode: result.ok ? 202 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error }, result.status);

              await jobRunner.dispatchJob(env, ctx, result.jobId);

              return json({ success: true, deploymentId: result.deploymentId, jobId: result.jobId }, 202);
            }
          }

          // Customers can't supply script content, so "update" deploys
          // the currently published tenant template release (same
          // artifact auto-deploy uses at provisioning time).
          const deployLatestMatch = subPath.match(/^\/sites\/([^/]+)\/deployments\/latest$/);
          if (method === "POST" && deployLatestMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const [, siteId] = deployLatestMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }
            const release = await tenantTemplate.getCurrentRelease(env);
            if (!release.ok) return json({ success: false, error: release.error }, release.status || 409);
            const result = await deployments.startDeployment(env, {
              siteId, version: release.version, migrations: release.migrations, scriptContent: release.scriptContent, actorUserId: customer.id
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "deployment", resourceId: result.ok ? result.deploymentId : null, action: "create",
              success: result.ok, statusCode: result.ok ? 202 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            await jobRunner.dispatchJob(env, ctx, result.jobId);
            return json({ success: true, deploymentId: result.deploymentId, jobId: result.jobId }, 202);
          }

          const rollbackMatch = subPath.match(/^\/sites\/([^/]+)\/deployments\/([^/]+)\/rollback$/);
          if (method === "POST" && rollbackMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const [, siteId, targetDeploymentId] = rollbackMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            // Security: scripts are never accepted from the customer; only the
            // stored release for the target deployment's version is used.
            let rollbackScript = null;
            const targetDeployment = await deployments.getDeployment(env, targetDeploymentId);
            if (!targetDeployment || targetDeployment.site_id !== siteId) {
              return json({ success: false, error: "target_deployment_not_found" }, 404);
            }
            const stored = await tenantTemplate.getReleaseByVersion(env, targetDeployment.version);
            if (stored.ok) rollbackScript = stored.scriptContent;
            if (!rollbackScript) return json({ success: false, error: "release_unavailable" }, 409);
            const result = await deployments.rollbackDeployment(env, {
              siteId, targetDeploymentId, scriptContent: rollbackScript, actorUserId: customer.id
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "deployment", resourceId: result.ok ? result.deploymentId : null, action: "rollback",
              success: result.ok, statusCode: result.ok ? 202 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);

            await jobRunner.dispatchJob(env, ctx, result.jobId);

            return json({ success: true, deploymentId: result.deploymentId, jobId: result.jobId }, 202);
          }

          // -------------------------------------------
          // Tenant portal data (Phase 5): analytics, reports,
          // campaigns, alerts — proxied from the site's own
          // tenant Super API (client.js), entitlement-gated by
          // tenant-portal.js. Read endpoints: any member. Run
          // report / acknowledge alert / create campaign:
          // analyst+/editor+ (operational actions, not full
          // site administration).
          // -------------------------------------------

          const siteSubResourceMatch = subPath.match(
            /^\/sites\/([^/]+)\/(analytics\/overview|analytics\/revenue|analytics\/tracking-health|reports|campaigns|alerts)$/
          );
          if (method === "GET" && siteSubResourceMatch) {
            const [, siteId, resource] = siteSubResourceMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            const params = new URL(request.url).searchParams;
            let result;
            if (resource === "analytics/overview") {
              result = await tenantPortal.getAnalyticsOverview(env, targetSite, {
                startDate: params.get("start_date"), endDate: params.get("end_date"),
                dimensionType: params.get("dimension_type"), currency: params.get("currency")
              });
            } else if (resource === "analytics/revenue") {
              result = await tenantPortal.getAnalyticsRevenue(env, targetSite, {
                startDate: params.get("start_date"), endDate: params.get("end_date"), currency: params.get("currency")
              });
            } else if (resource === "analytics/tracking-health") {
              result = await tenantPortal.getTrackingHealth(env, targetSite);
            } else if (resource === "reports") {
              result = await tenantPortal.listReports(env, targetSite);
            } else if (resource === "campaigns") {
              result = await tenantPortal.listCampaigns(env, targetSite);
            } else {
              result = await tenantPortal.listAlerts(env, targetSite);
            }

            if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status);
            return json(result.data);
          }

          const createCampaignMatch = subPath.match(/^\/sites\/([^/]+)\/campaigns$/);
          if (method === "POST" && createCampaignMatch) {
            const guard = await requireOrgRole(organizationId, "editor");
            if (guard) return guard;

            const [, siteId] = createCampaignMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            const body = await request.json().catch(() => ({}));
            const result = await tenantPortal.createCampaign(env, targetSite, body);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "campaign", action: "create",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.message, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status);
            return json(result.data);
          }

          // Set (or reset) the password of the caller's OWN login to a live site's dashboard. Admin and above.
          // The password travels in this request body only: it is never stored, logged or put in the audit row.
          const dashAdminMatch = subPath.match(/^\/sites\/([^/]+)\/dashboard-admin$/);
          if (method === "POST" && dashAdminMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            if (!(await customerAuth.throttle(env, request, "dashboard_admin_password", 10))) {
              return json({ success: false, error: "rate_limited" }, 429);
            }
            const body = await request.json().catch(() => ({}));
            const result = await tenantAdmin.setDashboardPassword(env, {
              siteId: dashAdminMatch[1], organizationId, email: customer.email, password: body.password
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "site_dashboard_admin", resourceId: dashAdminMatch[1], action: "set_password",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : (result.detail || result.error), requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, email: result.email });
          }

          // Switch off tracking links of a live site (editor and above). Reversible on the site's own dashboard.
          const disableLinksMatch = subPath.match(/^\/sites\/([^/]+)\/tracking-links\/disable$/);
          if (method === "POST" && disableLinksMatch) {
            const guard = await requireOrgRole(organizationId, "editor");
            if (guard) return guard;
            const body = await request.json().catch(() => ({}));
            const result = await tenantLinks.disableTrackingLinks(env, { organizationId, siteId: disableLinksMatch[1], ids: body.ids });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "tracking_link", resourceId: disableLinksMatch[1],
              action: `disable:${result.ok ? result.disabled + "/" + result.results.length : (Array.isArray(body.ids) ? body.ids.length : 0)}`,
              success: result.ok && result.failed === 0, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? (result.failed ? `${result.failed} failed` : null) : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, results: result.results, disabled: result.disabled, failed: result.failed });
          }

          const runReportMatch = subPath.match(/^\/sites\/([^/]+)\/reports\/([^/]+)\/run$/);
          if (method === "POST" && runReportMatch) {
            const guard = await requireOrgRole(organizationId, "analyst");
            if (guard) return guard;

            const [, siteId, reportId] = runReportMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            const result = await tenantPortal.runReport(env, targetSite, reportId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "report", resourceId: reportId, action: "run",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.message, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status);
            return json(result.data);
          }

          const ackAlertMatch = subPath.match(/^\/sites\/([^/]+)\/alerts\/([^/]+)\/acknowledge$/);
          if (method === "POST" && ackAlertMatch) {
            const guard = await requireOrgRole(organizationId, "analyst");
            if (guard) return guard;

            const [, siteId, alertId] = ackAlertMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }

            const result = await tenantPortal.acknowledgeAlert(env, targetSite, alertId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "alert", resourceId: alertId, action: "acknowledge",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.message, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status);
            return json(result.data);
          }

          // -------------------------------------------
          // Developer platform (Phase 6): API keys, webhooks,
          // search, export. Key/webhook management is admin+
          // (these are credentials); search is any member;
          // export is admin+ (contains member emails).
          // -------------------------------------------

          if (subPath === "/api-keys") {
            if (method === "GET") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              return json({ success: true, data: await apiKeys.listApiKeys(env, organizationId) });
            }
            if (method === "POST") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              const body = await request.json().catch(() => ({}));
              const result = await apiKeys.createApiKey(env, {
                organizationId, siteId: body.siteId || null, name: body.name, scopes: body.scopes,
                actorUserId: customer.id, expiresAt: body.expiresAt || null
              });
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "api_key", resourceId: result.ok ? result.keyId : null, action: "create",
                success: result.ok, statusCode: result.ok ? 200 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error }, result.status);
              // Token shown once — same pattern as every other
              // generated secret in this codebase.
              return json({ success: true, keyId: result.keyId, token: result.token, prefix: result.prefix });
            }
          }

          const apiKeyDeleteMatch = subPath.match(/^\/api-keys\/([^/]+)$/);
          if (method === "DELETE" && apiKeyDeleteMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const [, keyId] = apiKeyDeleteMatch;
            const result = await apiKeys.revokeApiKey(env, organizationId, keyId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "api_key", resourceId: keyId, action: "revoke",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true });
          }

          if (subPath === "/webhooks") {
            if (method === "GET") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              return json({ success: true, data: await webhooksModule.listWebhooks(env, organizationId), validEventTypes: webhooksModule.listValidEventTypes() });
            }
            if (method === "POST") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              const body = await request.json().catch(() => ({}));
              const result = await webhooksModule.createWebhook(env, {
                organizationId, url: body.url, eventTypes: body.eventTypes, actorUserId: customer.id
              });
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "webhook", resourceId: result.ok ? result.webhookId : null, action: "create",
                success: result.ok, statusCode: result.ok ? 200 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error }, result.status);
              return json({ success: true, webhookId: result.webhookId, secret: result.secret });
            }
          }

          const webhookDeleteMatch = subPath.match(/^\/webhooks\/([^/]+)$/);
          if (method === "DELETE" && webhookDeleteMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const [, webhookId] = webhookDeleteMatch;
            const result = await webhooksModule.deleteWebhook(env, organizationId, webhookId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "webhook", resourceId: webhookId, action: "delete",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true });
          }

          const webhookRotateMatch = subPath.match(/^\/webhooks\/([^/]+)\/rotate-secret$/);
          if (method === "POST" && webhookRotateMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const [, webhookId] = webhookRotateMatch;
            const result = await webhooksModule.rotateSecret(env, organizationId, webhookId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "webhook", resourceId: webhookId, action: "rotate_secret",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, secret: result.secret });
          }

          const webhookDeliveriesMatch = subPath.match(/^\/webhooks\/([^/]+)\/deliveries$/);
          if (method === "GET" && webhookDeliveriesMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const [, webhookId] = webhookDeliveriesMatch;
            const result = await webhooksModule.listDeliveries(env, organizationId, webhookId);
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, data: result.data });
          }

          const webhookRedeliverMatch = subPath.match(/^\/webhooks\/([^/]+)\/deliveries\/([^/]+)\/redeliver$/);
          if (method === "POST" && webhookRedeliverMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const [, webhookId, deliveryId] = webhookRedeliverMatch;
            const result = await webhooksModule.redeliver(env, organizationId, webhookId, deliveryId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "webhook_delivery", resourceId: deliveryId, action: "redeliver",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, data: result.data });
          }

          // In-app notifications (the automation_alerts inbox): any member reads, analyst+ acknowledges/resolves.
          if (method === "GET" && subPath === "/notifications") {
            const status = new URL(request.url).searchParams.get("status") === "all" ? "all" : "open";
            return json({ success: true, data: await notificationsRepo.list(env, organizationId, { status }), open: await notificationsRepo.countOpen(env, organizationId) });
          }
          const notifyMatch = subPath.match(/^\/notifications\/(\d+)\/(acknowledge|resolve)$/);
          if (method === "POST" && notifyMatch) {
            const guard = await requireOrgRole(organizationId, "analyst");
            if (guard) return guard;
            const changed = await notificationsRepo.setStatus(env, organizationId, Number(notifyMatch[1]), notifyMatch[2] === "resolve" ? "resolved" : "acknowledged");
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "notification", resourceId: notifyMatch[1], action: notifyMatch[2],
              success: changed, statusCode: changed ? 200 : 404, requestId, ipHash: customerIpHash
            });
            return changed ? json({ success: true }) : json({ success: false, error: "not_found" }, 404);
          }

          if (method === "GET" && subPath === "/search") {
            const query = new URL(request.url).searchParams.get("q");
            return json({ success: true, data: await searchOrganization(env, organizationId, query) });
          }

          if (method === "GET" && subPath === "/export") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const data = await exportOrganizationData(env, organizationId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization_export", action: "export",
              success: true, statusCode: 200, requestId, ipHash: customerIpHash
            });
            return json({ success: true, data });
          }

          // -------------------------------------------
          // White-label branding (Phase 7). Readable by any
          // member; writes are admin+ and entitlement-gated
          // inside branding.js itself.
          // -------------------------------------------

          if (subPath === "/branding") {
            if (method === "GET") {
              return json({ success: true, data: await branding.getBranding(env, organizationId) });
            }
            if (method === "PUT") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              const body = await request.json().catch(() => ({}));
              const result = await branding.updateBranding(env, organizationId, body);
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "organization_branding", action: "update",
                success: result.ok, statusCode: result.ok ? 200 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error }, result.status);
              return json({ success: true });
            }
          }

          // -------------------------------------------
          // Approval workflows (Phase 7) — currently wired only
          // to site deletion; see change-requests.js.
          // -------------------------------------------

          const siteDeleteMatch = subPath.match(/^\/sites\/([^/]+)$/);
          if (method === "DELETE" && siteDeleteMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const [, siteId] = siteDeleteMatch;
            const body = await request.json().catch(() => ({}));
            const result = await changeRequests.requestSiteDeletion(env, {
              organizationId, siteId, actorUserId: customer.id, reason: body.reason
            });
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "site", resourceId: siteId,
              action: result.requiresApproval ? "deletion_requested" : "delete",
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true, requiresApproval: result.requiresApproval, changeRequestId: result.changeRequestId });
          }

          if (method === "GET" && subPath === "/change-requests") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            return json({ success: true, data: await changeRequests.listChangeRequests(env, organizationId) });
          }

          const changeRequestActionMatch = subPath.match(/^\/change-requests\/([^/]+)\/(approve|reject)$/);
          if (method === "POST" && changeRequestActionMatch) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;

            const [, changeRequestId, action] = changeRequestActionMatch;
            const body = await request.json().catch(() => ({}));
            const result =
              action === "approve"
                ? await changeRequests.approveChangeRequest(env, { organizationId, changeRequestId, approverUserId: customer.id })
                : await changeRequests.rejectChangeRequest(env, { organizationId, changeRequestId, approverUserId: customer.id, reason: body.reason });

            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "change_request", resourceId: changeRequestId, action,
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            return json({ success: true });
          }

          // -------------------------------------------
          // Audit log + site health (Phase 7)
          // -------------------------------------------

          if (method === "GET" && subPath === "/audit-log") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            return json({ success: true, data: await listOrganizationAuditLog(env, organizationId) });
          }

          // Round 6.4B: audit-log CSV, one bounded page per request (X-Next-Cursor names the next). Dark (404) while CUSTOMER_AUDIT_CSV=off.
          if (method === "GET" && subPath === "/audit-log.csv") {
            const q = new URL(request.url).searchParams;
            const exported = await customerAuditCsv.exportAuditCsv(env, { organizationId, actorUserId: customer.id, limit: q.get("limit"), cursor: q.get("cursor"), requestId, ipHash: customerIpHash, endpoint: path, method });
            if (!exported.ok) return json({ success: false, error: exported.error }, exported.status);
            return new Response(exported.csv, {
              status: 200,
              headers: {
                "Content-Type": "text/csv; charset=utf-8",
                "Content-Disposition": `attachment; filename="lummet-audit-log-${/^[A-Za-z0-9-]{1,64}$/.test(organizationId) ? organizationId : "org"}.csv"`,
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                "X-Has-More": exported.nextCursor ? "true" : "false",
                ...(exported.nextCursor ? { "X-Next-Cursor": exported.nextCursor } : {})
              }
            });
          }

          const siteHealthMatch = subPath.match(/^\/sites\/([^/]+)\/health$/);
          if (method === "GET" && siteHealthMatch) {
            const [, siteId] = siteHealthMatch;
            const targetSite = await sites.getSite(env, siteId);
            if (!targetSite || targetSite.organization_id !== organizationId) {
              return json({ success: false, error: "not_found" }, 404);
            }
            return json({ success: true, data: await getSiteHealthReport(env, siteId) });
          }

          // -------------------------------------------
          // SSO / OIDC configuration (Phase 7). Admin+ — this
          // controls who can authenticate into the organization
          // at all. The login flow itself is unauthenticated,
          // near /api/customer/login.
          // -------------------------------------------

          if (subPath === "/sso") {
            if (method === "GET") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              return json({ success: true, data: await sso.getSsoSettings(env, organizationId) });
            }
            if (method === "POST") {
              const guard = await requireOrgRole(organizationId, "admin");
              if (guard) return guard;
              const body = await request.json().catch(() => ({}));
              const result = await sso.configureSso(env, organizationId, {
                issuer: body.issuer, clientId: body.clientId, clientSecret: body.clientSecret,
                authorizationEndpoint: body.authorizationEndpoint, tokenEndpoint: body.tokenEndpoint,
                jwksUri: body.jwksUri, defaultRole: body.defaultRole
              });
              await logAudit(env, {
                actorType: "customer_user", customerUserId: customer.id, organizationId,
                endpoint: path, method, resource: "organization_sso", action: "configure",
                success: result.ok, statusCode: result.ok ? 200 : result.status,
                errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
              });
              if (!result.ok) return json({ success: false, error: result.error }, result.status);
              return json({ success: true });
            }
          }

          if (subPath === "/sso/domains" || /^\/sso\/domains\/[^/]+(\/verify)?$/.test(subPath)) {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const m = subPath.match(/^\/sso\/domains\/([^/]+)(\/verify)?$/);
            let result;
            let action;
            if (subPath === "/sso/domains" && method === "GET") return json({ success: true, data: await ssoDomains.listSsoDomains(env, organizationId) });
            if (subPath === "/sso/domains" && method === "POST") {
              const body = await request.json().catch(() => ({}));
              result = await ssoDomains.addSsoDomain(env, organizationId, body.domain); action = "add_domain";
            } else if (m && m[2] && method === "POST") { result = await ssoDomains.verifySsoDomain(env, organizationId, m[1]); action = "verify_domain"; }
            else if (m && !m[2] && method === "DELETE") { result = await ssoDomains.removeSsoDomain(env, organizationId, m[1]); action = "remove_domain"; }
            else return json({ success: false, error: "method_not_allowed" }, 405);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization_sso", action,
              success: result.ok, statusCode: result.ok ? 200 : result.status,
              errorMessage: result.ok ? null : result.error, requestId, ipHash: customerIpHash
            });
            if (!result.ok) return json({ success: false, error: result.error }, result.status);
            const { ok, status, ...payload } = result;
            return json({ success: true, ...payload });
          }

          if (method === "POST" && subPath === "/sso/disable") {
            const guard = await requireOrgRole(organizationId, "admin");
            if (guard) return guard;
            const result = await sso.disableSso(env, organizationId);
            await logAudit(env, {
              actorType: "customer_user", customerUserId: customer.id, organizationId,
              endpoint: path, method, resource: "organization_sso", action: "disable",
              success: result.ok, statusCode: 200, requestId, ipHash: customerIpHash
            });
            return json({ success: true });
          }
        }


        if (siteMatch && method === "GET") {
          const site = await sites.getSite(env, siteMatch[1]);
          if (!site) return json({ success: false, error: "not_found" }, 404);
          // A site's own organization_id is the source of truth for
          // access — never trust the :id in the URL alone (master
          // prompt section 40: never trust a browser-supplied id
          // without verifying ownership).
          const membership = await organizations.getMembership(env, site.organization_id, customer.id);
          if (!membership) return json({ success: false, error: "forbidden" }, 403);
          const siteIpDenied = await orgIpDenied(env, request, site.organization_id); // Round 6.4C: the site's own organization decides
          if (siteIpDenied) return siteIpDenied;
          return json({ success: true, data: site });
        }

        return json({ success: false, error: "not_found" }, 404);
      }

      // ---------------------------------------------
      // DEVELOPER API (Phase 6 — master prompt section 30).
      // Authenticated by a customer API key (Authorization:
      // Bearer lmk_...), NOT the customer session cookie — a
      // completely separate trust boundary, same principle as
      // staff vs customer identity never mixing. Read-only
      // (see api-keys.js's header comment on why scopes stop
      // at *:read for now).
      // ---------------------------------------------

      // ---------------------------------------------
      // Alert check trigger for an external pinger (Cron Triggers are not
      // available on the current plan). Disabled unless ALERT_CHECK_TOKEN is
      // set; a wrong or missing token always gets the same 404 so the
      // endpoint's existence is not revealed.
      // ---------------------------------------------
      if (path === "/api/ops/alert-check" && (method === "POST" || method === "GET")) {
        const auth = request.headers.get("Authorization") || "";
        const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!(await alerts.tokenMatches(provided, env.ALERT_CHECK_TOKEN))) return json({ success: false, error: "not_found" }, 404);
        // The same tick also makes sure a daily control-plane backup exists (no-op unless one is due).
        ctx.waitUntil(cpBackup.runControlPlaneBackupIfDue(env).catch(() => {}));
        ctx.waitUntil(erasure.purgeDueOrganizations(env).catch(() => {}));
        // The same tick drives the durable-job safety net and webhook retries (docs/DURABLE_JOBS.md).
        const jobSweep = await jobRunner.sweepJobs(env, { launch: (p) => ctx.waitUntil(p.catch(() => {})), wait: false }).catch(() => ({ results: [] }));
        ctx.waitUntil(webhooksModule.sweepDeliveries(env).catch(() => {}));
        // Custom domains waiting for nameserver delegation, certificates or routing (docs/CUSTOM_DOMAINS.md).
        ctx.waitUntil(zoneDomains.sweep(env, { redeploy: makeDomainRedeploy(env, ctx) }).catch(() => {}));
        // A running tenant release rollout takes its next step (docs/TENANT_RELEASES.md).
        ctx.waitUntil(rollouts.advanceRunning(env, { dispatch: makeRolloutDispatch(env, ctx, { inline: false }) }).catch(() => {}));
        ctx.waitUntil(automationSweep.sweepTrackingLinkEvents(env).catch(() => {}));
        ctx.waitUntil(requestErrorsRepo.purgeOlderThanDays(env, 14).catch(() => {}));
        ctx.waitUntil(billingLifecycle.sweep(env, Date.now(), { billingService: billing }).catch(logLifecycleFailure));
        ctx.waitUntil(billingReminders.sweepReminders(env).then(() => billingNotifications.drain(env)).then(() => flushOutbox(env)).then(() => billingNotifications.drain(env)).catch(logNotificationFailure));
        // Round 6.5A: the monitors run in the background (their probes can take longer than a pinger waits), so this check reads the
        // result of the previous call. Off by default (SYNTHETIC_MONITORS), then inert.
        ctx.waitUntil(runSyntheticMonitors(env).catch((error) => console.error(JSON.stringify({ msg: "synthetic_monitors_run_failed", errorName: error && error.name ? String(error.name).slice(0, 40) : "Error" }))));
        const result = await alerts.runAlertCheck(env);
        return json({ success: true, skipped: result.skipped || null, results: (result.results || []).map((r) => ({ key: r.key, action: r.action })), jobs: jobSweep.results.map((r) => ({ jobId: r.jobId, action: r.action })) });
      }

      // ---------------------------------------------
      // CI release API (v1.2, docs/TENANT_RELEASES.md). Authenticated by a STAFF API TOKEN (Authorization:
      // Bearer lmst_...), never by a session cookie, and only for these routes: publish a tenant release and run
      // a rollout. Every route names the scope it needs; a token cannot reach any other staff API.
      // ---------------------------------------------
      if (path.startsWith("/api/ci/tenant-release/")) {
        const rest = path.slice("/api/ci/tenant-release/".length);
        const ciIpHash = await customerAuth.hashIPForRateLimit(request);
        if (!(await customerAuth.isUnderLimit(env, ciIpHash, "ci_bad_token", 20))) return json({ success: false, error: "rate_limited" }, 429);
        const ciHeader = request.headers.get("Authorization") || "";
        const ciToken = await staffTokens.verifyStaffToken(env, ciHeader.startsWith("Bearer ") ? ciHeader.slice(7) : "");
        if (!ciToken) {
          await customerAuth.recordFailure(env, ciIpHash, "ci_bad_token");
          return json({ success: false, error: "unauthorized" }, 401);
        }
        const needScope = (scope) => (staffTokens.hasStaffScope(ciToken, scope) ? null : json({ success: false, error: "forbidden_scope", required: scope }, 403));
        const ciActor = `token:${ciToken.prefix}`;
        const ciAudit = (resource, resourceId, action, result) => logAudit(env, {
          adminId: null, actorType: "staff_token", initiatedBy: ciActor, endpoint: path, method, resource, resourceId, action,
          success: result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error, requestId, ipHash: ciIpHash
        });
        const ciBody = async () => (await request.json().catch(() => ({})));
        const reply = (result, extra = {}) => (result.ok ? json({ success: true, ...extra }) : json({ success: false, error: result.error, ...(result.rolloutId ? { rolloutId: result.rolloutId } : {}), ...(result.missing ? { missing: result.missing, missingCount: result.missingCount } : {}) }, result.status || 400));

        if (method === "GET" && rest === "releases") {
          const denied = needScope("release:publish"); if (denied) return denied;
          return json({ success: true, data: await tenantTemplate.listReleases(env) });
        }
        if (method === "PUT" && rest === "assets") {
          const denied = needScope("release:publish"); if (denied) return denied;
          if (Number(request.headers.get("Content-Length") || 0) > 25 * 1024 * 1024) return json({ success: false, error: "asset_too_large" }, 413);
          const r = await tenantTemplate.putAsset(env, { path: url.searchParams.get("path") || "", bytes: new Uint8Array(await request.arrayBuffer()) });
          if (!r.ok) return json({ success: false, error: r.error }, r.status);
          return json({ success: true, hash: r.hash, size: r.size });
        }
        if (method === "POST" && rest === "publish") {
          const denied = needScope("release:publish"); if (denied) return denied;
          const b = await ciBody();
          const r = await tenantTemplate.publishRelease(env, { version: b.version, scriptContent: b.scriptContent, migrations: b.migrations, assets: b.assets, notes: b.notes, createdBy: ciActor });
          await ciAudit("tenant_template_release", b.version, "publish", r);
          return reply(r, { version: b.version, assetCount: r.assetCount });
        }
        if (method === "POST" && rest === "rollouts") {
          const denied = needScope("rollout:run"); if (denied) return denied;
          const b = await ciBody();
          const r = await rollouts.startRollout(env, { version: b.version || null, siteIds: b.siteIds || null, notes: b.notes || null, startedBy: ciActor });
          await ciAudit("tenant_rollout", r.rolloutId || "none", "start", r);
          if (!r.ok) return reply(r);
          // Take the first step now, so the first site starts without waiting for anything else.
          const first = r.nothingToDo ? r : await rollouts.advanceRollout(env, r.rolloutId, { dispatch: makeRolloutDispatch(env, ctx, { inline: true }) });
          return json({ success: true, ...first, nothingToDo: !!r.nothingToDo }, 202);
        }
        const ciRollout = matchPath("/api/ci/tenant-release/rollouts/:id", path);
        const ciRolloutAction = matchPath("/api/ci/tenant-release/rollouts/:id/:action", path);
        if (method === "GET" && ciRollout) {
          const denied = needScope("rollout:run"); if (denied) return denied;
          const r = await rollouts.getRollout(env, ciRollout.id);
          return r.ok ? json({ success: true, ...r }) : reply(r);
        }
        if (method === "POST" && ciRolloutAction) {
          const denied = needScope("rollout:run"); if (denied) return denied;
          const { id, action } = ciRolloutAction;
          if (action === "advance") {
            const r = await rollouts.advanceRollout(env, id, { dispatch: makeRolloutDispatch(env, ctx, { inline: true }) });
            return r.ok ? json({ success: true, ...r }) : reply(r);
          }
          if (action === "cancel" || action === "resume") {
            const r = action === "cancel" ? await rollouts.cancelRollout(env, id) : await rollouts.resumeRollout(env, id);
            await ciAudit("tenant_rollout", id, action, r);
            return reply(r);
          }
        }
        return json({ success: false, error: "not_found" }, 404);
      }

      if (path.startsWith("/api/v1/")) {
        const authHeader = request.headers.get("Authorization") || "";
        const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
        // Security: limit repeated bad keys per IP. Only FAILURES are counted, so
        // legitimate integrations making many valid calls are never slowed down
        // and no database write happens on the normal path.
        const apiIpHash = await customerAuth.hashIPForRateLimit(request);
        if (!(await customerAuth.isUnderLimit(env, apiIpHash, "api_v1_bad_key", 20))) {
          return json({ success: false, error: "rate_limited" }, 429);
        }
        const apiAuth = await apiKeys.verifyApiKey(env, bearerToken);
        if (!apiAuth) {
          await customerAuth.recordFailure(env, apiIpHash, "api_v1_bad_key");
          return json({ success: false, error: "unauthorized" }, 401);
        }

        async function siteInScope(siteId) {
          const site = await sites.getSite(env, siteId);
          if (!site || site.organization_id !== apiAuth.organizationId) return null;
          if (apiAuth.siteId && apiAuth.siteId !== siteId) return null;
          const serveGate = await evaluateServeGate(env, { organizationId: site.organization_id, entryPoint: "api-key:site-scope" });
          if (serveGate.blocked) return { __blocked: true, reasonCode: refusalFor(serveGate.access).reasonCode };
          return site;
        }

        if (method === "GET" && path === "/api/v1/sites") {
          if (!apiKeys.hasScope(apiAuth, "sites:read")) return json({ success: false, error: "insufficient_scope" }, 403);
          const serveGate = await evaluateServeGate(env, { organizationId: apiAuth.organizationId, entryPoint: "api-key:sites-list" });
          if (serveGate.blocked) return json({ success:false,error:"billing_access_restricted",reasonCode:refusalFor(serveGate.access).reasonCode },402);
          const allSites = await sites.listSitesForOrganization(env, apiAuth.organizationId);
          const scoped = apiAuth.siteId ? allSites.filter((s) => s.id === apiAuth.siteId) : allSites;
          return json({ success: true, data: scoped });
        }

        const v1SiteMatch = path.match(/^\/api\/v1\/sites\/([^/]+)(\/.*)?$/);
        if (v1SiteMatch) {
          const [, siteId, v1SubPath] = v1SiteMatch;
          const rest = v1SubPath || "";

          if (method === "GET" && rest === "") {
            if (!apiKeys.hasScope(apiAuth, "sites:read")) return json({ success: false, error: "insufficient_scope" }, 403);
            const site = await siteInScope(siteId);
            if (site?.__blocked) return json({ success:false,error:"billing_access_restricted",reasonCode:site.reasonCode },402);
            if (!site) return json({ success: false, error: "not_found" }, 404);
            return json({ success: true, data: site });
          }

          if (method === "GET" && rest === "/domains") {
            if (!apiKeys.hasScope(apiAuth, "domains:read")) return json({ success: false, error: "insufficient_scope" }, 403);
            const site = await siteInScope(siteId);
            if (site?.__blocked) return json({ success:false,error:"billing_access_restricted",reasonCode:site.reasonCode },402);
            if (!site) return json({ success: false, error: "not_found" }, 404);
            return json({ success: true, data: await domains.listDomainsForSite(env, siteId) });
          }

          if (method === "GET" && rest === "/domain-zones") {
            if (!apiKeys.hasScope(apiAuth, "domains:read")) return json({ success: false, error: "insufficient_scope" }, 403);
            const site = await siteInScope(siteId);
            if (site?.__blocked) return json({ success:false,error:"billing_access_restricted",reasonCode:site.reasonCode },402);
            if (!site) return json({ success: false, error: "not_found" }, 404);
            const zonesView = await zoneDomains.listForSite(env, siteId);
            return json({ success: true, data: zonesView.map((v) => ({
              id: v.zone.id, domain: v.zone.zone_name, status: v.zone.status, phase: v.progress.phase, nameServers: v.zone.name_servers,
              activatedAt: v.zone.activated_at, hostnames: v.hostnames.map((h) => ({ hostname: h.hostname, status: h.status, isPrimary: !!h.is_primary }))
            })) });
          }

          if (method === "GET" && rest === "/analytics/overview") {
            if (!apiKeys.hasScope(apiAuth, "analytics:read")) return json({ success: false, error: "insufficient_scope" }, 403);
            const site = await siteInScope(siteId);
            if (site?.__blocked) return json({ success:false,error:"billing_access_restricted",reasonCode:site.reasonCode },402);
            if (!site) return json({ success: false, error: "not_found" }, 404);
            const v1Params = new URL(request.url).searchParams;
            const result = await tenantPortal.getAnalyticsOverview(env, site, {
              startDate: v1Params.get("start_date"), endDate: v1Params.get("end_date"),
              dimensionType: v1Params.get("dimension_type"), currency: v1Params.get("currency")
            });
            if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status);
            return json(result.data);
          }
        }

        if (method === "GET" && path === "/api/v1/usage") {
          if (!apiKeys.hasScope(apiAuth, "usage:read")) return json({ success: false, error: "insufficient_scope" }, 403);
          return json({ success: true, data: await getUsageSnapshot(env, apiAuth.organizationId) });
        }

        return json({ success: false, error: "not_found" }, 404);
      }

      // ---------------------------------------------
      // CUSTOMER PORTAL PAGES (Phase 5 — master prompt
      // section 8). Server-rendered HTML, calling the same
      // service modules directly rather than looping back
      // through this Worker's own JSON API — the same
      // "read the data, render it" pattern the staff
      // console's pages already use.
      // ---------------------------------------------

      if ((path === "/app" || path.startsWith("/app/")) && method === "GET") {
        const { customer: portalSessionCustomer, policy: portalPolicy } = await customerAuth.getCustomerSession(request, env);
        // A session an organization policy blocks counts as signed out for the login page, so the person can sign in again; every other
        // page below the login check shows the 2FA notice instead (Round 6.4A).
        const portalCustomer = portalPolicy.blocked ? null : portalSessionCustomer;

        if (path === "/app/verify-email") return html(renderVerifyEmailPage());
        if (path === "/app/reset-password") return html(renderResetPasswordPage());
        if (path === "/app/forgot-password") return html(renderForgotPasswordPage());
        if (path === "/app/invitation") return html(renderInvitationPage());
        if (path === "/app/login") {
          if (portalCustomer) return redirect("/app/overview");
          return html(renderCustomerLoginPage({ turnstileSiteKey: String(env.CUSTOMER_TURNSTILE_REQUIRED || "off").toLowerCase() === "on" ? (env.TURNSTILE_SITE_KEY || "") : "" }));
        }

        // Customer 2FA enrollment page (release 2.6.0.16). Served before the org-policy block on purpose: it is the way out of a restricted session.
        if (path === ENROLL_PAGE_PATH && customer2faEnrollMode(env) === "on") {
          if (!portalSessionCustomer) return redirect("/app/login");
          return html(renderCustomer2faEnrollPage(), 200, { "Cache-Control": "no-store" });
        }
        if (portalSessionCustomer && portalPolicy.blocked) return html(renderOrg2faRequiredPage({ enrollPath: customer2faEnrollMode(env) === "on" ? ENROLL_PAGE_PATH : null }), 403, { "Cache-Control": "no-store" });
        if (!portalCustomer) return redirect("/app/login");

        const myOrgs = await organizations.listOrganizationsForUser(env, portalCustomer.id);
        const requestedOrgId = new URL(request.url).searchParams.get("org");
        const activeOrgId =
          (requestedOrgId && myOrgs.some((o) => o.id === requestedOrgId) && requestedOrgId) ||
          (myOrgs.some((o) => o.id === portalCustomer.activeOrganizationId) && portalCustomer.activeOrganizationId) ||
          myOrgs[0]?.id ||
          null;

        // Accept-invitation landing page — checked before the
        // no-organization fallback below, since accepting an
        // invitation is exactly how an account WITHOUT an
        // organization gets one.
        const inviteMatch = path.match(/^\/app\/invitations\/([^/]+)$/);
        if (inviteMatch) {
          const acceptResult = await organizations.acceptInvitation(env, inviteMatch[1], portalCustomer.id);
          if (!acceptResult.ok) {
            return html(
              renderCustomerShell({
                title: "Invitation", activeKey: "", customer: portalCustomer,
                organizations: myOrgs, activeOrganizationId: activeOrgId,
                bodyHtml: `<h1>Invitation</h1><div class="flash flash-error">This invitation is invalid or has expired.</div>`
              })
            );
          }
          return redirect(`/app/overview?org=${acceptResult.organizationId}`);
        }

        if (!activeOrgId) {
          // Shouldn't normally happen — signUp always creates one
          // organization — but a page must never crash over it.
          return html(
            renderCustomerShell({
              title: "Overview", activeKey: "overview", customer: portalCustomer,
              organizations: [], activeOrganizationId: null,
              bodyHtml: `<h1>No organization</h1><p class="subtitle">Your account isn't a member of any organization yet.</p>`
            })
          );
        }

        // Round 6.4C: the active organization's IP allowlist. A denied address sees a plain notice and no organization data; ?org= can still pick
        // another organization of the same person, which is checked on its own list.
        const portalIpVerdict = await orgSecurityPolicy.evaluateOrgIpAccess(env, request, activeOrgId);
        if (portalIpVerdict.wouldDeny && !portalIpVerdict.denied) console.log(JSON.stringify({ msg: "org_ip_allowlist_would_deny", organizationId: activeOrgId, mode: portalIpVerdict.mode }));
        if (portalIpVerdict.denied) return html(renderOrgIpDeniedPage(), 403, { "Cache-Control": "no-store" });

        const activeOrg = await organizations.getOrganization(env, activeOrgId);
        // Hide nav links for features this plan doesn't include, so a Starter
        // customer isn't offered pages that only say "upgrade". Mirrors the
        // route-level requireEntitlement checks; the routes remain the access control.
        const [hasBackups, hasAutomations, analyticsLevel, hasReports, hasAffiliate, hasAlerts, openNotifications] = await Promise.all([
          entitlementsService.requireEntitlement(env, activeOrgId, "backups.enabled"),
          entitlementsService.requireEntitlement(env, activeOrgId, "automations.enabled"),
          entitlementsService.checkEntitlement(env, activeOrgId, "analytics.level"),
          entitlementsService.requireEntitlement(env, activeOrgId, "reports.enabled"),
          entitlementsService.requireEntitlement(env, activeOrgId, "affiliate.enabled"),
          entitlementsService.requireEntitlement(env, activeOrgId, "alerts.enabled"),
          notificationsRepo.countOpen(env, activeOrgId)
        ]);
        const hasAnalytics = !!analyticsLevel && analyticsLevel !== "none";
        const hiddenNavKeys = [
          ...(hasBackups ? [] : ["backups"]), ...(hasAutomations ? [] : ["automations"]),
          ...(hasAnalytics ? [] : ["analytics"]), ...(hasReports ? [] : ["reports"]),
          ...(hasAffiliate ? [] : ["campaigns"]), ...(hasAlerts ? [] : ["alerts"])
        ];
        const shell = (opts) => renderCustomerShell({ hiddenNavKeys, navBadges: { notifications: openNotifications }, ...opts });
        const myMembership = myOrgs.find((o) => o.id === activeOrgId);
        const canManage = myMembership ? roleAtLeast(myMembership.my_role, "admin") : false;

        if (path === "/app" || path === "/app/overview") {
          const [subscription, sitesList, usage] = await Promise.all([
            plans.getActiveSubscription(env, activeOrgId),
            sites.listSitesForOrganization(env, activeOrgId),
            getUsageSnapshot(env, activeOrgId)
          ]);
          const plan = subscription ? await plans.getPlan(env, subscription.plan_id) : null;

          return html(
            shell({
              title: "Overview", activeKey: "overview", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderOverviewPage({ organization: activeOrg, subscription, plan, usage, sites: sitesList })
            })
          );
        }

        // ---- insight pages (v7F): the data comes from the JSON routes above; these only render and explain ----
        const insightPage = async (title, key, render) => {
          const sitesList = await sites.listSitesForOrganization(env, activeOrgId);
          return html(shell({
            title, activeKey: key, customer: portalCustomer, organizations: myOrgs, activeOrganizationId: activeOrgId,
            bodyHtml: await render(sitesList)
          }));
        };
        if (path === "/app/analytics") return insightPage("Analytics", "analytics", (s) => renderInsightAnalytics({ sites: s, entitled: hasAnalytics, canDisable: hasAffiliate && (myMembership ? roleAtLeast(myMembership.my_role, "editor") : false) }));
        if (path === "/app/reports") return insightPage("Reports", "reports", (s) => renderInsightReports({ sites: s, entitled: hasReports, canRun: myMembership ? roleAtLeast(myMembership.my_role, "analyst") : false }));
        if (path === "/app/campaigns") return insightPage("Campaigns", "campaigns", (s) => renderInsightCampaigns({ sites: s, entitled: hasAffiliate, canCreate: myMembership ? roleAtLeast(myMembership.my_role, "editor") : false }));
        if (path === "/app/alerts") return insightPage("Alerts", "alerts", (s) => renderInsightAlerts({ sites: s, entitled: hasAlerts, canAck: myMembership ? roleAtLeast(myMembership.my_role, "analyst") : false }));
        if (path === "/app/content") return insightPage("Content", "content", (s) => renderInsightContent({ sites: s, email: portalCustomer.email, canManage: myMembership ? roleAtLeast(myMembership.my_role, "admin") : false }));
        if (path === "/app/notifications") {
          const status = new URL(request.url).searchParams.get("status") === "all" ? "all" : "open";
          const items = await notificationsRepo.list(env, activeOrgId, { status });
          return html(shell({
            title: "Notifications", activeKey: "notifications", customer: portalCustomer, organizations: myOrgs, activeOrganizationId: activeOrgId,
            bodyHtml: renderInsightNotifications({ items, status, canManage: myMembership ? roleAtLeast(myMembership.my_role, "analyst") : false })
          }));
        }
        if (path === "/app/search") {
          const q = (new URL(request.url).searchParams.get("q") || "").trim().slice(0, 100);
          const results = q ? await searchOrganization(env, activeOrgId, q) : null;
          return html(shell({
            title: "Search", activeKey: "search", customer: portalCustomer, organizations: myOrgs, activeOrganizationId: activeOrgId,
            bodyHtml: renderInsightSearch({ query: q, results })
          }));
        }

        if (path === "/app/usage") {
          const [snapshot, monthly, aiCredits, aiLimit, ledger] = await Promise.all([
            getUsageSnapshot(env, activeOrgId),
            getMonthlyUsage(env, activeOrgId),
            getAiBalance(env, activeOrgId),
            checkUsageLimit(env, activeOrgId, "ai_credits"),
            canManage ? listAiLedger(env, activeOrgId) : Promise.resolve([])
          ]);
          return html(
            shell({
              title: "Usage & AI", activeKey: "usage", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderUsagePage({ snapshot, monthly, aiCredits, aiLimit, tasks: Object.fromEntries(Object.entries(AI_TASKS).map(([k, v]) => [k, v.credits])), ledger, canManage })
            })
          );
        }

        if (path === "/app/domains") {
          const sitesList = await sites.listSitesForOrganization(env, activeOrgId);
          const domainsBySite = {};
          const zonesBySite = {};
          const subdomainsBySite = {};
          for (const site of sitesList) {
            // Hostnames served through a delegated zone, and CNAME-connected subdomains, have their own cards.
            domainsBySite[site.id] = (await domains.listDomainsForSite(env, site.id)).filter((d) => !d.method || d.method === "txt");
            zonesBySite[site.id] = await zoneDomains.listForSite(env, site.id);
            subdomainsBySite[site.id] = await zoneDomains.listSubdomainsForSite(env, site.id);
          }
          return html(
            shell({
              title: "Domains", activeKey: "domains", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderDomainsPage({ sites: sitesList, domainsBySite, zonesBySite, subdomainsBySite, canManage })
            })
          );
        }

        if (path === "/app/deployments") {
          const sitesList = await sites.listSitesForOrganization(env, activeOrgId);
          const deploymentsBySite = {};
          for (const site of sitesList) deploymentsBySite[site.id] = await deployments.listDeploymentsForSite(env, site.id);
          const latest = await tenantTemplate.getCurrentRelease(env);
          return html(
            shell({
              title: "Deployments", activeKey: "deployments", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderCustomerDeploymentsPage({ sites: sitesList, deploymentsBySite, latestVersion: latest.ok ? latest.version : null, canManage })
            })
          );
        }

        if (path === "/app/developer") {
          const [keys, hooks] = canManage
            ? await Promise.all([apiKeys.listApiKeys(env, activeOrgId), webhooksModule.listWebhooks(env, activeOrgId)])
            : [[], []];
          return html(
            shell({
              title: "API keys & webhooks", activeKey: "developer", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderDeveloperPage({ apiKeys: keys, webhooks: hooks, eventTypes: webhooksModule.listValidEventTypes(), canManage })
            })
          );
        }

        if (path === "/app/backups") {
          const [sitesList, list, enabled] = canManage
            ? await Promise.all([
                sites.listSitesForOrganization(env, activeOrgId),
                backups.listBackups(env, activeOrgId),
                entitlementsService.requireEntitlement(env, activeOrgId, "backups.enabled")
              ])
            : [[], [], false];
          return html(
            shell({
              title: "Backups", activeKey: "backups", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderBackupsPage({ sites: sitesList, backups: list, enabled: !!enabled, isOwner: myMembership ? roleAtLeast(myMembership.my_role, "owner") : false, canManage })
            })
          );
        }

        if (path === "/app/automations") {
          const [rules, runs, enabled] = canManage
            ? await Promise.all([
                automations.listRules(env, activeOrgId),
                automations.listRuns(env, activeOrgId),
                entitlementsService.requireEntitlement(env, activeOrgId, "automations.enabled")
              ])
            : [[], [], false];
          return html(
            shell({
              title: "Automations", activeKey: "automations", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderAutomationsPage({ rules, runs, enabled: !!enabled, canManage, triggers: automations.TRIGGER_EVENTS, actions: Object.keys(automations.ACTIONS) })
            })
          );
        }

        if (path === "/app/sites") {
          const [sitesList, products] = await Promise.all([
            sites.listSitesForOrganization(env, activeOrgId),
            plans.listProducts(env)
          ]);
          return html(
            shell({
              title: "Sites", activeKey: "sites", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderSitesPage({ sites: sitesList, products, canManage })
            })
          );
        }

        if (path === "/app/billing") {
          const subscription = await plans.getActiveSubscription(env, activeOrgId);
          const plan = subscription ? await plans.getPlan(env, subscription.plan_id) : null;
          const [invoices, billingProfile, access, usage, aiCredits] = await Promise.all([
            billing.listInvoices(env, activeOrgId), billing.getBillingProfile(env, activeOrgId),
            resolveAccess(env, activeOrgId), getUsageSnapshot(env, activeOrgId), getAiBalance(env, activeOrgId)
          ]);

          // New customers see every plan; subscribers see the other plans of their own product (to switch).
          let availablePlans = [];
          if (!subscription) {
            const products = await plans.listProducts(env);
            for (const product of products) {
              availablePlans.push(...(await plans.listPlans(env, product.id)));
            }
          } else if (plan) {
            availablePlans = (await plans.listPlans(env, plan.product_id)).filter((p) => p.id !== plan.id || !subscription.provider);
          }
          const checkoutStatus = ["success", "canceled"].includes(url.searchParams.get("checkout")) ? url.searchParams.get("checkout") : null;
          const canManageBilling = myMembership ? roleAtLeast(myMembership.my_role, "billing") : false;

          return html(
            shell({
              title: "Billing", activeKey: "billing", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderBillingPage({ subscription, plan, invoices, availablePlans, canManage, canManageBilling, checkoutStatus, selectedPlanId: url.searchParams.get("plan") || null, billingProfile, access, usage, aiCredits, cardRequiredTrial: cardRequiredTrial(env) })
            })
          );
        }

        if (path === "/app/settings") {
          const [orgRow, membersList] = await Promise.all([
            organizations.getOrganization(env, activeOrgId),
            organizations.listMembers(env, activeOrgId)
          ]);
          return html(
            shell({
              title: "Settings", activeKey: "settings", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderOrgSettingsPage({ organization: orgRow, members: membersList, isOwner: canManage && (await organizations.getMembership(env, activeOrgId, portalCustomer.id))?.role === "owner", currentUserId: portalCustomer.id })
            })
          );
        }

        if (path === "/app/account") {
          const owned = (await env.LUMMET_DB.prepare(
            `SELECT o.id, o.name, o.scheduled_deletion_at FROM organization_users ou JOIN organizations o ON o.id = ou.organization_id
             WHERE ou.user_id = ? AND ou.role = 'owner' AND o.erased_at IS NULL ORDER BY o.name`
          ).bind(portalCustomer.id).all()).results;
          const me = await env.LUMMET_DB.prepare(`SELECT sso_organization_id FROM customer_users WHERE id = ?`).bind(portalCustomer.id).first();
          return html(
            shell({
              title: "Account", activeKey: "account", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderAccountPage({ customer: portalCustomer, ownedOrganizations: owned, isSsoManaged: !!me?.sso_organization_id })
            })
          );
        }

        if (path === "/app/team") {
          const [members, pendingInvitations] = await Promise.all([
            organizations.listMembers(env, activeOrgId),
            canManage ? organizations.listPendingInvitations(env, activeOrgId) : Promise.resolve([])
          ]);
          return html(
            shell({
              title: "Team", activeKey: "team", customer: portalCustomer,
              organizations: myOrgs, activeOrganizationId: activeOrgId,
              bodyHtml: renderTeamPage({ members, pendingInvitations, canManage })
            })
          );
        }

        return redirect("/app/overview");
      }

      // ---------------------------------------------
      // Everything below requires a valid session.
      // Page routes redirect to /login; API routes 401.
      // ---------------------------------------------

      const admin = await auth.getCurrentAdmin(request, env);
      if (!admin) {
        if (isApiRoute) return json({ success: false, error: "unauthorized" }, 401);
        return redirect("/login");
      }

      const ipHash = await hashIP(request);
      const adminIsSuper = isSuperAdmin(admin);

      // Any admin signed in with a temporary password (set at account
      // creation — see admins.js) is redirected to /account/password
      // for every HTML route until they set a real one. API routes are
      // left alone so nothing silently breaks mid-session.
      if (admin.must_change_password === 1 && !isApiRoute && path !== "/account/password") {
        return redirect("/account/password");
      }

      // Optional hard requirement (STAFF_2FA_REQUIRED=true): until this admin has
      // turned on two-factor, the only things they can reach are the 2FA setup,
      // changing their password, and logging out.
      if (staff2fa.twoFactorRequired(env) && !admin.two_factor_enabled) {
        const allowed = path === "/account/2fa" || path === "/account/password" || path.startsWith("/api/account/2fa/") || path === "/api/auth/logout";
        if (!allowed) {
          if (isApiRoute) return json({ success: false, error: "two_factor_setup_required" }, 403);
          return redirect("/account/2fa");
        }
      }

      // ---------------------------------------------
      // RBAC enforcement helpers (Phase 10)
      //
      // These are the checks that actually matter — the nav in
      // layout.js only hides a link a staff admin can't use, it
      // doesn't stop a direct request to the route. Every handler
      // below that touches a tenant's Content/System resources,
      // lummet.com's own CMS, or the control plane itself
      // (tenant registry, credentials, other admins' accounts)
      // goes through one of these first.
      // ---------------------------------------------

      function forbidden() {
        if (isApiRoute) return json({ success: false, error: "forbidden" }, 403);
        return html(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
          <h1>403 — Forbidden</h1><p>You don't have access to this. Ask a super admin to grant it.</p>
          <a href="/dashboard">Back to dashboard</a></body></html>`, 403);
      }

      /** Super-admin-only screens: tenant registry, credentials, other admins. */
      function requireSuperAdmin() {
        return adminIsSuper ? null : forbidden();
      }

      /** area = 'tenant' | 'cms'; action = create|read|update|delete. */
      async function requirePermission(area, resource, action) {
        const allowed = await hasPermission(env, admin, area, resource, action);
        return allowed ? null : forbidden();
      }

      /** For any route that acts on the admin's currently active tenant. */
      async function requireActiveTenantAccess() {
        const allowed = await canAccessTenant(env, admin, admin.activeTenantId);
        return allowed ? null : forbidden();
      }

      /** For routes that take an explicit :id — e.g. /api/tenants/:id/switch. */
      async function requireTenantParamAccess(tenantId) {
        const allowed = await canAccessTenant(env, admin, tenantId);
        return allowed ? null : forbidden();
      }

      // ===============================================
      // JSON API
      // ===============================================

      if (isApiRoute) {
        // GET /api/tenants — a staff admin only ever sees the tenants
        // they've been granted; a super admin sees all of them.
        if (method === "GET" && path === "/api/tenants") {
          const tenants = await registry.listTenants(env);
          const filtered = await listAccessibleTenants(env, admin, tenants);
          return json({ success: true, data: filtered });
        }

        // POST /api/tenants — registering a brand-new tenant touches
        // the control plane itself, not any one tenant's content, so
        // this stays super-admin-only (same as the Tenants nav section).
        if (method === "POST" && path === "/api/tenants") {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const body = await request.json().catch(() => ({}));
          const result = await registry.createTenant(env, body);

          await logAudit(env, {
            adminId: admin.id,
            tenantId: result.tenant?.id,
            endpoint: path,
            method,
            resource: "tenant",
            action: "create",
            success: result.ok,
            statusCode: result.ok ? 201 : result.status,
            errorMessage: result.ok ? null : (result.message || result.error),
            requestId,
            ipHash
          });

          if (!result.ok) {
            return json({ success: false, error: result.error, message: result.message }, result.status);
          }
          return json({ success: true, data: result.tenant, credential: result.credential }, 201);
        }

        const tenantIdParams = matchPath("/api/tenants/:id", path);
        const enableParams = matchPath("/api/tenants/:id/enable", path);
        const disableParams = matchPath("/api/tenants/:id/disable", path);
        const rotateParams = matchPath("/api/tenants/:id/rotate-credential", path);
        const testParams = matchPath("/api/tenants/:id/test-connection", path);
        const capabilitiesParams = matchPath("/api/tenants/:id/capabilities", path);
        const switchParams = matchPath("/api/tenants/:id/switch", path);

        if (method === "GET" && tenantIdParams) {
          const guard = await requireTenantParamAccess(tenantIdParams.id);
          if (guard) return guard;
          const tenant = await registry.getTenant(env, tenantIdParams.id);
          if (!tenant) return json({ success: false, error: "not_found" }, 404);
          const health = await registry.getTenantHealth(env, tenantIdParams.id);
          const capabilities = await registry.getTenantCapabilities(env, tenantIdParams.id);
          return json({ success: true, data: { ...tenant, health, capabilities } });
        }

        if (method === "PUT" && tenantIdParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const body = await request.json().catch(() => ({}));
          const result = await registry.updateTenant(env, tenantIdParams.id, body);

          await logAudit(env, {
            adminId: admin.id, tenantId: tenantIdParams.id, endpoint: path, method,
            resource: "tenant", resourceId: tenantIdParams.id, action: "update",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, data: result.tenant });
        }

        if (method === "DELETE" && tenantIdParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const result = await registry.deleteTenant(env, tenantIdParams.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: tenantIdParams.id, endpoint: path, method,
            resource: "tenant", resourceId: tenantIdParams.id, action: "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true });
        }

        if (method === "POST" && enableParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const result = await registry.setTenantStatus(env, enableParams.id, "active");
          await logAudit(env, {
            adminId: admin.id, tenantId: enableParams.id, endpoint: path, method,
            resource: "tenant", resourceId: enableParams.id, action: "enable",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, data: result.tenant });
        }

        if (method === "POST" && disableParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const result = await registry.setTenantStatus(env, disableParams.id, "disabled");
          await logAudit(env, {
            adminId: admin.id, tenantId: disableParams.id, endpoint: path, method,
            resource: "tenant", resourceId: disableParams.id, action: "disable",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, data: result.tenant });
        }

        if (method === "POST" && rotateParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const result = await registry.rotateCredential(env, rotateParams.id);
          await logAudit(env, {
            adminId: admin.id, tenantId: rotateParams.id, endpoint: path, method,
            resource: "tenant_credential", resourceId: rotateParams.id, action: "rotate",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : (result.message || result.error), requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.error, message: result.message }, result.status);
          return json({ success: true, credential: result.credential });
        }

        if (method === "POST" && testParams) {
          const guard = await requireTenantParamAccess(testParams.id);
          if (guard) return guard;
          const result = await registry.testConnection(env, testParams.id);
          await logAudit(env, {
            adminId: admin.id, tenantId: testParams.id, endpoint: path, method,
            resource: "tenant", resourceId: testParams.id, action: "test_connection",
            success: result.ok, statusCode: result.ok ? 200 : result.status,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status);
          return json({ success: true, data: result.data });
        }

        if (method === "GET" && capabilitiesParams) {
          const guard = await requireTenantParamAccess(capabilitiesParams.id);
          if (guard) return guard;
          const capabilities = await registry.getTenantCapabilities(env, capabilitiesParams.id);
          return json({ success: true, data: capabilities });
        }

        if (method === "POST" && switchParams) {
          const guard = await requireTenantParamAccess(switchParams.id);
          if (guard) return guard;
          const tenant = await registry.getTenant(env, switchParams.id);
          if (!tenant) return json({ success: false, error: "not_found" }, 404);
          await auth.setActiveTenant(env, admin.sessionId, switchParams.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: switchParams.id, endpoint: path, method,
            resource: "session", resourceId: switchParams.id, action: "switch_tenant",
            success: true, statusCode: 200, requestId, ipHash
          });

          return json({ success: true, data: { active_tenant_id: switchParams.id } });
        }

        if (method === "DELETE" && path === "/api/session/active-tenant") {
          await auth.setActiveTenant(env, admin.sessionId, null);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "session", action: "clear_active_tenant",
            success: true, statusCode: 200, requestId, ipHash
          });

          return json({ success: true, data: { active_tenant_id: null } });
        }

        // Manual, on-demand run of the same check the Cron Trigger
        // performs on a schedule — useful for testing and for an
        // admin who doesn't want to wait for the next tick.
        if (method === "POST" && path === "/api/tenants/health-check-all") {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const summary = await runHealthChecks(env);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "tenant_health", action: "health_check_all",
            success: true, statusCode: 200, requestId, ipHash,
            errorMessage: `checked=${summary.checked} online=${summary.online} disabled=${summary.disabled} failed=${summary.failed}`
          });

          return json({ success: true, data: summary });
        }

        // Lists the active tenant's media library for the media-picker
        // widget in CRUD forms. Proxies through the same authenticated
        // client.js path as everything else — the browser never sees
        // the tenant's credential, only this JSON list.
        if (method === "GET" && path === "/api/media-picker") {
          if (!admin.activeTenantId) {
            return json({ success: true, data: [] });
          }
          const tenantGuard = await requireActiveTenantAccess();
          if (tenantGuard) return tenantGuard;
          const tenant = await registry.getTenant(env, admin.activeTenantId);
          if (!tenant) return json({ success: true, data: [] });

          const result = await getFromTenant(env, tenant, "/en/api/super/media");
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason }, result.status);
          return json({ success: true, data: result.data.data || [] });
        }

        if (method === "POST" && path === "/api/media/upload") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "media", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitMediaUpload(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "media", action: "upload",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        if (method === "POST" && path === "/api/media/from-url") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "media", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitMediaFromUrl(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "media", action: "create_from_url",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        if (method === "POST" && path === "/api/permissions/set") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "users", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSetPermission(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "permissions", action: "set",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        const itemAccessScopeParams = matchPath("/api/item-access/:id/scope", path);
        if (method === "POST" && itemAccessScopeParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "users", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSetItemScope(env, admin, itemAccessScopeParams.id, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "item_access", resourceId: itemAccessScopeParams.id, action: "set_scope",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        const itemAccessAssignParams = matchPath("/api/item-access/:id/assignment", path);
        if (method === "POST" && itemAccessAssignParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "users", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSetItemAssignment(env, admin, itemAccessAssignParams.id, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "item_access", resourceId: itemAccessAssignParams.id, action: "set_assignment",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "POST" && path === "/api/ad-rules") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "settings", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreateAdRule(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "ad_rules", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        const adRuleParams = matchPath("/api/ad-rules/:id", path);
        if (adRuleParams && (method === "PUT" || method === "DELETE")) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "settings", "update"));
          if (guard) return guard;
          const payload = method === "PUT" ? await request.json().catch(() => ({})) : null;
          const result =
            method === "PUT"
              ? await submitUpdateAdRule(env, admin, adRuleParams.id, payload)
              : await submitDeleteAdRule(env, admin, adRuleParams.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "ad_rules", resourceId: adRuleParams.id, action: method === "PUT" ? "update" : "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "POST" && path === "/api/review-blocks") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "components", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreateReviewBlock(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "review_blocks", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        const reviewBlockParams = matchPath("/api/review-blocks/:id", path);
        if (reviewBlockParams && (method === "PUT" || method === "DELETE")) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "components", "update"));
          if (guard) return guard;
          const payload = method === "PUT" ? await request.json().catch(() => ({})) : null;
          const result =
            method === "PUT"
              ? await submitUpdateReviewBlock(env, admin, reviewBlockParams.id, payload)
              : await submitDeleteReviewBlock(env, admin, reviewBlockParams.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "review_blocks", resourceId: reviewBlockParams.id, action: method === "PUT" ? "update" : "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        const newsroomMetaParams = matchPath("/api/news/:id/newsroom-meta", path);
        if (newsroomMetaParams && method === "PUT") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "news", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitNewsroomMeta(env, admin, newsroomMetaParams.id, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "newsroom_meta", resourceId: newsroomMetaParams.id, action: "update",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        const newsroomRelationsParams = matchPath("/api/news/:id/newsroom-relations", path);
        if (newsroomRelationsParams && method === "PUT") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "news", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitNewsroomRelations(env, admin, newsroomRelationsParams.id, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "newsroom_relations", resourceId: newsroomRelationsParams.id, action: "update",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "POST" && path === "/api/reports") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "reports", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreateReport(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "reports", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        const runReportParams = matchPath("/api/reports/:id/run", path);
        if (method === "POST" && runReportParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "reports", "read"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitRunReport(env, admin, runReportParams.id, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "reports", resourceId: runReportParams.id, action: "run",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data });
        }

        if (method === "GET" && path === "/api/reports/column-options") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "reports", "read"));
          if (guard) return guard;
          const reportType = new URL(request.url).searchParams.get("report_type") || "";
          const result = await fetchReportColumnOptions(env, admin, reportType);
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data });
        }

        const analyticsRunParams = matchPath("/api/analytics/:kind", path);
        if (method === "POST" && analyticsRunParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "analytics", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitAnalyticsRun(env, admin, analyticsRunParams.kind, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "analytics_run", resourceId: analyticsRunParams.kind, action: "run",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data });
        }

        if (method === "POST" && path === "/api/alert-rules") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "analytics_alerts", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreateAlertRule(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "analytics_alerts", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        const ackAlertParams = matchPath("/api/alerts/:id/acknowledge", path);
        if (method === "POST" && ackAlertParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "analytics_alerts", "update"));
          if (guard) return guard;
          const result = await submitAcknowledgeAlert(env, admin, ackAlertParams.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "analytics_alerts", resourceId: ackAlertParams.id, action: "acknowledge",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "POST" && path === "/api/seo") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "seo", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSaveSeoMeta(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "seo", action: "upsert",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "DELETE" && path === "/api/seo") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "seo", "delete"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitDeleteSeoMeta(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "seo", action: "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "POST" && path === "/api/postback-configs") {
          const guard = (await requirePermission("tenant", "postback_configs", "create")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreatePostbackConfig(env, admin, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "postback_configs", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        const updatePostbackParams = matchPath("/api/postback-configs/:id", path);
        if (method === "PUT" && updatePostbackParams) {
          const guard = (await requirePermission("tenant", "postback_configs", "update")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitUpdatePostbackConfig(env, admin, updatePostbackParams.id, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "postback_configs", resourceId: updatePostbackParams.id, action: "update",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "DELETE" && updatePostbackParams) {
          const guard = (await requirePermission("tenant", "postback_configs", "delete")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const result = await submitArchivePostbackConfig(env, admin, updatePostbackParams.id);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "postback_configs", resourceId: updatePostbackParams.id, action: "archive",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        const rotatePostbackParams = matchPath("/api/postback-configs/:id/rotate-token", path);
        if (method === "POST" && rotatePostbackParams) {
          const guard = (await requirePermission("tenant", "postback_configs", "update")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const result = await submitRotatePostbackToken(env, admin, rotatePostbackParams.id);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "postback_configs", resourceId: rotatePostbackParams.id, action: "rotate_token",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data });
        }

        if (method === "POST" && path === "/api/provider-adapters") {
          const guard = (await requirePermission("tenant", "postback_configs", "create")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreateProviderAdapter(env, admin, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "provider_adapter_configs", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        const updateAdapterParams = matchPath("/api/provider-adapters/:id", path);
        if (method === "PUT" && updateAdapterParams) {
          const guard = (await requirePermission("tenant", "postback_configs", "update")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitUpdateProviderAdapter(env, admin, updateAdapterParams.id, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "provider_adapter_configs", resourceId: updateAdapterParams.id, action: "update",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "DELETE" && updateAdapterParams) {
          const guard = (await requirePermission("tenant", "postback_configs", "delete")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const result = await submitArchiveProviderAdapter(env, admin, updateAdapterParams.id);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "provider_adapter_configs", resourceId: updateAdapterParams.id, action: "archive",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        const replyInquiryParams = matchPath("/api/inquiries/:id/reply", path);
        if (method === "POST" && replyInquiryParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "inquiries", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitReplyInquiry(env, admin, replyInquiryParams.id, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "inquiries", resourceId: replyInquiryParams.id, action: "reply",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        const submissionStatusParams = matchPath("/api/submissions/:id", path);
        if (method === "PUT" && submissionStatusParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "submissions", "update"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitUpdateSubmissionStatus(env, admin, submissionStatusParams.id, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "submissions", resourceId: submissionStatusParams.id, action: "update_status",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        if (method === "POST" && path === "/api/notifications") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "notifications", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSendNotification(env, admin, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "notifications", action: "send",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true }, 201);
        }

        // ---- Editorial AI Tools ----
        // Gated by the "ai_tools" resource in the permission matrix
        // (super admins always pass via hasPermission).
        const AI_TOOL_ROUTES = {
          "/api/ai/generate-review": submitGenerateReview,
          "/api/ai/generate-seo": submitGenerateSeoCopy,
          "/api/ai/generate-faqs": submitGenerateFaqs,
          "/api/ai/generate-schema": submitGenerateSchema,
          "/api/ai/generate-outline": submitGenerateOutline,
          "/api/ai/improve-content": submitImproveContent,
          "/api/ai/suggest-links": submitSuggestInternalLinks
        };
        if (method === "POST" && Object.prototype.hasOwnProperty.call(AI_TOOL_ROUTES, path)) {
          const guard = (await requirePermission("tenant", "ai_tools", "read")) || (await requireActiveTenantAccess());
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await AI_TOOL_ROUTES[path](env, admin, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "ai_tools", action: path.replace("/api/ai/", ""),
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          // Tenant's AI handlers return their fields top-level
          // (e.g. { success, generated, text }), not nested under
          // `data` like the ordinary CRUD handlers -- re-nest here
          // so the page's JS can read `data.data.text` etc.
          // consistently with every other API route on this page.
          const { success: _tenantSuccess, ...aiFields } = result.data || {};
          return json({ success: true, data: aiFields });
        }

        // ---- AI Management Chat API (see worker/ai/*) ----
        if (method === "POST" && path === "/api/ai/chat") {
          const payload = await request.json().catch(() => ({}));
          const result = await handleChatMessage(env, admin, {
            conversationId: payload.conversationId || null,
            message: payload.message
          });

          if (result.ok) {
            await logAudit(env, {
              adminId: admin.id,
              tenantId: result.result?.tenant?.id || admin.activeTenantId,
              endpoint: path, method,
              resource: result.intent?.resource || null,
              action: result.intent?.operation || null,
              success: result.result?.ok !== false,
              statusCode: result.result?.ok === false ? (result.result.status || 400) : 200,
              errorMessage: result.result?.ok === false ? (result.result.message || result.result.error) : null,
              requestId, ipHash,
              initiatedBy: "ai", aiConversationId: result.conversationId
            });
          }

          if (!result.ok) return json({ success: false, error: result.error, message: result.message }, 400);
          return json({
            success: true,
            data: {
              conversationId: result.conversationId,
              reply: result.reply,
              intent: result.intent,
              result: result.result
            }
          });
        }

        if (method === "GET" && path === "/api/ai/conversations") {
          const conversations = await listConversations(env, admin);
          return json({ success: true, data: conversations });
        }

        const aiConversationParams = matchPath("/api/ai/conversations/:id", path);
        if (method === "GET" && aiConversationParams) {
          const conversation = await getOwnedConversation(env, admin, aiConversationParams.id);
          if (!conversation) return json({ success: false, error: "not_found" }, 404);
          const messages = await attachPendingPreviews(env, admin, await getMessages(env, conversation.id));
          return json({ success: true, data: { conversation, messages } });
        }

        // ---- AI write confirmation ----
        // The ONLY route in this codebase where confirming an AI chat
        // message causes a tenant write. Everything here is
        // re-verified fresh inside confirm.js -- this route is just
        // the transport.
        const aiConfirmParams = matchPath("/api/ai/confirm/:id", path);
        if (method === "POST" && aiConfirmParams) {
          const payload = await request.json().catch(() => ({}));
          const result = await confirmPendingOperation(env, admin, aiConfirmParams.id, payload.payloadHash || null);
          if (!result.ok) {
            return json({ success: false, error: result.error, message: result.message, conflictingFields: result.conflictingFields }, result.status === 409 ? 409 : 400);
          }
          return json({ success: true, data: result });
        }

        if (method === "POST" && path === "/api/newsletter-subscribers") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "newsletter", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitAddSubscriber(env, admin, payload);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "newsletter", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true }, 201);
        }

        const unsubParams = matchPath("/api/newsletter-subscribers/:id", path);
        if (method === "DELETE" && unsubParams) {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "newsletter", "delete"));
          if (guard) return guard;
          const result = await submitUnsubscribe(env, admin, unsubParams.id);
          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "newsletter", resourceId: unsubParams.id, action: "unsubscribe",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        // ---------------------------------------------
        // Base country/category hub pages
        // ---------------------------------------------

        if (method === "GET" && path === "/api/hub-pages/eligible-casinos") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "countries", "read"));
          if (guard) return guard;
          const countryCode = url.searchParams.get("country_code");
          const categorySlug = url.searchParams.get("category_slug");
          if (!countryCode && !categorySlug) return json({ success: false, error: "country_code_or_category_slug_required" }, 422);
          const result = await proxyHubEligibleCasinos(env, admin, countryCode, categorySlug);
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data || [] });
        }

        const hubPageParams = matchPath("/api/hub-pages/:kind/:id", path);
        if (hubPageParams && (method === "PUT" || method === "DELETE")) {
          const resource = hubPageParams.kind === "country" ? "countries" : "categories";
          const guard =
            (await requireActiveTenantAccess()) ||
            (await requirePermission("tenant", resource, method === "PUT" ? "update" : "delete"));
          if (guard) return guard;
          const payload = method === "PUT" ? await request.json().catch(() => ({})) : null;
          const result =
            method === "PUT"
              ? await submitUpdateHubPage(env, admin, hubPageParams.kind, hubPageParams.id, payload)
              : await submitDeleteHubPage(env, admin, hubPageParams.kind, hubPageParams.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource, action: method === "PUT" ? "update" : "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data });
        }

        const hubPageCreateParams = matchPath("/api/hub-pages/:kind", path);
        if (hubPageCreateParams && method === "POST") {
          const resource = hubPageCreateParams.kind === "country" ? "countries" : "categories";
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", resource, "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreateHubPage(env, admin, hubPageCreateParams.kind, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource, action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        // ---------------------------------------------
        // SEO landing pages (country pages / category×country pages)
        // ---------------------------------------------

        if (method === "GET" && path === "/api/seo-pages/countries-search") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "seo_pages", "read"));
          if (guard) return guard;
          const q = url.searchParams.get("q") || "";
          const result = await proxySearchCountries(env, admin, q);
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data || [] });
        }

        if (method === "GET" && path === "/api/seo-pages/eligible-casinos") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "seo_pages", "read"));
          if (guard) return guard;
          const countryCode = url.searchParams.get("country_code");
          const categorySlug = url.searchParams.get("category_slug");
          if (!countryCode) return json({ success: false, error: "country_code_required" }, 422);
          const result = await proxyEligibleCasinos(env, admin, countryCode, categorySlug);
          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data || [] });
        }

        if (method === "POST" && path === "/api/seo-pages/generate-draft") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "seo_pages", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitGenerateCategoryCountryDraft(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "seo_pages", action: "generate_draft",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        if (method === "POST" && path === "/api/seo-pages") {
          const guard = (await requireActiveTenantAccess()) || (await requirePermission("tenant", "seo_pages", "create"));
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitCreateSeoPage(env, admin, payload);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "seo_pages", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true, data: result.data?.data }, 201);
        }

        const seoPageParams = matchPath("/api/seo-pages/:id", path);
        if (seoPageParams && (method === "PUT" || method === "DELETE")) {
          const guard =
            (await requireActiveTenantAccess()) ||
            (await requirePermission("tenant", "seo_pages", method === "PUT" ? "update" : "delete"));
          if (guard) return guard;
          const payload = method === "PUT" ? await request.json().catch(() => ({})) : null;
          const result =
            method === "PUT"
              ? await submitUpdateSeoPage(env, admin, seoPageParams.id, payload)
              : await submitDeleteSeoPage(env, admin, seoPageParams.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
            resource: "seo_pages", resourceId: seoPageParams.id, action: method === "PUT" ? "update" : "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error || result.reason,
            requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.reason, reasonCode: result.reasonCode || result.reason, message: result.message }, result.status || 400);
          return json({ success: true });
        }

        // ---------------------------------------------
        // Staff SaaS operations API (master prompt section 45).
        // Super-admin only; every mutation is audited with the
        // organization it touched. Not reachable with a customer session.
        // ---------------------------------------------

        if (path.startsWith("/api/platform/saas/")) {
          const guard = requireSuperAdmin();
          if (guard) return guard;

          async function staffAudit(resource, resourceId, action, result, organizationId = null) {
            await logAudit(env, {
              adminId: admin.id, organizationId, endpoint: path, method, resource, resourceId, action,
              success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
              errorMessage: result.ok ? null : result.error, requestId, ipHash
            });
            return result.ok ? json({ success: true }) : json({ success: false, error: result.error }, result.status || 400);
          }
          const staffBody = async () => (await request.json().catch(() => ({})));

          // Round 6.1C: staff-only revenue analytics CSV and finance unit-cost settings (super-admin gate above).
          if (method === "GET" && path === "/api/platform/saas/revenue-analytics/export.csv") {
            const mode = revenueAnalytics.analyticsMode(env);
            if (mode === "off") return json({ success: false, error: "revenue_analytics_disabled" }, 404);
            const cohorts = await revenueAnalytics.monthlyCohorts(env, { limit: revenueAnalytics.MAX_COHORT_MONTHS });
            const csv = revenueAnalytics.toCsv(
              ["cohort_month", "currency", "logos", "starting_mrr_cents", "current_mrr_cents", "nrr_percent", "grr_percent", "logo_churn_percent", "churned_logos"],
              cohorts.map((r) => [r.cohortMonth, r.currency, r.logos, r.startingMrrCents, r.currentMrrCents, r.nrrPercent, r.grrPercent, r.logoChurnPercent, r.churnedLogos])
            );
            await logAudit(env, { adminId: admin.id, endpoint: path, method, resource: "revenue_analytics", action: "export_csv", success: true, statusCode: 200, requestId, ipHash, reason: `cohort rows exported: ${cohorts.length}` });
            return new Response(csv, { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="lummet-revenue-cohorts.csv"', "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
          }
          if (method === "POST" && path === "/api/platform/saas/revenue-analytics/finance-unit-costs") {
            const body = await staffBody();
            const reason = String(body.reason || "").trim();
            const result = reason.length < 5 || reason.length > 500
              ? { ok: false, status: 422, error: "reason_required" }
              : await revenueAnalytics.setFinanceUnitCosts(env, body.costs);
            await logAudit(env, { adminId: admin.id, endpoint: path, method, resource: "finance_unit_costs", resourceId: "finance_unit_costs_by_tier", action: "update", success: result.ok, statusCode: result.ok ? 200 : result.status || 422, errorMessage: result.ok ? null : result.error, requestId, ipHash, reason: reason.slice(0, 500) || null });
            return result.ok ? json({ success: true }) : json({ success: false, error: result.error }, result.status || 422);
          }

          // Phase 5.6/5.7: paginated staff quote queue and scoped Customer 360.
          if (method === "GET" && path === "/api/platform/saas/quotes") {
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
            const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
            return json({ success: true, data: await commercial.listQuoteQueue(env, { limit, offset }) });
          }
          const customer360Match = path.match(/^\/api\/platform\/saas\/organizations\/([^/]+)\/customer-360$/);
          if (method === "GET" && customer360Match) {
            const data = await commercial.getCustomer360(env, decodeURIComponent(customer360Match[1]));
            if (!data) return json({ success: false, error: "organization_not_found" }, 404);
            return json({ success: true, data });
          }
          const staffQuoteMatch = path.match(/^\/api\/platform\/saas\/quotes\/([^/]+)\/(edit|send|fulfill|invoice)$/);
          if (method === "POST" && staffQuoteMatch) {
            const body = await staffBody();
            if (!String(body.reason || "").trim()) return json({ success: false, error: "reason_required" }, 422);
            const quoteId = decodeURIComponent(staffQuoteMatch[1]);
            const result = staffQuoteMatch[2] === "edit"
              ? await commercial.editQuote(env, quoteId, body, { staffId: admin.id })
              : staffQuoteMatch[2] === "fulfill"
                ? await commercial.fulfillQuote(env, quoteId, { staffId: admin.id, reason: body.reason })
                : staffQuoteMatch[2] === "invoice"
                  ? await commercial.sendQuoteInvoice(env, quoteId, { staffId: admin.id, reason: body.reason, mode: body.mode || "one_time" })
                  : await commercial.sendQuote(env, quoteId, { staffId: admin.id });
            await logAudit(env, { adminId: admin.id, endpoint: path, method, resource: "quote", resourceId: quoteId, action: staffQuoteMatch[2], reason: String(body.reason).trim().slice(0,500), success: result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error, requestId, ipHash });
            return result.ok ? json({ success: true, data: result }) : json({ success: false, error: result.error }, result.status || 400);
          }

          // v2.5.2.2: dunning queue, reason-required dunning actions, four-eyes approvals.
          if (method === "GET" && path === "/api/platform/saas/dunning") {
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
            const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
            return json({ success: true, data: await commercial.listDunningQueue(env, { limit, offset }) });
          }
          const compMatch = path.match(/^\/api\/platform\/saas\/dunning\/([^/]+)\/comp$/);
          if (method === "POST" && compMatch) {
            const body = await staffBody();
            if (!String(body.reason || "").trim()) return json({ success: false, error: "reason_required" }, 422);
            const subscriptionId = decodeURIComponent(compMatch[1]);
            const result = await commercial.requestCompApproval(env, subscriptionId, { invoiceId: body.invoiceId || null, reason: body.reason, staffId: admin.id });
            await logAudit(env, { adminId: admin.id, organizationId: result.organizationId || null, endpoint: path, method, resource: "subscription", resourceId: subscriptionId, action: "dunning_comp_requested", reason: String(body.reason).trim().slice(0, 500), success: result.ok, statusCode: result.ok ? 200 : (result.status || 400), errorMessage: result.ok ? null : result.error, requestId, ipHash });
            return result.ok ? json({ success: true, data: result }) : json({ success: false, error: result.error }, result.status || 400);
          }
          if (method === "GET" && path === "/api/platform/saas/webhooks/failed") {
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
            const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
            return json({ success: true, data: await billing.listFailedWebhookEvents(env, { limit, offset }) });
          }
          const replayMatch = path.match(/^\/api\/platform\/saas\/webhooks\/(evt_[A-Za-z0-9_]+)\/replay$/);
          if (method === "POST" && replayMatch) {
            const body = await staffBody();
            if (!String(body.reason || "").trim()) return json({ success: false, error: "reason_required" }, 422);
            const result = await billing.replayWebhookEvent(env, replayMatch[1], { reason: body.reason, staffId: admin.id });
            await logAudit(env, { adminId: admin.id, organizationId: null, endpoint: path, method, resource: "billing_webhook_event", resourceId: replayMatch[1], action: "webhook_replay", reason: String(body.reason).trim().slice(0, 500), success: result.ok, statusCode: result.ok ? 200 : (result.status || 400), errorMessage: result.ok ? null : result.error, requestId, ipHash });
            return result.ok ? json({ success: true, data: result }) : json({ success: false, error: result.error }, result.status || 400);
          }
          const dunningMatch = path.match(/^\/api\/platform\/saas\/dunning\/([^/]+)\/(extend-grace|resend-notice)$/);
          if (method === "POST" && dunningMatch) {
            const body = await staffBody();
            if (!String(body.reason || "").trim()) return json({ success: false, error: "reason_required" }, 422);
            const subscriptionId = decodeURIComponent(dunningMatch[1]);
            const result = dunningMatch[2] === "extend-grace"
              ? await commercial.extendGrace(env, subscriptionId, { days: body.days, reason: body.reason, staffId: admin.id })
              : await commercial.resendDunningNotice(env, subscriptionId, { reason: body.reason, staffId: admin.id });
            await logAudit(env, { adminId: admin.id, organizationId: result.organizationId || null, endpoint: path, method, resource: "subscription", resourceId: subscriptionId, action: dunningMatch[2] === "extend-grace" ? "dunning_extend_grace" : "dunning_resend_notice", reason: String(body.reason).trim().slice(0, 500), success: result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error, requestId, ipHash });
            return result.ok ? json({ success: true, data: result }) : json({ success: false, error: result.error }, result.status || 400);
          }
          if (method === "GET" && path === "/api/platform/saas/approvals") {
            const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 50));
            const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
            return json({ success: true, data: await commercial.listApprovals(env, { status: url.searchParams.get("status"), limit, offset }) });
          }
          if (method === "POST" && path === "/api/platform/saas/approvals") {
            const body = await staffBody();
            const result = await commercial.requestApproval(env, { kind: body.kind, organizationId: String(body.organizationId || ""), amount: body.amount, paymentId: body.paymentId || null, currency: body.currency || null, reason: body.reason, staffId: admin.id });
            await logAudit(env, { adminId: admin.id, organizationId: String(body.organizationId || "") || null, endpoint: path, method, resource: "approval_request", resourceId: result.requestId || null, action: "request_" + String(body.kind || "unknown"), reason: String(body.reason || "").trim().slice(0, 500), success: result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error, requestId, ipHash });
            return result.ok ? json({ success: true, data: result }) : json({ success: false, error: result.error }, result.status || 400);
          }
          const approvalMatch = path.match(/^\/api\/platform\/saas\/approvals\/([^/]+)\/(approve|reject)$/);
          if (method === "POST" && approvalMatch) {
            const body = await staffBody();
            const approvalId = decodeURIComponent(approvalMatch[1]);
            const result = await commercial.decideApproval(env, approvalId, { decision: approvalMatch[2], staffId: admin.id, reason: body.reason });
            await logAudit(env, { adminId: admin.id, organizationId: result.organizationId || null, endpoint: path, method, resource: "approval_request", resourceId: approvalId, action: approvalMatch[2], reason: String(body.reason || "").trim().slice(0, 500), success: result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error, requestId, ipHash });
            return result.ok ? json({ success: true, data: result }) : json({ success: false, error: result.error }, result.status || 400);
          }

          if (method === "POST") {
            const immediateCancel = matchPath("/api/platform/saas/organizations/:id/immediate-cancel", path);
            if (immediateCancel) {
              const b=await staffBody(); const decision=await commercial.recordImmediateCancelDecision(env,{organizationId:immediateCancel.id,subscriptionId:String(b.subscriptionId||''),staffId:admin.id,refundDecision:b.refundDecision,refundAmountCents:b.refundAmountCents||0,currency:b.currency||'usd',reason:b.reason});
              if(!decision.ok) return json({success:false,error:decision.error},decision.status||400);
              const result=await commercial.immediateCancelStaff(env,immediateCancel.id,String(b.subscriptionId||''),{staffId:admin.id,reason:b.reason});
              await logAudit(env,{adminId:admin.id,organizationId:immediateCancel.id,endpoint:path,method,resource:'subscription',resourceId:b.subscriptionId,action:'immediate_cancel',reason:String(b.reason).trim().slice(0,1000),success:result.ok,statusCode:result.ok? 200:result.status||400,errorMessage:result.ok?null:result.error,requestId,ipHash});
              return result.ok?json({success:true,data:result}):json({success:false,error:result.error},result.status||400);
            }
            const tax=matchPath("/api/platform/saas/tax-checklist/:jurisdiction",path);
            if(tax){const b=await staffBody();const result=await commercial.updateTaxChecklist(env,{jurisdiction:tax.id,status:b.status,evidenceUrl:b.evidenceUrl,notes:b.notes,staffId:admin.id});await logAudit(env,{adminId:admin.id,endpoint:path,method,resource:'tax_registration',resourceId:tax.id,action:'update',reason:String(b.notes||'').slice(0,500),success:result.ok,statusCode:result.ok? 200:result.status||400,requestId,ipHash});return result.ok?json({success:true}):json({success:false,error:result.error},result.status||400);}
            const founder=matchPath("/api/platform/saas/quotes/:id/founder-license",path);
            if(founder){const b=await staffBody();const result=await commercial.founderLicenseInvoice(env,founder.id,{staffId:admin.id,reason:b.reason});await logAudit(env,{adminId:admin.id,endpoint:path,method,resource:'quote',resourceId:founder.id,action:'founder_license_invoice',reason:String(b.reason||'').slice(0,500),success:result.ok,statusCode:result.ok? 200:result.status||400,requestId,ipHash});return result.ok?json({success:true,data:result}):json({success:false,error:result.error},result.status||400);}
            const retryPushMatch = path.match(/^\/api\/platform\/saas\/sites\/([^/]+)\/access-push\/retry$/);
            if (retryPushMatch) {
              let b; try { b = await request.json(); } catch { return json({ success:false,error:"invalid_json",reasonCode:"invalid_json" },400); }
              if (!String(b.reason || "").trim()) return json({ success:false,error:"reason_required",reasonCode:"reason_required" },422);
              const result = await siteAccess.retrySiteAccessPush(env, decodeURIComponent(retryPushMatch[1]), { actorId: admin.id, reason: b.reason });
              if (!result.ok) return json({ success:false,error:result.error,reasonCode:result.reasonCode },result.status||400);
              await logAudit(env,{adminId:admin.id,endpoint:path,method,resource:"site",resourceId:result.siteId,action:"retry_site_access_push",reason:String(b.reason).trim().slice(0,500),success:true,statusCode:200,requestId,ipHash});
              return json({success:true,data:result});
            }
            if (path === "/api/platform/saas/sites/reactivate-bulk") {
              let b; try { b = await request.json(); } catch { return json({ success:false,error:"invalid_json",reasonCode:"invalid_json" },400); }
              const result = await siteAccess.bulkReactivateSites(env, { siteIds: b.siteIds, actorId: admin.id, reason: b.reason });
              const fullySuccessful = result.ok && result.failed === 0;
              // Round 6.5B: name the sites in the audit row (sorted, de-duplicated, bounded) so an incident record can say exactly which sites were touched.
              const auditSiteIds = Array.isArray(b.siteIds) ? [...new Set(b.siteIds.map((x) => String(x).slice(0, 100)))].sort().join(",").slice(0, 1000) : null;
              await logAudit(env, { adminId: admin.id, endpoint: path, method, resource: "site", resourceId: auditSiteIds, action: "bulk_reactivate", reason: String(b.reason || "").trim().slice(0,1000), success: fullySuccessful, statusCode: fullySuccessful ? 200 : result.ok ? 207 : result.status || 400, errorMessage: fullySuccessful ? null : result.ok ? "partial_failure" : result.error, requestId, ipHash });
              return result.ok ? json({ success: fullySuccessful, ...result }, fullySuccessful ? 200 : 207) : json({ success: false, error: result.error }, result.status || 400);
            }
            const staffPlanChange = matchPath("/api/platform/saas/organizations/:id/change-plan", path);
            if (staffPlanChange) {
              const b = await staffBody();
              if (!String(b.reason || "").trim()) return json({ success: false, error: "reason_required" }, 422);
              const owned = await env.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE organization_id=? AND status NOT IN ('canceled','expired','incomplete_expired') ORDER BY created_at DESC LIMIT 1`).bind(staffPlanChange.id).first();
              if (!owned || owned.id !== String(b.subscriptionId || "")) return json({ success: false, error: "subscription_not_current" }, 404);
              const result = await billing.changePlan(env, staffPlanChange.id, b.planId, { actorUserId: `staff:${admin.id}`, staffOverrideReason: String(b.reason).trim() });
              await logAudit(env, { adminId: admin.id, organizationId: staffPlanChange.id, endpoint: path, method, resource: "subscription", resourceId: b.subscriptionId, action: "staff_change_plan", reason: String(b.reason).trim().slice(0,1000), success: result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error, requestId, ipHash });
              return result.ok ? json({ success: true, pending: !!result.pending, scheduled: !!result.scheduled, effectiveAt: result.effectiveAt || null }) : json({ success: false, error: result.error, blockers: result.blockers || [] }, result.status || 400);
            }
            const driftResolve = matchPath("/api/platform/saas/reconciliation-findings/:id/resolve", path);
            if (driftResolve) {
              const b = await staffBody();
              const finding = await env.LUMMET_DB.prepare("SELECT organization_id FROM reconciliation_findings WHERE id=?").bind(driftResolve.id).first();
              if (!finding) return json({ success: false, error: "finding_not_found" }, 404);
              let result;
              try { result = await resolveDrift(env, { findingId: driftResolve.id, decision: b.decision, actorId: `staff:${admin.id}`, reason: String(b.reason || "") }); }
              catch (e) { result = { ok: false, status: 422, error: e?.message || "drift_resolution_failed" }; }
              await logAudit(env, { adminId: admin.id, organizationId: finding.organization_id, endpoint: path, method, resource: "reconciliation_finding", resourceId: driftResolve.id, action: `resolve:${b.decision}`, reason: String(b.reason || "").trim().slice(0,1000), success: !result?.error, statusCode: result?.error ? (result.status || 422) : 200, errorMessage: result?.error || null, requestId, ipHash });
              return result?.error ? json({ success: false, error: result.error }, result.status || 422) : json({ success: true, ...result });
            }
            const orgStatus = matchPath("/api/platform/saas/organizations/:id/status", path);
            if (orgStatus) {
              const b = await staffBody();
              if (b.status !== "active" && !String(b.reason || "").trim()) return json({ success: false, error: "reason_required" }, 422);
              return staffAudit("organization", orgStatus.id, `set_status:${b.status}`, await staffSaas.setOrganizationStatus(env, orgStatus.id, b.status, b.reason), orgStatus.id);
            }
            // Round 6.4C: recovery for an owner locked out by their own IP allowlist. Super-admin gate above; reason required; audited with the staff id.
            const ipClear = matchPath("/api/platform/saas/organizations/:id/ip-allowlist/clear", path);
            if (ipClear && method === "POST") {
              const b = await staffBody();
              const r = await orgSecurityPolicy.clearIpAllowlistAsStaff(env, { organizationId: ipClear.id, adminId: admin.id, reason: b.reason, requestId, ipHash, endpoint: path, method });
              return r.ok ? json({ success: true, cleared: r.cleared }) : json({ success: false, error: r.error }, r.status);
            }
            const stopDel = matchPath("/api/platform/saas/organizations/:id/stop-deletion", path);
            if (stopDel) return staffAudit("organization", stopDel.id, "stop_scheduled_deletion", await staffSaas.stopScheduledDeletion(env, stopDel.id), stopDel.id);
            const ovSet = matchPath("/api/platform/saas/organizations/:id/override", path);
            if (ovSet) {
              const b = await staffBody();
              const owned = await env.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE id = ? AND organization_id = ?`).bind(String(b.subscriptionId || ""), ovSet.id).first();
              if (!owned) return json({ success: false, error: "subscription_not_found" }, 404);
              return staffAudit("entitlement_override", `${b.subscriptionId}:${b.key}`, "set", await staffSaas.setEntitlementOverride(env, b.subscriptionId, b.key, b.valueType, b.value, b.reason), ovSet.id);
            }
            const ovDel = matchPath("/api/platform/saas/organizations/:id/override/remove", path);
            if (ovDel) {
              const b = await staffBody();
              const owned = await env.LUMMET_DB.prepare(`SELECT id FROM subscriptions WHERE id = ? AND organization_id = ?`).bind(String(b.subscriptionId || ""), ovDel.id).first();
              if (!owned) return json({ success: false, error: "subscription_not_found" }, 404);
              return staffAudit("entitlement_override", `${b.subscriptionId}:${b.key}`, "remove", await staffSaas.removeEntitlementOverride(env, b.subscriptionId, b.key), ovDel.id);
            }
            const credits = matchPath("/api/platform/saas/organizations/:id/ai-credits", path);
            if (credits) {
              const b = await staffBody();
              return staffAudit("ai_credits", credits.id, `grant:${b.amount}`, await staffSaas.grantAiCredits(env, credits.id, b.amount, b.reason, admin.id), credits.id);
            }
            const siteStatus = matchPath("/api/platform/saas/sites/:id/status", path);
            if (siteStatus) {
              const b = await staffBody();
              if (b.status === "suspended" && !String(b.reason || "").trim()) return json({ success: false, error: "reason_required" }, 422);
              const site = await sites.getSite(env, siteStatus.id);
              return staffAudit("site", siteStatus.id, `set_status:${b.status}`, await staffSaas.setSiteStatus(env, siteStatus.id, b.status, b.reason, String(admin.id)), site ? site.organization_id : null);
            }
            if (path === "/api/platform/saas/coupons") {
              const b = await staffBody();
              const r = await staffSaas.createCoupon(env, b);
              await logAudit(env, {
                adminId: admin.id, endpoint: path, method, resource: "coupon", resourceId: r.couponId || null, action: "create",
                success: r.ok, statusCode: r.ok ? 200 : r.status || 400, errorMessage: r.ok ? null : r.error, requestId, ipHash
              });
              return r.ok ? json({ success: true, couponId: r.couponId }) : json({ success: false, error: r.error }, r.status || 400);
            }
            const couponEdit = matchPath("/api/platform/saas/coupons/:id", path);
            if (couponEdit) {
              const b = await staffBody();
              return staffAudit("coupon", couponEdit.id, "update", await staffSaas.updateCoupon(env, couponEdit.id, b));
            }
            const keyRevoke = matchPath("/api/platform/saas/api-keys/:id/revoke", path);
            if (keyRevoke) {
              const k = await env.LUMMET_DB.prepare(`SELECT organization_id FROM customer_api_keys WHERE id = ?`).bind(keyRevoke.id).first();
              return staffAudit("api_key", keyRevoke.id, "staff_revoke", await staffSaas.revokeApiKeyAsStaff(env, keyRevoke.id), k ? k.organization_id : null);
            }
            const hookStatus = matchPath("/api/platform/saas/webhooks/:id/status", path);
            if (hookStatus) {
              const b = await staffBody();
              const w = await env.LUMMET_DB.prepare(`SELECT organization_id FROM webhooks WHERE id = ?`).bind(hookStatus.id).first();
              return staffAudit("webhook", hookStatus.id, `staff_set_status:${b.status}`, await staffSaas.setWebhookStatusAsStaff(env, hookStatus.id, b.status), w ? w.organization_id : null);
            }
            const planEdit = matchPath("/api/platform/saas/plans/:id", path);
            if (planEdit) {
              const b = await staffBody();
              return staffAudit("plan", planEdit.id, "update", await staffSaas.updatePlan(env, planEdit.id, { priceCents: b.priceCents, status: b.status, trialDays: b.trialDays, stripePriceId: b.stripePriceId }));
            }
            const jobRetry = matchPath("/api/platform/saas/jobs/:id/retry", path);
            if (jobRetry) {
              const job = await jobsModule.getJob(env, jobRetry.id);
              if (!job || job.status !== "failed" || !job.site_id) return json({ success: false, error: "job_not_retryable" }, 409);
              if (job.type === "tenant_provisioning") {
                const r = await provisioning.retryProvisioning(env, job.site_id, { actorUserId: String(admin.id), actorType: "lummet_admin" });
                if (r.ok) {
                  await jobRunner.requeueDeadLetter(env, jobRetry.id); // a staff retry gives a dead-lettered job a fresh set of automatic retries
                  await jobRunner.dispatchJob(env, ctx, r.jobId);
                }
                return staffAudit("job", jobRetry.id, "retry", r.ok ? { ok: true } : r, job.organization_id);
              }
              if (job.type === "site_deployment") {
                // The sweep never retries a failed deployment by itself; a staff member choosing to is the decision it was waiting for.
                await jobRunner.requeueDeadLetter(env, jobRetry.id);
                await jobRunner.dispatchJob(env, ctx, jobRetry.id);
                return staffAudit("job", jobRetry.id, "retry", { ok: true }, job.organization_id);
              }
              return staffAudit("job", jobRetry.id, "retry", { ok: false, status: 409, error: "retry_not_supported_for_type" }, job.organization_id);
            }
            if (path === "/api/platform/saas/key-rotation/run") {
              const b = await staffBody();
              let r;
              try { r = await keyRotation.reencryptAll(env, { limit: b.limit }); } catch (_) { r = { ok: false, status: 500, error: "encryption_key_not_configured" }; }
              return staffAudit("encryption_key_rotation", "all", "reencrypt", r.ok ? { ok: true, rotated: r.rotated, failed: r.failed.length } : r);
            }
            if (path === "/api/platform/saas/cp-backups") {
              const r = await cpBackup.createControlPlaneBackup(env);
              if (r.ok) await cpBackup.purgeOldControlPlaneBackups(env);
              return staffAudit("control_plane_backup", r.backupId || "none", "create", r);
            }
            const cpVerify = matchPath("/api/platform/saas/cp-backups/:id/verify", path);
            if (cpVerify) return staffAudit("control_plane_backup", cpVerify.id, "verify", await cpBackup.verifyControlPlaneBackup(env, cpVerify.id));
            if (path === "/api/platform/saas/alerts/check") {
              const r = await alerts.runAlertCheck(env);
              return staffAudit("alert_check", "all", "run", r.skipped ? { ok: false, status: 409, error: r.skipped } : { ok: true });
            }
            if (path === "/api/platform/saas/email/flush") {
              const r = await flushOutbox(env);
              return staffAudit("email_outbox", "all", "flush", r.skipped ? { ok: false, status: 409, error: r.skipped } : { ok: true });
            }
            // Staff resend of a billing notification (Phase 2.3). Dedupe-aware: see billingNotifications.resend.
            const notifResend = matchPath("/api/platform/saas/notifications/:id/resend", path);
            if (notifResend) {
              const r = await billingNotifications.resend(env, notifResend.id);
              await logAudit(env, {
                adminId: admin.id, organizationId: r.organizationId || null, endpoint: path, method, resource: "billing_notification", resourceId: notifResend.id,
                action: r.ok ? `resend:${r.kind}:${r.action}` : `resend:${r.kind || "unknown"}`, success: r.ok, statusCode: r.ok ? 200 : r.status || 400, errorMessage: r.ok ? null : r.error, requestId, ipHash
              });
              if (!r.ok) return json({ success: false, error: r.error }, r.status || 400);
              return json({ success: true, action: r.action, queued: r.queued ?? 0, requeued: r.requeued ?? 0 });
            }
            // Staff closes a plan-sync issue they have dealt with (for example an unknown price that is not ours). Audited.
            const issueResolve = matchPath("/api/platform/saas/plan-sync-issues/:id/resolve", path);
            if (issueResolve) {
              const issueId = Number(issueResolve.id);
              const done = Number.isInteger(issueId) && issueId > 0 && (await planChangeRepo.resolveIssue(env, issueId, `staff:${admin.id}`));
              return staffAudit("plan_sync_issue", String(issueResolve.id), "resolve", done ? { ok: true } : { ok: false, status: 404, error: "issue_not_found_or_already_resolved" });
            }
            // ---- Tenant release rollouts and staff API tokens (v1.2, docs/TENANT_RELEASES.md) ----
            const rolloutAudit = async (resourceId, action, result, extra = {}) => {
              await logAudit(env, {
                adminId: admin.id, endpoint: path, method, resource: "tenant_rollout", resourceId, action,
                success: result.ok, statusCode: result.ok ? 200 : result.status || 400, errorMessage: result.ok ? null : result.error, requestId, ipHash
              });
              return result.ok ? json({ success: true, ...result, ...extra }) : json({ success: false, error: result.error, ...(result.rolloutId ? { rolloutId: result.rolloutId } : {}) }, result.status || 400);
            };
            if (path === "/api/platform/saas/rollouts") {
              const b = await staffBody();
              const r = await rollouts.startRollout(env, { version: b.version || null, siteIds: b.siteIds || null, notes: b.notes || null, startedBy: `admin:${admin.id}` });
              return rolloutAudit(r.rolloutId || "none", "start", r);
            }
            const rolloutAct = matchPath("/api/platform/saas/rollouts/:id/:action", path);
            if (rolloutAct) {
              if (rolloutAct.action === "advance") {
                // The open staff page calls this every few seconds while a rollout runs. Not audited per call: it decides nothing.
                const r = await rollouts.advanceRollout(env, rolloutAct.id, { dispatch: makeRolloutDispatch(env, ctx, { inline: true }) });
                return r.ok ? json({ success: true, ...r }) : json({ success: false, error: r.error }, r.status || 400);
              }
              if (rolloutAct.action === "cancel") return rolloutAudit(rolloutAct.id, "cancel", await rollouts.cancelRollout(env, rolloutAct.id));
              if (rolloutAct.action === "resume") return rolloutAudit(rolloutAct.id, "resume", await rollouts.resumeRollout(env, rolloutAct.id));
            }
            if (path === "/api/platform/saas/staff-tokens") {
              const b = await staffBody();
              const r = await staffTokens.createStaffToken(env, { name: b.name, scopes: b.scopes, createdBy: String(admin.id), expiresInDays: b.expiresInDays });
              await logAudit(env, {
                adminId: admin.id, endpoint: path, method, resource: "staff_api_token", resourceId: r.ok ? r.tokenId : null, action: "create",
                success: r.ok, statusCode: r.ok ? 200 : r.status || 400, errorMessage: r.ok ? null : r.error, requestId, ipHash
              });
              // The only time the token is ever shown.
              return r.ok ? json({ success: true, token: r.token, prefix: r.prefix, expiresAt: r.expiresAt, scopes: r.scopes }) : json({ success: false, error: r.error }, r.status || 400);
            }
            const tokenRevoke = matchPath("/api/platform/saas/staff-tokens/:id/revoke", path);
            if (tokenRevoke) return staffAudit("staff_api_token", tokenRevoke.id, "revoke", await staffTokens.revokeStaffToken(env, tokenRevoke.id));
            if (path === "/api/platform/saas/tenant-template/publish") {
              const b = await staffBody();
              const r = await tenantTemplate.publishRelease(env, {
                version: b.version, scriptContent: b.scriptContent, migrations: b.migrations, assets: b.assets, notes: b.notes, createdBy: String(admin.id)
              });
              return staffAudit("tenant_template_release", b.version, "publish", r);
            }
            const activateMatch = matchPath("/api/platform/saas/tenant-template/:version/activate", path);
            if (activateMatch) {
              const r = await tenantTemplate.activateRelease(env, activateMatch.version);
              return staffAudit("tenant_template_release", activateMatch.version, "activate", r);
            }
          }
          if (method === "PUT" && path === "/api/platform/saas/tenant-template/assets") {
            // One static file per request (raw body); the server recomputes
            // the hash, so the caller can't register a file under a wrong one.
            const assetPath = url.searchParams.get("path") || "";
            if (Number(request.headers.get("Content-Length") || 0) > 25 * 1024 * 1024) return json({ success: false, error: "asset_too_large" }, 413);
            const bytes = new Uint8Array(await request.arrayBuffer());
            const r = await tenantTemplate.putAsset(env, { path: assetPath, bytes });
            if (!r.ok) return json({ success: false, error: r.error }, r.status);
            return json({ success: true, hash: r.hash, size: r.size });
          }
          if (method === "GET" && path === "/api/platform/saas/notifications") {
            const q = url.searchParams;
            const pageNo = Math.min(Math.max(parseInt(q.get("page") || "1", 10) || 1, 1), 10000);
            const kindQ = BILLING_KINDS.includes(q.get("kind")) ? q.get("kind") : "";
            const stateQ = notificationRepoStates.includes(q.get("state")) ? q.get("state") : "";
            const rows = await notificationRepoList(env, { organizationId: String(q.get("organization") || "").slice(0, 64), kind: kindQ, state: stateQ, limit: 51, offset: (pageNo - 1) * 50 });
            return json({ success: true, data: rows.slice(0, 50), hasMore: rows.length > 50, page: pageNo });
          }
          if (method === "GET" && path === "/api/platform/saas/site-access/sites") {
            return json({ success: true, data: await (await import("./repositories/site-access.js")).listSitesForStaffAccess(env, 1000) });
          }
          if (method === "GET" && path === "/api/platform/saas/site-access/push-failures") {
            return json({ success: true, data: await (await import("./repositories/site-access.js")).listPushFailures(env, 200) });
          }
          if (method === "GET" && path === "/api/platform/saas/access-shadow") {
            const q = url.searchParams; const pageNo = Math.min(Math.max(parseInt(q.get("page") || "1", 10) || 1, 1), 10000);
            const rows = await billingLifecycleRepo.listShadow(env, { limit: Math.min(pageNo*50, 500) });
            return json({success:true,data:rows.slice((pageNo-1)*50,pageNo*50),page:pageNo});
          }
          if (method === "GET" && path === "/api/platform/saas/reconciliation-findings") {
            const q = url.searchParams;
            const pageNo = Math.min(Math.max(parseInt(q.get("page") || "1", 10) || 1, 1), 10000);
            const status = ["open","accepted_stripe","kept_lummet","resolved"].includes(q.get("status")) ? q.get("status") : "open";
            const data = await listDrift(env, { status, limit: 50, offset: (pageNo - 1) * 50 });
            return json({ success: true, data, page: pageNo });
          }
          // Sprint 3.2: what the plan sync found (unknown prices, shadow changes) and the customers' plan-change intents. Paged, read-only.
          if (method === "GET" && path === "/api/platform/saas/plan-sync-issues") {
            const q = url.searchParams;
            const pageNo = Math.min(Math.max(parseInt(q.get("page") || "1", 10) || 1, 1), 10000);
            const kind = ["unknown_price_id", "shadow_plan_change"].includes(q.get("kind")) ? q.get("kind") : "";
            const page = await planChangeRepo.listIssues(env, { kind, open: q.get("all") !== "1", limit: 50, offset: (pageNo - 1) * 50 });
            return json({ success: true, data: page.rows, hasMore: page.hasMore, page: pageNo });
          }
          if (method === "GET" && path === "/api/platform/saas/plan-change-intents") {
            const q = url.searchParams;
            const pageNo = Math.min(Math.max(parseInt(q.get("page") || "1", 10) || 1, 1), 10000);
            const status = ["pending", "submitted", "confirmed", "failed", "superseded"].includes(q.get("status")) ? q.get("status") : "";
            const page = await planChangeRepo.listIntents(env, { subscriptionId: String(q.get("subscription") || "").slice(0, 64), status, limit: 50, offset: (pageNo - 1) * 50 });
            return json({ success: true, data: page.rows, hasMore: page.hasMore, page: pageNo });
          }
          if (method === "GET" && path === "/api/platform/saas/plan-prices") {
            const q = url.searchParams;
            const pageNo = Math.min(Math.max(parseInt(q.get("page") || "1", 10) || 1, 1), 10000);
            const page = await planPriceList(env, { planId: String(q.get("plan") || "").slice(0, 64), limit: 50, offset: (pageNo - 1) * 50 });
            return json({ success: true, data: page.rows, hasMore: page.hasMore, page: pageNo });
          }
          if (method === "GET" && path === "/api/platform/saas/rollouts") return json({ success: true, data: await rollouts.dashboard(env) });
          const rolloutGet = method === "GET" ? matchPath("/api/platform/saas/rollouts/:id", path) : null;
          if (rolloutGet) {
            const r = await rollouts.getRollout(env, rolloutGet.id);
            return r.ok ? json({ success: true, ...r }) : json({ success: false, error: r.error }, r.status || 404);
          }
          if (method === "GET" && path === "/api/platform/saas/tenant-template") {
            return json({ success: true, data: await tenantTemplate.listReleases(env) });
          }
          return json({ success: false, error: "not_found" }, 404);
        }

        // ---------------------------------------------
        // Lummet admin management API (Phase 10, super-admin only)
        // ---------------------------------------------

        const adminRoleParams = matchPath("/api/admins/:id/role", path);
        if (method === "POST" && adminRoleParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSetRole(env, adminRoleParams.id, payload.role, admin.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin", resourceId: adminRoleParams.id, action: "set_role",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.error }, result.status || 400);
          return json({ success: true });
        }

        const adminStatusParams = matchPath("/api/admins/:id/status", path);
        if (method === "POST" && adminStatusParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSetStatus(env, adminStatusParams.id, payload.status, admin.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin", resourceId: adminStatusParams.id, action: "set_status",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.error }, result.status || 400);
          return json({ success: true });
        }

        if (method === "POST" && path.startsWith("/api/account/2fa/")) {
          const action = path.slice("/api/account/2fa/".length);
          const body = await request.json().catch(() => ({}));
          let result;
          if (action === "setup") result = await staff2fa.startStaffTotpSetup(env, admin);
          else if (action === "confirm") result = await staff2fa.confirmStaffTotpSetup(env, admin.id, body.code);
          else if (action === "disable") result = await staff2fa.disableStaffTotp(env, admin.id, { code: body.code, backupCode: body.backupCode });
          else return json({ success: false, error: "not_found" }, 404);
          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin_2fa", resourceId: admin.id, action,
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status || 400);
          const { ok, status, ...payload } = result;
          return json({ success: true, ...payload });
        }

        const adminReset2fa = matchPath("/api/admins/:id/2fa-reset", path);
        if (method === "POST" && adminReset2fa) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          if (String(adminReset2fa.id) === String(admin.id)) return json({ success: false, error: "use_disable_instead" }, 400);
          const result = await staff2fa.resetStaffTotp(env, adminReset2fa.id);
          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin", resourceId: adminReset2fa.id, action: "reset_2fa",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });
          if (!result.ok) return json({ success: false, error: result.error }, result.status || 400);
          return json({ success: true });
        }

        const adminTenantAccessParams = matchPath("/api/admins/:id/tenant-access", path);
        if (method === "POST" && adminTenantAccessParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSetTenantAccess(env, adminTenantAccessParams.id, payload.tenant_id, !!payload.allowed);

          await logAudit(env, {
            adminId: admin.id, tenantId: payload.tenant_id || null, endpoint: path, method,
            resource: "lummet_admin_tenant_access", resourceId: adminTenantAccessParams.id,
            action: payload.allowed ? "grant" : "revoke",
            success: result.ok, statusCode: 200, requestId, ipHash
          });

          return json({ success: true });
        }

        const adminPermissionParams = matchPath("/api/admins/:id/permission", path);
        if (method === "POST" && adminPermissionParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const payload = await request.json().catch(() => ({}));
          const result = await submitSetAdminPermission(
            env, adminPermissionParams.id, payload.area, payload.resource, payload.action, !!payload.allowed
          );

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin_permission", resourceId: adminPermissionParams.id,
            action: `${payload.area}.${payload.resource}.${payload.action}=${!!payload.allowed}`,
            success: result.ok, statusCode: 200, requestId, ipHash
          });

          return json({ success: true });
        }

        const adminDeleteParams = matchPath("/api/admins/:id", path);
        if (method === "DELETE" && adminDeleteParams) {
          const guard = requireSuperAdmin();
          if (guard) return guard;
          const result = await submitDeleteAdmin(env, adminDeleteParams.id, admin.id);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin", resourceId: adminDeleteParams.id, action: "delete",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });

          if (!result.ok) return json({ success: false, error: result.error }, result.status || 400);
          return json({ success: true });
        }

        return json({ success: false, error: "not_found" }, 404);
      }

      // ===============================================
      // DASHBOARD PAGES (HTML)
      // ===============================================

      if (method === "GET" && path === "/dashboard") {
        return html(await renderDashboardHome(env, admin));
      }

      // No checkResourcePermission()/requireSuperAdmin() guard here on
      // purpose, matching the /api/ai/* routes above: this page is a
      // query surface, not a resource — what an admin can actually see
      // or change through it is enforced per-message inside
      // resolver.js/confirm.js, identically for every admin regardless
      // of role. (This lives in the DASHBOARD PAGES section, not the
      // isApiRoute block above, because "/ai" itself doesn't start
      // with "/api/" — only its POST/GET data routes do.)
      if (method === "GET" && path === "/ai") {
        return html(await renderAiChatPage(env, admin));
      }

      if (method === "GET" && path === "/account/2fa") {
        return html(await renderTwoFactorPage(env, admin, { status: await staff2fa.getStaffTotpStatus(env, admin.id), required: staff2fa.twoFactorRequired(env) }));
      }

      if (path === "/account/password") {
        if (method === "GET") {
          return html(await renderChangePasswordPage(env, admin, null));
        }

        if (method === "POST") {
          const form = await parseForm(request);
          const result = await submitChangePassword(env, admin, form);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin", resourceId: admin.id, action: "change_password",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.error, requestId, ipHash
          });

          if (!result.ok) {
            return html(await renderChangePasswordPage(env, admin, describePasswordError(result.error)));
          }
          return redirect("/dashboard");
        }
      }

      if (method === "GET" && path === "/tenants") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderTenantsList(env, admin, readFlash(url)));
      }

      if (path === "/tenants/new") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        if (method === "GET") return html(await renderAddTenantForm(env, admin));

        if (method === "POST") {
          const form = await parseForm(request);
          const result = await registry.createTenant(env, form);

          await logAudit(env, {
            adminId: admin.id,
            tenantId: result.tenant?.id,
            endpoint: path,
            method,
            resource: "tenant",
            action: "create",
            success: result.ok,
            statusCode: result.ok ? 201 : result.status,
            errorMessage: result.ok ? null : (result.message || result.error),
            requestId,
            ipHash
          });

          if (!result.ok) {
            return html(await renderAddTenantForm(env, admin, { error: result.message || describeRegistryError(result.error) }));
          }

          return html(await renderTenantCreatedPage(env, admin, result.tenant, result.credential), 201);
        }
      }

      if (method === "GET" && path === "/tenants/health") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderHealthPage(env, admin));
      }

      if (method === "GET" && path === "/tenants/deployments") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderDeploymentsPage(env, admin));
      }

      const tenantDetailParams = matchPath("/tenants/:id", path);
      if (method === "GET" && tenantDetailParams) {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        const pageHtml = await renderTenantDetail(env, admin, tenantDetailParams.id, readFlash(url));
        if (!pageHtml) return html("Tenant not found.", 404);
        return html(pageHtml);
      }

      const contentOrSystemCrud = await handleResourceRoutes(request, env, admin, path, method, requestId, ipHash);
      if (contentOrSystemCrud) return contentOrSystemCrud;

      // ---------------------------------------------
      // Lummet Site CMS (Phase 9) — lummet.com's own pages,
      // authors, brands, partners, updates, publications,
      // advertisements, and homepage settings. Backed directly
      // by this control plane's own D1, not any tenant's.
      // ---------------------------------------------

      if (method === "GET" && path === "/cms/settings") {
        const guard = await requirePermission("cms", "site_settings", "read");
        if (guard) return guard;
        return html(await renderSiteSettingsPage(env, admin, readFlash(url)));
      }

      if (method === "POST" && path === "/cms/settings") {
        const guard = await requirePermission("cms", "site_settings", "update");
        if (guard) return guard;
        const form = await parseForm(request);
        await submitSiteSettings(env, form);

        await logAudit(env, {
          adminId: admin.id, tenantId: null, endpoint: path, method,
          resource: "lummet_site_settings", action: "update",
          success: true, statusCode: 200, requestId, ipHash
        });

        return redirect("/cms/settings?flash=Homepage+settings+saved&flash_type=success");
      }

      const cmsListParams = matchPath("/cms/:resource", path);
      if (method === "GET" && cmsListParams && getCmsResourceConfig(cmsListParams.resource)) {
        const guard = await requirePermission("cms", cmsListParams.resource, "read");
        if (guard) return guard;
        return html(await renderCmsList(env, admin, cmsListParams.resource, readFlash(url)));
      }

      const cmsNewParams = matchPath("/cms/:resource/new", path);
      if (cmsNewParams && getCmsResourceConfig(cmsNewParams.resource)) {
        const guard = await requirePermission("cms", cmsNewParams.resource, "create");
        if (guard) return guard;

        // Some lists (e.g. Inquiries) hold records created by visitors, never by hand.
        if (getCmsResourceConfig(cmsNewParams.resource).supportsCreate === false) {
          return redirect(`/cms/${cmsNewParams.resource}?flash=This+list+cannot+be+added+to+by+hand&flash_type=error`);
        }

        if (method === "GET") return html(await renderCmsForm(env, admin, cmsNewParams.resource, null, null));

        if (method === "POST") {
          const form = await parseForm(request);
          const result = await submitCmsCreate(env, cmsNewParams.resource, form);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: `lummet_cms_${cmsNewParams.resource}`, action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error, requestId, ipHash
          });

          if (!result.ok) return html(await renderCmsForm(env, admin, cmsNewParams.resource, null, result.message || result.error));
          return redirect(`/cms/${cmsNewParams.resource}?flash=Created&flash_type=success`);
        }
      }

      const cmsEditParams = matchPath("/cms/:resource/:id/edit", path);
      if (cmsEditParams && getCmsResourceConfig(cmsEditParams.resource)) {
        if (method === "GET") {
          const guard = await requirePermission("cms", cmsEditParams.resource, "read");
          if (guard) return guard;
          return html(await renderCmsForm(env, admin, cmsEditParams.resource, cmsEditParams.id, null));
        }

        if (method === "POST") {
          const guard = await requirePermission("cms", cmsEditParams.resource, "update");
          if (guard) return guard;
          const form = await parseForm(request);
          const result = await submitCmsUpdate(env, cmsEditParams.resource, cmsEditParams.id, form);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: `lummet_cms_${cmsEditParams.resource}`, resourceId: cmsEditParams.id, action: "update",
            success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
            errorMessage: result.ok ? null : result.message || result.error, requestId, ipHash
          });

          if (!result.ok) return html(await renderCmsForm(env, admin, cmsEditParams.resource, cmsEditParams.id, result.message || result.error));
          return redirect(`/cms/${cmsEditParams.resource}?flash=Saved&flash_type=success`);
        }
      }

      const cmsDeleteParams = matchPath("/cms/:resource/:id/delete", path);
      if (method === "POST" && cmsDeleteParams && getCmsResourceConfig(cmsDeleteParams.resource)) {
        const guard = await requirePermission("cms", cmsDeleteParams.resource, "delete");
        if (guard) return guard;
        const result = await submitCmsDelete(env, cmsDeleteParams.resource, cmsDeleteParams.id);

        await logAudit(env, {
          adminId: admin.id, tenantId: null, endpoint: path, method,
          resource: `lummet_cms_${cmsDeleteParams.resource}`, resourceId: cmsDeleteParams.id, action: "delete",
          success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
          errorMessage: result.ok ? null : result.error, requestId, ipHash
        });

        return json({ success: result.ok, error: result.ok ? undefined : result.error });
      }

      // ---------------------------------------------
      // Staff console — SaaS operations (master prompt section 45)
      // ---------------------------------------------

      if (method === "GET" && path === "/api/platform/saas/tax-checklist") { const guard=requireSuperAdmin(); if(guard)return guard; return json({success:true,data:await commercial.listTaxChecklist(env)}); }
      if (method === "POST" && path === "/api/platform/saas/credit-packs/reconcile") { const guard=requireSuperAdmin(); if(guard)return guard; const result=await commercial.reconcileCreditPacks(env); await logAudit(env,{adminId:admin.id,endpoint:path,method,resource:'credit_pack_grants',action:'reconcile',success:result.ok,statusCode:result.ok? 200:502,requestId,ipHash}); return json({success:true,data:result}); }
      if (method === "GET" && path.startsWith("/platform/saas")) {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        if (path === "/platform/saas/site-access") {
          return html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site access operations</title><main style="max-width:1100px;margin:2rem auto;font:16px system-ui;padding:0 1rem"><h1>Site access operations</h1><p>Bulk reactivation is audited. Choose sites or whole organizations, enter a reason, then confirm.</p><p><a href="/platform/saas/access-shadow">Subscription access shadow report</a> · <a href="/platform/saas/site-access#failures">Push failures</a> · <a href="/platform/saas/alerts">Operational alerts</a></p><section><h2>Suspended sites and organizations</h2><label>Filter <input id="filter" type="search" placeholder="Organization or site"></label><div id="sites" aria-live="polite">Loading…</div><label for="reason">Reason (required)</label><textarea id="reason" required minlength="5" rows="3" style="display:block;width:100%;max-width:50rem"></textarea><button id="reactivate" type="button">Review and reactivate selected</button><pre id="result" aria-live="polite"></pre></section><section id="failures"><h2>Repeated push failures</h2><div id="pushFailures">Loading…</div></section></main><script nonce="${nonceToken()}">
const $=id=>document.getElementById(id);let allSites=[];
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function renderSites(){const q=$('filter').value.toLowerCase();const rows=allSites.filter(s=>(s.status==='suspended'||s.organization_status==='suspended'||s.organization_status==='closed')&&(String(s.name)+' '+String(s.organization_name)+' '+String(s.id)).toLowerCase().includes(q));const orgs=new Map();rows.forEach(function(s){if(!orgs.has(s.organization_id))orgs.set(s.organization_id,{name:s.organization_name,sites:[]});orgs.get(s.organization_id).sites.push(s)});$('sites').innerHTML=Array.from(orgs.entries()).map(function(pair){const id=pair[0],o=pair[1];return '<fieldset><legend><label><input type="checkbox" class="org" value="'+esc(id)+'"> Organization: '+esc(o.name)+' ('+o.sites.length+' sites)</label></legend>'+o.sites.map(function(s){return '<label style="display:block;margin:.3rem 1rem"><input type="checkbox" class="site" data-org="'+esc(id)+'" value="'+esc(s.id)+'" '+(s.status!=='suspended'?'disabled':'')+'> '+esc(s.name)+' — '+esc(s.status)+' '+(s.tenant_id?'':'(not provisioned)')+'</label>'}).join('')+'</fieldset>'}).join('')||'<p>No suspended or closed-organization sites found.</p>';document.querySelectorAll('.org').forEach(function(c){c.addEventListener('change',function(){document.querySelectorAll('.site[data-org="'+CSS.escape(c.value)+'"]:not(:disabled)').forEach(function(x){x.checked=c.checked})})})}
async function loadFailures(){const r=await fetch('/api/platform/saas/site-access/push-failures');const j=await r.json();$('pushFailures').innerHTML=(j.data||[]).map(function(x){return '<article><strong>'+esc(x.organization_name)+' / '+esc(x.site_name)+'</strong> — '+esc(x.desired_state)+'; attempts '+esc(x.attempts)+'<p>'+esc(x.last_error)+'</p><label>Retry reason <input id="why-'+esc(x.site_id)+'" required></label> <button data-retry="'+esc(x.site_id)+'">Retry push</button></article>'}).join('')||'<p>No failed pushes.</p>';document.querySelectorAll('[data-retry]').forEach(function(b){b.onclick=async function(){const id=b.dataset.retry,reason=$('why-'+id).value.trim();if(reason.length<5||!confirm('Retry tenant access push for '+id+'?'))return;const r=await fetch('/api/platform/saas/sites/'+encodeURIComponent(id)+'/access-push/retry',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({reason:reason})});$('result').textContent=JSON.stringify(await r.json(),null,2);await loadFailures()}})}
fetch('/api/platform/saas/site-access/sites').then(function(r){return r.json()}).then(function(j){allSites=j.data||[];renderSites()}).catch(function(e){$('sites').textContent='Unable to load sites: '+e.message});$('filter').addEventListener('input',renderSites);
$('reactivate').onclick=async function(){const reason=$('reason').value.trim();const ids=Array.from(document.querySelectorAll('.site:checked:not(:disabled)')).map(function(x){return x.value});document.querySelectorAll('.org:checked').forEach(function(c){document.querySelectorAll('.site[data-org="'+CSS.escape(c.value)+'"]:not(:disabled)').forEach(function(x){if(!ids.includes(x.value))ids.push(x.value)})});if(reason.length<5){$('result').textContent='A reason of at least five characters is required.';return}if(!ids.length){$('result').textContent='Select at least one suspended site or organization.';return}if(!confirm('Reactivate '+ids.length+' site(s)? This action will be audited.'))return;const r=await fetch('/api/platform/saas/sites/reactivate-bulk',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({siteIds:ids,reason:reason})});$('result').textContent=JSON.stringify(await r.json(),null,2);await Promise.all([loadFailures(),fetch('/api/platform/saas/site-access/sites').then(function(r){return r.json()}).then(function(j){allSites=j.data||[];renderSites()})])};loadFailures().catch(function(e){$('pushFailures').textContent='Unable to load failures: '+e.message});
</script></html>`);
        }
        if (path === "/platform/saas/access-shadow") {
          const rows = await billingLifecycleRepo.listShadow(env, { limit: 100 });
          const esc = (v) => String(v ?? "").replace(/[&<>\"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;", "\"":"&quot;", "'":"&#39;"}[c]));
          const body = (rows.results || []).map(r => `<tr><td>${esc(r.organization_name || r.organization_id)}</td><td>${esc(r.state)}</td><td>${esc(r.reason)}</td><td>${esc(r.evaluated_at)}</td></tr>`).join("");
          return html(`<!doctype html><html><meta charset="utf-8"><title>Access shadow report</title><h1>Subscription access shadow report</h1><p>Would-be access refusals only; shadow mode does not enforce.</p><table><thead><tr><th>Organization</th><th>State</th><th>Reason / entry point</th><th>Evaluated</th></tr></thead><tbody>${body}</tbody></table></html>`);
        }
        if (path === "/platform/saas") return html(await renderSaasOverview(env, admin));
        if (path === "/platform/saas/revenue-analytics") return html(await renderRevenueAnalyticsPage(env, admin, { trialPage: url.searchParams.get("trialPage") || 1, activationPage: url.searchParams.get("activationPage") || 1 }));
        if (path === "/platform/saas/organizations") return html(await renderOrganizationsPage(env, admin, { q: url.searchParams.get("q") || "", status: url.searchParams.get("status") || "", page: url.searchParams.get("page") }));
        if (path === "/platform/saas/subscriptions") return html(await renderSubscriptionsPage(env, admin, { status: url.searchParams.get("status") || "", page: url.searchParams.get("page") }));
        if (path === "/platform/saas/plans") return html(await renderPlansPage(env, admin));
        if (path === "/platform/saas/jobs") return html(await renderJobsPage(env, admin, { status: url.searchParams.get("status") || "", type: url.searchParams.get("type") || "", page: url.searchParams.get("page") }));
        if (path === "/platform/saas/email") return html(await renderEmailPage(env, admin));
        if (path === "/platform/saas/notifications") return html(await renderNotificationsPage(env, admin, { organization: url.searchParams.get("organization") || "", kind: url.searchParams.get("kind") || "", state: url.searchParams.get("state") || "", page: url.searchParams.get("page") }));
        if (path === "/platform/saas/releases") return html(await renderTenantTemplatePage(env, admin));
        const opStatus = url.searchParams.get("status") || "";
        if (path === "/platform/saas/key-rotation") return html(await renderKeyRotationPage(env, admin));
        if (path === "/platform/saas/cp-backups") return html(await renderCpBackupsPage(env, admin));
        if (path === "/platform/saas/alerts") return html(await renderOpsAlertsPage(env, admin));
        if (path === "/platform/saas/reconciliation") return html(await renderReconciliationPage(env, admin));
        if (path === "/platform/saas/errors") return html(await renderServerErrorsPage(env, admin));
        if (path === "/platform/saas/errors") return html(await renderServerErrorsPage(env, admin));
        if (path === "/platform/saas/domains") return html(await renderDomainsAdminPage(env, admin, { status: opStatus, page: url.searchParams.get("page") }));
        if (path === "/platform/saas/deployments") return html(await renderDeploymentsAdminPage(env, admin, { status: opStatus, page: url.searchParams.get("page") }));
        if (path === "/platform/saas/webhooks") return html(await renderWebhooksAdminPage(env, admin, { status: opStatus, page: url.searchParams.get("page") }));
        if (path === "/platform/saas/api-keys") return html(await renderApiKeysAdminPage(env, admin, { status: opStatus, page: url.searchParams.get("page") }));
        if (path === "/platform/saas/backups") return html(await renderBackupsAdminPage(env, admin, { status: opStatus, page: url.searchParams.get("page") }));
        if (path === "/platform/saas/coupons") return html(await renderCouponsPage(env, admin));
        if (path === "/platform/saas/quotes") return html(await renderPhase5StaffPage(env, admin, 'quotes'));
        if (path === "/platform/saas/customer-360") return html(await renderPhase5StaffPage(env, admin, 'customer-360'));
        if (path === "/platform/saas/dunning") return html(await renderPhase5StaffPage(env, admin, 'dunning'));
        if (path === "/platform/saas/approvals") return html(await renderPhase5StaffPage(env, admin, 'approvals'));
        if (path === "/platform/saas/catalog-drift") return html(await renderPhase5StaffPage(env, admin, 'catalog-drift'));
        if (path === "/platform/saas/tax") return html(await renderPhase5StaffPage(env, admin, 'tax'));
        if (path === "/platform/saas/webhook-replay") return html(await renderPhase5StaffPage(env, admin, 'webhook-replay'));
        const orgPage = matchPath("/platform/saas/organizations/:id", path);
        if (orgPage) { const page = await renderOrganizationDetailPage(env, admin, orgPage.id); return page ? html(page) : html("<h1>Not found</h1>", 404); }
        const jobPage = matchPath("/platform/saas/jobs/:id", path);
        if (jobPage) { const page = await renderJobDetailPage(env, admin, jobPage.id); return page ? html(page) : html("<h1>Not found</h1>", 404); }
      }

      // ---------------------------------------------
      // Platform — Lummet admin management (Phase 10, super-admin only)
      // ---------------------------------------------

      if (method === "GET" && path === "/platform/admins") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderAdminsList(env, admin, readFlash(url)));
      }

      if (path === "/platform/admins/new") {
        const guard = requireSuperAdmin();
        if (guard) return guard;

        if (method === "GET") return html(await renderNewAdminForm(env, admin, null));

        if (method === "POST") {
          const form = await parseForm(request);
          const result = await submitCreateAdmin(env, admin, form);

          await logAudit(env, {
            adminId: admin.id, tenantId: null, endpoint: path, method,
            resource: "lummet_admin", action: "create",
            success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
            errorMessage: result.ok ? `email:${result.email}` : result.error, requestId, ipHash
          });

          if (!result.ok) return html(await renderNewAdminForm(env, admin, describeAuthError(result.error)));
          return html(await renderAdminCreatedPage(env, admin, result.email, result.tempPassword));
        }
      }

      const adminDetailParams = matchPath("/platform/admins/:id", path);
      if (method === "GET" && adminDetailParams) {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderAdminDetail(env, admin, adminDetailParams.id, readFlash(url)));
      }

      if (method === "GET" && path === "/platform/api") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderApiReferencePage(env, admin));
      }

      if (method === "GET" && path === "/platform/credentials") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderCredentialsPage(env, admin));
      }

      if (method === "GET" && path === "/platform/audit-logs") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderAuditLogsPage(env, admin, Object.fromEntries(url.searchParams)));
      }

      if (method === "GET" && path === "/platform/capabilities") {
        const guard = requireSuperAdmin();
        if (guard) return guard;
        return html(await renderCapabilitiesPage(env, admin));
      }

      return html("Not found.", 404);
    } catch (error) {
      holder.error = error;   // fetch() logs and records it with the request id; nothing about the request is put in the log here
      if (isApiRoute) return json({ success: false, error: "internal_error", requestId }, 500);
      return html(`Something went wrong. If you contact support, quote this reference: ${requestId}`, 500);
    }
}

// Invoked by the Cron Trigger configured in wrangler.jsonc.
  // ctx.waitUntil keeps the Worker alive until both the health-check
  // sweep and the audit-log retention prune finish, since scheduled
  // handlers otherwise terminate as soon as the function returns.
async function runScheduled(event, env, ctx) {
  const cron = event && event.cron ? event.cron : scheduler.TICK_CRON;
  // Phase 3.5: daily reconciliation surfaces drift without changing local subscription/access state.
  // This branch records exactly one heartbeat with the reconciliation outcome below.
  if (scheduler.cronKind(cron) === "daily") {
    // Usage capture is an independent scheduled task: Stripe reconciliation failure must not suppress it.
    // Round 6.1A: one bounded step of the deterministic revenue backfill per day (a no-op once every subscription has a revenue state, and under REVENUE_METRICS=off).
    // Round 6.1B: then the daily revenue job writes revenue_snapshots from the ledger. Each step has its own failure handling, so a failed backfill never stops the job.
    ctx.waitUntil((async () => {
      try {
        const result = await runRevenueBackfillTick(env);
        console.log(JSON.stringify({ msg: "revenue_backfill_tick", ...result }));
      } catch (error) {
        console.error(JSON.stringify({ msg: "revenue_backfill_failed", error: error?.message || String(error) }));
      }
      try {
        const result = await runDailyRevenueJob(env);
        console.log(JSON.stringify({ msg: "revenue_daily_job", ...result }));
      } catch (error) {
        console.error(JSON.stringify({ msg: "revenue_daily_job_failed", error: error?.message || String(error) }));
      }
    })());
    ctx.waitUntil(captureDailyUsageSnapshots(env).then((result) => {
      console.log(JSON.stringify({ msg: "usage_snapshots_completed", organizations: result.organizations, metrics: result.metrics }));
    }).catch((error) => {
      console.error(JSON.stringify({ msg: "usage_snapshots_failed", error: error?.message || String(error) }));
    }));
    ctx.waitUntil((async () => {
      try {
        let afterId = "";
        let checked = 0;
        let findingCount = 0;
        while (true) {
          const page = await reconcileSubscriptions(env, {
            afterId, limit: 100,
            fetchSubscription: (id) => stripeRequest(env, "GET", `/subscriptions/${encodeURIComponent(id)}`)
          });
          checked += page.checked;
          findingCount += page.findings.length;
          if (!page.nextCursor) break;
          afterId = page.nextCursor;
        }
        console.log(JSON.stringify({msg:"billing_reconciliation_completed",checked,findings:findingCount}));
        await scheduler.recordTick(env, cron, {ok:true,detail:`reconciliation checked=${checked} findings=${findingCount}`});
      } catch (error) {
        console.error(JSON.stringify({msg:"billing_reconciliation_failed",error:error?.message || String(error)}));
        await scheduler.recordTick(env, cron, {ok:false,detail:error?.message || String(error)});
      }
    })());
    return;
  }
  // Weekly work is reserved for a later phase. Unknown crons fall through to the existing tick.
  if (scheduler.cronKind(cron) === "weekly") { ctx.waitUntil(scheduler.recordTick(env, cron)); return; }
  // Heartbeat first for the ordinary tick path: it proves the trigger fires even if work below fails.
  ctx.waitUntil(scheduler.recordTick(env, cron));

  ctx.waitUntil(runHealthChecks(env));
  ctx.waitUntil(siteAccess.processSiteAccessPushes(env).catch((error) => console.error(JSON.stringify({msg:"site_access_push_sweep_failed",error:error?.message||String(error)}))));
  ctx.waitUntil(storageSync.runStorageSync(env).catch((error) => console.error(JSON.stringify({msg:"storage_sync_failed",error:error?.message||String(error)}))));
  ctx.waitUntil(pruneOldAuditLogs(env));
  ctx.waitUntil(flushOutbox(env, { fetchImpl: typeof env.EMAIL_FETCH === "function" ? env.EMAIL_FETCH : fetch }).catch(() => {}));
  ctx.waitUntil(backups.purgeExpired(env).catch(() => {}));
  // Round 6.5A: synthetic monitors probe first, then the alert check reads what they recorded (SYNTHETIC_MONITORS=off is inert).
  ctx.waitUntil(runMonitorsThenAlertCheck(env));
  ctx.waitUntil(cpBackup.runControlPlaneBackupIfDue(env).catch(() => {}));
  ctx.waitUntil(erasure.purgeDueOrganizations(env).catch(() => {}));
  ctx.waitUntil(erasure.sweepExpiredFinancialRecords(env).catch(() => {}));
  ctx.waitUntil(jobRunner.sweepJobs(env, { launch: (p) => ctx.waitUntil(p.catch(() => {})), wait: false }).catch(() => {}));
  ctx.waitUntil(webhooksModule.sweepDeliveries(env).catch(() => {}));
  ctx.waitUntil(rollouts.advanceRunning(env, { dispatch: makeRolloutDispatch(env, ctx, { inline: false }) }).catch(() => {}));
  ctx.waitUntil(automationSweep.sweepTrackingLinkEvents(env).catch(() => {}));
  ctx.waitUntil(requestErrorsRepo.purgeOlderThanDays(env, 14).catch(() => {}));
  // Billing lifecycle (Phase 1.2). Failures are logged, never swallowed: this path decides who keeps access.
  ctx.waitUntil(billingLifecycle.sweep(env, Date.now(), { billingService: billing }).catch(logLifecycleFailure));
  // Billing emails (Phase 2.1): finish unqueued notifications, then deliver, then record what was delivered.
  ctx.waitUntil(billingReminders.sweepReminders(env).then(() => billingNotifications.drain(env)).then(() => flushOutbox(env)).then(() => billingNotifications.drain(env)).catch(logNotificationFailure));
}

// Round 6.5A. Probes first, so the alert check sees this tick's result. A failure of the probe run itself is logged and must not stop the
// alert check (the other alerts still need to go out); nothing is recorded as ok in that case, so the monitors go stale and page.
async function runMonitorsThenAlertCheck(env) {
  try {
    const run = await runSyntheticMonitors(env);
    if (!run.skipped) console.log(JSON.stringify({ msg: "synthetic_monitors_tick", mode: run.mode, results: run.results.map((r) => `${r.monitor}:${r.status}`) }));
  } catch (error) {
    console.error(JSON.stringify({ msg: "synthetic_monitors_run_failed", errorName: error && error.name ? String(error.name).slice(0, 40) : "Error" }));
  }
  await alerts.runAlertCheck(env).catch(() => {});
}

async function captureDailyUsageSnapshots(env) {
  // Paginate by stable organization ID; snapshot writes are idempotent per organization/day/metric.
  let afterId = "";
  let organizations = 0;
  let metrics = 0;
  while (true) {
    const rows = await organizationsRepo.selectOrganizationIdsAfter(env, afterId, 100);
    if (!rows.length) break;
    for (const row of rows) {
      const usage = await getUsageSnapshot(env, row.id);
      const result = await commercial.captureUsageSnapshot(env, row.id, usage, { source: "daily_scheduler" });
      organizations++;
      metrics += result.written || 0;
    }
    afterId = rows[rows.length - 1].id;
    if (rows.length < 100) break;
  }
  return { organizations, metrics };
}

function logNotificationFailure(error) {
  console.error(JSON.stringify({ msg: "billing_notification_tick_failed", error: error?.message || String(error) }));
}

function logLifecycleFailure(error) {
  console.error(JSON.stringify({ msg: "billing_lifecycle_sweep_failed", error: error?.message || String(error) }));
}

// -----------------------------------------------------
// /content/* and /system/* routing
// Handles: the special key/value "settings" screen, the
// generic CRUD screens for every resource configured in
// resources.js, and falls back to the placeholder page for
// nav items with no Super API backing yet (permissions,
// components).
// -----------------------------------------------------

async function handleResourceRoutes(request, env, admin, path, method, requestId, ipHash) {
  const sectionMatch = path.match(/^\/(content|system)\//);
  if (!sectionMatch) return null;

  const section = sectionMatch[1];
  const sectionLabel = section === "content" ? "Content" : "System";

  // RBAC (Phase 10) — every Content/System route acts on whichever
  // tenant is currently active, so both "does this admin still have
  // access to that tenant at all" and "does this admin hold the
  // specific resource/action grant" are checked before anything else.
  const forbiddenHtml = () =>
    html(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;">
      <h1>403 — Forbidden</h1><p>You don't have access to this. Ask a super admin to grant it.</p>
      <a href="/dashboard">Back to dashboard</a></body></html>`, 403);
  const forbiddenJson = () => json({ success: false, error: "forbidden" }, 403);

  if (!(await canAccessTenant(env, admin, admin.activeTenantId))) {
    return method === "POST" && path.endsWith("/delete") ? forbiddenJson() : forbiddenHtml();
  }

  async function checkResourcePermission(resourceKey, action, isJsonRoute) {
    const allowed = await hasPermission(env, admin, "tenant", resourceKey, action);
    if (allowed) return null;
    return isJsonRoute ? forbiddenJson() : forbiddenHtml();
  }

  if (section === "system") {
    if (method === "GET" && path === "/system/settings") {
      const guard = await checkResourcePermission("settings", "read", false);
      if (guard) return guard;
      return html(await renderSettingsPage(env, admin, readFlash(new URL(request.url))));
    }

    if (method === "POST" && path === "/system/settings") {
      const guard = await checkResourcePermission("settings", "update", false);
      if (guard) return guard;
      const form = await parseForm(request);
      const result = await submitSettings(env, admin, form);

      await logAudit(env, {
        adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
        resource: "settings", action: "update",
        success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
        errorMessage: result.ok ? null : result.message || result.error || result.reason,
        requestId, ipHash
      });

      const flashParam = result.ok
        ? "flash=Settings+saved&flash_type=success"
        : `flash=${encodeURIComponent(result.message || "Could not save settings")}&flash_type=error`;

      return redirect(`/system/settings?${flashParam}`);
    }

    if (method === "GET" && path === "/system/media/new") {
      const guard = await checkResourcePermission("media", "create", false);
      if (guard) return guard;
      return html(await renderMediaUploadForm(env, admin));
    }

    if (method === "GET" && path === "/system/permissions") {
      const guard = await checkResourcePermission("users", "read", false);
      if (guard) return guard;
      return html(await renderPermissionsMatrix(env, admin));
    }

    const itemAccessParams = matchPath("/system/users/:id/item-access", path);
    if (method === "GET" && itemAccessParams) {
      const guard = await checkResourcePermission("users", "read", false);
      if (guard) return guard;
      return html(await renderUserItemAccess(env, admin, itemAccessParams.id));
    }
  }

  if (section === "content") {
    const reviewBlocksParams = matchPath("/content/reviews/:slug/blocks", path);
    if (method === "GET" && reviewBlocksParams) {
      const guard = await checkResourcePermission("reviews", "read", false);
      if (guard) return guard;
      return html(await renderReviewBlocksPage(env, admin, reviewBlocksParams.slug));
    }

    const newsroomTagsParams = matchPath("/content/news/:slug/newsroom", path);
    if (method === "GET" && newsroomTagsParams) {
      const guard = await checkResourcePermission("news", "read", false);
      if (guard) return guard;
      return html(await renderNewsroomTagsPage(env, admin, newsroomTagsParams.slug));
    }

    if (method === "GET" && path === "/content/reports") {
      const guard = await checkResourcePermission("reports", "read", false);
      if (guard) return guard;
      return html(await renderReportsPage(env, admin));
    }

    if (method === "GET" && path === "/content/alerts") {
      const guard = await checkResourcePermission("analytics_alerts", "read", false);
      if (guard) return guard;
      return html(await renderAlertsPage(env, admin));
    }

    if (method === "GET" && path === "/content/analytics") {
      const guard = await checkResourcePermission("analytics", "read", false);
      if (guard) return guard;
      return html(await renderAnalyticsPage(env, admin, Object.fromEntries(new URL(request.url).searchParams)));
    }

    if (method === "GET" && path === "/content/seo") {
      const guard = await checkResourcePermission("seo", "read", false);
      if (guard) return guard;
      return html(await renderSeoMetaPage(env, admin));
    }

    if (method === "GET" && path === "/content/integrations") {
      const guard = await checkResourcePermission("postback_configs", "read", false);
      if (guard) return guard;
      return html(await renderIntegrationsPage(env, admin));
    }

    if (method === "GET" && path === "/content/ai-tools") {
      const guard = await checkResourcePermission("ai_tools", "read", false);
      if (guard) return guard;
      return html(await renderAiToolsPage(env, admin));
    }

    if (method === "GET" && path === "/content/support") {
      const guard = await checkResourcePermission("inquiries", "read", false);
      if (guard) return guard;
      return html(await renderSupportPage(env, admin));
    }

    if (method === "GET" && path === "/content/newsletter") {
      const guard = await checkResourcePermission("newsletter", "read", false);
      if (guard) return guard;
      return html(await renderNewsletterPage(env, admin));
    }

    if (method === "GET" && path === "/content/countries") {
      const guard = await checkResourcePermission("countries", "read", false);
      if (guard) return guard;
      return html(await renderCountriesList(env, admin));
    }
    if (method === "GET" && path === "/content/countries/new") {
      const guard = await checkResourcePermission("countries", "create", false);
      if (guard) return guard;
      return html(await renderCountryForm(env, admin, null));
    }
    const countryEditParams = matchPath("/content/countries/:code/edit", path);
    if (method === "GET" && countryEditParams) {
      const guard = await checkResourcePermission("countries", "update", false);
      if (guard) return guard;
      return html(await renderCountryForm(env, admin, countryEditParams.code));
    }

    if (method === "GET" && path === "/content/categories") {
      const guard = await checkResourcePermission("categories", "read", false);
      if (guard) return guard;
      return html(await renderCategoriesList(env, admin));
    }
    if (method === "GET" && path === "/content/categories/new") {
      const guard = await checkResourcePermission("categories", "create", false);
      if (guard) return guard;
      return html(await renderCategoryForm(env, admin, null));
    }
    const categoryEditParams = matchPath("/content/categories/:slug/edit", path);
    if (method === "GET" && categoryEditParams) {
      const guard = await checkResourcePermission("categories", "update", false);
      if (guard) return guard;
      return html(await renderCategoryForm(env, admin, categoryEditParams.slug));
    }

    if (method === "GET" && path === "/content/country-pages") {
      const guard = await checkResourcePermission("seo_pages", "read", false);
      if (guard) return guard;
      return html(await renderCountryPagesList(env, admin));
    }
    if (method === "GET" && path === "/content/country-pages/new") {
      const guard = await checkResourcePermission("seo_pages", "create", false);
      if (guard) return guard;
      return html(await renderCountryPageForm(env, admin, null));
    }
    const countryPageEditParams = matchPath("/content/country-pages/:id/edit", path);
    if (method === "GET" && countryPageEditParams) {
      const guard = await checkResourcePermission("seo_pages", "update", false);
      if (guard) return guard;
      return html(await renderCountryPageForm(env, admin, countryPageEditParams.id));
    }

    if (method === "GET" && path === "/content/category-countries") {
      const guard = await checkResourcePermission("seo_pages", "read", false);
      if (guard) return guard;
      return html(await renderCategoryCountriesList(env, admin));
    }
    if (method === "GET" && path === "/content/category-countries/new") {
      const guard = await checkResourcePermission("seo_pages", "create", false);
      if (guard) return guard;
      return html(await renderCategoryCountryForm(env, admin, null));
    }
    const categoryCountryEditParams = matchPath("/content/category-countries/:id/edit", path);
    if (method === "GET" && categoryCountryEditParams) {
      const guard = await checkResourcePermission("seo_pages", "update", false);
      if (guard) return guard;
      return html(await renderCategoryCountryForm(env, admin, categoryCountryEditParams.id));
    }
  }

  const newParams = matchPath(`/${section}/:resource/new`, path);
  const editParams = matchPath(`/${section}/:resource/:id/edit`, path);
  const deleteParams = matchPath(`/${section}/:resource/:id/delete`, path);
  const toggleFieldParams = matchPath(`/${section}/:resource/:id/toggle-field`, path);
  const listParams = matchPath(`/${section}/:resource`, path);

  const resourceKey = (newParams || editParams || deleteParams || toggleFieldParams || listParams)?.resource;
  if (!resourceKey) return null;

  const config = getResourceConfig(resourceKey);
  const activeKey = `${section}-${resourceKey}`;

  if (!config || config.section !== sectionLabel) {
    if (method === "GET" && listParams) {
      return html(await renderResourcePlaceholder(env, admin, sectionLabel, resourceKey, activeKey));
    }
    return null;
  }

  const base = `/${section}/${resourceKey}`;

  if (method === "GET" && newParams && config.supportsCreate) {
    const guard = await checkResourcePermission(resourceKey, "create", false);
    if (guard) return guard;
    return html(await renderResourceForm(env, admin, resourceKey, config, null));
  }

  if (method === "POST" && newParams && config.supportsCreate) {
    const guard = await checkResourcePermission(resourceKey, "create", false);
    if (guard) return guard;
    const form = await parseForm(request);
    const result = await submitCreate(env, admin, resourceKey, config, form);

    await logAudit(env, {
      adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
      resource: resourceKey, action: "create",
      success: result.ok, statusCode: result.ok ? 201 : result.status || 400,
      errorMessage: result.ok ? null : result.message || result.error || result.reason,
      requestId, ipHash
    });

    if (!result.ok) {
      return html(
        await renderResourceForm(env, admin, resourceKey, config, null, result.message || "Could not create.")
      );
    }
    return redirect(`${base}?flash=Created&flash_type=success`);
  }

  if (method === "GET" && editParams) {
    const guard = await checkResourcePermission(resourceKey, "read", false);
    if (guard) return guard;
    return html(await renderResourceForm(env, admin, resourceKey, config, editParams.id));
  }

  if (method === "POST" && editParams) {
    const guard = await checkResourcePermission(resourceKey, "update", false);
    if (guard) return guard;
    const form = await parseForm(request);
    const result = await submitUpdate(env, admin, resourceKey, config, editParams.id, form);

    await logAudit(env, {
      adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
      resource: resourceKey, resourceId: editParams.id, action: "update",
      success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
      errorMessage: result.ok ? null : result.message || result.error || result.reason,
      requestId, ipHash
    });

    if (!result.ok) {
      return html(
        await renderResourceForm(env, admin, resourceKey, config, editParams.id, result.message || "Could not save changes.")
      );
    }
    return redirect(`${base}?flash=Saved&flash_type=success`);
  }

  if (method === "POST" && deleteParams && config.supportsDelete) {
    const guard = await checkResourcePermission(resourceKey, "delete", true);
    if (guard) return guard;
    const result = await submitDelete(env, admin, resourceKey, deleteParams.id);

    await logAudit(env, {
      adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
      resource: resourceKey, resourceId: deleteParams.id, action: "delete",
      success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
      errorMessage: result.ok ? null : result.message || result.error || result.reason,
      requestId, ipHash
    });

    return json(
      { success: result.ok, error: result.ok ? undefined : result.reason || result.error },
      result.ok ? 200 : result.status || 400
    );
  }

  if (method === "POST" && toggleFieldParams) {
    const guard = await checkResourcePermission(resourceKey, "update", true);
    if (guard) return guard;

    const payload = await request.json().catch(() => ({}));
    const toggleConfig = config.listColumns.find((c) => c.toggle && c.key === payload.field);
    if (!toggleConfig) return json({ success: false, error: "not_toggleable" }, 422);

    const result = await submitToggleField(env, admin, resourceKey, toggleFieldParams.id, {
      key: toggleConfig.key,
      pairField: toggleConfig.toggle.pairField,
      pairOnValue: toggleConfig.toggle.pairOnValue,
      pairOffValue: toggleConfig.toggle.pairOffValue
    });

    await logAudit(env, {
      adminId: admin.id, tenantId: admin.activeTenantId, endpoint: path, method,
      resource: resourceKey, resourceId: toggleFieldParams.id, action: `toggle_${toggleConfig.key}`,
      success: result.ok, statusCode: result.ok ? 200 : result.status || 400,
      errorMessage: result.ok ? null : result.message || result.error || result.reason,
      requestId, ipHash
    });

    return json(
      { success: result.ok, error: result.ok ? undefined : result.reason || result.error },
      result.ok ? 200 : result.status || 400
    );
  }

  if (method === "GET" && listParams) {
    const guard = await checkResourcePermission(resourceKey, "read", false);
    if (guard) return guard;
    return html(await renderResourceList(env, admin, resourceKey, config, readFlash(new URL(request.url)), new URL(request.url).searchParams));
  }

  return null;
}

function readFlash(url) {
  const message = url.searchParams.get("flash");
  const type = url.searchParams.get("flash_type") === "error" ? "error" : "success";
  return message ? { message, type } : null;
}

function describeAuthError(code) {
  const map = {
    invalid_credentials: "Incorrect email or password.",
    too_many_attempts: "Too many attempts. Try again in 15 minutes.",
    email_and_password_required: "Email and password are required.",
    already_bootstrapped: "An admin account already exists — please log in instead.",
    invalid_email_or_password: "Please provide a valid email and a password of at least 12 characters.",
    email_required: "Email is required.",
    invalid_role: "Please choose a valid role.",
    email_already_registered: "That email is already registered.",
    invalid_code: "That code is not correct. Try the next code from your app.",
    code_already_used: "That code was already used. Wait for the next code and try again.",
    invalid_backup_code: "That backup code is not valid.",
    code_or_backup_code_required: "Enter your authenticator code or a backup code.",
    mfa_restart: "That sign-in expired. Please log in again.",
    account_disabled: "This account is disabled."
  };
  return map[code] || "Something went wrong. Please try again.";
}

function describePasswordError(code) {
  const map = {
    passwords_do_not_match: "The new password and confirmation don't match.",
    password_too_short: "New password must be at least 12 characters.",
    invalid_current_password: "Current password is incorrect.",
    not_found: "Account not found."
  };
  return map[code] || "Could not change password. Please try again.";
}

function describeRegistryError(code) {
  const map = {
    name_and_host_required: "Name and host are required.",
    host_already_registered: "A tenant with this host is already registered.",
    credential_generation_failed: "Could not generate a credential — check that CREDENTIAL_KEK is configured on this Worker."
  };
  return map[code] || "Could not register this tenant.";
}
