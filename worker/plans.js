// =====================================================
// PRODUCTS & PLANS (commercial catalog)
//
// Read-only from the customer side in Phase 1. Catalog
// management (creating/editing product & plan records,
// pricing) is staff-console work — master prompt section 45
// — and is not built yet; see the completion report for what
// that means in practice (today the catalog only has the one
// seeded example plan from migration 0006).
// =====================================================

import { notify } from "./billing-notifications.js";
import * as repo from "./repositories/billing-lifecycle.js";
import { checkTrialByDomain, recordTrialByDomain } from "./trial-abuse.js";

export async function listProducts(env) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT * FROM products WHERE status = 'active' ORDER BY category, name`
  ).all();
  return result.results || [];
}

export async function listPlans(env, productId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT p.*,
       (SELECT pp.stripe_price_id FROM plan_prices pp WHERE pp.plan_id = p.id AND pp.active = 1
          AND pp.currency = lower(p.currency) AND pp.interval = CASE p.billing_period WHEN 'annual' THEN 'year' ELSE 'month' END
        ORDER BY pp.version DESC LIMIT 1) AS active_price_id
     FROM plans p WHERE p.product_id = ? AND p.status = 'active' ORDER BY p.price_cents`
  )
    .bind(productId)
    .all();
  return result.results || [];
}

export async function getPlan(env, planId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM plans WHERE id = ?`).bind(planId).first();
}

export async function getActiveSubscription(env, organizationId) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM subscriptions WHERE organization_id = ? AND status NOT IN ('canceled', 'expired', 'incomplete_expired')
     ORDER BY created_at DESC LIMIT 1`
  )
    .bind(organizationId)
    .first();
}

/**
 * Starts a trial subscription for an organization on the given
 * plan. Phase 1 allows at most one non-canceled subscription per
 * organization at a time — upgrade/downgrade/multi-subscription
 * flows are Phase 2 billing work (master prompt section 14) and
 * are refused here rather than silently creating two subscriptions
 * whose entitlements could conflict.
 *
 * No payment provider exists yet, so this only ever produces a
 * "trialing" subscription — never "active" (rule #5: don't fake
 * billing).
 */
/**
 * Trial-abuse mitigation, part 1: the same PERSON coming back (master prompt section 13; roadmap 1.6).
 *
 * A trial belongs to the people who OWN the organization. The question is: does an owner of THIS organization
 * (compared by email_key: lower case, "+tag" removed, Gmail dots unified) also own a DIFFERENT organization that
 * already held a subscription? If so, refuse.
 *
 * Phase 1.5 fix (N3): this used to compare EVERY member of this organization with EVERY member of other
 * organizations, so an agency's staff, invited into a client's organization, made the client's trial look
 * "already used" because the staff already belonged to the agency's organization. Only owners count now: a staff
 * member invited into a client organization is a member there, not an owner, and is never the reason for a refusal.
 *
 * The other signals (card fingerprint, business email domain) live in trial-abuse.js, because they need billing
 * configuration; this function stays the always-on, no-configuration part.
 */
async function hasPriorTrialElsewhere(env, organizationId) {
  return repo.otherOrgOwnedBySamePerson(env, organizationId);
}

export async function startTrialSubscription(env, organizationId, planId) {
  const plan = await getPlan(env, planId);
  if (!plan) return { ok: false, status: 422, error: "invalid_plan" };

  const existing = await env.LUMMET_DB.prepare(
    `SELECT id FROM subscriptions WHERE organization_id = ? AND status NOT IN ('canceled', 'expired', 'incomplete_expired')`
  )
    .bind(organizationId)
    .first();
  if (existing) return { ok: false, status: 409, error: "organization_already_subscribed" };

  const trialDays = plan.trial_days || 0;
  if (trialDays > 0 && (await hasPriorTrialElsewhere(env, organizationId))) {
    return { ok: false, status: 409, error: "trial_already_used" };
  }
  if (trialDays > 0) {
    const byDomain = await checkTrialByDomain(env, organizationId);
    if (!byDomain.ok) return { ok: false, status: 409, error: byDomain.error, reason: byDomain.reason };
  }

  const id = crypto.randomUUID();
  const trialEndsAt =
    trialDays > 0 ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString() : null;

  await env.LUMMET_DB.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan_id, status, trial_ends_at) VALUES (?, ?, ?, 'trialing', ?)`
  )
    .bind(id, organizationId, planId, trialEndsAt)
    .run();
  if (trialDays > 0) await recordTrialByDomain(env, organizationId);
  // Phase 2.1: tell the owners the trial started (inert unless BILLING_EMAILS=on; waits for a verified address).
  if (trialDays > 0) {
    try { await notify.trialStarted(env, { organizationId, subscriptionId: id, trialEndsAt }); }
    catch (e) { console.error(JSON.stringify({ msg: "billing_trial_welcome_failed", organizationId, error: e?.message || String(e) })); }
  }

  return { ok: true, subscriptionId: id, trialEndsAt };
}
