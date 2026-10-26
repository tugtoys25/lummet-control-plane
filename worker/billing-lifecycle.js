// =====================================================
// BILLING LIFECYCLE SWEEP (Phase 1.2)
//
// Runs from the five-minute tick. Idempotent: every rule is a conditional UPDATE guarded by the status it
// expects, and an event row is written only when a row actually changed, so running the sweep twice changes
// nothing the second time.
//
//   BILLING_ENFORCE=off      -> does nothing except retry already-queued Stripe cancellations
//   BILLING_ENFORCE=shadow   -> records what it WOULD do in subscription_access_shadow; changes no subscription
//   BILLING_ENFORCE=enforce  -> applies the transitions
//
// Transitions written (everything after them is computed from the clock by access.js):
//   trialing (no card, trial ended)   -> expired
//   past_due (grace ended)            -> restricted   (restricted_at = the moment grace ended)
//   restricted (window elapsed)       -> suspended    (suspended_at = the moment the window elapsed)
// A suspended or closed state is only pushed to a customer's SITES when BILLING_SUSPEND_SITES=enforce (legacy on alias; the serve gate).
// =====================================================

import { billingConfig } from "./billing-config.js";
import { computeAccess } from "./access.js";
import { transitionSiteStatus } from "./sites.js";
import * as repo from "./repositories/billing-lifecycle.js";
import { notify } from "./billing-notifications.js";
import { enqueueSiteAccessPush } from "./site-access.js";
import { deriveSafely } from "./revenue.js";

const BILLING_SUSPENSION_REASON = "billing: suspended for non-payment";
const DAY = 86400000;

const EQUIVALENT_STATE = { trialing: "trialing", active: "active", past_due: "past_due", restricted: "restricted", unpaid: "restricted", suspended: "suspended", expired: "trial_expired" };

const stamp = (v) => {
  if (!v) return null;
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => new Date(t).toISOString();

/** Apply one transition and, only if it really changed the row, write the event that explains it. */
async function applied(env, sub, toStatus, reason, change) {
  if (!(await change)) return false;
  await repo.insertStatusEvent(env, { subscriptionId: sub.id, fromStatus: sub.status, toStatus, reason });
  // Round 6.1A: the sweep moved the status (for example past_due -> restricted ends the MRR); record the movement. Never fails the sweep.
  await deriveSafely(env, { subscriptionId: sub.id, source: "lifecycle" });
  return true;
}

/** Suspend (or restore) an organization's sites to match the access state. Only touches sites THIS module suspended. */
export async function applySiteGate(env, organizationId, state) {
  const sites = await repo.sitesForOrganization(env, organizationId);
  const out = { suspended: 0, restored: 0 };
  if (state === "suspended" || state === "closed") {
    for (const s of sites) {
      if (s.status !== "active") continue;
      const r = await transitionSiteStatus(env, s.id, "suspended", { reason: BILLING_SUSPENSION_REASON, actorType: "system" });
      if (r.ok) {
        try { await enqueueSiteAccessPush(env, s.id, state === "closed" ? "closed" : "suspended", BILLING_SUSPENSION_REASON); out.suspended += 1; }
        catch (error) { await transitionSiteStatus(env, s.id, "active", { reason: "site state push enqueue failed; rolled back", actorType: "system" }); throw error; }
      }
    }
  } else {
    for (const s of sites) {
      if (s.status !== "suspended" || s.suspension_reason !== BILLING_SUSPENSION_REASON) continue;   // staff suspensions are never undone here
      const r = await transitionSiteStatus(env, s.id, "active", { reason: "billing: restored", actorType: "system" });
      if (r.ok) {
        try { await enqueueSiteAccessPush(env, s.id, "serving", "billing: restored"); out.restored += 1; }
        catch (error) { await transitionSiteStatus(env, s.id, "suspended", { reason: BILLING_SUSPENSION_REASON, actorType: "system" }); throw error; }
      }
    }
  }
  return out;
}

async function shadowRecord(env, row) {
  const last = await repo.lastShadow(env, row.organizationId);
  if (last && last.state === row.state && last.would_change_from === row.wouldChangeFrom) return false;   // idempotent
  await repo.insertShadow(env, row);
  return true;
}

async function derivedFor(env, sub) {
  const derived = {};
  if (sub.status === "past_due" && !sub.grace_ends_at) {
    derived.graceStart = stamp(await repo.lastEnteredStatusAt(env, sub.id, ["past_due"])) ?? stamp(sub.updated_at);
  }
  if ((sub.status === "restricted" || sub.status === "unpaid") && !sub.restricted_at) {
    derived.restrictedStart = stamp(await repo.lastEnteredStatusAt(env, sub.id, ["restricted", "unpaid"])) ?? stamp(sub.updated_at);
  }
  return derived;
}

export async function sweep(env, now = Date.now(), { cfg, billingService } = {}) {
  const config = cfg || billingConfig(env);
  const summary = { mode: config.mode, expiredTrials: 0, restricted: 0, suspended: 0, shadowRows: 0, sitesSuspended: 0, sitesRestored: 0, cancelRetries: 0, cancelRetriesFailed: 0, planChangeRetries: 0, planChangeRetriesFailed: 0 };

  // Retried in every mode: a customer who deleted their organization must not keep being billed.
  if (billingService) Object.assign(summary, await retryPendingCancellations(env, billingService));
  // Likewise a plan change the customer asked for (sprint 3.2) is resent, with its own idempotency key, until it lands or fails.
  if (billingService?.retryPlanChangeIntents) Object.assign(summary, await billingService.retryPlanChangeIntents(env));

  if (config.mode === "off" && config.suspendSitesMode !== "shadow") return summary;
  const enforce = config.mode === "enforce";

  for (const sub of await repo.sweepCandidates(env)) {
    const org = await repo.getOrganizationStatus(env, sub.organization_id);
    const derived = await derivedFor(env, sub);
    const access = computeAccess({ sub, org, now, cfg: config, derived });
    const differs = access.state !== EQUIVALENT_STATE[sub.status];

    if (!enforce) {
      if (config.mode === "shadow" && differs && await shadowRecord(env, { organizationId: sub.organization_id, subscriptionId: sub.id, state: access.state, wouldChangeFrom: sub.status, reason: access.reason })) summary.shadowRows += 1;
      if (config.suspendSitesMode === "shadow" && (access.state === "suspended" || access.state === "closed")) {
        if (await shadowRecord(env, { organizationId: sub.organization_id, subscriptionId: sub.id, state: access.state, wouldChangeFrom: "site_serving", reason: "BILLING_SUSPEND_SITES shadow: would push site access state; no site changed" })) summary.shadowRows += 1;
      }
      continue;
    }
    if (!differs) continue;

    if (sub.status === "trialing") {
      if (await applied(env, sub, "expired", "trial ended without payment", repo.markExpired(env, sub))) {
        summary.expiredTrials += 1;
        await notify.trialEnded(env, { organizationId: sub.organization_id, subscriptionId: sub.id, restrictedDays: config.restrictedDays });
      }
    } else if (sub.status === "past_due") {
      if (access.state === "restricted" || access.state === "suspended") {
        const graceEnd = stamp(sub.grace_ends_at) ?? (derived.graceStart != null ? derived.graceStart + config.graceDays * DAY : now);
        if (await applied(env, sub, "restricted", "grace period ended", repo.markRestricted(env, sub, iso(graceEnd)))) {
          summary.restricted += 1;
          await notify.restricted(env, { organizationId: sub.organization_id, subscriptionId: sub.id, restrictedAt: iso(graceEnd), suspendsAt: iso(graceEnd + config.restrictedDays * DAY) });
        }
        // A long-overdue row may already be past the restricted window: the next tick moves it on.
      }
    } else if ((sub.status === "restricted" || sub.status === "unpaid") && (access.state === "suspended" || access.state === "closed")) {
      const since = stamp(sub.restricted_at) ?? derived.restrictedStart ?? now;
      const suspendedAt = Math.min(now, since + config.restrictedDays * DAY);
      if (await applied(env, sub, "suspended", "restricted window elapsed", repo.markSuspended(env, sub, iso(suspendedAt)))) {
        summary.suspended += 1;
        await notify.suspended(env, { organizationId: sub.organization_id, subscriptionId: sub.id, suspendedAt: iso(suspendedAt) });
      }
    }

    if (config.suspendSitesMode === "shadow") {
      if (access.state === "suspended" || access.state === "closed") {
        await repo.insertShadow(env, { organizationId: sub.organization_id, subscriptionId: sub.id, state: access.state, wouldChangeFrom: "site_serving", reason: "BILLING_SUSPEND_SITES shadow: would push site access state; no site changed" });
        summary.shadowRows += 1;
      }
    } else if (config.suspendSites) {
      const gate = await applySiteGate(env, sub.organization_id, access.state);
      summary.sitesSuspended += gate.suspended; summary.sitesRestored += gate.restored;
    }
  }
  return summary;
}

// -----------------------------------------------------
// Pending Stripe cancellations (Phase 1.5): a failure to cancel is queued, never swallowed.
// -----------------------------------------------------
export async function queueCancelPending(env, { organizationId, providerSubscriptionId = null, atPeriodEnd = true, error }) {
  await repo.upsertCancelPending(env, { organizationId, providerSubscriptionId, atPeriodEnd, error });
}

export async function retryPendingCancellations(env, billingService, { limit = 25 } = {}) {
  let ok = 0, failed = 0;
  for (const row of await repo.listCancelPending(env, limit)) {
    try {
      const r = await billingService.cancelSubscription(env, row.organization_id, { atPeriodEnd: !!row.at_period_end });
      // "No active subscription" means there is nothing left to cancel: the job is done either way.
      if (r.ok || r.error === "no_active_subscription") {
        await repo.deleteCancelPending(env, row.organization_id);
        ok += 1;
      } else {
        await queueCancelPending(env, { organizationId: row.organization_id, providerSubscriptionId: row.provider_subscription_id, atPeriodEnd: !!row.at_period_end, error: r.error });
        failed += 1;
      }
    } catch (e) {
      await queueCancelPending(env, { organizationId: row.organization_id, providerSubscriptionId: row.provider_subscription_id, atPeriodEnd: !!row.at_period_end, error: e?.message || e });
      failed += 1;
    }
  }
  return { cancelRetries: ok, cancelRetriesFailed: failed };
}
