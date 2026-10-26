# Phase 2, first half (v2.2.0): billing notification engine

Blueprint: Phase 2, sprint 2.1 (engine and the lifecycle emails). The second half (remaining templates, sprint 2.2
webhooks, reminders, staff view) ships as v2.2.0.final.

## What it does

Customers are told what is happening, once. Every notice is a **durable intent row** (`billing_notifications`, UNIQUE
on `<subscription or organization id>:<kind>:<stage>`) that is then expanded into one outbox message per recipient.

| Notice | Fired by | Stage (what makes it "the same email") |
|---|---|---|
| `trial_welcome` | trial start (`plans.js`), and email verification | once per subscription; waits for a **verified** owner address |
| `trial_ended` | lifecycle sweep, trial expired | once per subscription |
| `payment_failed` | `invoice.payment_failed` | invoice + attempt bucket (1, 2, 3+): three emails, never a repeat of one |
| `receipt` | `invoice.paid`, amount > 0 | invoice id |
| `restricted` | lifecycle sweep | the moment grace ended |
| `suspended` | lifecycle sweep | the moment the restricted window elapsed |
| `reactivated` | `invoice.paid` on a restricted or suspended subscription (a past-due recovery gets only the receipt) | invoice id |
| `cancellation_scheduled` | `customer.subscription.updated`, cancel flag flips on | period end |

Recipients are the **active owners** of the organization (the billing contact arrives in sprint 3.3). Addresses that
bounced permanently or complained are never mailed.

## Safety properties

- **Idempotent**: the same webhook five times, the same sweep twice, a Stripe retry with a new event id: one email (AT-9).
- **Never lost, never duplicated**: the intent is written first; if queueing fails (for example the encryption key is
  missing) the row stays unqueued, the failure is logged, and the five-minute tick finishes it. Each outbox message has
  its own dedupe key (intent id + recipient), so finishing a half-done intent cannot double-send.
- **Never breaks a money path**: queueing problems are logged and retried; they are not thrown into webhook or sweep code.
  Only a failure to write the intent row itself (database down) propagates, which makes Stripe redeliver.
- **Suppression is checked twice**: when queueing, and again when the outbox sends (an address can bounce in between).
  A suppressed queued message becomes status `suppressed` (not `failed`, so it does not raise the failed-email alert).
- **Body encrypted at rest** while queued and wiped after sending (existing outbox behaviour, unchanged).

## Resend webhook (gap G7)

`POST /api/email/webhook/resend`, authenticated by the Svix signature over the raw body (`RESEND_WEBHOOK_SECRET`,
5-minute timestamp window). Permanent bounces and spam complaints write `email_suppressions` (SHA-256 of the lowercased
address only). Transient bounces, delivery and delay events are acknowledged and ignored. Redelivery of the same
`svix-id` changes nothing. Create it in Resend: Webhooks, endpoint `<PORTAL_BASE_URL>/api/email/webhook/resend`, events
`email.bounced` and `email.complained`.

## Alerts

- `email_bounce_rate`: 5% or more of the last 24 hours' mail bounced permanently or drew a complaint (at least 20 messages), or 3 or more complaints.
- `billing_email_stuck`: a notification recorded but not queued for 30 minutes, or out of attempts (10).

## Flags and configuration

| Name | Effect |
|---|---|
| `BILLING_EMAILS` = `off` (default) / `shadow` / `on` | `off`: inert. `shadow`: each decision is logged as `billing_email_shadow`, nothing is recorded or sent. `on`: emails are queued. Production must set it explicitly (config check). |
| `RESEND_WEBHOOK_SECRET` | required once `BILLING_EMAILS=on` (config check) |
| `BILLING_EMAIL_FROM`, `BILLING_EMAIL_REPLY_TO` | optional verified sender and reply-to for billing mail; default `EMAIL_FROM` |
| `BRAND_NAME` | optional, default `Lummet` |

**Rollout**: `off` -> `shadow` (read the log lines against real traffic) -> `on`. **Stripe's own failed-payment and
receipt emails stay on** until Phase 4 verifies these; for a while customers may get both.

## Deliberate differences from the blueprint

1. **Delivery uses the existing durable email outbox**, not the generic `jobs` table. The outbox already is a durable,
   retrying queue (attempts, backoff, dead state, alert on failures), and the notification row is the durable intent.
   A second queue for the same mail would add a failure mode, not remove one.
2. **Separate flag `BILLING_EMAILS`** instead of reusing `BILLING_ENFORCE`: you can turn mail on before or after
   enforcement. Restricted and suspended mail can only fire when the lifecycle actually moves an account there.
3. **Trial welcome waits for a verified address**, so signing up with someone else's address cannot make us mail them.
4. **Suppression applies to billing notices only.** A complaint about a receipt must not stop a password reset.
5. Emails leave on the next five-minute tick (or `POST /api/platform/saas/email/flush`), not inside the webhook request.

## Not in this half (arrives in v2.2.0.final)

Trial reminders and renewal notices from the sweep, `customer.subscription.trial_will_end`, `invoice.payment_action_required`,
`checkout.session.expired`, `invoice.upcoming`, `customer.subscription.created`, the plan-changed, ending-soon, win-back,
refund and deletion-warning templates, and the staff view and dedupe-aware resend.

## Verification status

- Tests: full control-plane suite on Node 22 (see the package report). New file: `test/billing-notifications.test.js`.
- Run only against the fake provider and an in-memory SQLite. **Not verified**: live Resend delivery, SPF/DKIM/DMARC alignment
  on the sending domain (the sprint's exit criterion, **verify live**), the real Svix signature from Resend, Node 24.
- Staging checks to run before approval: send a test-mode `invoice.payment_failed` and confirm one email; send a Resend
  test bounce and confirm a suppression row and no further mail to that address; confirm `BILLING_EMAILS=shadow` logs and sends nothing.

## Migration 0051 and rollback

Adds `billing_notifications`, `email_suppressions`, `email_webhook_events` and `email_outbox.notification_id` (all additive).
Rollback: set `BILLING_EMAILS=off`; the tables and column can be ignored. Retention: `billing_notifications` is deleted with
the organization; `email_suppressions` holds only hashes.
