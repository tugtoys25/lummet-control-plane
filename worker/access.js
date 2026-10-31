// =====================================================
// ACCESS STATE MACHINE (Phase 1.1)
//
// ONE function decides what an organization may do. No route decides on its own.
//   state:     trialing | trial_expired | active | past_due | restricted | suspended | closed
//   canMutate: may create/change things (the write gate)
//   canServe:  its public sites may keep serving (the serve gate)
//
// computeAccess() is PURE (no I/O, injectable clock) so every transition is table-testable.
// resolveAccess() loads the rows and calls it. All timers come from billing-config.js.
//
// Stripe is the source of truth for money; Lummet is the source of truth for access.
// =====================================================

import { billingConfig } from "./billing-config.js";
import * as repo from "./repositories/billing-lifecycle.js";

const DAY = 86400000;
const ts = (v) => {
  if (!v) return null;
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");   // SQLite CURRENT_TIMESTAMP has no zone
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => (t == null ? null : new Date(t).toISOString());

function out(state, canMutate, canServe, reason, endsAt = null) {
  return { state, canMutate, canServe, reason, endsAt: iso(endsAt) };
}

/**
 * @param {{sub: ?object, org: ?object, now: number, cfg: object, derived?: object}} input
 *   derived: { graceStart, restrictedStart } timestamps recovered from history for rows that predate migration 0049.
 */
export function computeAccess({ sub, org, now, cfg, derived = {} }) {
  if (org && org.status === "closed") return out("closed", false, false, "organization closed");

  // Never subscribed, or the subscription ended with nothing replacing it.
  if (!sub) return out("trial_expired", false, true, "no subscription");

  const status = sub.status;
  const rawStatus = sub.stripe_status;

  // ---- Terminal / ended subscriptions start the restricted clock from the moment they ended. -------------
  if (status === "canceled" || status === "expired" || status === "incomplete_expired") {
    const from = status === "expired"
      ? (ts(sub.trial_ends_at) ?? ts(sub.updated_at))
      : (ts(sub.restricted_at) ?? ts(sub.canceled_at) ?? ts(sub.updated_at));
    return timeLadder({ from, now, cfg, firstState: "trial_expired", reasonPrefix: status === "expired" ? "trial ended" : "subscription ended", sub });
  }

  if (status === "suspended" || sub.suspended_at) {
    const since = ts(sub.suspended_at) ?? ts(sub.updated_at);
    const closeAt = since == null ? null : since + cfg.suspendedDays * DAY;
    if (closeAt != null && now >= closeAt) return out("closed", false, false, "suspended period elapsed");
    return out("suspended", false, false, "suspended for non-payment", closeAt);
  }

  if (status === "restricted" || status === "unpaid" || rawStatus === "unpaid") {
    const since = ts(sub.restricted_at) ?? derived.restrictedStart ?? ts(sub.updated_at);
    return ladderFromRestricted({ since, now, cfg });
  }

  if (status === "past_due") {
    const graceEnd = ts(sub.grace_ends_at) ?? (derived.graceStart != null ? derived.graceStart + cfg.graceDays * DAY : null);
    if (graceEnd != null && now >= graceEnd) return ladderFromRestricted({ since: graceEnd, now, cfg });
    return out("past_due", true, true, "payment failed, in grace period", graceEnd);
  }

  if (status === "trialing") {
    const hasProvider = !!sub.provider_subscription_id;
    const end = ts(sub.trial_ends_at);
    // A trial with a provider behind it is converted by the provider; only a local (no card) trial can lapse here.
    if (!hasProvider && end != null && now >= end) {
      return timeLadder({ from: end, now, cfg, firstState: "trial_expired", reasonPrefix: "trial ended", sub });
    }
    return out("trialing", true, true, hasProvider ? "provider trial" : "local trial", end);
  }

  if (status === "active") {
    return out("active", true, true, sub.cancel_at_period_end ? "active, cancelling at period end" : "active", sub.cancel_at_period_end ? ts(sub.current_period_end) : null);
  }

  // paused / incomplete / anything unknown: do not grant write access on a status nobody has reasoned about.
  return out("restricted", false, true, `unrecognised status "${status}"`);
}

// trial_expired (live, read-only) for restrictedDays, then restricted (live, read-only) for restrictedDays,
// then suspended for suspendedDays, then closed.
function timeLadder({ from, now, cfg }) {
  if (from == null) return out("trial_expired", false, true, "trial ended");
  const toRestricted = from + cfg.restrictedDays * DAY;
  if (now < toRestricted) return out("trial_expired", false, true, "trial ended, still live and read-only", toRestricted);
  return ladderFromRestricted({ since: toRestricted, now, cfg });
}

function ladderFromRestricted({ since, now, cfg }) {
  if (since == null) return out("restricted", false, true, "restricted");
  const toSuspended = since + cfg.restrictedDays * DAY;
  if (now < toSuspended) return out("restricted", false, true, "restricted: read, export and pay only", toSuspended);
  const toClosed = toSuspended + cfg.suspendedDays * DAY;
  if (now < toClosed) return out("suspended", false, false, "suspended for non-payment", toClosed);
  return out("closed", false, false, "suspension period elapsed");
}

async function derivedTimes(env, sub) {
  if (!sub) return {};
  const derived = {};
  if (sub.status === "past_due" && !sub.grace_ends_at) {
    derived.graceStart = ts(await repo.lastEnteredStatusAt(env, sub.id, ["past_due"])) ?? ts(sub.updated_at);
  }
  if ((sub.status === "restricted" || sub.status === "unpaid") && !sub.restricted_at) {
    derived.restrictedStart = ts(await repo.lastEnteredStatusAt(env, sub.id, ["restricted", "unpaid"])) ?? ts(sub.updated_at);
  }
  return derived;
}

/** The subscription that decides access: the live one, else the most recent ended one (its end starts the clock). */
export async function subscriptionForAccess(env, organizationId) {
  return (await repo.liveSubscription(env, organizationId)) || (await repo.latestSubscription(env, organizationId));
}

export async function resolveAccess(env, organizationId, now = Date.now(), { cfg } = {}) {
  const config = cfg || billingConfig(env);
  const org = await repo.getOrganizationStatus(env, organizationId);
  const sub = await subscriptionForAccess(env, organizationId);
  const derived = await derivedTimes(env, sub);
  const result = computeAccess({ sub, org, now, cfg: config, derived });
  return { ...result, subscriptionId: sub ? sub.id : null, organizationId };
}

/** Staff or customer facing explanation of a refusal, as a stable machine code the UI can turn into a prompt. */
export function refusalFor(access) {
  return {
    error: "billing_access_restricted",
    reasonCode: `billing_${String(access.state || "restricted").replace(/[^a-z0-9]+/g, "_")}`,
    reason: access.state,
    message:
      access.state === "past_due" ? "A payment failed. Update your payment method to avoid interruption."
      : access.state === "trial_expired" ? (access.reason === "no subscription" ? "Start your free trial or choose a plan to begin making changes." : "Your trial has ended. Choose a plan to keep making changes.")
      : access.state === "restricted" ? "Your account is read-only until payment is resolved."
      : access.state === "suspended" ? "Your account is suspended for non-payment. Pay to restore it."
      : "This account is closed.",
    endsAt: access.endsAt
  };
}

// -----------------------------------------------------
// Write gate (Phase 1.4): the organization read-only gate in index.js asks this one function.
// Exempt: everything a customer needs to GET OUT of a restricted state (pay, start a trial, export their data).
// -----------------------------------------------------
const WRITE_GATE_EXEMPT_EXACT = new Set(["/switch", "/reactivate", "/cancel-deletion", "/request-deletion", "/trial", "/backups"]);

export function isWriteGateExempt(subPath) {
  return WRITE_GATE_EXEMPT_EXACT.has(subPath) || subPath.startsWith("/billing/") || subPath.startsWith("/backups/");
}

/**
 * Decides one mutating request. BILLING_ENFORCE=off: never blocks and writes nothing. shadow: never blocks, but records
 * each would-be refusal with the entry point name (at most once an hour per organization and entry point).
 * enforce: blocks when the organization cannot mutate.
 * Returns { blocked, access, mode }.
 */
export async function evaluateWriteGate(env, { organizationId, method, subPath, now = Date.now() }) {
  const cfg = billingConfig(env);
  if (cfg.mode === "off" || method === "GET" || method === "HEAD" || isWriteGateExempt(subPath)) return { blocked: false, access: null, mode: cfg.mode };
  const access = await resolveAccess(env, organizationId, now, { cfg });
  if (access.canMutate) return { blocked: false, access, mode: cfg.mode };
  if (cfg.mode === "shadow") {
    const entryPoint = String(subPath || "/unknown").split("?")[0].slice(0,160);
    const reason = `would refuse entry_point=${entryPoint} method=${method}`;
    if (!(await repo.shadowReasonSeenRecently(env, organizationId, reason))) {
      await repo.insertShadow(env, { organizationId, subscriptionId: access.subscriptionId, state: access.state, wouldChangeFrom: null, reason });
    }
    return { blocked: false, access, mode: cfg.mode };
  }
  return { blocked: true, access, mode: cfg.mode };
}

/** Serve gate for internal proxies/API-key reads. Rollout mirrors canMutate: off, shadow (log only), enforce. */
export async function evaluateServeGate(env, { organizationId, entryPoint = "unknown", now = Date.now() }) {
  const cfg = billingConfig(env);
  if (cfg.mode === "off") return { blocked:false, access:null, mode:cfg.mode };
  const access = await resolveAccess(env, organizationId, now, { cfg });
  if (access.canServe) return { blocked:false, access, mode:cfg.mode };
  const reason = `would refuse serve entry_point=${String(entryPoint).slice(0,160)}`;
  if (cfg.mode === "shadow") {
    if (!(await repo.shadowReasonSeenRecently(env, organizationId, reason))) await repo.insertShadow(env, { organizationId, subscriptionId: access.subscriptionId, state: access.state, wouldChangeFrom: null, reason });
    return { blocked:false, access, mode:cfg.mode };
  }
  return { blocked:true, access, mode:cfg.mode };
}
