# Phase 2, third part (v2.2.2): staff notifications view, dedupe-aware resend and the Phase 2 gate

Blueprint: Phase 2, sprint 2.1 ("Staff 'resend' is safe (dedupe-aware)") and the Phase 2 approval gate. v2.2.0 built the
engine, v2.2.1 the remaining templates, webhooks and reminders; this release adds what staff need to operate them and the
tooling that decides whether the phase may be approved. **v2.2.2.final** completes the phase: it carries everything from the
earlier zips plus the filled-in staging record and the consolidated Phase 2 notes. **No new migration. The tenant repo is
unchanged.**

## What staff get

**`/platform/saas/notifications`** (super admin; new "Billing notifications" entry in the SaaS menu, and linked from the
Email outbox page). One row per notice Lummet decided to send: when, organization, notice kind, stage, state, recipients
(and how many were suppressed), the last error. Filters: organization id, kind, state. Paged like the other staff lists.
`GET /api/platform/saas/notifications` returns the same rows as JSON. Neither the list, the page nor the API exposes the
payload, an address or a message body.

| State | Meaning | Resend offered |
|---|---|---|
| `pending` | recorded, the five-minute tick is still queueing it | yes |
| `stuck` | recorded, not queued, out of attempts | yes |
| `queued` | handed to the outbox, nothing delivered yet | no |
| `failed` | a message could not be delivered and none has been | yes |
| `sent` | at least one message was delivered | no |

The `billing_email_stuck` alert now links to `/platform/saas/notifications?state=stuck`.

## Resend is dedupe-aware (`billing-notifications.js`, `resend()`)

`POST /api/platform/saas/notifications/:id/resend` never writes a new notice or a new message. That is what makes it safe
to click twice, or to click on something that already went out. It does one of three things, per message:

| Situation | What happens |
|---|---|
| The notice never reached the outbox (pending, or out of attempts) | It gets a fresh set of attempts and is queued now. The dedupe key is unchanged, so a concurrent tick cannot make a second copy. |
| A message failed delivery and still has its body | **That same outbox row** goes back to `queued` (same id, same dedupe key, attempts reset). |
| A message is `queued`, `sent` or `suppressed` | Left alone. |

When nothing can be put back, the call answers `409` with the reason, and the page shows it:

| Error | Meaning |
|---|---|
| `in_flight` | a message is already queued (a double click lands here) |
| `already_delivered` | it was delivered; it will not be sent again |
| `recipient_suppressed` | the address bounced or complained since; not mailed |
| `message_unavailable` | the failed message's body was already dropped (see below); the notice goes out again only if its trigger fires again |
| `emails_not_on` | `BILLING_EMAILS` is not `on` |
| `nothing_to_resend`, `organization_gone`, `no_recipients`, `no_verified_recipient` | no eligible message |

Every resend, accepted or refused, is written to the audit log (`billing_notification`, action
`resend:<kind>:<outcome>`, with the organization). There is no "force resend of a delivered notice": a customer who says
they never received one is a support case (check the recipient and the Resend dashboard), not a button.

## One behaviour change to know about: failed billing messages keep their body for 14 days

So that staff can resend the exact message that failed, a **billing** message that fails permanently now keeps its
encrypted body instead of wiping it at once. Facts:
- Still encrypted at rest under the same key; `scripts/key-rotation` re-encrypts it like any queued message.
- The five-minute tick drops it after 14 days (`FAILED_BODY_DAYS`); after that the message is `message_unavailable`.
- Every other message type (verification, reset, invitation, alerts) is wiped on failure exactly as before (tested).
- Account and organization erasure delete failed messages for the erased address or organization, as before.
- A sent message is wiped as before.

## Phase 2 gate (`scripts/phase-gate.mjs`, `npm run check:phase2`)

Answers "may Phase 2 be approved?" with two kinds of check:
- **code** (computed from the files): all 15 blueprint notices exist as templates; handlers exist for the five sprint 2.2
  events; migration 0051 shape; the Resend webhook route; the staff view and resend route; resend never writes an intent or
  a message; the `email_bounce_rate` and `billing_email_stuck` alerts; every Phase 2 flag is in `CONFIGURATION.md` and the
  example config; change notes with a rollback for 2.1, 2.2 and 2.3.
- **staging** (only a person can prove these): `docs/PHASE_2_STAGING_RECORD.md` lists 13 checks (SPF/DKIM/DMARC, live Resend
  delivery, the five events added and fired from the Stripe CLI, one welcome and one reminder, one email for action-required,
  coupon hold released, a shadow run on real traffic, the AT-3 dunning series, bounce and complaint suppression, the
  bounce-rate alert, safe staff resend, Stripe's own failed-payment email still on) plus an approval line. A box counts only
  when it is ticked **and** has evidence written after `evidence:`.

`--static-only` checks code only (CI runs it on every pull request, on Node 22 and 24). Without it the script exits non-zero
until the record is complete and signed. **The script never edits the record and never ticks anything.** In this release the
record is blank and the gate reports it as open: that is the true state.

## Safety properties (unchanged and extended)

- Resend cannot duplicate: it creates nothing, it only re-queues a failed row or retries an unqueued intent (AT-9 holds).
- A suppressed address is never mailed, including by a resend of a message queued before it bounced.
- Staff-only: closed to anonymous callers and customer sessions (tested), audited, and no payload or address in any response.

## Verification status

- Full control-plane suite on Node 22 (counts in the package report). New file: `test/billing-notifications-staff.test.js`
  (15 tests); `test/admin-shell.test.js` expects the new menu entry; `test/phase2-gate.test.js` covers the gate.
- Run only against the fake provider and an in-memory SQLite. **Not verified**: Node 24 (CI runs it), live Resend delivery and
  the staff page in a browser against staging (the page is rendered and asserted as HTML only), plus everything listed as open
  in `docs/PHASE_2_STAGING_RECORD.md`.

## Rollback

Deploy v2.2.1. Nothing in the schema changed. The resend route and page disappear; failed billing messages that kept a body
simply keep it until the 14-day prune (v2.2.1 never reads it) or until erasure. `BILLING_EMAILS=off` still makes the whole
notification system inert.
