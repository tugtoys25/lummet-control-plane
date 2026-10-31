// Billing lifecycle persistence (Phase 0.2 to 1.5). Repository: plain data in, plain data out. No business rules here.
// The rules live in access.js, billing-lifecycle.js, scheduler.js and organizations.js.

const NOT_LIVE = "('canceled','expired','incomplete_expired')";

// ---------- organizations and subscriptions ----------
export async function getOrganizationStatus(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT id, status FROM organizations WHERE id = ?`).bind(organizationId).first();
}

export async function liveSubscription(env, organizationId) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM subscriptions WHERE organization_id = ? AND status NOT IN ${NOT_LIVE} ORDER BY created_at DESC LIMIT 1`
  ).bind(organizationId).first();
}

export async function latestSubscription(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM subscriptions WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).bind(organizationId).first();
}

/** Latest time the subscription entered any of `statuses` (from the status event log), or null. */
export async function lastEnteredStatusAt(env, subscriptionId, statuses) {
  const marks = statuses.map(() => "?").join(",");
  const row = await env.LUMMET_DB.prepare(
    `SELECT MAX(created_at) t FROM subscription_status_events WHERE subscription_id = ? AND to_status IN (${marks})`
  ).bind(subscriptionId, ...statuses).first();
  return row?.t || null;
}

export async function sweepCandidates(env, limit = 500) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.* FROM subscriptions s WHERE s.status IN ('trialing','past_due','restricted','unpaid','suspended') ORDER BY s.created_at LIMIT ?`
  ).bind(limit).all()).results || [];
}

export async function insertStatusEvent(env, { subscriptionId, fromStatus, toStatus, reason }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscription_status_events (subscription_id, from_status, to_status, reason, actor_type) VALUES (?, ?, ?, ?, 'system')`
  ).bind(subscriptionId, fromStatus || null, toStatus, reason).run();
}

// Each transition is conditional on the status the caller saw, so a second run changes nothing. Returns true if it changed a row.
async function guarded(env, sql, binds) {
  const res = await env.LUMMET_DB.prepare(sql).bind(...binds).run();
  return !!res?.meta?.changes;
}
export const markExpired = (env, sub) => guarded(env, `UPDATE subscriptions SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`, [sub.id, sub.status]);
export const markRestricted = (env, sub, restrictedAtIso) => guarded(env, `UPDATE subscriptions SET status = 'restricted', restricted_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`, [restrictedAtIso, sub.id, sub.status]);
export const markSuspended = (env, sub, suspendedAtIso) => guarded(env, `UPDATE subscriptions SET status = 'suspended', suspended_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?`, [suspendedAtIso, sub.id, sub.status]);

// ---------- shadow mode ----------
export async function lastShadow(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT state, would_change_from, reason FROM subscription_access_shadow WHERE organization_id = ? ORDER BY id DESC LIMIT 1`).bind(organizationId).first();
}
export async function insertShadow(env, { organizationId, subscriptionId, state, wouldChangeFrom, reason }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO subscription_access_shadow (organization_id, subscription_id, state, would_change_from, reason) VALUES (?, ?, ?, ?, ?)`
  ).bind(organizationId, subscriptionId || null, state, wouldChangeFrom || null, reason).run();
}
export async function shadowReasonSeenRecently(env, organizationId, reason) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT 1 x FROM subscription_access_shadow WHERE organization_id = ? AND reason = ? AND evaluated_at > datetime('now','-1 hour') LIMIT 1`
  ).bind(organizationId, reason).first();
  return !!r;
}
export async function listShadow(env, { limit = 200 } = {}) {
  return (await env.LUMMET_DB.prepare(
    `SELECT sh.*, o.name organization_name FROM subscription_access_shadow sh LEFT JOIN organizations o ON o.id = sh.organization_id ORDER BY sh.id DESC LIMIT ?`
  ).bind(limit).all()).results || [];
}

// ---------- sites ----------
export async function sitesForOrganization(env, organizationId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, status, suspension_reason FROM sites WHERE organization_id = ?`).bind(organizationId).all()).results || [];
}

// ---------- pending Stripe cancellations ----------
export async function upsertCancelPending(env, { organizationId, providerSubscriptionId, atPeriodEnd, error }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO billing_cancel_pending (organization_id, provider_subscription_id, at_period_end, attempts, last_error, last_attempt_at)
     VALUES (?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(organization_id) DO UPDATE SET attempts = attempts + 1, last_error = excluded.last_error, last_attempt_at = CURRENT_TIMESTAMP`
  ).bind(organizationId, providerSubscriptionId || null, atPeriodEnd ? 1 : 0, String(error || "unknown").slice(0, 300)).run();
}
export async function listCancelPending(env, limit = 25) {
  return (await env.LUMMET_DB.prepare(`SELECT * FROM billing_cancel_pending ORDER BY created_at LIMIT ?`).bind(limit).all()).results || [];
}
export async function deleteCancelPending(env, organizationId) {
  await env.LUMMET_DB.prepare(`DELETE FROM billing_cancel_pending WHERE organization_id = ?`).bind(organizationId).run();
}
export async function cancellingPeriodEnd(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT current_period_end FROM subscriptions WHERE organization_id = ? AND cancel_at_period_end = 1 ORDER BY created_at DESC LIMIT 1`
  ).bind(organizationId).first();
  return r?.current_period_end || null;
}

// ---------- seats ----------
export async function countMembers(env, organizationId) {
  return (await env.LUMMET_DB.prepare(`SELECT COUNT(*) c FROM organization_users WHERE organization_id = ?`).bind(organizationId).first())?.c || 0;
}
export async function countPendingInvitations(env, organizationId, { nowIso, ignoreInvitationId = null }) {
  return (await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM organization_invitations WHERE organization_id = ? AND status = 'pending' AND expires_at > ? AND id != ?`
  ).bind(organizationId, nowIso, ignoreInvitationId || "").first())?.c || 0;
}

// ---------- webhook rejections ----------
export async function insertWebhookRejection(env, { provider, eventId, eventType, reason }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO billing_webhook_rejections (provider, event_id, event_type, reason) VALUES (?, ?, ?, ?)`
  ).bind(provider, eventId || null, eventType || null, reason).run();
}

// ---------- scheduler heartbeat ----------
export async function insertTick(env, { cron, ok, detail }) {
  await env.LUMMET_DB.prepare(`INSERT INTO scheduler_ticks (cron, ok, detail) VALUES (?, ?, ?)`).bind(cron, ok ? 1 : 0, detail || null).run();
}
export async function pruneTicks(env, days) {
  await env.LUMMET_DB.prepare(`DELETE FROM scheduler_ticks WHERE ran_at < datetime('now', ?)`).bind(`-${days} days`).run();
}
export async function lastTick(env, cron) {
  return env.LUMMET_DB.prepare(`SELECT cron, ran_at, ok, detail FROM scheduler_ticks WHERE cron = ? ORDER BY id DESC LIMIT 1`).bind(cron).first();
}

// ---------- trial abuse (Phase 1.5) ----------
// fingerprint_hash is UNIQUE, so one trial per card and one per business domain is also enforced by the database.
export async function findTrialFingerprint(env, hash) {
  return env.LUMMET_DB.prepare(`SELECT id, organization_id, email_domain FROM trial_fingerprints WHERE fingerprint_hash = ?`).bind(hash).first();
}
export async function insertTrialFingerprint(env, { hash, emailDomain, organizationId }) {
  const res = await env.LUMMET_DB.prepare(
    `INSERT OR IGNORE INTO trial_fingerprints (fingerprint_hash, email_domain, organization_id) VALUES (?, ?, ?)`
  ).bind(hash, emailDomain || null, organizationId || null).run();
  return !!res?.meta?.changes;
}
/** Verified owners' addresses for an organization (the people whose identity a trial belongs to). */
export async function ownerEmails(env, organizationId) {
  return (await env.LUMMET_DB.prepare(
    `SELECT u.email, u.email_key FROM organization_users ou JOIN customer_users u ON u.id = ou.user_id WHERE ou.organization_id = ? AND ou.role = 'owner'`
  ).bind(organizationId).all()).results || [];
}
/** Another organization (not this one) owned by the same person that ever held a subscription. */
// startedOnly: ignore subscriptions that never really began (an abandoned checkout leaves an 'incomplete' row). Default
// false keeps the original behaviour for the checkout path; the no-card trial path passes true.
export async function otherOrgOwnedBySamePerson(env, organizationId, { startedOnly = false } = {}) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c
     FROM subscriptions s
     JOIN organization_users ou ON ou.organization_id = s.organization_id AND ou.role = 'owner'
     JOIN customer_users u ON u.id = ou.user_id
     WHERE s.organization_id != ?
       ${startedOnly ? "AND s.status NOT IN ('incomplete','incomplete_expired')" : ""}
       AND u.email_key IS NOT NULL AND u.email_key != ''
       AND u.email_key IN (
         SELECT cu.email_key FROM organization_users mou
         JOIN customer_users cu ON cu.id = mou.user_id
         WHERE mou.organization_id = ? AND mou.role = 'owner'
       )`
  ).bind(organizationId, organizationId).first();
  return (row?.c || 0) > 0;
}

/** The local trial is over as of now (the provider was told to end it). */
export async function endLocalTrial(env, subscriptionId) {
  await env.LUMMET_DB.prepare(`UPDATE subscriptions SET trial_ends_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(subscriptionId).run();
}

/** A no-card (local) trial already running on this plan for the organization, or null. */
export async function runningLocalTrial(env, organizationId, planId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT id, trial_ends_at FROM subscriptions WHERE organization_id = ? AND status = 'trialing' AND provider IS NULL AND plan_id = ? ORDER BY created_at DESC LIMIT 1`
  ).bind(organizationId, planId).first();
  return row ? { subscriptionId: row.id, trialEndsAt: row.trial_ends_at } : null;
}
