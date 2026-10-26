// =====================================================
// OPERATIONAL ALERTS (roadmap 2.2)
//
// runAlertCheck() looks for problems that need a human, and tells
// one when a problem STARTS, reminds while it persists, and says when
// it is RESOLVED. Messages contain counts only, never customer data.
//
// Channels (either or both):
//   ALERT_WEBHOOK_URL - Slack/Discord-style incoming webhook ({text}).
//                       Independent of the email provider, so it still
//                       works if email itself is what broke.
//   ALERT_EMAIL       - queued through the normal email outbox.
//
// Something must call this on a schedule. Cron Triggers are not on
// the current plan, so besides scheduled() there is a token-protected
// endpoint (POST /api/ops/alert-check) an external uptime pinger can
// hit every few minutes. See docs/ALERTING.md.
// =====================================================
import { queueEmail, flushOutbox, portalLink } from "./email.js";
import { checkOutboundUrl } from "./url-safety.js";
import * as repo from "./repositories/alert-state.js";
import { configIssues } from "./config-check.js";
import { billingConfig } from "./billing-config.js";
import { MONITORS, monitorAlertCount, monitorAlertDetail } from "./synthetic-monitors.js";

export const REMINDER_HOURS = 6;

const CHECKS = [
  { key: "failed_jobs", title: "Failed background jobs", path: "/platform/saas/jobs?status=failed", },
  { key: "stuck_jobs", title: "Jobs stuck for over 30 minutes", path: "/platform/saas/jobs", },
  { key: "dead_jobs", title: "Background jobs the system gave up retrying (dead-lettered)", path: "/platform/saas/jobs?status=failed", },
  { key: "dead_webhook_deliveries", title: "Webhook deliveries that ran out of retries (10 or more in 24 hours)", path: "/platform/saas/webhooks", },
  { key: "failed_sites", title: "Sites in a failed state", path: "/platform/saas/organizations", },
  { key: "past_due", title: "Subscriptions with a failed payment (past due)", path: "/platform/saas/subscriptions?status=past_due", },
  { key: "failed_emails", title: "Emails that could not be delivered", path: "/platform/saas/email", },
  { key: "stale_email_queue", title: "Emails queued for over 30 minutes", path: "/platform/saas/email", },
  { key: "unhealthy_tenants", title: "Tenants failing health checks", path: "/tenants/health", },
  { key: "incomplete_deletions", title: "Organization or account deletions that could not fully clean up (external resources may be left behind)", path: "/platform/saas/organizations", },
  { key: "server_errors", title: "Server errors in the last 15 minutes (5 or more)", path: "/platform/saas/errors", },
  { key: "failed_billing_webhooks", title: "Billing webhook events that failed processing (last 7 days)", path: "/platform/saas/subscriptions", },
  { key: "failed_rollout", title: "The latest tenant release rollout stopped on a failure (the remaining sites are still on the old version)", path: "/platform/saas/deployments", },
  { key: "failed_domains", title: "Custom domains the platform could not connect (Cloudflare zone failed or hostname will not attach)", path: "/platform/saas/domains", },
  { key: "cron_not_running", title: "The scheduled tick has stopped (no five-minute run recorded in 20 minutes)", path: "/platform/saas", },
  { key: "cancel_pending_stuck", title: "Stripe cancellations for deleted organizations still failing after 24 hours (customers may still be billed)", path: "/platform/saas/subscriptions", },
  { key: "webhook_wrong_mode", title: "Stripe webhook events refused because they came from the wrong mode (test event in production or the reverse)", path: "/platform/saas/subscriptions", },
  { key: "unknown_price_id", title: "Stripe subscriptions on a price Lummet does not know (their plan could not be synced; add the price to the catalog and run the sync, or resolve the issue)", path: "/platform/saas/subscriptions", },
  { key: "dispute_open", title: "Open payment dispute requires finance review", path: "/platform/saas/reconciliation", },
  { key: "site_access_push_failed", title: "Tenant site-access state push repeatedly failed", path: "/platform/saas/alerts", },
  { key: "reconcile_drift", title: "Billing reconciliation drift awaiting staff decision", path: "/platform/saas/reconciliation", },
  { key: "trial_expired_still_live", title: "Expired trials whose sites are still live after the suspension point (check the enforcement sweep and BILLING_SUSPEND_SITES)", path: "/platform/saas/subscriptions", },
  { key: "webhook_lag", title: "Outgoing customer webhook deliveries are overdue (not sent or not retried on schedule for over 5 minutes)", path: "/platform/saas/webhooks", },
  { key: "plan_change_stuck", title: "Customer plan changes not confirmed by Stripe after an hour (the customer may be billed for a plan they do not have yet)", path: "/platform/saas/subscriptions", },
  { key: "email_bounce_rate", title: "Email bounce or complaint rate is high (5% or more of the last 24 hours, or 3+ complaints): check the sending domain and recent templates", path: "/platform/saas/email", },
  { key: "billing_email_stuck", title: "Billing notifications recorded but not queued for over 30 minutes (customers are not being told about billing events)", path: "/platform/saas/notifications?state=stuck", },
  // Round 6.5A: synthetic monitors. Each pages through exactly this machinery (once when it starts, reminders, resolved).
  // The count is the number of consecutive failed probes once it reaches SYNTHETIC_FAILURE_THRESHOLD (or a stale result);
  // it is 0 unless SYNTHETIC_MONITORS=on. The reason shown is a code, never a value. See docs/SYNTHETIC_MONITORS.md.
  ...MONITORS.map((m) => ({
    key: m.alertKey, title: m.alertTitle, path: "/platform/saas/alerts",
    count: (env, now) => monitorAlertCount(env, m.name, now),
    detail: (env, now) => monitorAlertDetail(env, m.name, now)
  })),
  // Names of missing production settings (never values). Counted from env, not the database.
  { key: "config_incomplete", title: "Production configuration is incomplete", path: "/platform/saas",
    count: (env) => configIssues(env).length,
    detail: (env) => `Missing: ${configIssues(env).map((i) => i.key).join(", ")}` },
  // Only checked once backup storage exists, so an unconfigured feature never alerts.
  { key: "backup_stale", title: "No successful control-plane backup in the last 36 hours", path: "/platform/saas/cp-backups",
    when: (env) => !!env.BACKUPS, }
];

async function sendWebhook(env, text, fetchImpl) {
  const target = env.ALERT_WEBHOOK_URL;
  if (!target) return { configured: false };
  if (!checkOutboundUrl(target).ok) return { configured: true, ok: false, error: "alert_webhook_url_not_allowed" };
  try {
    const res = await fetchImpl(target, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(8000),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text })      // Slack reads "text", Discord reads "content"
    });
    return { configured: true, ok: res.ok, error: res.ok ? null : `http_${res.status}` };
  } catch (_) {
    return { configured: true, ok: false, error: "request_failed" };
  }
}

async function sendEmail(env, subject, message, dedupeKey, fetchImpl) {
  if (!env.ALERT_EMAIL) return { configured: false };
  const link = portalLink(env, "/platform/saas");
  const queued = await queueEmail(env, { to: env.ALERT_EMAIL, template: "notification", vars: { subject, message, link }, dedupeKey });
  if (!queued.ok) return { configured: true, ok: false, error: queued.error };
  const flush = await flushOutbox(env, { fetchImpl }).catch(() => null);
  // Queued is durable: the outbox retries on its own. Count as delivered-to-queue.
  return { configured: true, ok: true, queued: true, flushed: flush };
}

/** Sends through every configured channel. ok = at least one channel took it. */
async function notify(env, subject, message, dedupeKey, fetchImpl) {
  const [hook, mail] = [await sendWebhook(env, `${subject}\n${message}`, fetchImpl), await sendEmail(env, subject, message, dedupeKey, fetchImpl)];
  const configured = hook.configured || mail.configured;
  return { configured, ok: (hook.ok === true) || (mail.ok === true) };
}

export async function runAlertCheck(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.ALERT_WEBHOOK_URL && !env.ALERT_EMAIL) return { ok: true, skipped: "no_alert_channel_configured" };

  const results = [];
  for (const check of CHECKS) {
    if (check.when && !check.when(env)) continue;
    const count = check.count ? await check.count(env, now) : await countFor(env, check.key);
    const detail = count > 0 && check.detail ? ` ${await check.detail(env, now)}.` : "";
    const state = await repo.get(env, check.key);
    const wasFiring = !!(state && state.firing);
    const nowIso = new Date(now).toISOString();
    const where = portalLink(env, check.path);
    const stamp = Math.floor(now / 1000);

    if (count > 0) {
      const reminderDue = wasFiring && state.last_notified_at &&
        now - Date.parse(state.last_notified_at.replace(" ", "T") + (state.last_notified_at.endsWith("Z") ? "" : "Z")) >= REMINDER_HOURS * 3600 * 1000;
      if (!wasFiring || reminderDue) {
        const kind = wasFiring ? "Still happening" : "New problem";
        const sent = await notify(env, `[Lummet alert] ${check.title}`, `${kind}: ${check.title}. Count: ${count}.${detail}${where ? ` ${where}` : ""}`, `alert:${check.key}:${stamp}`, fetchImpl);
        if (sent.ok) {
          await repo.markFiring(env, check.key, count, nowIso);
        }
        // Not recorded when delivery failed: the next check tries again.
        results.push({ key: check.key, count, action: sent.ok ? (wasFiring ? "reminded" : "notified") : "notify_failed" });
      } else {
        await repo.touchCount(env, check.key, count, nowIso);
        results.push({ key: check.key, count, action: "still_firing_quiet" });
      }
    } else if (wasFiring) {
      const sent = await notify(env, `[Lummet resolved] ${check.title}`, `Resolved: ${check.title} is back to zero.`, `alert:${check.key}:resolved:${stamp}`, fetchImpl);
      if (sent.ok) {
        await repo.markResolved(env, check.key, nowIso);
      }
      results.push({ key: check.key, count: 0, action: sent.ok ? "resolved" : "notify_failed" });
    } else {
      results.push({ key: check.key, count: 0, action: "ok" });
    }
  }
  return { ok: true, results };
}

export async function listAlertState(env) {
  return repo.listAll(env);
}

/**
 * Checks that need billing configuration live here, not in the repository (a repository imports only other repositories).
 * Everything else is the repository's own query.
 */
async function countFor(env, key) {
  if (key === "trial_expired_still_live") {
    // Round 6.2B (blueprint 6.2, ENFORCEMENT_CUTOVER step 3): an expired local trial whose site still serves after the access
    // ladder (access.js timeLadder: live and read-only for BILLING_RESTRICTED_DAYS, restricted for the same number again) says
    // it should be suspended. Evaluated only when BILLING_SUSPEND_SITES is shadow or enforce: with it off sites are never
    // suspended by design, so an alert would be permanent noise. A trial with a payment provider behind it is converted by the
    // provider and is not counted. Counts organizations, never customer data.
    const cfg = billingConfig(env);
    if (cfg.suspendSitesMode === "off") return 0;
    return repo.countExpiredTrialsStillLive(env, cfg.restrictedDays * 2);
  }
  return repo.countFor(env, key);
}

/** Live count for one alert check, using the same query the alert run uses (for staff tiles). */
export async function countAlert(env, key) {
  return countFor(env, key);
}

/** Constant-time comparison for the shared check token. */
export async function tokenMatches(provided, expected) {
  if (!expected || !provided) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(provided)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
