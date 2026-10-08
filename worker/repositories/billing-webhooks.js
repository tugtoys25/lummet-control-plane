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
