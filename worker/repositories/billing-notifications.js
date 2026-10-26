// Billing notification persistence (Phase 2.1). Repository: plain data in, plain data out. No business rules here;
// the rules live in billing-notifications.js and resend-webhook.js.

export const MAX_ATTEMPTS = 10;

// ---------- intents ----------
/** Inserts the intent. created=false when the dedupe key already exists (the existing row is returned). */
export async function insertIntent(env, row) {
  const r = await env.LUMMET_DB.prepare(
    `INSERT INTO billing_notifications (id, organization_id, subscription_id, kind, stage, dedupe_key, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(dedupe_key) DO NOTHING`
  ).bind(row.id, row.organizationId, row.subscriptionId || null, row.kind, row.stage || "", row.dedupeKey, row.payload || null).run();
  if (r.meta.changes) return { created: true, row: await getByDedupeKey(env, row.dedupeKey) };
  return { created: false, row: await getByDedupeKey(env, row.dedupeKey) };
}

export async function getByDedupeKey(env, dedupeKey) {
  return env.LUMMET_DB.prepare(`SELECT * FROM billing_notifications WHERE dedupe_key = ?`).bind(dedupeKey).first();
}

export async function deleteIntent(env, id) {
  await env.LUMMET_DB.prepare(`DELETE FROM billing_notifications WHERE id = ? AND queued_at IS NULL`).bind(id).run();
}

export async function markQueued(env, id, { recipientCount, suppressedCount }) {
  await env.LUMMET_DB.prepare(
    `UPDATE billing_notifications SET queued_at = CURRENT_TIMESTAMP, payload = NULL, last_error = NULL, recipient_count = ?, suppressed_count = ? WHERE id = ?`
  ).bind(recipientCount, suppressedCount, id).run();
}

export async function markAttemptFailed(env, id, error) {
  await env.LUMMET_DB.prepare(
    `UPDATE billing_notifications SET attempts = attempts + 1, last_error = ? WHERE id = ? AND queued_at IS NULL`
  ).bind(String(error || "unknown").slice(0, 300), id).run();
}

/** Intents not yet fully queued, oldest first, that still have attempts left. */
export async function listPending(env, limit = 25) {
  return (await env.LUMMET_DB.prepare(
    `SELECT * FROM billing_notifications WHERE queued_at IS NULL AND attempts < ? ORDER BY created_at LIMIT ?`
  ).bind(MAX_ATTEMPTS, limit).all()).results || [];
}

/** Sets sent_at on every queued notification whose first message the outbox has delivered. Returns how many changed. */
export async function syncSent(env) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE billing_notifications SET sent_at = CURRENT_TIMESTAMP
     WHERE sent_at IS NULL AND queued_at IS NOT NULL
       AND EXISTS (SELECT 1 FROM email_outbox o WHERE o.notification_id = billing_notifications.id AND o.status = 'sent')`
  ).run();
  return r.meta.changes || 0;
}

export async function listForOrganization(env, organizationId, { limit = 50, offset = 0 } = {}) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, organization_id, subscription_id, kind, stage, attempts, last_error, recipient_count, suppressed_count, created_at, queued_at, sent_at
     FROM billing_notifications WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
  ).bind(organizationId, limit, offset).all()).results || [];
}

// ---------- staff view and resend (Phase 2.3) ----------
// The state of a notification, worked out from its own columns and its outbox messages:
//   pending   recorded, not yet handed to the outbox, still being retried
//   stuck     recorded, not queued, out of attempts (needs a staff resend)
//   queued    handed to the outbox, nothing delivered yet
//   failed    at least one message could not be delivered and none has been
//   sent      at least one message was delivered
const STATE_SQL = `CASE
  WHEN n.queued_at IS NULL AND n.attempts >= ${MAX_ATTEMPTS} THEN 'stuck'
  WHEN n.queued_at IS NULL THEN 'pending'
  WHEN n.sent_at IS NOT NULL THEN 'sent'
  WHEN EXISTS (SELECT 1 FROM email_outbox o WHERE o.notification_id = n.id AND o.status = 'failed') THEN 'failed'
  ELSE 'queued' END`;
export const NOTIFICATION_STATES = ["pending", "stuck", "queued", "failed", "sent"];

/** Notifications for the staff screen, newest first. Filters are optional and combine. Never returns the payload or any address. */
export async function listForStaff(env, { organizationId = "", kind = "", state = "", limit = 51, offset = 0 } = {}) {
  return (await env.LUMMET_DB.prepare(
    `SELECT * FROM (
       SELECT n.id, n.organization_id, o.name AS organization_name, n.subscription_id, n.kind, n.stage, n.attempts, n.last_error,
              n.recipient_count, n.suppressed_count, n.created_at, n.queued_at, n.sent_at, ${STATE_SQL} AS state,
              (SELECT COUNT(*) FROM email_outbox m WHERE m.notification_id = n.id AND m.status = 'failed') AS failed_messages
       FROM billing_notifications n LEFT JOIN organizations o ON o.id = n.organization_id
       WHERE (? = '' OR n.organization_id = ?) AND (? = '' OR n.kind = ?)
     ) WHERE (? = '' OR state = ?) ORDER BY created_at DESC, id LIMIT ? OFFSET ?`
  ).bind(organizationId, organizationId, kind, kind, state, state, limit, offset).all()).results || [];
}

export async function getById(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM billing_notifications WHERE id = ?`).bind(String(id || "")).first();
}

/** The outbox messages of a notification (one per recipient). The address is returned only as a masked hint. */
export async function outboxMessagesFor(env, notificationId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, to_email, status, attempts, last_error, created_at, sent_at, (body_encrypted IS NOT NULL) AS has_body
     FROM email_outbox WHERE notification_id = ? ORDER BY created_at, rowid`
  ).bind(notificationId).all()).results || [];
}

/** Gives an intent that ran out of attempts a fresh set. Only for an intent that is still not queued. */
export async function resetAttempts(env, id) {
  const r = await env.LUMMET_DB.prepare(`UPDATE billing_notifications SET attempts = 0, last_error = NULL WHERE id = ? AND queued_at IS NULL`).bind(id).run();
  return r.meta.changes > 0;
}

/**
 * Puts one FAILED message back in the outbox queue, the same row and the same dedupe key, so it can never become a
 * second copy. Only a failed message that still has its body can go back; anything else is left alone.
 */
export async function requeueFailedMessage(env, outboxId) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE email_outbox SET status = 'queued', attempts = 0, last_error = NULL, next_attempt_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'failed' AND body_encrypted IS NOT NULL AND notification_id IS NOT NULL`
  ).bind(outboxId).run();
  return r.meta.changes > 0;
}

/** Failed billing messages keep their (encrypted) body so staff can resend; drop it after `days` days. Returns how many. */
export async function pruneFailedBodies(env, days = 14) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE email_outbox SET body_encrypted = NULL, body_iv = NULL
     WHERE status = 'failed' AND body_encrypted IS NOT NULL AND notification_id IS NOT NULL AND created_at < datetime('now', ?)`
  ).bind(`-${Number(days)} days`).run();
  return r.meta.changes || 0;
}

// ---------- who to tell, and what to say ----------
/** Active owners of the organization (the billing contact joins in sprint 3.3). */
export async function listOwners(env, organizationId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT u.id, u.email, u.full_name, u.email_verified_at
     FROM organization_users ou JOIN customer_users u ON u.id = ou.user_id
     WHERE ou.organization_id = ? AND ou.role = 'owner' AND u.status = 'active' ORDER BY ou.id`
  ).bind(organizationId).all()).results || [];
}

export async function organizationSummary(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT id, name, status FROM organizations WHERE id = ?`).bind(organizationId).first();
}

export async function subscriptionSummary(env, subscriptionId) {
  if (!subscriptionId) return null;
  return env.LUMMET_DB.prepare(
    `SELECT s.id, s.status, s.plan_id, s.trial_ends_at, s.current_period_end, s.grace_ends_at, s.restricted_at, s.suspended_at,
            p.name AS plan_name, p.price_cents, p.currency, p.billing_period
     FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`
  ).bind(subscriptionId).first();
}

/** Organizations an owner (by user id) belongs to that currently have a trial running, for the welcome email. */
export async function trialingOrganizationsOwnedBy(env, userId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id AS subscription_id, s.organization_id FROM organization_users ou
     JOIN subscriptions s ON s.organization_id = ou.organization_id
     WHERE ou.user_id = ? AND ou.role = 'owner' AND s.status = 'trialing'`
  ).bind(userId).all()).results || [];
}

// ---------- suppressions ----------
export async function isSuppressed(env, emailHash) {
  return !!(await env.LUMMET_DB.prepare(`SELECT 1 AS x FROM email_suppressions WHERE email_hash = ?`).bind(emailHash).first());
}

/** Of the hashes given, the ones that are suppressed. */
export async function suppressedAmong(env, hashes) {
  const out = new Set();
  for (const h of hashes) if (await isSuppressed(env, h)) out.add(h);
  return out;
}

export async function addSuppression(env, emailHash, reason) {
  const r = await env.LUMMET_DB.prepare(
    `INSERT INTO email_suppressions (email_hash, reason) VALUES (?, ?) ON CONFLICT(email_hash) DO NOTHING`
  ).bind(emailHash, reason).run();
  return r.meta.changes > 0;
}

export async function removeSuppression(env, emailHash) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM email_suppressions WHERE email_hash = ?`).bind(emailHash).run();
  return r.meta.changes > 0;
}

export async function listSuppressions(env, { limit = 50, offset = 0 } = {}) {
  return (await env.LUMMET_DB.prepare(
    `SELECT email_hash, reason, created_at FROM email_suppressions ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all()).results || [];
}

// ---------- Resend webhook bookkeeping ----------
/** true when this delivery id is new (and is now recorded), false when it was handled before. */
export async function recordWebhookEvent(env, id, type) {
  const r = await env.LUMMET_DB.prepare(
    `INSERT INTO email_webhook_events (id, type) VALUES (?, ?) ON CONFLICT(id) DO NOTHING`
  ).bind(id, type).run();
  return r.meta.changes > 0;
}

export async function forgetWebhookEvent(env, id) {
  await env.LUMMET_DB.prepare(`DELETE FROM email_webhook_events WHERE id = ?`).bind(id).run();
}

export async function pruneWebhookEvents(env, days = 30) {
  await env.LUMMET_DB.prepare(`DELETE FROM email_webhook_events WHERE received_at < datetime('now', ?)`).bind(`-${Number(days)} days`).run();
}

// ---------- outbox hooks used by the delivery step ----------
export async function markOutboxSuppressed(env, outboxId) {
  await env.LUMMET_DB.prepare(
    `UPDATE email_outbox SET status = 'suppressed', last_error = 'recipient_suppressed', body_encrypted = NULL, body_iv = NULL WHERE id = ? AND status = 'queued'`
  ).bind(outboxId).run();
}

// ---------- health numbers for the alerts ----------
/** Messages the provider accepted in the last 24 hours, and the suppressions reported in the same window. */
export async function deliverabilityLast24h(env) {
  const sent = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM email_outbox WHERE status = 'sent' AND sent_at >= datetime('now','-24 hours')`).first();
  const bad = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM email_suppressions WHERE created_at >= datetime('now','-24 hours')`).first();
  const complaints = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM email_suppressions WHERE reason = 'complaint' AND created_at >= datetime('now','-24 hours')`).first();
  return { sent: sent.n, suppressed: bad.n, complaints: complaints.n };
}

/** Notifications stuck before being queued: older than 30 minutes, or out of attempts. */
export async function stuckNotificationCount(env) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) n FROM billing_notifications WHERE queued_at IS NULL AND (created_at < datetime('now','-30 minutes') OR attempts >= ?)`
  ).bind(MAX_ATTEMPTS).first();
  return r.n;
}
