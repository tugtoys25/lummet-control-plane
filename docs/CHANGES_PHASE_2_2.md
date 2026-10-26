# Phase 2, second half (v2.2.1): webhook coverage, reminders and the remaining templates

Blueprint: Phase 2, sprint 2.2 (webhook coverage, first set; trial and renewal reminders) plus the templates sprint 2.1
left over. This is the second half of Phase 2. **v2.2.1.final** completes the phase (staff view with a dedupe-aware resend,
phase gate checks, staging verification record). **No new migration**: every dedupe rule fits the existing
`billing_notifications` table (migration 0051). The tenant repo is unchanged.

## Webhooks added

| Event | What it does | If it cannot be handled |
|---|---|---|
| `customer.subscription.created` | Upserts the subscription by provider id. Known id: no-op. A local trial is converted in place (as checkout does). Only `trialing` and `active` are materialised; `incomplete` waits for the event that confirms it. A card trial sends the welcome once. | Unknown customer: acknowledged and ignored (logged). No plan matches the price, or a second provider subscription for the same organization: fails so Stripe redelivers, and the `failed_billing_webhooks` alert covers a permanent one. |
| `customer.subscription.trial_will_end` | Sends the trial reminder through the same helper the sweep uses. | Unknown subscription: fails and is redelivered (created may simply not have arrived yet). |
| `invoice.payment_action_required` | One "your bank needs you to confirm this payment" email per invoice. | No resolvable organization: fails and is redelivered. |
| `checkout.session.expired` | Releases the coupon hold the checkout was keeping. | Nothing to release: acknowledged. |
| `invoice.upcoming` | Renewal notice (see below). | Cancelling, trialing, unknown or zero-amount: acknowledged, no email. |

Out-of-order and repeated delivery are covered by tests (created before/after checkout completed, trial_will_end before the
subscription exists, the same event five times).

## Reminders (the five-minute tick, `worker/billing-reminders.js`)

Runs when `BILLING_EMAILS` is `shadow` or `on`, **independent of `BILLING_ENFORCE`**. Buckets come from `BILLING_REMINDER_DAYS`
(default `3,1`). A reminder for bucket N goes out once N days or fewer are left, once, and never for a window shorter than N
days (a 2-day trial gets the 1-day reminder, not a "3 days left" mail as it starts).

| Notice | Who is reminded | Stage (what makes it "the same email") |
|---|---|---|
| `trial_reminder` | trialing, trial end known | bucket + trial end date |
| `renewal_notice` | active, provider-backed, not cancelling | renewal date |
| `grace_reminder` | past due, grace end known | bucket + grace end date |
| `ending_soon` | cancel-at-period-end set | bucket + end date |
| `deletion_warning` | organization with a scheduled deletion | bucket + deletion date; carries the organization export link |

**One email between a Stripe event and the sweep.** `trial_will_end` and `invoice.upcoming` build the same stage as the sweep,
so whichever arrives first sends and the other is a duplicate. Because Stripe's own timing differs from ours (its renewal
notice is typically earlier than our 3-day bucket), the renewal email leaves when whichever arrives first does.

**Renewal notices default to annual plans only** (`BILLING_RENEWAL_NOTICES=yearly`); a monthly customer already gets a receipt
each month. `all` mails every paid renewal, `off` none.

**Export link.** The deletion warning links to `/api/customer/organizations/<id>/export`. That is a signed-in download for an
organization admin or owner (GET is not blocked for a closed organization), not a public link: the email says so.

## Templates added (nine; 17 in total)

`trial_reminder`, `renewal_notice`, `grace_reminder`, `card_authentication`, `plan_changed`, `ending_soon`, `win_back`,
`refund_issued`, `deletion_warning`. Each renders with and without every optional fact, never prints `undefined`, and
HTML-escapes what it interpolates (tested).

Triggers wired in this release: trial reminder, renewal notice, grace reminder, card authentication, plan changed (a plan
change through billing emails the owners once; the same plan or a double click in the same minute emails nothing extra),
ending soon, deletion warning.

**Templates with no trigger yet (deliberate):**
- `refund_issued`: the trigger is the `charge.refunded` webhook and the refund tool, both Phase 3.4. The notice function
  (`notify.refundIssued`, one email per refund id) and template are ready and tested.
- `win_back`: promotional. Behind `BILLING_WINBACK_EMAILS` (**default off**), and **no sweep or webhook triggers it even when
  on**, until an unsubscribe path exists. The template prints an unsubscribe link when one is supplied.

## Flags and configuration

| Name | Effect |
|---|---|
| `BILLING_REMINDER_DAYS` | reminder buckets (default `3,1`) |
| `BILLING_RENEWAL_NOTICES` | `yearly` (default) / `all` / `off` |
| `BILLING_WINBACK_EMAILS` | `off` (default) / `on` |

`BILLING_EMAILS` still governs everything: `off` inert, `shadow` logs each decision as `billing_email_shadow`, `on` sends.

## Safety properties (unchanged and extended)

- A reminder that fails is logged (`billing_reminder_failed`) and counted; one bad row does not stop the sweep.
- A mail problem on a plan change never undoes the change (logged as `billing_plan_changed_notice_failed`).
- Recipients, suppression, verified-only welcome and the outbox retry are exactly as in v2.2.0.
- Nothing is granted on a guess: `customer.subscription.created` ignores `incomplete`.

## Not in this release (arrives in v2.2.1.final)

The staff view of notifications with a dedupe-aware resend, and the Phase 2 gate: staging verification attached, approval.

**Update:** the team's plan moved this to v2.2.2 (staff view, dedupe-aware resend and the gate script; see `CHANGES_PHASE_2_3.md`) and v2.2.2.final (staging record filled in, approval).

## Verification status

- Full control-plane suite on Node 22 (counts in the package report). New file: `test/billing-reminders.test.js`.
- Run only against the fake provider and an in-memory SQLite. **Not verified**: live Resend delivery, SPF/DKIM/DMARC on the
  sending domain, real Stripe event payloads for the five new events (fixtures here are hand-written from Stripe's documented
  shapes), Node 24.
- Staging checks before approval: create a test-mode trial and confirm one welcome and one reminder; send `invoice.upcoming`
  and `invoice.payment_action_required` from the Stripe CLI and confirm one email each; expire a checkout that held a limited
  coupon and confirm the hold is gone; run with `BILLING_EMAILS=shadow` and confirm the reminder decisions log and nothing sends.
- Stripe must be told to send the events: add `customer.subscription.created`, `customer.subscription.trial_will_end`,
  `invoice.payment_action_required`, `checkout.session.expired` and `invoice.upcoming` to the webhook endpoint's event list.

## Rollback

Set `BILLING_EMAILS=off` (everything becomes inert) or deploy v2.2.0. The new webhook handlers are additive; Stripe events
they no longer handle fall back to "acknowledged and ignored". No schema change to undo.
