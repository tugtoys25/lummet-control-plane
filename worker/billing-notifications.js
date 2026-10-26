// =====================================================
// BILLING NOTIFICATION ENGINE (Phase 2.1)
//
// Customers are told what is happening, once.
//
//   BILLING_EMAILS=off      (default) inert: nothing is recorded or sent
//   BILLING_EMAILS=shadow   decisions are computed and logged; nothing is recorded or sent
//   BILLING_EMAILS=on       emails are queued
//
// Shape: enqueue() first writes a durable INTENT row (billing_notifications, UNIQUE on subscription + kind + stage),
// then hands one message per recipient to the email outbox (which retries delivery with backoff). If anything fails
// between the two, the intent stays unqueued and drain() on the five-minute tick finishes it. Every step is safe to
// run twice: the intent is unique, and each outbox message carries its own dedupe key (intent id + recipient).
// A failure is logged and left for the retry; it is never swallowed and never thrown into a money path.
//
// Recipients: active owners of the organization (the billing contact joins in sprint 3.3). Addresses that bounced
// permanently or complained are never mailed (email_suppressions).
// =====================================================
import { emailsMode, winbackEnabled } from "./billing-config.js";
import { renderBillingEmail, BILLING_KINDS } from "./billing-email-templates.js";
import { queueEmail, portalLink, emailHash } from "./email.js";
import * as repo from "./repositories/billing-notifications.js";

// Welcome mail is only sent to an owner who has verified the address, so signing up with someone else's address
// cannot make us email them; it is sent when they verify (onEmailVerified).
const VERIFIED_ONLY = new Set(["trial_welcome"]);

export const brandName = (env) => String((env && env.BRAND_NAME) || "Lummet").slice(0, 60);

function log(msg, extra) {
  console.error(JSON.stringify({ msg, ...extra }));
}

export function dedupeKeyFor({ subscriptionId, organizationId, kind, stage }) {
  return `${subscriptionId || organizationId}:${kind}:${stage || ""}`;
}

/** Records the intent and tries to queue it now. Returns a plain result; throws only if the intent cannot be written. */
export async function enqueue(env, { kind, organizationId, subscriptionId = null, stage = "", facts = {} }) {
  const mode = emailsMode(env);
  if (mode === "off") return { ok: true, skipped: "off" };
  if (!BILLING_KINDS.includes(kind)) return { ok: false, error: "unknown_kind" };
  if (!organizationId) return { ok: false, error: "missing_organization" };
  // Promotional mail ships switched off until an unsubscribe path exists (BILLING_WINBACK_EMAILS).
  if (kind === "win_back" && !winbackEnabled(env)) return { ok: true, skipped: "winback_off" };
  if (mode === "shadow") {
    console.info(JSON.stringify({ msg: "billing_email_shadow", kind, organizationId, subscriptionId, stage }));
    return { ok: true, skipped: "shadow" };
  }
  const dedupeKey = dedupeKeyFor({ subscriptionId, organizationId, kind, stage });
  const { created, row } = await repo.insertIntent(env, {
    id: crypto.randomUUID(), organizationId, subscriptionId, kind, stage, dedupeKey, payload: JSON.stringify(facts)
  });
  if (!created && row.queued_at) return { ok: true, duplicate: true, notificationId: row.id };
  return expand(env, row);
}

/** Queues one message per eligible recipient for an intent. Never throws. */
export async function expand(env, row) {
  try {
    const facts = row.payload ? JSON.parse(row.payload) : {};
    const [org, sub, owners] = await Promise.all([
      repo.organizationSummary(env, row.organization_id),
      repo.subscriptionSummary(env, row.subscription_id),
      repo.listOwners(env, row.organization_id)
    ]);
    if (!org) { await repo.deleteIntent(env, row.id); return { ok: true, skipped: "organization_gone" }; }
    const eligible = VERIFIED_ONLY.has(row.kind) ? owners.filter((o) => o.email_verified_at) : owners;
    if (!eligible.length) {
      // Nothing to send now. Release the dedupe key so the same notice can still go out when an owner exists or verifies.
      await repo.deleteIntent(env, row.id);
      return { ok: true, skipped: owners.length ? "no_verified_recipient" : "no_recipients" };
    }
    const hashes = new Map();
    for (const o of eligible) hashes.set(o.email, await emailHash(o.email));
    const suppressed = await repo.suppressedAmong(env, [...hashes.values()]);
    const recipients = eligible.filter((o) => !suppressed.has(hashes.get(o.email)));

    const message = renderBillingEmail(row.kind, {
      ...facts, brand: brandName(env), orgName: org.name, planName: facts.planName || sub?.plan_name || null,
      billingUrl: portalLink(env, "/app/billing")
    });
    for (const o of recipients) {
      const q = await queueEmail(env, {
        to: o.email, template: `billing_${row.kind}`, message, organizationId: row.organization_id,
        dedupeKey: `bn:${row.id}:${hashes.get(o.email).slice(0, 16)}`,
        from: env.BILLING_EMAIL_FROM || null, replyTo: env.BILLING_EMAIL_REPLY_TO || null, notificationId: row.id
      });
      if (!q.ok) throw new Error(q.error || "queue_failed");
    }
    await repo.markQueued(env, row.id, { recipientCount: recipients.length, suppressedCount: eligible.length - recipients.length });
    return { ok: true, queued: recipients.length, suppressed: eligible.length - recipients.length, notificationId: row.id };
  } catch (e) {
    const error = e?.message || String(e);
    log("billing_notification_failed", { notificationId: row.id, kind: row.kind, error });
    await repo.markAttemptFailed(env, row.id, error);
    return { ok: false, error, notificationId: row.id };
  }
}

/** Tick: finish intents that were recorded but not fully queued, then mark delivered ones as sent. */
export async function drain(env, { limit = 25 } = {}) {
  if (emailsMode(env) !== "on") return { skipped: "not_on" };
  let queued = 0, failed = 0;
  for (const row of await repo.listPending(env, limit)) {
    const r = await expand(env, row);
    if (r.ok && !r.skipped) queued += 1; else if (!r.ok) failed += 1;
  }
  const sent = await repo.syncSent(env);
  const pruned = await repo.pruneFailedBodies(env, FAILED_BODY_DAYS);
  return { queued, failed, sent, pruned };
}

/** How long a failed billing message keeps its encrypted body, so staff can still resend it. */
export const FAILED_BODY_DAYS = 14;

/**
 * Staff resend, safe by construction (Phase 2.3). Nothing here can create a second copy of an email that was or will be
 * delivered, because it never writes a new message: it only puts an existing, FAILED one back in the queue (same row, same
 * dedupe key), or lets an intent that never reached the outbox try again.
 *
 *   not queued yet (pending or out of attempts)  -> fresh attempts, then queue it now
 *   queued, a message failed and still has its body -> that message goes back in the queue
 *   queued/sent/suppressed messages              -> left alone and reported
 *
 * Returns { ok: true, action, ... } when something was put back, otherwise { ok: false, status: 409, error } with the reason:
 * in_flight, already_delivered, recipient_suppressed, message_unavailable (the failed body was already dropped; the notice
 * can only go out again if its trigger fires again) or nothing_to_resend.
 */
export async function resend(env, id) {
  if (emailsMode(env) !== "on") return { ok: false, status: 409, error: "emails_not_on" };
  const row = await repo.getById(env, id);
  if (!row) return { ok: false, status: 404, error: "not_found" };
  const base = { notificationId: row.id, organizationId: row.organization_id, kind: row.kind };

  if (!row.queued_at) {
    await repo.resetAttempts(env, row.id);
    const r = await expand(env, await repo.getById(env, row.id));
    if (!r.ok) return { ok: false, status: 502, error: r.error || "queue_failed", ...base };
    if (r.skipped) return { ok: false, status: 409, error: r.skipped, ...base };
    return { ok: true, action: "queued", queued: r.queued, suppressed: r.suppressed, ...base };
  }

  const tally = { requeued: 0, inFlight: 0, delivered: 0, suppressed: 0, unavailable: 0 };
  for (const m of await repo.outboxMessagesFor(env, row.id)) {
    if (m.status === "queued") tally.inFlight += 1;
    else if (m.status === "sent") tally.delivered += 1;
    else if (m.status === "suppressed") tally.suppressed += 1;
    else if (m.status === "failed") {
      if (m.has_body && await repo.isSuppressed(env, await emailHash(m.to_email))) tally.suppressed += 1;
      else if (m.has_body && await repo.requeueFailedMessage(env, m.id)) tally.requeued += 1;
      else tally.unavailable += 1;
    }
  }
  if (tally.requeued) return { ok: true, action: "requeued", ...tally, ...base };
  const error = tally.unavailable ? "message_unavailable" : tally.inFlight ? "in_flight" : tally.delivered ? "already_delivered" : tally.suppressed ? "recipient_suppressed" : "nothing_to_resend";
  return { ok: false, status: 409, error, ...tally, ...base };
}

/** An owner verified their address: send the trial welcome for trials already running. */
export async function onEmailVerified(env, userId) {
  if (emailsMode(env) !== "on") return { skipped: "not_on" };
  const out = [];
  for (const t of await repo.trialingOrganizationsOwnedBy(env, userId)) {
    const sub = await repo.subscriptionSummary(env, t.subscription_id);
    out.push(await enqueue(env, { kind: "trial_welcome", organizationId: t.organization_id, subscriptionId: t.subscription_id, stage: "start", facts: { trialEndsAt: sub?.trial_ends_at || null } }));
  }
  return out;
}

// ---- named triggers: one place that decides each notice's stage (what makes it "the same email") ----
export const notify = {
  trialStarted: (env, { organizationId, subscriptionId, trialEndsAt }) =>
    enqueue(env, { kind: "trial_welcome", organizationId, subscriptionId, stage: "start", facts: { trialEndsAt } }),
  trialEnded: (env, { organizationId, subscriptionId, restrictedDays }) =>
    enqueue(env, { kind: "trial_ended", organizationId, subscriptionId, stage: "ended", facts: { restrictedDays } }),
  // Stage = invoice + attempt bucket: the 1st, 2nd and 3rd-or-later failure are three emails; Stripe retrying the same attempt is one.
  paymentFailed: (env, { organizationId, subscriptionId, invoice, graceEndsAt }) =>
    enqueue(env, {
      kind: "payment_failed", organizationId, subscriptionId, stage: `${invoice.id}:a${Math.min(Math.max(Number(invoice.attempt_count) || 1, 1), 3)}`,
      facts: { amountCents: invoice.amount_due ?? null, currency: invoice.currency || null, invoiceUrl: invoice.hosted_invoice_url || null, attempt: Number(invoice.attempt_count) || 1, graceEndsAt: graceEndsAt || null }
    }),
  receipt: (env, { organizationId, subscriptionId, invoice }) =>
    (Number(invoice.amount_paid) > 0
      ? enqueue(env, {
          kind: "receipt", organizationId, subscriptionId, stage: invoice.id,
          facts: {
            amountCents: invoice.amount_paid, currency: invoice.currency || null, invoiceUrl: invoice.hosted_invoice_url || null,
            periodStart: invoice.period_start ? invoice.period_start * 1000 : null, periodEnd: invoice.period_end ? invoice.period_end * 1000 : null
          }
        })
      : Promise.resolve({ ok: true, skipped: "zero_amount" })),
  restricted: (env, { organizationId, subscriptionId, restrictedAt, suspendsAt }) =>
    enqueue(env, { kind: "restricted", organizationId, subscriptionId, stage: restrictedAt, facts: { suspendsAt } }),
  suspended: (env, { organizationId, subscriptionId, suspendedAt }) =>
    enqueue(env, { kind: "suspended", organizationId, subscriptionId, stage: suspendedAt, facts: {} }),
  reactivated: (env, { organizationId, subscriptionId, invoiceId }) =>
    enqueue(env, { kind: "reactivated", organizationId, subscriptionId, stage: invoiceId, facts: {} }),
  cancellationScheduled: (env, { organizationId, subscriptionId, endsAt }) =>
    enqueue(env, { kind: "cancellation_scheduled", organizationId, subscriptionId, stage: endsAt || "period", facts: { endsAt } }),

  // ---- Phase 2.2 ----
  // Reminder stages are "<bucket>:<the date it counts down to>": the Stripe event and the sweep compute the same stage,
  // so whichever arrives first sends the email and the other is a duplicate. A trial that is later extended starts over.
  trialReminder: (env, { organizationId, subscriptionId, trialEndsAt, bucket, daysLeft }) =>
    enqueue(env, { kind: "trial_reminder", organizationId, subscriptionId, stage: `d${bucket}:${dayOf(trialEndsAt)}`, facts: { trialEndsAt, daysLeft } }),
  renewalNotice: (env, { organizationId, subscriptionId, renewsAt, amountCents, currency }) =>
    enqueue(env, { kind: "renewal_notice", organizationId, subscriptionId, stage: dayOf(renewsAt), facts: { renewsAt, amountCents: amountCents ?? null, currency: currency || null } }),
  graceReminder: (env, { organizationId, subscriptionId, graceEndsAt, bucket, daysLeft, invoiceUrl }) =>
    enqueue(env, { kind: "grace_reminder", organizationId, subscriptionId, stage: `d${bucket}:${dayOf(graceEndsAt)}`, facts: { graceEndsAt, daysLeft, invoiceUrl: invoiceUrl || null } }),
  cardAuthentication: (env, { organizationId, subscriptionId, invoice }) =>
    enqueue(env, {
      kind: "card_authentication", organizationId, subscriptionId, stage: invoice.id || "invoice",
      facts: { amountCents: invoice.amount_due ?? null, currency: invoice.currency || null, invoiceUrl: invoice.hosted_invoice_url || null }
    }),
  // Stage includes the minute, so a double click is one email but a real second change later is another.
  planChanged: (env, { organizationId, subscriptionId, fromPlanId, toPlanId, planName, previousPlanName, now = Date.now() }) =>
    enqueue(env, { kind: "plan_changed", organizationId, subscriptionId, stage: `${fromPlanId || "none"}>${toPlanId}:${Math.floor(now / 60000)}`, facts: { planName, previousPlanName: previousPlanName || null } }),
  endingSoon: (env, { organizationId, subscriptionId, endsAt, bucket, daysLeft }) =>
    enqueue(env, { kind: "ending_soon", organizationId, subscriptionId, stage: `d${bucket}:${dayOf(endsAt)}`, facts: { endsAt, daysLeft } }),
  winBack: (env, { organizationId, subscriptionId, canceledAt, unsubscribeUrl }) =>
    enqueue(env, { kind: "win_back", organizationId, subscriptionId, stage: dayOf(canceledAt) || "canceled", facts: { unsubscribeUrl: unsubscribeUrl || null } }),
  refundIssued: (env, { organizationId, subscriptionId, refundId, amountCents, currency, invoiceUrl }) =>
    enqueue(env, { kind: "refund_issued", organizationId, subscriptionId, stage: refundId, facts: { amountCents: amountCents ?? null, currency: currency || null, invoiceUrl: invoiceUrl || null } }),
  deletionWarning: (env, { organizationId, deletesAt, bucket, daysLeft }) =>
    enqueue(env, {
      kind: "deletion_warning", organizationId, subscriptionId: null, stage: `d${bucket}:${dayOf(deletesAt)}`,
      facts: { deletesAt, daysLeft, exportUrl: portalLink(env, `/api/customer/organizations/${organizationId}/export`) }
    })
};

/** "2026-11-04" from an ISO string, a SQLite timestamp or epoch ms; "" when there is none. */
export function dayOf(value) {
  if (value == null || value === "") return "";
  const t = typeof value === "number" ? value : Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? String(value) : String(value).replace(" ", "T") + "Z");
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}
