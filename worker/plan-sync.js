// =====================================================
// PLAN SYNC (Phase 3, sprint 3.2, first half)
//
// Stripe is the truth for what a customer is subscribed to; Lummet is the truth for what that plan allows. This module
// keeps the two joined: when a customer.subscription.created/updated event names a price, the price is mapped to a plan
// through plan_prices (any version) and subscriptions.plan_id follows it.
//
//   BILLING_ENFORCE=off      -> inert (the legacy behaviour: plan_id changes only when Lummet itself changes it)
//   BILLING_ENFORCE=shadow   -> records what it WOULD change in plan_sync_issues (kind shadow_plan_change); changes nothing
//   BILLING_ENFORCE=enforce  -> applies the change and confirms the customer's open plan-change intent
//
// An UNKNOWN price (one plan_prices does not hold) changes nothing and raises the `unknown_price_id` alert (AT-5).
// Older events arriving late can never move a plan backwards: see subscriptions.plan_synced_event_at (migration 0053).
// =====================================================

import * as repo from "./repositories/plan-change-intents.js";
import { planIdForPrice } from "./plan-prices.js";
import { billingMode } from "./billing-config.js";

/** The price id a subscription event carries: the first item's price (the blueprint's items.data[0]). */
export function subscriptionPriceId(obj) {
  return obj?.items?.data?.[0]?.price?.id || obj?.plan?.id || null;
}

/** Monthly-equivalent price in cents; an annual plan is divided by 12. A plan with no price counts as 0. */
export function monthlyEquivalentCents(plan) {
  const cents = Number(plan?.price_cents) || 0;
  return plan?.billing_period === "annual" ? cents / 12 : cents;
}

/**
 * 'upgrade' | 'downgrade' | 'lateral'. Compared by monthly-equivalent price, so monthly to annual of the same tier is
 * lateral (a billing-period change, not a tier change). Different currencies are never compared: lateral.
 */
export function classifyDirection(fromPlan, toPlan) {
  if (!fromPlan || !toPlan) return "lateral";
  if (String(fromPlan.currency || "").toLowerCase() !== String(toPlan.currency || "").toLowerCase()) return "lateral";
  const a = Math.round(monthlyEquivalentCents(fromPlan)), b = Math.round(monthlyEquivalentCents(toPlan));
  return b > a ? "upgrade" : b < a ? "downgrade" : "lateral";
}

/** Moves the subscription's open intent to confirmed when the provider now shows the plan it asked for. */
async function confirmOpenIntent(env, subscriptionId, planId) {
  const open = await repo.openIntentFor(env, subscriptionId);
  if (!open || open.to_plan_id !== planId) return false;
  return (await repo.moveIntent(env, open.id, "submitted", "confirmed")) || (await repo.moveIntent(env, open.id, "pending", "confirmed"));
}

/**
 * Syncs one subscription's plan from a provider event.
 *   sub                 the local subscriptions row (already known; the caller resolved it by provider id)
 *   obj                 the event's subscription object
 *   event               the whole event (id, created)
 *   recordStatusEvent   billing.js's status-event writer (kept out of this module so it stays provider-neutral)
 *   onApplied           optional async callback after a plan really changed: ({ fromPlanId, toPlanId, eventAt })
 * Returns { action }: off | no_price | unknown_price | in_sync | shadow | stale | applied.
 */
export async function syncPlanFromSubscription(env, { sub, obj, event, recordStatusEvent, onApplied }) {
  const mode = billingMode(env);
  if (mode === "off") return { action: "off" };

  const items = obj?.items?.data || [];
  let priceId = subscriptionPriceId(obj);
  let mappedPlanId = priceId ? await planIdForPrice(env, priceId) : null;
  // Subscription item order is not a plan contract: add-ons may be first. Find the first catalog price that maps to a plan.
  if (!mappedPlanId) {
    for (const item of items.slice(1)) {
      const candidate = item?.price?.id; if (!candidate) continue;
      const plan = await planIdForPrice(env, candidate);
      if (plan) { priceId = candidate; mappedPlanId = plan; break; }
    }
  }
  if (!priceId) return { action: "no_price" };            // an event that carries no items says nothing about the plan

  const eventAt = Number(event?.created) || Math.floor(Date.now() / 1000);

  if (!mappedPlanId) {
    await repo.raiseIssue(env, {
      kind: "unknown_price_id", stripePriceId: priceId, providerSubscriptionId: obj.id, subscriptionId: sub.id,
      organizationId: sub.organization_id, fromPlanId: sub.plan_id, toPlanId: null, eventId: event?.id
    });
    console.error(JSON.stringify({ msg: "billing_unknown_price_id", providerSubscriptionId: obj.id, priceId, subscriptionId: sub.id, eventId: event?.id || null }));
    return { action: "unknown_price" };                   // nothing about the subscription is changed
  }
  await repo.resolveForSubscription(env, obj.id, ["unknown_price_id"], "auto: price mapped");

  if (mappedPlanId === sub.plan_id) {
    await repo.resolveForSubscription(env, obj.id, ["shadow_plan_change"], "auto: plan matches");
    if (mode === "enforce") {
      await repo.touchSyncedAt(env, sub.id, eventAt);
      await confirmOpenIntent(env, sub.id, mappedPlanId);
    }
    return { action: "in_sync" };
  }

  if (mode === "shadow") {
    await repo.raiseIssue(env, {
      kind: "shadow_plan_change", stripePriceId: priceId, providerSubscriptionId: obj.id, subscriptionId: sub.id,
      organizationId: sub.organization_id, fromPlanId: sub.plan_id, toPlanId: mappedPlanId, eventId: event?.id
    });
    console.log(JSON.stringify({ msg: "billing_plan_sync_shadow", subscriptionId: sub.id, from: sub.plan_id, to: mappedPlanId, priceId }));
    return { action: "shadow" };
  }

  // enforce: apply, unless a NEWER event already decided the plan.
  if (!(await repo.applyPlan(env, sub.id, mappedPlanId, eventAt))) return { action: "stale" };
  const [from, to] = await Promise.all([repo.planForSync(env, sub.plan_id), repo.planForSync(env, mappedPlanId)]);
  await recordStatusEvent({
    subscriptionId: sub.id, fromStatus: sub.status, toStatus: sub.status,
    reason: `plan synced from provider: ${from?.key || sub.plan_id} -> ${to?.key || mappedPlanId}`, actorType: "billing_webhook"
  });
  await confirmOpenIntent(env, sub.id, mappedPlanId);
  await repo.resolveForSubscription(env, obj.id, ["shadow_plan_change"], "auto: plan applied");
  if (onApplied) await onApplied({ fromPlanId: sub.plan_id, toPlanId: mappedPlanId, fromName: from?.name || null, toName: to?.name || null, eventAt });
  return { action: "applied", fromPlanId: sub.plan_id, toPlanId: mappedPlanId };
}

/** Raises unknown_price_id for a price the catalog does not hold (used by customer.subscription.created). No-op when off. */
export async function noteUnknownPriceOnCreate(env, { obj, event, organizationId }) {
  if (billingMode(env) === "off") return false;
  let priceId = subscriptionPriceId(obj);
  let known = priceId ? await planIdForPrice(env, priceId) : null;
  if (!known) { for (const item of (obj?.items?.data || []).slice(1)) { const candidate=item?.price?.id; if(!candidate) continue; const plan=await planIdForPrice(env,candidate); if(plan){priceId=candidate;known=plan;break;} } }
  if (!priceId || known) return false;
  await repo.raiseIssue(env, {
    kind: "unknown_price_id", stripePriceId: priceId, providerSubscriptionId: obj.id, subscriptionId: null,
    organizationId: organizationId || null, fromPlanId: null, toPlanId: null, eventId: event?.id
  });
  console.error(JSON.stringify({ msg: "billing_unknown_price_id", providerSubscriptionId: obj.id, priceId, eventId: event?.id || null }));
  return true;
}
