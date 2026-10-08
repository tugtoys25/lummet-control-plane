// Operational alert state and the health counts the alert checks read. (Repository.)

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
  failed_billing_webhooks: `SELECT COUNT(*) n FROM billing_webhook_events WHERE status = 'failed' AND received_at >= datetime('now','-7 days')`,
  backup_stale: `SELECT CASE WHEN COALESCE((SELECT MAX(created_at) FROM control_plane_backups WHERE status IN ('complete','expired')), '1970-01-01') < datetime('now','-36 hours') THEN 1 ELSE 0 END n`
};

export async function countFor(env, key) {
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
  return (await env.LUMMET_DB.prepare(`SELECT key, firing, last_count, first_seen_at, last_notified_at FROM alert_state ORDER BY key`).all()).results;
}
