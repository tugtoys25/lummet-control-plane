// =====================================================
// PLAN PRICES (Phase 3, sprint 3.1)
//
// Checkout, plan changes and webhook plan mapping read the Stripe price from plan_prices, never from a free-text field.
// The table is filled by scripts/stripe-sync.mjs from catalog/plans.v1.json; see docs/CHANGES_PHASE_3_1.md.
// =====================================================
import * as repo from "./repositories/plan-prices.js";
import { PERIOD_INTERVAL } from "./catalog.js";

/** 'test' or 'live' from the Stripe secret key prefix (sk_/rk_ + test/live); null when no key is configured. */
export function stripeModeFromEnv(env) {
  const key = String((env && env.STRIPE_SECRET_KEY) || "");
  if (/^(sk|rk)_test_/.test(key)) return "test";
  if (/^(sk|rk)_live_/.test(key)) return "live";
  return null;
}

/**
 * The price a NEW checkout or plan change uses for this plan.
 *   { ok: true, price }
 *   { ok: false, status: 409, error: "plan_not_billing_configured" }   no active synced price (custom plan, never synced)
 *   { ok: false, status: 409, error: "price_mode_mismatch" }           the price belongs to the other Stripe mode
 * A row with mode 'unknown' (carried over from the old free-text field) is accepted; Stripe itself rejects a price
 * that does not exist in the key's mode, so the worst case is a failed checkout, never a wrong charge.
 */
export async function resolveCheckoutPrice(env, plan) {
  const interval = PERIOD_INTERVAL[plan.billing_period];
  if (!interval) return { ok: false, status: 409, error: "plan_not_billing_configured" };
  const price = await repo.activeForPlan(env, plan.id, plan.currency, interval);
  if (!price) return { ok: false, status: 409, error: "plan_not_billing_configured" };
  const mode = stripeModeFromEnv(env);
  if (mode && price.stripe_mode !== "unknown" && price.stripe_mode !== mode) {
    console.error(JSON.stringify({ msg: "plan_price_mode_mismatch", planId: plan.id, priceMode: price.stripe_mode, keyMode: mode, lookupKey: price.lookup_key }));
    return { ok: false, status: 409, error: "price_mode_mismatch" };
  }
  return { ok: true, price };
}

/** plan_id for a Stripe price id, any version (a subscriber on version 1 still maps after version 2 goes live). */
export async function planIdForPrice(env, stripePriceId) {
  return (await repo.byStripePriceId(env, stripePriceId))?.plan_id || null;
}

export { listPage as listPlanPrices } from "./repositories/plan-prices.js";
