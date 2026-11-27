// Persistence for trial extension requests. Plain data in, plain data out; the rules live in worker/trial-extensions.js.

/** True when the organization has ever had a free trial (a row with a trial end, or one that expired). Never expires: one trial per organization. */
export async function orgHadTrial(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT 1 AS x FROM subscriptions WHERE organization_id = ? AND (trial_ends_at IS NOT NULL OR status = 'expired') LIMIT 1`
  ).bind(organizationId).first();
  return !!row;
}

export async function insertRequest(env, { id, organizationId, requestedBy, message, wantedDays }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO trial_extension_requests (id, organization_id, requested_by, message, wanted_days) VALUES (?, ?, ?, ?, ?)`
  ).bind(id, organizationId, requestedBy || null, message || null, wantedDays ?? null).run();
}

export const pendingFor = (env, organizationId) =>
  env.LUMMET_DB.prepare(`SELECT * FROM trial_extension_requests WHERE organization_id = ? AND status = 'pending' LIMIT 1`).bind(organizationId).first();

export const latestFor = (env, organizationId) =>
  env.LUMMET_DB.prepare(`SELECT * FROM trial_extension_requests WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(organizationId).first();

export const getRequest = (env, id) => env.LUMMET_DB.prepare(`SELECT * FROM trial_extension_requests WHERE id = ?`).bind(id).first();

export async function listForStaff(env, { status = "", limit = 200 } = {}) {
  const where = ["pending", "approved", "declined"].includes(status) ? "WHERE r.status = ?" : "";
  const stmt = env.LUMMET_DB.prepare(
    `SELECT r.*, o.name AS organization_name, u.email AS requested_by_email,
            (SELECT COUNT(*) FROM sites s WHERE s.organization_id = r.organization_id) AS site_count
     FROM trial_extension_requests r
     LEFT JOIN organizations o ON o.id = r.organization_id
     LEFT JOIN customer_users u ON u.id = r.requested_by
     ${where} ORDER BY (r.status = 'pending') DESC, r.created_at DESC LIMIT ?`
  );
  return (await (where ? stmt.bind(status, limit) : stmt.bind(limit)).all()).results || [];
}

export async function countPending(env) {
  const row = await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM trial_extension_requests WHERE status = 'pending'`).first();
  return row?.c || 0;
}

/** Closes a pending request. Returns false when it was not pending any more (another staff member got there first). */
export async function decide(env, id, { status, decidedBy, days, comment, grantedSubscriptionId }) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE trial_extension_requests SET status = ?, decided_by = ?, decided_days = ?, decision_comment = ?, granted_subscription_id = ?, decided_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending'`
  ).bind(status, decidedBy || null, days ?? null, comment || null, grantedSubscriptionId || null, id).run();
  return (r?.meta?.changes ?? r?.changes ?? 0) > 0;
}

export const latestSubscription = (env, organizationId) =>
  env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(organizationId).first();

export async function insertLocalTrial(env, { id, organizationId, planId, trialEndsAt }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan_id, status, trial_ends_at) VALUES (?, ?, ?, 'trialing', ?)`
  ).bind(id, organizationId, planId, trialEndsAt).run();
}

/** Organizations with an active site, no paid or running subscription, and a trial that has run out: candidates to pause. */
export async function orgsToPause(env, nowIso, limit = 300) {
  return (await env.LUMMET_DB.prepare(
    `SELECT DISTINCT si.organization_id AS organization_id
     FROM sites si
     WHERE si.status = 'active' AND si.organization_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM subscriptions t WHERE t.organization_id = si.organization_id AND t.trial_ends_at IS NOT NULL AND t.trial_ends_at <= ?)
       AND NOT EXISTS (SELECT 1 FROM subscriptions p WHERE p.organization_id = si.organization_id AND p.status IN ('active', 'past_due'))
     LIMIT ?`
  ).bind(nowIso, limit).all()).results?.map((r) => r.organization_id) || [];
}

/** Organizations holding sites this feature paused, so they can be restored once the customer pays or is granted an extension. */
export async function orgsWithPausedSites(env, reason, limit = 300) {
  return (await env.LUMMET_DB.prepare(
    `SELECT DISTINCT organization_id FROM sites WHERE status = 'suspended' AND suspension_reason = ? AND organization_id IS NOT NULL LIMIT ?`
  ).bind(reason, limit).all()).results?.map((r) => r.organization_id) || [];
}

/** Ids of the organization's sites that are live right now (the ones a trial end pauses). */
export async function activeSiteIds(env, organizationId) {
  return ((await env.LUMMET_DB.prepare(`SELECT id FROM sites WHERE organization_id = ? AND status = 'active'`).bind(organizationId).all()).results || []).map((r) => r.id);
}

/** The lapsed local trial rows are closed as 'expired' before a granted trial is created, so exactly one trial is ever live. */
export async function expireLapsedLocalTrials(env, organizationId) {
  await env.LUMMET_DB.prepare(
    `UPDATE subscriptions SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND status = 'trialing' AND provider_subscription_id IS NULL`
  ).bind(organizationId).run();
}
