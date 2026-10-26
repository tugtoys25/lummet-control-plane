// Billing webhook event bookkeeping (v7C). All SQL for billing_webhook_events lives here.
//
// Lifecycle: received -> processed | failed. The provider redelivers an event it did not get a 2xx for;
// a failed event, or one stuck in 'received' because the Worker died mid-processing, may be claimed
// again (atomically, so two concurrent redeliveries cannot both run it) until MAX_ATTEMPTS is used up.

export const MAX_ATTEMPTS = 5;
export const STALE_MINUTES = 5;

/** First sight of an event. Returns true if this call inserted it. */
export async function recordReceived(env, provider, eventId, eventType) {
  const r = await env.LUMMET_DB.prepare(
    `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, status, attempts, last_attempt_at)
     VALUES (?, ?, ?, 'received', 1, CURRENT_TIMESTAMP)
     ON CONFLICT(provider, provider_event_id) DO NOTHING`
  ).bind(provider, eventId, eventType).run();
  return (r?.meta?.changes || 0) > 0;
}

/**
 * Takes an already-seen event back for another attempt, but only if it failed (and attempts remain) or
 * has been 'received' for longer than STALE_MINUTES. One UPDATE decides, so only one caller wins.
 */
export async function claimRetry(env, provider, eventId, { maxAttempts = MAX_ATTEMPTS, staleMinutes = STALE_MINUTES } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE billing_webhook_events
        SET status = 'received', attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP
      WHERE provider = ? AND provider_event_id = ? AND attempts < ?
        AND (status = 'failed'
             OR (status = 'received' AND COALESCE(last_attempt_at, received_at) <= datetime('now', '-' || ? || ' minutes')))`
  ).bind(provider, eventId, maxAttempts, staleMinutes).run();
  return (r?.meta?.changes || 0) > 0;
}

export async function markProcessed(env, provider, eventId) {
  await env.LUMMET_DB.prepare(
    `UPDATE billing_webhook_events SET status = 'processed', error_message = NULL, processed_at = CURRENT_TIMESTAMP WHERE provider = ? AND provider_event_id = ?`
  ).bind(provider, eventId).run();
}

export async function markFailed(env, provider, eventId, message) {
  await env.LUMMET_DB.prepare(
    `UPDATE billing_webhook_events SET status = 'failed', error_message = ? WHERE provider = ? AND provider_event_id = ?`
  ).bind(String(message).slice(0, 500), provider, eventId).run();
}

// ---- Phase 5.7: staff replay of failed events ----
export async function listFailedEvents(env, { limit = 50, offset = 0 } = {}) {
  return (await env.LUMMET_DB.prepare(
    `SELECT provider, provider_event_id, event_type, status, attempts, error_message, received_at, last_attempt_at
     FROM billing_webhook_events WHERE status = 'failed' OR (status = 'received' AND COALESCE(last_attempt_at, received_at) <= datetime('now', '-' || ? || ' minutes'))
     ORDER BY received_at DESC LIMIT ? OFFSET ?`).bind(STALE_MINUTES, limit, offset).all()).results || [];
}
export async function findEvent(env, provider, eventId) {
  return env.LUMMET_DB.prepare("SELECT provider, provider_event_id, event_type, status, attempts FROM billing_webhook_events WHERE provider=? AND provider_event_id=?").bind(provider, eventId).first();
}
// Staff replay ignores the automatic-retry attempt cap but still needs the event to be failed (or stuck): one UPDATE decides,
// so two staff members replaying at once cannot both run it, and a processed event can never be replayed.
export async function claimStaffReplay(env, provider, eventId, { staleMinutes = STALE_MINUTES } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE billing_webhook_events SET status = 'received', attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP
      WHERE provider = ? AND provider_event_id = ?
        AND (status = 'failed' OR (status = 'received' AND COALESCE(last_attempt_at, received_at) <= datetime('now', '-' || ? || ' minutes')))`
  ).bind(provider, eventId, staleMinutes).run();
  return (r?.meta?.changes || 0) > 0;
}
export async function insertReplayLog(env, { id, provider, eventId, staffId, reason, outcome, error }) {
  return env.LUMMET_DB.prepare("INSERT INTO billing_webhook_replays (id, provider, provider_event_id, staff_id, reason, outcome, error_message) VALUES (?,?,?,?,?,?,?)")
    .bind(id, provider, eventId, staffId, reason, outcome, error ? String(error).slice(0, 500) : null).run();
}
