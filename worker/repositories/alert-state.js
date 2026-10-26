// Operational alert state and the health counts the alert checks read. (Repository.)

import * as billingNotifications from "./billing-notifications.js";

const COUNT_QUERIES = {
  failed_jobs: `SELECT COUNT(*) n FROM jobs WHERE status = 'failed' AND created_at > datetime('now','-24 hours')`,
  stuck_jobs: `SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running') AND created_at < datetime('now','-30 minutes')`,
  // Jobs the sweep gave up on (retries used up, or not retryable). Clears when staff retry or requeue them.
  dead_jobs: `SELECT COUNT(*) n FROM jobs WHERE dead_lettered_at IS NOT NULL AND dead_lettered_at > datetime('now','-7 days')`,
  // One customer's dead endpoint is that customer's business; this fires only on a spike (10+ in 24h), which points at a platform-side problem.
  dead_webhook_deliveries: `SELECT CASE WHEN COUNT(*) >= 10 THEN COUNT(*) ELSE 0 END n FROM webhook_deliveries WHERE status = 'dead' AND COALESCE(last_attempt_at, created_at) > datetime('now','-24 hours')`,
  failed_sites: `SELECT COUNT(*) n FROM sites WHERE status = 'failed'`,
  past_due: `SELECT COUNT(*) n FROM subscriptions WHERE status = 'past_due'`,
  failed_emails: `SELECT COUNT(*) n FROM email_outbox WHERE status = 'failed'`,
  stale_email_queue: `SELECT COUNT(*) n FROM email_outbox WHERE status = 'queued' AND created_at < datetime('now','-30 minutes')`,
  // Active tenants whose latest health check is anything but Online. Disabled tenants are expected to be down.
  unhealthy_tenants: `SELECT COUNT(*) n FROM tenant_health th JOIN tenants t ON t.id = th.tenant_id WHERE t.status = 'active' AND th.status NOT IN ('Online','Disabled')`,
  // An erasure whose MOST RECENT attempt is partial or failed (external resources left behind, retried on the next run).
  // An organization whose deletion staff later stopped is no longer retried, so it does not count.
  incomplete_deletions: `SELECT COUNT(*) n FROM erasure_log e WHERE e.status IN ('partial','failed')
    AND (e.kind != 'organization' OR EXISTS (SELECT 1 FROM organizations o WHERE o.id = e.subject_id AND o.scheduled_deletion_at IS NOT NULL AND o.erased_at IS NULL))
    AND e.id = (SELECT e2.id FROM erasure_log e2 WHERE e2.kind = e.kind AND e2.subject_id = e.subject_id ORDER BY e2.created_at DESC, e2.rowid DESC LIMIT 1)`,
  // 7-day window so an old failure the provider never retried does not alert forever.
  // 5 or more server errors (5xx or unhandled exceptions) within 15 minutes; below that it is noise, not an incident.
  server_errors: `SELECT CASE WHEN COUNT(*) >= 5 THEN COUNT(*) ELSE 0 END n FROM request_errors WHERE created_at >= datetime('now','-15 minutes')`,
  failed_billing_webhooks: `SELECT COUNT(*) n FROM billing_webhook_events WHERE status = 'failed' AND received_at >= datetime('now','-7 days')`,
  // Custom domains the platform could not connect: a zone that failed in the last 14 days, or an active zone whose
  // hostname keeps failing to attach. A customer who simply has not changed their nameservers yet is NOT an incident.
  // Only the LATEST rollout counts: once staff resume it, cancel it, or a newer one runs, the alert clears.
  failed_rollout: `SELECT COUNT(*) AS n FROM tenant_rollouts WHERE status = 'failed' AND id = (SELECT id FROM tenant_rollouts ORDER BY created_at DESC, rowid DESC LIMIT 1)`,
  failed_domains: `SELECT (SELECT COUNT(*) FROM domain_zones WHERE status = 'failed' AND updated_at >= datetime('now','-14 days'))
    + (SELECT COUNT(*) FROM domains WHERE method = 'nameservers' AND status = 'dns_verified' AND failure_reason IS NOT NULL) AS n`,
  // Phase 0.2: no five-minute tick recorded for 20 minutes means the Cron Trigger is not running at all.
  // Only evaluated once at least one tick has EVER been recorded, so a fresh install does not alert before its first tick.
  cron_not_running: `SELECT CASE WHEN (SELECT COUNT(*) FROM scheduler_ticks WHERE cron = '*/5 * * * *') > 0
      AND COALESCE((SELECT MAX(ran_at) FROM scheduler_ticks WHERE cron = '*/5 * * * *'), '1970-01-01') < datetime('now','-20 minutes') THEN 1 ELSE 0 END n`,
  // Phase 1.5: a Stripe cancellation for a deleted organization that has not gone through for 24 hours.
  cancel_pending_stuck: `SELECT COUNT(*) n FROM billing_cancel_pending WHERE created_at < datetime('now','-24 hours')`,
  // Phase 0.3: webhook events refused by the livemode guard in the last 24 hours.
  webhook_wrong_mode: `SELECT COUNT(*) n FROM billing_webhook_rejections WHERE created_at >= datetime('now','-24 hours')`,
  // Phase 3.2: a Stripe subscription is on a price Lummet's plan_prices does not hold, so its plan could not be synced.
  // Clears when the price is added by the catalog sync (the next event for the subscription closes it) or staff resolve it.
  unknown_price_id: `SELECT COUNT(*) n FROM plan_sync_issues WHERE kind = 'unknown_price_id' AND resolved_at IS NULL`,
  // Phase 3.2: a customer's plan change still unconfirmed by Stripe after an hour (sent but no webhook, or never sent).
  plan_change_stuck: `SELECT COUNT(*) n FROM plan_change_intents WHERE status IN ('pending','submitted') AND direction != 'downgrade' AND updated_at < datetime('now','-60 minutes')`,
  site_access_push_failed: `SELECT COUNT(*) n FROM site_access_push_jobs WHERE status = 'failed' AND updated_at >= datetime('now','-7 days')`,
  reconcile_drift: `SELECT COUNT(*) n FROM reconciliation_findings WHERE status = 'open'`,
  // Round 6.2B. Outgoing customer-webhook deliveries that the retry machinery should already have handled.
  // A delivery that is waiting out its normal backoff (1, 5, 30, 120, 360 minutes, see worker/webhooks.js) is NOT lag.
  // Lag = never started (pending) or in flight (retrying) with no activity for over 5 minutes, or a failed delivery
  // whose next retry was due more than 10 minutes ago (the sweep runs every 5 minutes). Deliveries older than the
  // three-day retry window are expired by the sweep itself and are not counted.
  webhook_lag: `SELECT COUNT(*) n FROM webhook_deliveries
    WHERE created_at >= datetime('now','-3 days')
      AND ((status IN ('pending','retrying') AND COALESCE(last_attempt_at, created_at) <= datetime('now','-5 minutes'))
        OR (status = 'failed' AND attempt < 6 AND last_attempt_at IS NOT NULL
            AND datetime(last_attempt_at, '+' || (CASE attempt WHEN 1 THEN 1 WHEN 2 THEN 5 WHEN 3 THEN 30 WHEN 4 THEN 120 ELSE 360 END + 10) || ' minutes') <= datetime('now')))`,
  dispute_open: `SELECT COUNT(*) n FROM disputes WHERE status NOT IN ('won','lost','charge_refunded')`,
  backup_stale: `SELECT CASE WHEN COALESCE((SELECT MAX(created_at) FROM control_plane_backups WHERE status IN ('complete','expired')), '1970-01-01') < datetime('now','-36 hours') THEN 1 ELSE 0 END n`
};

/** Computed checks (need more than one query). Each returns the number to alert on; 0 means healthy. */
const COMPUTED = {
  // Phase 2.1: 5% or more of the last 24 hours' mail bounced permanently or drew a complaint (at least 20 sent), or 3+ complaints.
  email_bounce_rate: async (env) => {
    const d = await billingNotifications.deliverabilityLast24h(env);
    const total = d.sent + d.suppressed;
    return (total >= 20 && d.suppressed / total >= 0.05) || d.complaints >= 3 ? d.suppressed : 0;
  },
  // Phase 2.1: billing notifications recorded but not queued for 30 minutes (or out of retries): customers are not being told.
  billing_email_stuck: (env) => billingNotifications.stuckNotificationCount(env)
};

/**
 * Round 6.2B (blueprint 6.2, ENFORCEMENT_CUTOVER step 3): organizations with an expired local trial (no provider behind it, no
 * active or past-due subscription) whose site is still active `days` after the trial ended. The caller (alerts.js) decides
 * whether the check applies at all and how many days the access ladder allows; SQL stays here. Counts organizations only.
 * Moved out of COMPUTED in Round 6.5A: it needed billing-config, and a repository may import only other repositories.
 */
export async function countExpiredTrialsStillLive(env, days) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(DISTINCT s.organization_id) n FROM subscriptions s
       JOIN sites si ON si.organization_id = s.organization_id AND si.status = 'active'
       JOIN organizations o ON o.id = s.organization_id AND COALESCE(o.status, 'active') != 'closed'
      WHERE s.provider_subscription_id IS NULL
        AND s.trial_ends_at IS NOT NULL AND datetime(s.trial_ends_at) IS NOT NULL
        AND s.status IN ('trialing','expired')
        AND datetime(s.trial_ends_at, '+' || ? || ' days') <= datetime('now')
        AND NOT EXISTS (SELECT 1 FROM subscriptions s2 WHERE s2.organization_id = s.organization_id AND s2.status IN ('active','past_due'))`
  ).bind(String(days)).first();
  return row.n;
}

export async function countFor(env, key) {
  if (COMPUTED[key]) return COMPUTED[key](env);
  const sql = COUNT_QUERIES[key];
  if (!sql) throw new Error(`unknown health check: ${key}`);
  return (await env.LUMMET_DB.prepare(sql).first()).n;
}

export async function get(env, key) {
  return env.LUMMET_DB.prepare(`SELECT * FROM alert_state WHERE key = ?`).bind(key).first();
}

export async function markFiring(env, key, count, nowIso) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO alert_state (key, firing, last_count, first_seen_at, last_notified_at, updated_at) VALUES (?, 1, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET firing = 1, last_count = excluded.last_count,
       first_seen_at = CASE WHEN alert_state.firing = 1 THEN alert_state.first_seen_at ELSE excluded.first_seen_at END,
       last_notified_at = excluded.last_notified_at, updated_at = excluded.updated_at`
  ).bind(key, count, nowIso, nowIso, nowIso).run();
}

export async function touchCount(env, key, count, nowIso) {
  await env.LUMMET_DB.prepare(`UPDATE alert_state SET last_count = ?, updated_at = ? WHERE key = ?`).bind(count, nowIso, key).run();
}

export async function markResolved(env, key, nowIso) {
  await env.LUMMET_DB.prepare(`UPDATE alert_state SET firing = 0, last_count = 0, updated_at = ? WHERE key = ?`).bind(nowIso, key).run();
}

export async function listAll(env) {
  // `probe:` rows are the synthetic monitors' own observations (Round 6.5A), shown by their own tile, not alerts.
  return (await env.LUMMET_DB.prepare(`SELECT key, firing, last_count, first_seen_at, last_notified_at FROM alert_state WHERE key NOT LIKE 'probe:%' ORDER BY key`).all()).results;
}
