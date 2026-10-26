// Reminder queries for the five-minute tick (Phase 2.2). Repository: plain data in, plain data out. No business rules.

/** Trials still running. total length = trial_ends_at - created_at, so a short trial is not reminded about a long window. */
export async function trialingSubscriptions(env, limit = 500) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.organization_id, s.trial_ends_at, s.created_at FROM subscriptions s
     WHERE s.status = 'trialing' AND s.trial_ends_at IS NOT NULL ORDER BY s.trial_ends_at LIMIT ?`
  ).bind(limit).all()).results || [];
}

/** Paying subscriptions that will renew (provider-backed, not set to cancel). */
export async function renewingSubscriptions(env, limit = 500) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.organization_id, s.current_period_end, p.price_cents, p.currency, p.billing_period
     FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id
     WHERE s.status = 'active' AND s.provider_subscription_id IS NOT NULL AND s.cancel_at_period_end = 0
       AND s.current_period_end IS NOT NULL ORDER BY s.current_period_end LIMIT ?`
  ).bind(limit).all()).results || [];
}

export async function pastDueSubscriptions(env, limit = 500) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.organization_id, s.grace_ends_at, s.latest_invoice_id,
            (SELECT hosted_invoice_url FROM invoices i WHERE i.provider_invoice_id = s.latest_invoice_id LIMIT 1) AS invoice_url
     FROM subscriptions s WHERE s.status = 'past_due' AND s.grace_ends_at IS NOT NULL ORDER BY s.grace_ends_at LIMIT ?`
  ).bind(limit).all()).results || [];
}

export async function endingSubscriptions(env, limit = 500) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.organization_id, s.current_period_end FROM subscriptions s
     WHERE s.status IN ('active','trialing','past_due') AND s.cancel_at_period_end = 1 AND s.current_period_end IS NOT NULL
     ORDER BY s.current_period_end LIMIT ?`
  ).bind(limit).all()).results || [];
}

export async function organizationsPendingDeletion(env, limit = 200) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, scheduled_deletion_at FROM organizations
     WHERE scheduled_deletion_at IS NOT NULL AND erased_at IS NULL ORDER BY scheduled_deletion_at LIMIT ?`
  ).bind(limit).all()).results || [];
}
