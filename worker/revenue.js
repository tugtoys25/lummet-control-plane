// =====================================================
// REVENUE MOVEMENTS (Round 6.1A, release 2.6.0.1)
//
// Turns provider-confirmed subscription state into an append-only ledger of MRR movements (migration 0071). No SQL here: the
// repository owns it. Nothing in this file is called from a customer or staff UI action. The only callers are
//   - the billing webhook dispatcher (after the existing handlers have written the subscription),
//   - the billing lifecycle sweep (after it moves a subscription's status), and
//   - the daily tick (the deterministic backfill).
//
//   REVENUE_METRICS=off      -> nothing is recorded
//   REVENUE_METRICS=shadow   -> (default) movements are recorded; nothing reads them yet
//   REVENUE_METRICS=on       -> same writes; reserved for the 6.1B/6.1C readers
//
// Design: a movement is the DIFFERENCE between the MRR the ledger last recorded for a subscription and the MRR its current row
// implies. Seeing the same state again gives a difference of zero and writes nothing, so a duplicate, a replay or a re-run is a no-op.
// A per-subscription watermark (the newest provider event time already considered) makes a late, older event a no-op as well.
//
// MRR contribution is the list price of the plan times the confirmed quantity, minus a recurring coupon (Round 6.1B): active and past_due
// count, annual is divided by 12, trials and every other status count nothing. Add-on prices and currency conversion are NOT included;
// see OPEN_ITEMS. The daily job that turns this ledger into revenue_snapshots is worker/revenue-job.js.
// =====================================================

import { revenueMode } from "./billing-config.js";
import * as repo from "./repositories/revenue.js";
import { planIdForPrice } from "./repositories/billing-subscriptions.js";

export const COUNTED_STATUSES = new Set(["active", "past_due"]);
/** Coupon durations that keep reducing every invoice. A one-time ("once") discount is not recurring revenue. */
export const RECURRING_DISCOUNTS = new Set(["repeating", "forever"]);
const MAX_ATTEMPTS = 3;

/** The coupon fields joined onto a subscription row (repository.subscriptionForRevenue), as the discount mrrCents understands, or null. */
export function discountOf(row) {
  if (!row || !row.coupon_duration) return null;
  return { percentOff: row.coupon_percent_off == null ? null : Number(row.coupon_percent_off), amountOffCents: row.coupon_amount_off_cents == null ? null : Number(row.coupon_amount_off_cents), duration: row.coupon_duration };
}

/**
 * One subscription's monthly recurring revenue in cents (blueprint section 13). Pure.
 * active and past_due count; annual is divided by 12; a RECURRING coupon (repeating or forever) is subtracted; trials, every other
 * status, one-time fees and one-time discounts count nothing. A percent applies to the whole line (price x quantity); a flat amount is
 * taken once per invoice (spread over 12 months on an annual plan). The result never goes below zero.
 */
export function mrrCents({ status, priceCents, billingPeriod, quantity = 1, discount = null }) {
  if (!COUNTED_STATUSES.has(status)) return 0;
  if (!Number.isInteger(priceCents) || priceCents <= 0) return 0;
  const q = Number.isInteger(quantity) && quantity >= 1 ? quantity : 1;
  const total = priceCents * q;
  let gross;
  if (billingPeriod === "monthly") gross = total;
  else if (billingPeriod === "annual") gross = Math.round(total / 12);
  else return 0; // 'custom' (contract pricing) is not list-price MRR
  let off = 0;
  if (discount && RECURRING_DISCOUNTS.has(discount.duration)) {
    if (discount.percentOff > 0 && discount.percentOff <= 100) off = Math.round((gross * discount.percentOff) / 100);
    else if (discount.amountOffCents > 0) off = billingPeriod === "annual" ? Math.round(discount.amountOffCents / 12) : discount.amountOffCents;
  }
  return Math.max(0, gross - off);
}

/** Price-only MRR as if the subscription were counted: what a past counted period was worth (used by the backfill). */
const countedMrr = (sub, quantity = 1) => mrrCents({ status: "active", priceCents: sub.price_cents, billingPeriod: sub.billing_period, quantity, discount: discountOf(sub) });

const upper = (c) => String(c || "USD").trim().toUpperCase();
const dayOfUnix = (unix) => new Date(Number(unix) * 1000).toISOString().slice(0, 10);
const dayOfMs = (ms) => new Date(ms).toISOString().slice(0, 10);
/** 'YYYY-MM-DD' from a stored timestamp ('2026-10-15 08:00:00' or ISO), or null. */
function dayOfStamp(value) { const s = String(value || ""); return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null; }

function kindFor(before, after) {
  if (before === 0 && after > 0) return "new";
  if (before > 0 && after === 0) return "churn";
  return after > before ? "expansion" : "contraction";
}

/**
 * Observe one subscription and record the movement its current state implies, if any.
 *   source        'webhook' (provider-confirmed event) or 'lifecycle' (the billing sweep)
 *   eventCreated  the provider event time in unix seconds (webhooks); an older one than already seen is ignored
 *   quantity      the provider-confirmed quantity of the plan item, when the event carries one; otherwise the last known one is kept
 *   now           injectable clock (ms) for lifecycle observations
 * Returns { status: 'applied' | 'unchanged' | 'stale' | 'disabled' | 'missing', movement? }.
 */
export async function deriveSubscriptionMovement(env, { subscriptionId, source = "webhook", eventCreated = null, quantity, now = Date.now() } = {}) {
  if (revenueMode(env) === "off") return { status: "disabled" };
  const sub = await repo.subscriptionForRevenue(env, subscriptionId);
  if (!sub) return { status: "missing" };
  // First sight of a subscription that existed before the rollout: baseline it from its history instead of booking it as new today.
  if (!(await repo.getState(env, subscriptionId))) await backfillOne(env, sub, { now });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = (await repo.getState(env, subscriptionId)) || { seq: 0, mrr_cents: 0, quantity: 1, last_event_created: 0, currency: upper(sub.currency) };
    const at = Number(eventCreated) || 0;
    if (at && at < Number(state.last_event_created || 0)) return { status: "stale" };
    const qty = Number.isInteger(quantity) && quantity >= 1 ? quantity : Number(state.quantity) || 1;
    const target = mrrCents({ status: sub.status, priceCents: sub.price_cents, billingPeriod: sub.billing_period, quantity: qty, discount: discountOf(sub) });
    const before = Number(state.mrr_cents) || 0;
    const currency = upper(sub.currency);
    const next = { mrrCents: target, currency, planId: sub.plan_id, quantity: qty };
    const delta = target - before;
    const movement = delta === 0 ? null : {
      seq: Number(state.seq) + 1, day: at ? dayOfUnix(at) : dayOfMs(now), kind: kindFor(before, target), deltaCents: delta, mrrAfterCents: target,
      currency, planId: sub.plan_id, quantity: qty, source, eventCreated: at || null
    };
    const result = await repo.commitObservation(env, { subscriptionId, organizationId: sub.organization_id, expectedSeq: Number(state.seq), movements: movement ? [movement] : [], next, eventCreated: at });
    if (result.applied) return movement ? { status: "applied", movement } : { status: "unchanged" };
  }
  throw new Error(`revenue_movement_conflict: subscription ${subscriptionId} kept changing underneath the ledger`);
}

/** Same as deriveSubscriptionMovement, but a failure is logged and returned, never raised: revenue shadowing must not fail billing. */
export async function deriveSafely(env, args) {
  try { return await deriveSubscriptionMovement(env, args); }
  catch (error) {
    console.error(JSON.stringify({ msg: "revenue_movement_failed", subscriptionId: args?.subscriptionId, eventId: args?.eventId || null, error: error?.message || String(error) }));
    return { status: "error" };
  }
}

// ---- which provider events matter, and what they say about quantity ----

const SUBSCRIPTION_EVENTS = new Set(["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]);
const INVOICE_OR_CHECKOUT_EVENTS = new Set(["checkout.session.completed", "invoice.paid", "invoice.payment_failed"]);

/** The provider subscription id an event is about, for the events that can change a subscription's status, plan or quantity. */
export function providerSubscriptionIdFor(event) {
  const obj = event?.data?.object || {};
  if (SUBSCRIPTION_EVENTS.has(event?.type)) return obj.id || null;
  if (INVOICE_OR_CHECKOUT_EVENTS.has(event?.type)) return typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id || null;
  return null;
}

/** The confirmed quantity of the PLAN line on a subscription event (add-on lines are skipped), or undefined when it cannot be told. */
export async function planQuantityFromEvent(env, event) {
  if (event?.type !== "customer.subscription.created" && event?.type !== "customer.subscription.updated") return undefined;
  const items = event?.data?.object?.items?.data;
  if (!Array.isArray(items) || !items.length) return undefined;
  const valid = (q) => (Number.isInteger(Number(q)) && Number(q) >= 1 ? Number(q) : undefined);
  for (const item of items) {
    if (item?.price?.id && (await planIdForPrice(env, item.price.id))) return valid(item.quantity);
  }
  return items.length === 1 ? valid(items[0]?.quantity) : undefined;
}

/** Called by the webhook dispatcher after a provider event was handled. `findByProviderId` resolves the local subscription row. */
export async function trackProviderEvent(env, event, findByProviderId) {
  if (revenueMode(env) === "off") return { status: "disabled" };
  const providerId = providerSubscriptionIdFor(event);
  if (!providerId) return { status: "ignored" };
  try {
    const sub = await findByProviderId(env, providerId);
    if (!sub) return { status: "missing" };
    const quantity = await planQuantityFromEvent(env, event);
    return await deriveSubscriptionMovement(env, { subscriptionId: sub.id, source: "webhook", eventCreated: Number(event.created) || null, quantity });
  } catch (error) {
    console.error(JSON.stringify({ msg: "revenue_movement_failed", eventId: event?.id || null, type: event?.type || null, error: error?.message || String(error) }));
    return { status: "error" };
  }
}

// ---- deterministic backfill ----

/**
 * Reconstruct one subscription's history from what is stored: its status events and its current plan. The result depends only on those
 * rows, never on the clock, so two databases with the same rows get the same ledger. Plan and quantity history is not stored anywhere,
 * so the CURRENT plan is assumed for the whole counted period (limitation recorded in OPEN_ITEMS).
 * Writes the state row even when there is nothing to record, so the subscription is marked done and has a watermark.
 */
async function backfillOne(env, sub, { now = Date.now() } = {}) {
  const history = await repo.statusHistory(env, sub.id);
  const price = countedMrr(sub, 1);
  const counted = (s) => COUNTED_STATUSES.has(s);
  const countedNow = mrrCents({ status: sub.status, priceCents: sub.price_cents, billingPeriod: sub.billing_period, quantity: 1, discount: discountOf(sub) });
  const firstCountedEvent = history.find((h) => counted(h.to_status));
  const fallbackDay = dayOfStamp(sub.created_at) || dayOfStamp(sub.updated_at) || dayOfMs(now);
  const movements = [];
  const currency = upper(sub.currency);
  if (price > 0 && (firstCountedEvent || countedNow > 0)) {
    const startDay = dayOfStamp(firstCountedEvent?.created_at) || dayOfStamp(sub.current_period_start) || fallbackDay;
    movements.push({ seq: 1, day: startDay, kind: "new", deltaCents: price, mrrAfterCents: price, currency, planId: sub.plan_id, quantity: 1, source: "backfill" });
    if (countedNow === 0) {
      const startIndex = history.indexOf(firstCountedEvent);
      const left = firstCountedEvent ? history.slice(startIndex + 1).find((h) => !counted(h.to_status)) : null;
      const endDay = dayOfStamp(left?.created_at) || dayOfStamp(sub.canceled_at) || dayOfStamp(sub.updated_at) || startDay;
      movements.push({ seq: 2, day: endDay < startDay ? startDay : endDay, kind: "churn", deltaCents: -price, mrrAfterCents: 0, currency, planId: sub.plan_id, quantity: 1, source: "backfill" });
    }
  }
  const result = await repo.commitObservation(env, {
    subscriptionId: sub.id, organizationId: sub.organization_id, expectedSeq: 0, movements,
    next: { mrrCents: countedNow, currency, planId: sub.plan_id, quantity: 1 }, eventCreated: 0
  });
  return { created: result.applied ? movements.length : 0 };
}

/**
 * Backfill a batch of subscriptions that have no revenue state yet, in id order. Re-running it, or running it while webhooks arrive,
 * changes nothing that already exists. Resume with the returned nextCursor.
 */
export async function backfillRevenueMovements(env, { limit = 200, afterId = "", now = Date.now() } = {}) {
  const ids = await repo.listBackfillCandidates(env, { afterId, limit });
  let created = 0;
  for (const id of ids) {
    const sub = await repo.subscriptionForRevenue(env, id);
    if (!sub) continue;
    created += (await backfillOne(env, sub, { now })).created;
  }
  const full = ids.length >= Math.max(1, Math.min(1000, Number(limit) || 200));
  return { processed: ids.length, created, nextCursor: full ? ids[ids.length - 1] : null };
}

/** One bounded step of the backfill for the daily tick (up to five batches). Does nothing under REVENUE_METRICS=off. */
export async function runBackfillTick(env, { limit = 200, batches = 5, now = Date.now() } = {}) {
  if (revenueMode(env) === "off") return { skipped: "off", processed: 0, created: 0 };
  let processed = 0, created = 0, cursor = "", more = false;
  for (let i = 0; i < batches; i++) {
    const r = await backfillRevenueMovements(env, { limit, afterId: cursor, now });
    processed += r.processed; created += r.created; more = r.nextCursor != null; cursor = r.nextCursor || "";
    if (!more) break;
  }
  return { skipped: null, processed, created, more };
}
