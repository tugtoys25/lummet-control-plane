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

export async function listProducts(env) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT * FROM products WHERE status = 'active' ORDER BY category, name`
  ).all();
  return result.results || [];
}

export async function listPlans(env, productId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT * FROM plans WHERE product_id = ? AND status = 'active' ORDER BY price_cents`
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
 * Partial trial-abuse mitigation (master prompt section 13; roadmap
 * 1.6). Checked: has any email that is a member of THIS organization
 * already had a trial in a DIFFERENT organization? If so, refuse — this
 * catches the straightforward "cancel and sign up again under a new
 * org with the same email" pattern.
 *
 * v7G: addresses are compared by email_key (lower case, "+tag" removed,
 * Gmail dots and googlemail.com unified), so a trivial variant of the
 * same address no longer gets a second trial.
 *
 * NOT covered by this check, and explicitly flagged rather than
 * silently assumed solved: an operator using a genuinely different
 * email address each time. Closing that needs a payment-method fingerprint (e.g. a
 * Stripe SetupIntent collected before the trial, without charging it)
 * or an email-verification-provider risk signal — either requires a
 * live account this environment cannot exercise, so it isn't built
 * here. Do not treat this function's existence as though the deeper
 * problem is solved.
 */
async function hasPriorTrialElsewhere(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c
     FROM subscriptions s
     JOIN organization_users ou ON ou.organization_id = s.organization_id
     JOIN customer_users u ON u.id = ou.user_id
     WHERE s.organization_id != ?
       AND u.email_key IN (
         SELECT cu.email_key FROM organization_users mou
         JOIN customer_users cu ON cu.id = mou.user_id
         WHERE mou.organization_id = ?
       )`
  ).bind(organizationId, organizationId).first();
  return (row?.c || 0) > 0;
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

  const id = crypto.randomUUID();
  const trialEndsAt =
    trialDays > 0 ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000).toISOString() : null;

  await env.LUMMET_DB.prepare(
    `INSERT INTO subscriptions (id, organization_id, plan_id, status, trial_ends_at) VALUES (?, ?, ?, 'trialing', ?)`
  )
    .bind(id, organizationId, planId, trialEndsAt)
    .run();

  return { ok: true, subscriptionId: id, trialEndsAt };
}
