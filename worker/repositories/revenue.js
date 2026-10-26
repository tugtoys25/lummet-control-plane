// Revenue tables (migration 0071): subscription_movements, subscription_revenue_state, revenue_snapshots.
// Repository: plain data in, plain data out. What a movement MEANS (kinds, which statuses count, the backfill history rules) lives in
// worker/revenue.js; this file only knows how the rows are stored. All SQL for these tables belongs here.

/** The subscription with the plan fields the MRR contribution needs, or null. */
export async function subscriptionForRevenue(env, subscriptionId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.organization_id, s.status, s.plan_id, s.created_at, s.updated_at, s.canceled_at, s.current_period_start,
            p.price_cents, p.billing_period, p.currency,
            c.percent_off AS coupon_percent_off, c.amount_off_cents AS coupon_amount_off_cents, c.duration AS coupon_duration
       FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id LEFT JOIN coupons c ON c.id = s.coupon_id WHERE s.id = ?`
  ).bind(subscriptionId).first()) || null;
}

export async function getState(env, subscriptionId) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM subscription_revenue_state WHERE subscription_id = ?`).bind(subscriptionId).first()) || null;
}

/** Status history of one subscription, oldest first (id breaks ties so the order never depends on the clock). */
export async function statusHistory(env, subscriptionId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT to_status, created_at FROM subscription_status_events WHERE subscription_id = ? ORDER BY id`
  ).bind(subscriptionId).all();
  return r.results || [];
}

/** Subscriptions that have no revenue state yet, in id order after a cursor. The state row itself is what marks one as done. */
export async function listBackfillCandidates(env, { afterId = "", limit = 200 } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT s.id FROM subscriptions s
      WHERE s.id > ? AND NOT EXISTS (SELECT 1 FROM subscription_revenue_state r WHERE r.subscription_id = s.id)
      ORDER BY s.id LIMIT ?`
  ).bind(afterId, Math.max(1, Math.min(1000, Number(limit) || 200))).all();
  return (r.results || []).map((x) => x.id);
}

export async function listMovements(env, subscriptionId) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM subscription_movements WHERE subscription_id = ? ORDER BY seq`).bind(subscriptionId).all();
  return r.results || [];
}

/**
 * One atomic observation of a subscription: zero or more ledger rows plus the new state, in a single batch (one transaction in D1).
 * `expectedSeq` is the ledger position the caller read. A writer that read a stale position collides on UNIQUE (subscription_id, seq)
 * and nothing is written, so a duplicate or concurrent delivery can never double-count. Returns { applied: true } or
 * { applied: false, conflict: true }; any other error is raised.
 */
export async function commitObservation(env, { subscriptionId, organizationId, expectedSeq, movements = [], next, eventCreated = 0 }) {
  const db = env.LUMMET_DB;
  const lastSeq = movements.length ? movements[movements.length - 1].seq : expectedSeq;
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO subscription_revenue_state (subscription_id, seq, mrr_cents, currency, plan_id, quantity, last_event_created) VALUES (?, 0, 0, ?, ?, 1, 0)`)
      .bind(subscriptionId, next.currency, next.planId)
  ];
  for (const m of movements) {
    statements.push(db.prepare(
      `INSERT INTO subscription_movements (id, subscription_id, organization_id, seq, day, kind, mrr_delta_cents, mrr_after_cents, currency, plan_id, quantity, source, provider_event_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(`${subscriptionId}:${m.seq}`, subscriptionId, organizationId, m.seq, m.day, m.kind, m.deltaCents, m.mrrAfterCents, m.currency, m.planId ?? null, m.quantity, m.source, m.eventCreated ?? null));
  }
  statements.push(db.prepare(
    `UPDATE subscription_revenue_state SET seq = ?, mrr_cents = ?, currency = ?, plan_id = ?, quantity = ?,
            last_event_created = MAX(last_event_created, ?), updated_at = CURRENT_TIMESTAMP
      WHERE subscription_id = ? AND seq = ?`
  ).bind(lastSeq, next.mrrCents, next.currency, next.planId, next.quantity, Number(eventCreated) || 0, subscriptionId, expectedSeq));
  try {
    await db.batch(statements);
    return { applied: true };
  } catch (error) {
    if (/UNIQUE constraint failed/i.test(String(error?.message || error))) return { applied: false, conflict: true };
    throw error;
  }
}

// ---- revenue_snapshots: written by the 6.1B daily job (worker/revenue-job.js); this file is the table's only owner. ----

/** Idempotent: re-running a day replaces that (day, currency) row and never adds a second. */
export async function upsertSnapshot(env, s) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO revenue_snapshots (day, currency, mrr_cents, arr_cents, active, trialing, past_due, new_mrr, expansion_mrr, contraction_mrr, churned_mrr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(day, currency) DO UPDATE SET mrr_cents = excluded.mrr_cents, arr_cents = excluded.arr_cents, active = excluded.active, trialing = excluded.trialing,
       past_due = excluded.past_due, new_mrr = excluded.new_mrr, expansion_mrr = excluded.expansion_mrr, contraction_mrr = excluded.contraction_mrr,
       churned_mrr = excluded.churned_mrr, computed_at = CURRENT_TIMESTAMP`
  ).bind(s.day, s.currency, s.mrrCents, s.arrCents, s.active, s.trialing, s.pastDue, s.newMrr, s.expansionMrr, s.contractionMrr, s.churnedMrr).run();
}

export async function listSnapshots(env, { from = "0000-00-00", to = "9999-99-99", currency = "" } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT * FROM revenue_snapshots WHERE day >= ? AND day <= ? AND (? = '' OR currency = ?) ORDER BY day, currency`
  ).bind(from, to, currency, currency).all();
  return r.results || [];
}

/** The day's movements summed by kind and currency, for the 6.1B bridge. */
export async function movementTotalsForDay(env, day) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT currency, kind, COUNT(*) AS n, SUM(mrr_delta_cents) AS delta_cents FROM subscription_movements WHERE day = ? GROUP BY currency, kind ORDER BY currency, kind`
  ).bind(day).all();
  return r.results || [];
}

// ---- reads for the 6.1B daily job: everything is derived from stored rows, so a re-run for a day gives the same answer ----

/** The ledger summed to the end of `day`, per currency. A currency with any movement up to then is listed even when it nets to zero. */
export async function cumulativeMrrByCurrency(env, day) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT currency, SUM(mrr_delta_cents) AS mrr_cents FROM subscription_movements WHERE day <= ? GROUP BY currency ORDER BY currency`
  ).bind(day).all();
  return r.results || [];
}

/**
 * Subscriptions per plan currency and status as they stood at the END of `day`, for the three statuses the snapshot counts. The status is
 * the newest status event on or before the day; before a subscription's first event it is that event's from-status, and with no events
 * at all it is the current status. Subscriptions created after the day are not counted.
 */
export async function statusCountsAsOf(env, day) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT UPPER(p.currency) AS currency, st.status AS status, COUNT(*) AS n FROM (
       SELECT s.plan_id AS plan_id, COALESCE(
                (SELECT e.to_status FROM subscription_status_events e WHERE e.subscription_id = s.id AND substr(e.created_at, 1, 10) <= ? ORDER BY e.id DESC LIMIT 1),
                (SELECT e.from_status FROM subscription_status_events e WHERE e.subscription_id = s.id ORDER BY e.id ASC LIMIT 1),
                s.status) AS status
         FROM subscriptions s WHERE substr(s.created_at, 1, 10) <= ?
     ) st JOIN plans p ON p.id = st.plan_id
     WHERE st.status IN ('active', 'trialing', 'past_due') GROUP BY UPPER(p.currency), st.status ORDER BY 1, 2`
  ).bind(day, day).all();
  return r.results || [];
}

/** The first day anything could be reported: the earliest movement or subscription. Null when there is neither. */
export async function earliestRevenueDay(env) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT MIN(d) AS day FROM (SELECT MIN(day) AS d FROM subscription_movements UNION ALL SELECT MIN(substr(created_at, 1, 10)) FROM subscriptions)`
  ).first();
  return row && row.day ? row.day : null;
}

export async function latestSnapshotDay(env) {
  const row = await env.LUMMET_DB.prepare(`SELECT MAX(day) AS day FROM revenue_snapshots`).first();
  return row && row.day ? row.day : null;
}

/** Every currency's row for the newest snapshot day. */
export async function latestSnapshotRows(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM revenue_snapshots WHERE day = (SELECT MAX(day) FROM revenue_snapshots) ORDER BY currency`).all();
  return r.results || [];
}
