// plan_change_intents and plan_sync_issues (migration 0053). Repository: plain data in, plain data out.
// The rules (what counts as upgrade or downgrade, when an intent is confirmed) live in worker/plan-sync.js and billing.js.

const OPEN = "('pending','submitted')";
const clampLimit = (n) => Math.min(Math.max(Math.floor(Number(n)) || 50, 1), 200);
const clampOffset = (n) => Math.min(Math.max(Math.floor(Number(n)) || 0, 0), 500000);

// ---------- intents ----------

export async function openIntentFor(env, subscriptionId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM plan_change_intents WHERE subscription_id = ? AND status IN ${OPEN}`).bind(subscriptionId).first();
}

export async function getIntent(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM plan_change_intents WHERE id = ?`).bind(id).first();
}

/** Inserts a pending intent. Returns false when another change is already in flight for the subscription (unique index). */
export async function insertIntent(env, f) {
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO plan_change_intents (id, subscription_id, from_plan_id, to_plan_id, status, idempotency_key, direction, to_price_id, requested_by)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).bind(f.id, f.subscriptionId, f.fromPlanId || null, f.toPlanId, f.idempotencyKey, f.direction || null, f.toPriceId || null, f.requestedBy || null).run();
    return true;
  } catch (e) {
    if (/UNIQUE/i.test(String(e?.message))) return false;
    throw e;
  }
}

/** Conditional status change; true only when the row really moved from `from` (so a repeat does nothing twice). */
export async function moveIntent(env, id, from, to, { error = null, bumpAttempts = false } = {}) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE plan_change_intents SET status = ?, last_error = ?, attempts = attempts + ?, updated_at = CURRENT_TIMESTAMP,
       confirmed_at = CASE WHEN ? = 'confirmed' THEN CURRENT_TIMESTAMP ELSE confirmed_at END
     WHERE id = ? AND status = ?`
  ).bind(to, error ? String(error).slice(0, 500) : null, bumpAttempts ? 1 : 0, to, id, from).run();
  return (r?.meta?.changes ?? 0) > 0;
}

/** Records one more failed attempt on an intent that stays pending. */
export async function noteAttempt(env, id, error) {
  await env.LUMMET_DB.prepare(
    `UPDATE plan_change_intents SET attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`
  ).bind(String(error || "").slice(0, 500), id).run();
}

/** Open intents that sat longer than `minutes`, so a newer request may replace them. */
export async function supersedeStale(env, subscriptionId, minutes) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE plan_change_intents SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
     WHERE subscription_id = ? AND status IN ${OPEN} AND updated_at < datetime('now', ?)`
  ).bind(subscriptionId, `-${Math.max(1, Math.floor(minutes))} minutes`).run();
  return r?.meta?.changes ?? 0;
}

/** Pending intents the sweep should retry: older than `minutes` (so it never races the request that wrote them). */
export async function pendingToRetry(env, minutes, limit = 25) {
  return (await env.LUMMET_DB.prepare(
    `SELECT i.*, s.provider_subscription_id, s.organization_id
       FROM plan_change_intents i JOIN subscriptions s ON s.id = i.subscription_id
      WHERE i.status = 'pending' AND i.updated_at < datetime('now', ?) ORDER BY i.updated_at LIMIT ?`
  ).bind(`-${Math.max(0, Math.floor(minutes))} minutes`, clampLimit(limit)).all()).results || [];
}

export async function listIntents(env, { subscriptionId = "", status = "", limit = 50, offset = 0 } = {}) {
  const lim = clampLimit(limit);
  const r = await env.LUMMET_DB.prepare(
    `SELECT i.*, s.organization_id FROM plan_change_intents i JOIN subscriptions s ON s.id = i.subscription_id
      WHERE (? = '' OR i.subscription_id = ?) AND (? = '' OR i.status = ?)
      ORDER BY i.created_at DESC, i.id LIMIT ? OFFSET ?`
  ).bind(subscriptionId, subscriptionId, status, status, lim + 1, clampOffset(offset)).all();
  const rows = r.results || [];
  return { rows: rows.slice(0, lim), hasMore: rows.length > lim };
}

// ---------- sync issues ----------

/** Raises (or re-counts) an open issue. One open row per kind, provider subscription and price: a redelivery bumps `occurrences`. */
export async function raiseIssue(env, f) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO plan_sync_issues (kind, stripe_price_id, provider_subscription_id, subscription_id, organization_id, from_plan_id, to_plan_id, event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, provider_subscription_id, stripe_price_id) WHERE resolved_at IS NULL
     DO UPDATE SET occurrences = occurrences + 1, last_seen_at = CURRENT_TIMESTAMP, event_id = excluded.event_id,
       from_plan_id = excluded.from_plan_id, to_plan_id = excluded.to_plan_id`
  ).bind(f.kind, f.stripePriceId || "", f.providerSubscriptionId || "", f.subscriptionId || null, f.organizationId || null, f.fromPlanId || null, f.toPlanId || null, f.eventId || null).run();
}

/** Closes open issues of the given kinds for a subscription (the situation they described no longer holds). */
export async function resolveForSubscription(env, providerSubscriptionId, kinds, by) {
  if (!providerSubscriptionId || !kinds.length) return 0;
  const marks = kinds.map(() => "?").join(",");
  const r = await env.LUMMET_DB.prepare(
    `UPDATE plan_sync_issues SET resolved_at = CURRENT_TIMESTAMP, resolved_by = ?
     WHERE provider_subscription_id = ? AND kind IN (${marks}) AND resolved_at IS NULL`
  ).bind(by, providerSubscriptionId, ...kinds).run();
  return r?.meta?.changes ?? 0;
}

export async function resolveIssue(env, id, by) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE plan_sync_issues SET resolved_at = CURRENT_TIMESTAMP, resolved_by = ? WHERE id = ? AND resolved_at IS NULL`
  ).bind(by, id).run();
  return (r?.meta?.changes ?? 0) > 0;
}

export async function listIssues(env, { kind = "", open = true, limit = 50, offset = 0 } = {}) {
  const lim = clampLimit(limit);
  const r = await env.LUMMET_DB.prepare(
    `SELECT * FROM plan_sync_issues WHERE (? = '' OR kind = ?) AND (? = 0 OR resolved_at IS NULL)
      ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`
  ).bind(kind, kind, open ? 1 : 0, lim + 1, clampOffset(offset)).all();
  const rows = r.results || [];
  return { rows: rows.slice(0, lim), hasMore: rows.length > lim };
}

// ---------- plan facts the sync needs ----------

export async function planForSync(env, planId) {
  return env.LUMMET_DB.prepare(`SELECT id, key, name, price_cents, billing_period, currency FROM plans WHERE id = ?`).bind(planId).first();
}

/** Applies a provider-confirmed plan. Guarded by event time, so an older event can never overwrite a newer one. */
export async function applyPlan(env, subscriptionId, planId, eventAt) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE subscriptions SET plan_id = ?, plan_synced_event_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND COALESCE(plan_synced_event_at, 0) <= ?`
  ).bind(planId, eventAt, subscriptionId, eventAt).run();
  return (r?.meta?.changes ?? 0) > 0;
}

/** Remembers the newest event the sync saw for a subscription whose plan did not change. */
export async function touchSyncedAt(env, subscriptionId, eventAt) {
  await env.LUMMET_DB.prepare(
    `UPDATE subscriptions SET plan_synced_event_at = ? WHERE id = ? AND COALESCE(plan_synced_event_at, 0) < ?`
  ).bind(eventAt, subscriptionId, eventAt).run();
}
export async function listActiveAddonsForOrganization(env,organizationId){const r=await env.LUMMET_DB.prepare(`SELECT a.entitlement_key,a.delta_per_unit,sa.quantity FROM subscription_addons sa JOIN subscriptions s ON s.id=sa.subscription_id JOIN addons a ON a.id=sa.addon_id WHERE s.organization_id=? AND s.status NOT IN ('canceled','expired','incomplete_expired') AND a.active=1`).bind(organizationId).all();return r.results||[];}
export async function latestStorageUsage(env,organizationId){return env.LUMMET_DB.prepare(`SELECT value FROM usage_snapshots WHERE organization_id=? AND metric='storage_bytes' ORDER BY day DESC LIMIT 1`).bind(organizationId).first();}
