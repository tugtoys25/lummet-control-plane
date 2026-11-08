// =====================================================
// CREATE A PLAN'S STRIPE PRICE FROM THE CONSOLE
//
// Until now staff created the recurring price in Stripe by hand and pasted its id on the plan's Pricing tab. This does the first
// half for them and then runs the SAME attach step as the manual path (plan-catalog.js setPlanPrice), so every existing check
// still applies: Stripe is asked about the id, amount, currency, interval and test/live mode must match, a price id is never
// used twice, and a new immutable price version is recorded with its lookup key.
//
// Safe by construction:
//   - Stripe prices are immutable, so a wrong click cannot be edited away. A LIVE key therefore needs an explicit confirmation.
//   - Product ids are the ones scripts/stripe-sync.mjs uses (prod_lummet_<product key>): the product is found, created only when
//     missing, and never renamed, so the two tools never create duplicates of each other.
//   - Idempotency keys are the same as the sync script's (product:<id>, price:<lookup key>), so a retry returns the same object.
//   - A price already in Stripe under the lookup key (a half-finished earlier attempt) is adopted when it matches exactly,
//     refused with a clear error when it does not. Nothing is ever edited or archived here.
//   - If Stripe succeeds and the attach step refuses, the error carries the Stripe price id so nothing is lost.
// =====================================================
import { stripeRequest } from "./billing-stripe.js";
import { stripeProductId, priceLookupKey, PERIOD_INTERVAL, TAX_BEHAVIORS } from "./catalog.js";
import { stripeModeFromEnv } from "./plan-prices.js";
import { setPlanPrice } from "./plan-catalog.js";
import * as repo from "./repositories/plan-catalog.js";
import * as versions from "./repositories/plan-price-versions.js";

const fail = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const isMissing = (e) => e?.kind === "rejected" && (e.status === 404 || e.code === "resource_missing");

function stripeFailure(e) {
  const detail = String(e?.message || "").slice(0, 300);
  return e?.kind === "rejected" ? fail(422, "stripe_rejected", { detail }) : fail(502, "stripe_unreachable", { detail });
}

/**
 * input: { amountCents?, taxBehavior?, reason, confirmLive? }. The amount defaults to the plan's list price.
 * Returns { ok: true, version, verified, stripePriceId, lookupKey, mode, adopted } or { ok: false, status, error, ... }.
 */
export async function createStripePriceForPlan(env, planId, input = {}) {
  const plan = await repo.getPlan(env, planId);
  if (!plan) return fail(404, "not_found");
  const interval = PERIOD_INTERVAL[plan.billing_period];
  if (!interval) return fail(422, "plan_not_recurring");
  if (!env.STRIPE_SECRET_KEY) return fail(409, "stripe_not_configured");

  const amount = Number(input.amountCents ?? plan.price_cents);
  if (!Number.isInteger(amount) || amount <= 0 || amount > 100_000_000) return fail(422, "invalid_price_cents");
  const taxBehavior = input.taxBehavior || "unspecified";
  if (!TAX_BEHAVIORS.includes(taxBehavior)) return fail(422, "invalid_tax_behavior");
  const reason = clean(input.reason, 300);
  if (!reason) return fail(422, "reason_required");

  const mode = stripeModeFromEnv(env); // "live" | "test" | null (an unrecognised key shape)
  if (mode !== "test" && input.confirmLive !== true) return fail(409, "live_confirmation_required", { mode: mode || "unknown" });

  const product = await repo.getProduct(env, plan.product_id);
  if (!product) return fail(422, "product_not_found");
  const currency = String(plan.currency || "USD").toLowerCase();
  const version = (await versions.maxVersion(env, planId, currency, interval)) + 1;
  const lookupKey = priceLookupKey(plan.key, interval, currency, version);
  const stripeProduct = stripeProductId(product.key);

  try {
    // 1. The Stripe product: found by its fixed id, created only when missing (its name is what customers see at Checkout).
    try { await stripeRequest(env, "GET", `/products/${encodeURIComponent(stripeProduct)}`); }
    catch (e) {
      if (!isMissing(e)) throw e;
      await stripeRequest(env, "POST", "/products", {
        id: stripeProduct, name: product.public_name || product.name, metadata: { lummet_product_key: product.key }
      }, { idempotencyKey: `product:${stripeProduct}` });
    }

    // 2. A price already under this lookup key is a half-finished earlier attempt: adopt it only if it matches exactly.
    let price = null, adopted = false;
    const found = await stripeRequest(env, "GET", `/prices?limit=1&lookup_keys[]=${encodeURIComponent(lookupKey)}`);
    const existing = found?.data?.[0];
    if (existing) {
      const same = existing.active !== false && existing.unit_amount === amount && String(existing.currency).toLowerCase() === currency
        && existing.recurring?.interval === interval && (existing.recurring?.interval_count || 1) === 1;
      if (!same) return fail(409, "lookup_key_in_use", { lookupKey, stripePriceId: existing.id });
      price = existing; adopted = true;
    }

    // 3. Otherwise create it. Same shape as the sync script, so a price made here and one made there are indistinguishable.
    if (!price) {
      price = await stripeRequest(env, "POST", "/prices", {
        product: stripeProduct, currency, unit_amount: amount, recurring: { interval }, lookup_key: lookupKey,
        tax_behavior: taxBehavior === "unspecified" ? undefined : taxBehavior,
        nickname: `${plan.name} (${interval}) v${version}`.slice(0, 250),
        metadata: { lummet_plan_key: plan.key, lummet_price_version: version, lummet_created_by: "staff_console" }
      }, { idempotencyKey: `price:${lookupKey}` });
    }

    // 4. Attach through the existing path (verifies against Stripe again, records the version, mirrors the list price).
    const attached = await setPlanPrice(env, planId, { amountCents: amount, stripePriceId: price.id, taxBehavior, reason });
    if (!attached.ok) return { ...attached, stripePriceId: price.id, createdInStripe: !adopted };
    return { ok: true, version: attached.version, verified: attached.verified, mode: attached.mode, from: attached.from, to: attached.to, reason: attached.reason, stripePriceId: price.id, lookupKey, adopted };
  } catch (e) {
    return stripeFailure(e);
  }
}
