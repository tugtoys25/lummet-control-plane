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
import { billingConfig } from "./billing-config.js";
import { resolveAccess } from "./access.js";
import * as commercialRepo from "./repositories/commercial.js";

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
  "dedicated_infrastructure.enabled": { type: "boolean", value: false },
  // Round 6.4C: organization IP allowlist. Off for every plan until the owner grants it to the plans he calls "business" (a plan_entitlements
  // row, or a staff override on one subscription). No plan name appears in code.
  "security.ip_allowlist.enabled": { type: "boolean", value: false }
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

export async function resolveForOrganization(env, organizationId, { now } = {}) {
  const subscription = await getActiveSubscription(env, organizationId);

  if (!subscription || !USABLE_STATUSES.has(subscription.status) || isEffectivelyExpiredTrial(subscription)) {
    return { ...ZERO_ACCESS_ENTITLEMENTS };
  }

  // With BILLING_ENFORCE=enforce the access state machine (access.js) decides, so a past_due subscription whose grace
  // period has ended no longer keeps full entitlements forever. Off and shadow leave the legacy logic above untouched.
  if (billingConfig(env).mode === "enforce") {
    const access = await resolveAccess(env, organizationId, now ?? Date.now());
    if (!access.canMutate) return { ...ZERO_ACCESS_ENTITLEMENTS };
  }

  const plan = await getPlan(env, subscription.plan_id);
  if (!plan) return { ...ZERO_ACCESS_ENTITLEMENTS };

  const planEntitlements = await loadPlanEntitlements(env, plan.id);
  const overrides = await loadOverrides(env, subscription.id);
  const resolved = { ...ZERO_ACCESS_ENTITLEMENTS, ...planEntitlements, ...overrides };
  const founder = await commercialRepo.findFounderLicense?.(env, organizationId);
  if (founder?.entitlement_json) { try { Object.assign(resolved, JSON.parse(founder.entitlement_json)); } catch (error) { console.error(JSON.stringify({ msg: "founder_entitlement_json_invalid", organizationId, error: error?.message || String(error) })); } }
  const quoteGrants = await commercialRepo.listQuoteEntitlementGrants?.(env, organizationId);
  for (const grant of quoteGrants || []) { try { Object.assign(resolved, JSON.parse(grant.entitlement_json)); } catch (error) { console.error(JSON.stringify({ msg: "quote_entitlement_json_invalid", organizationId, error: error?.message || String(error) })); } }
  // Active catalog add-ons are additive overrides, applied after the base plan and explicit
  // subscription overrides. Only numeric entitlements can be increased; no add-on can enable
  // a boolean capability or lower an existing limit.
  const addonRows = await commercialRepo.selectSubscriptionAddons(env, subscription.id);
  for (const row of addonRows) {
    const current = resolved[row.entitlement_key];
    if (current && current.type === "number" && Number.isFinite(Number(row.delta_per_unit)) && Number(row.delta_per_unit) >= 0) {
      current.value += Number(row.delta_per_unit) * Number(row.quantity);
    }
  }
  return resolved;
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
