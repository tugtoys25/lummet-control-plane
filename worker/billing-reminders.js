// =====================================================
// BILLING REMINDERS (Phase 2.2)
//
// Runs from the five-minute tick. Looks at the clock and the subscription rows and tells customers what is about to
// happen: a trial ending, a renewal, a grace period running out, a cancellation taking effect, a deletion date.
//
// Every reminder is idempotent for two reasons: a notice's dedupe stage is "<bucket>:<the date it counts down to>", so
// the sweep can run every five minutes and send once; and the Stripe webhooks that announce the same thing
// (trial_will_end, invoice.upcoming) compute the same stage through the same helpers here, so whichever arrives first
// sends and the other is a duplicate.
//
// Buckets come from BILLING_REMINDER_DAYS (default "3,1"). A reminder for bucket N goes out once the time left is N
// days or less, but never for a window longer than the trial / period itself (a 2-day trial gets the 1-day reminder
// only, not a "3 days left" mail the moment it starts).
//
// BILLING_EMAILS=off does nothing; shadow logs each decision (enqueue does that); on queues. Independent of BILLING_ENFORCE.
// =====================================================
import { billingConfig, emailsMode, renewalNoticeMode } from "./billing-config.js";
import { notify } from "./billing-notifications.js";
import * as repo from "./repositories/billing-reminders.js";

const DAY = 86400000;

const stamp = (v) => {
  if (!v) return null;
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? t : null;
};
const iso = (t) => new Date(t).toISOString();

/**
 * The reminder bucket for `msLeft`: the smallest configured day count that is >= the whole days left (rounded up).
 * null when more time is left than the largest bucket, or when none is left.
 */
export function bucketFor(msLeft, reminderDays) {
  if (!Number.isFinite(msLeft) || msLeft <= 0) return null;
  const left = Math.ceil(msLeft / DAY);
  const sorted = [...reminderDays].sort((a, b) => a - b);
  return sorted.find((n) => n >= left) ?? null;
}

/** Whole days left, rounded up, for the email wording. */
export const daysLeftFor = (msLeft) => Math.max(1, Math.ceil(msLeft / DAY));

/** A bucket only applies when the whole window was longer than the bucket (no "3 days left" on a 2-day trial). */
const windowAllows = (bucket, windowMs) => windowMs == null || windowMs > bucket * DAY;

/** Trial reminders for one subscription; shared by the sweep and the trial_will_end webhook. */
export async function remindTrial(env, { organizationId, subscriptionId, trialEndsAt, createdAt = null, now = Date.now(), cfg = billingConfig(env) }) {
  const end = typeof trialEndsAt === "number" ? trialEndsAt : stamp(trialEndsAt);
  if (end == null) return { ok: true, skipped: "no_trial_end" };
  const bucket = bucketFor(end - now, cfg.reminderDays);
  if (bucket == null) return { ok: true, skipped: "not_due" };
  const started = typeof createdAt === "number" ? createdAt : stamp(createdAt);
  if (!windowAllows(bucket, started != null ? end - started : null)) return { ok: true, skipped: "window_too_short" };
  return notify.trialReminder(env, { organizationId, subscriptionId, trialEndsAt: iso(end), bucket, daysLeft: daysLeftFor(end - now) });
}

/** Whether a renewal for this plan period gets an email under BILLING_RENEWAL_NOTICES. */
export function renewalWanted(env, billingPeriod) {
  const mode = renewalNoticeMode(env);
  return mode === "all" || (mode === "yearly" && ["annual", "yearly", "year"].includes(String(billingPeriod || "").toLowerCase()));
}

export async function sweepReminders(env, now = Date.now()) {
  const summary = { trial: 0, renewal: 0, grace: 0, ending: 0, deletion: 0, errors: 0 };
  if (emailsMode(env) === "off") return { ...summary, skipped: "off" };
  const cfg = billingConfig(env);
  const maxDays = Math.max(...cfg.reminderDays);
  const count = (key, r) => { if (r && r.ok && !r.skipped && !r.duplicate) summary[key] += 1; if (r && !r.ok) summary.errors += 1; };

  // Each reminder is its own try: one bad row never stops the rest of the sweep, and the failure is logged, not swallowed.
  const each = async (rows, fn) => {
    for (const row of rows) {
      try { await fn(row); } catch (e) { summary.errors += 1; console.error(JSON.stringify({ msg: "billing_reminder_failed", error: e?.message || String(e) })); }
    }
  };

  await each(await repo.trialingSubscriptions(env), async (s) =>
    count("trial", await remindTrial(env, { organizationId: s.organization_id, subscriptionId: s.id, trialEndsAt: s.trial_ends_at, createdAt: s.created_at, now, cfg })));

  await each(await repo.renewingSubscriptions(env), async (s) => {
    const renews = stamp(s.current_period_end);
    if (renews == null || !renewalWanted(env, s.billing_period)) return;
    const left = renews - now;
    if (left <= 0 || Math.ceil(left / DAY) > maxDays) return;
    count("renewal", await notify.renewalNotice(env, { organizationId: s.organization_id, subscriptionId: s.id, renewsAt: iso(renews), amountCents: s.price_cents, currency: s.currency }));
  });

  await each(await repo.pastDueSubscriptions(env), async (s) => {
    const end = stamp(s.grace_ends_at);
    const bucket = end == null ? null : bucketFor(end - now, cfg.reminderDays);
    if (bucket == null) return;
    count("grace", await notify.graceReminder(env, { organizationId: s.organization_id, subscriptionId: s.id, graceEndsAt: iso(end), bucket, daysLeft: daysLeftFor(end - now), invoiceUrl: s.invoice_url }));
  });

  await each(await repo.endingSubscriptions(env), async (s) => {
    const end = stamp(s.current_period_end);
    const bucket = end == null ? null : bucketFor(end - now, cfg.reminderDays);
    if (bucket == null) return;
    count("ending", await notify.endingSoon(env, { organizationId: s.organization_id, subscriptionId: s.id, endsAt: iso(end), bucket, daysLeft: daysLeftFor(end - now) }));
  });

  await each(await repo.organizationsPendingDeletion(env), async (o) => {
    const end = stamp(o.scheduled_deletion_at);
    const bucket = end == null ? null : bucketFor(end - now, cfg.reminderDays);
    if (bucket == null) return;
    count("deletion", await notify.deletionWarning(env, { organizationId: o.id, deletesAt: iso(end), bucket, daysLeft: daysLeftFor(end - now) }));
  });

  // Win-back mail (promotional) has a template and a switch (BILLING_WINBACK_EMAILS, default off) but NO trigger here:
  // it is wired only once an unsubscribe path exists.
  return summary;
}
