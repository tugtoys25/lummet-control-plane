// =====================================================
// ENTITLEMENT SERVICE
//
// The ONLY place that should ever answer "can this
// organization do X" / "how much of X can it have". Never
// gate a feature on a plan name or product key directly
// (master prompt section 12 — no `if (plan === "pro")`
// anywhere in application code); always resolve through here.
//
// A "trialing" subscription past its trial_ends_at with no
// billing behind it collapses to the zero-access floor
// immediately, calculated from the real date every time —
// never a status flag someone forgot to flip (section 13).
// =====================================================

import { getActiveSubscription, getPlan } from "./plans.js";

// The floor for an organization with no usable subscription at all
// — never subscribed, or its subscription expired/was canceled
// with nothing replacing it. This is a system-level default, not
// tied to any specific plan's name or identity (rule #3).
const ZERO_ACCESS_ENTITLEMENTS = {
  "sites.max": { type: "number", value: 0 },
  "domains.custom.max": { type: "number", value: 0 },
  "users.max": { type: "number", value: 1 },
  "storage.max_mb": { type: "number", value: 0 },
  "ai.enabled": { type: "boolean", value: false },
  "affiliate.enabled": { type: "boolean", value: false },
  "analytics.level": { type: "text", value: "none" },
  "white_label.enabled": { type: "boolean", value: false },
  "api.enabled": { type: "boolean", value: false },
  // Phase 5 additions — gate the tenant-portal analytics/reports/
  // campaigns/alerts proxy (tenant-portal.js). "affiliate.enabled"
  // already covers campaigns (see tenant-portal.js's own comment).
  "reports.enabled": { type: "boolean", value: false },
  "alerts.enabled": { type: "boolean", value: false },
  // Phase 7 additions — see migration 0014's header comment.
  "approval_workflows.enabled": { type: "boolean", value: false },
  "dedicated_infrastructure.enabled": { type: "boolean", value: false }
};

function castValue(type, raw) {
  if (type === "boolean") return raw === "true" || raw === "1";
  if (type === "number") return Number(raw);
  if (type === "json") {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  return raw; // text
}

async function loadPlanEntitlements(env, planId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT key, value_type, value FROM plan_entitlements WHERE plan_id = ?`
  )
    .bind(planId)
    .all();
  const map = {};
  for (const row of result.results || []) {
    map[row.key] = { type: row.value_type, value: castValue(row.value_type, row.value) };
  }
  return map;
}

async function loadOverrides(env, subscriptionId) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT key, value_type, value FROM subscription_entitlement_overrides WHERE subscription_id = ?`
  )
    .bind(subscriptionId)
    .all();
  const map = {};
  for (const row of result.results || []) {
    map[row.key] = { type: row.value_type, value: castValue(row.value_type, row.value) };
  }
  return map;
}

function isEffectivelyExpiredTrial(subscription) {
  return (
    subscription.status === "trialing" &&
    subscription.trial_ends_at &&
    new Date(subscription.trial_ends_at).getTime() < Date.now()
  );
}

// past_due keeps read access during a grace period rather than an
// immediate hard cutoff — see master prompt section 13's
// trial-expired -> restricted -> grace-period -> suspended flow.
// The actual grace-period/suspension state machine is Phase 2
// billing work; this only prevents past_due from silently
// resolving to full access.
const USABLE_STATUSES = new Set(["trialing", "active", "past_due"]);

export async function resolveForOrganization(env, organizationId) {
  const subscription = await getActiveSubscription(env, organizationId);

  if (!subscription || !USABLE_STATUSES.has(subscription.status) || isEffectivelyExpiredTrial(subscription)) {
    return { ...ZERO_ACCESS_ENTITLEMENTS };
  }

  const plan = await getPlan(env, subscription.plan_id);
  if (!plan) return { ...ZERO_ACCESS_ENTITLEMENTS };

  const planEntitlements = await loadPlanEntitlements(env, plan.id);
  const overrides = await loadOverrides(env, subscription.id);

  return { ...ZERO_ACCESS_ENTITLEMENTS, ...planEntitlements, ...overrides };
}

/** Returns the raw resolved value for one entitlement key, or undefined. */
export async function checkEntitlement(env, organizationId, key) {
  const entitlements = await resolveForOrganization(env, organizationId);
  const entry = entitlements[key];
  return entry ? entry.value : undefined;
}

/**
 * Convenience boolean check. For numeric limits, pass `atLeast` to
 * ask "does the org's limit allow at least N" rather than reading
 * the raw number yourself.
 */
export async function requireEntitlement(env, organizationId, key, { atLeast } = {}) {
  const value = await checkEntitlement(env, organizationId, key);
  if (typeof value === "boolean") return value === true;
  if (typeof value === "number" && atLeast != null) return value >= atLeast;
  return !!value;
}
