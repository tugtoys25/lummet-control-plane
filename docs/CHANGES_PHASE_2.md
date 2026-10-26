# Phase 2 consolidated (v2.2.2.final): customer communication

Blueprint: Phase 2, sprints 2.1 and 2.2, plus the Phase 2 approval gate. This is the single entry point for the phase.
The detail lives in the three part notes it summarises: `CHANGES_PHASE_2_1.md` (v2.2.0, engine), `CHANGES_PHASE_2_2.md`
(v2.2.1, webhooks, reminders, remaining templates) and `CHANGES_PHASE_2_3.md` (v2.2.2, staff view, resend, gate).

**v2.2.2.final contains no code change over v2.2.2.** `package.json` stays at `2.2.2` (the packager requires `x.y.z`). The
release is v2.2.2 rolled up with this note and the `.wrangler/`-free packaging. The tenant repo is byte-identical to v2.2.1.
**Phase 2 is code complete. It is not approved**: approval is a human step, done against staging with
`docs/PHASE_2_STAGING_RECORD.md`, which ships blank because nothing in it can be proven by the tooling.

## What the phase delivers

| Blueprint item | Where | Release |
|---|---|---|
| Migration 0051: `billing_notifications` (dedupe key UNIQUE), `email_suppressions` (email hash UNIQUE) | `migrations/0051_billing_notifications.sql` | v2.2.0 |
| Templates, HTML and text, branded, billing From and Reply-To (all 15 blueprint notices, 17 kinds) | `worker/billing-email-templates.js` | v2.2.0 and v2.2.1 |
| Dedupe key per subscription (or organization), kind and stage; sending through durable jobs; owners as recipients | `worker/billing-notifications.js` | v2.2.0 |
| Resend webhook: bounces and complaints write suppressions; alert `email_bounce_rate` | `POST /api/email/webhook/resend` | v2.2.0 |
| Webhooks: `customer.subscription.created`, `.trial_will_end`, `invoice.payment_action_required`, `checkout.session.expired`, `invoice.upcoming` | `worker/billing.js` | v2.2.1 |
| Trial and renewal reminders from the sweep (`BILLING_REMINDER_DAYS`) | scheduled tick | v2.2.1 |
| Staff list of notices; dedupe-aware resend; `billing_email_stuck` links to it | `/platform/saas/notifications` | v2.2.2 |
| Phase gate (9 code checks, 13 staging checks, approval line) | `npm run check:phase2` | v2.2.2 |

## Flags and configuration (all in `CONFIGURATION.md` and `.dev.vars.example`)

`BILLING_EMAILS` (`off` default, `shadow`, `on`), `RESEND_WEBHOOK_SECRET`, `BILLING_EMAIL_FROM`, `BILLING_EMAIL_REPLY_TO`,
`BILLING_REMINDER_DAYS`, `BILLING_RENEWAL_NOTICES`, `BILLING_WINBACK_EMAILS` (keep `off`; no trigger sends win-back mail).
With `BILLING_EMAILS=off` the whole notification system is inert.

## Rollout order (staging first, then production)

1. Deploy this package to staging with `BILLING_EMAILS=off`. Run migration 0051 if it has not run (`scripts/migrate.mjs`).
2. Set `BILLING_EMAIL_FROM`, `BILLING_EMAIL_REPLY_TO`, `RESEND_WEBHOOK_SECRET`; add the Resend webhook for bounces and complaints.
3. Add the five Phase 2 events to the Stripe test-mode webhook endpoint.
4. Set `BILLING_EMAILS=shadow`; watch `billing_email_shadow` log lines on real traffic; nothing is sent.
5. Set `BILLING_EMAILS=on` on staging; work through `docs/PHASE_2_STAGING_RECORD.md`, one box at a time, with evidence.
6. Run `npm run check:phase2`. It exits 0 only when every box has evidence and the approval line has a name and a date.
7. Only then promote to production, again `shadow` first. Stripe's own failed-payment email stays enabled until Phase 4.

## Known behaviours to accept before approving

- A billing message that fails permanently keeps its encrypted body for 14 days (`FAILED_BODY_DAYS`) so staff can resend it.
- There is no force-resend of a delivered notice; that is a support case.
- Win-back mail is built but never triggered.

## What is verified and what is not

- Verified: full control-plane suite on Node 22, 1,161 of 1,161 passing, against the fake billing provider and in-memory
  SQLite; `npm run check:phase2 -- --static-only` passes all 9 code checks.
- **Not verified, and not claimed**: Node 24 (CI runs it), live Resend delivery, DNS alignment, real Stripe CLI payloads,
  the staff page in a browser. All of these are the 13 open boxes in the staging record.

## Rollback

Deploy v2.2.1, or v2.2.0 to drop the reminders too. No schema change after migration 0051, and 0051 is additive: older code
ignores the two tables. `BILLING_EMAILS=off` makes the notification system inert without a deploy.
