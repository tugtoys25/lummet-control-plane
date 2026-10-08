// Outgoing webhook delivery records. (Repository: all SQL for webhook_deliveries lives here.)
//
// Status lifecycle: failed -> retrying -> delivered | failed | dead.
// `attempt` is the number of attempts MADE; `last_attempt_at` is when the latest one began.

export async function insert(env, d) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, response_code, error_message, attempt, delivered_at, last_attempt_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
  ).bind(d.id, d.webhookId, d.eventType, d.payload, d.status, d.responseCode ?? null, d.errorMessage ?? null, d.attempt ?? 1, d.deliveredAt ?? null).run();
}

export async function get(env, deliveryId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`).bind(deliveryId).first()) || null;
}

export async function getWebhook(env, webhookId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM webhooks WHERE id = ?`).bind(webhookId).first()) || null;
}

export async function listForWebhook(env, webhookId, limit = 50) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, event_type, status, response_code, error_message, attempt, created_at, delivered_at, last_attempt_at
       FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).bind(webhookId, limit).all();
  return r.results || [];
}

/** Candidates for a retry: failed ones, plus ones stuck in 'retrying' (the Worker died mid-send) for over 5 minutes. */
export async function listRetryCandidates(env, { maxAttempts, limit }) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, webhook_id, status, attempt, created_at, last_attempt_at FROM webhook_deliveries
      WHERE attempt < ?
        AND (status = 'failed' OR (status = 'retrying' AND COALESCE(last_attempt_at, created_at) <= datetime('now', '-5 minutes')))
      ORDER BY COALESCE(last_attempt_at, created_at) LIMIT ?`
  ).bind(maxAttempts, limit).all();
  return r.results || [];
}

/** Takes a delivery for its next attempt. True only for the single caller that wins. */
export async function claim(env, deliveryId, fromStatus, observedAttempt) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE webhook_deliveries SET status = 'retrying', attempt = attempt + 1, last_attempt_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = ? AND attempt = ?`
  ).bind(deliveryId, fromStatus, observedAttempt).run();
  return (r?.meta?.changes || 0) > 0;
}

export async function recordOutcome(env, deliveryId, { status, responseCode, errorMessage }) {
  await env.LUMMET_DB.prepare(
    `UPDATE webhook_deliveries
        SET status = ?, response_code = ?, error_message = ?,
            delivered_at = CASE WHEN ? = 'delivered' THEN CURRENT_TIMESTAMP ELSE delivered_at END
      WHERE id = ?`
  ).bind(status, responseCode ?? null, errorMessage ? String(errorMessage).slice(0, 500) : null, status, deliveryId).run();
}

/** Deliveries that failed so long ago that retrying now would only confuse the receiver (and any left 'retrying' at the cap). */
export async function expireStale(env, { maxAttempts, windowDays }) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE webhook_deliveries SET status = 'dead', error_message = COALESCE(error_message, 'retry window expired')
      WHERE (status = 'failed' AND created_at <= datetime('now', '-' || ? || ' days'))
         OR (status = 'retrying' AND attempt >= ? AND COALESCE(last_attempt_at, created_at) <= datetime('now', '-5 minutes'))`
  ).bind(windowDays, maxAttempts).run();
  return r?.meta?.changes || 0;
}
