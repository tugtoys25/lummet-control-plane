# Incident runbooks (Round 6.5B, release 2.6.0.13)

Seven procedures for the incidents the blueprint names, plus the restore drill. They are written from the code as it stands
(**STATIC REVIEW**). **None has been exercised against live Cloudflare, Stripe, Resend or a real incident: every runbook is
NOT VERIFIED** until the owner runs it in staging and attaches the evidence. Nothing here is a promise to customers.

| Runbook | Start here when |
|---|---|
| [Webhook backlog](runbooks/webhook-backlog.md) | `failed_billing_webhooks`, `webhook_lag` or `dead_webhook_deliveries` fires, or Stripe shows undelivered events |
| [Stripe outage](runbooks/stripe-outage.md) | Stripe is down or erroring: checkout fails, plan changes stick, cancellations queue |
| [D1 incident](runbooks/d1-incident.md) | the control-plane database is erroring, slow, or has lost or corrupted data |
| [Cloudflare incident](runbooks/cloudflare-incident.md) | Workers, R2, queues, custom hostnames, Access or WAF misbehave on Cloudflare's side or after our change |
| [Mass email failure](runbooks/mass-email-failure.md) | `failed_emails`, `stale_email_queue`, `email_bounce_rate` or `billing_email_stuck` fires |
| [Mistaken suspension](runbooks/mistaken-suspension.md) | sites that should be live are suspended; the audited bulk-reactivation path |
| [Restore drill](runbooks/restore-drill.md) | scheduled drill, or a real restore needs rehearsing first (AT-15) |

The report the drill produces starts from `docs/RESTORE_DRILL_REPORT_TEMPLATE.md`.

## Rules every runbook shares

1. **Never fake success.** Do not mark an invoice paid, grant a plan, set a subscription `active`, or tell a customer something
   worked, because a dependency is down. Queue, retry, and say what is pending. Money, access and identity state change only
   through the audited staff tools and signed provider events.
2. **Every staff action is audited with a reason.** If a tool in a runbook has no reason field, stop and escalate.
3. **Stop the cause before you repair the symptom.** A repair that the next sweep undoes is not a repair.
4. **Read before you write.** Use the read-only queries first; write queries are not in these runbooks on purpose.
5. **No secrets in tickets, chat or reports.** Names of settings, never values. Request ids and audit row ids, never tokens.
6. **A failed repair is reported as failed.** Partial results (HTTP 207) are partial.
7. **Do not change defaults to get out of trouble.** `BILLING_ENFORCE`, `BILLING_SUSPEND_SITES`, `STRIPE_TAX_ENABLED` and
   `FOUNDER_LICENSE_ENABLED` keep their documented defaults unless the owner decides otherwise and records it.

## Incident record

Keep one record per incident (a ticket or a dated file outside this repository). Minimum fields:

- incident id, severity, UTC start, UTC detected, UTC mitigated, UTC closed, and who was incident lead;
- the alert keys that fired (see [alerting](ALERTING.md)) and the runbook used;
- every staff action taken: route or script, the reason text entered, and the audit row id or request id;
- customer impact in counts (organizations, sites, emails), never names;
- decisions made and who approved them;
- what was NOT done and why, and the follow-ups with owners.

Each runbook's "Record the incident" section lists what is specific to it.

## Who is paged and how (placeholders)

**[OPEN]** Who is paged, by what tool, in what order, and the out-of-hours rule are not supplied by the owner. The platform's
only built-in paging channel is `ALERT_WEBHOOK_URL` and/or `ALERT_EMAIL` ([alerting](ALERTING.md)). No rota, escalation
chain or response-time commitment is assumed. See `docs/PLACEHOLDERS.md` (Round 6.5B).

## Status page

**[OPEN]** Who may post to the status page, and the wording rules, are owner decisions. `STATUS_PROVIDER_URL` is the
configured link (Round 6.2A). Do not claim a cause or an ETA you have not confirmed.

## Where each runbook ends up

Runbooks link to the existing procedures instead of repeating them: [backup and restore](CONTROL_PLANE_BACKUP.md),
[go-live checklist](GO_LIVE_CHECKLIST.md), [enforcement cutover](ENFORCEMENT_CUTOVER.md), [durable jobs](DURABLE_JOBS.md),
[Cloudflare Access](CLOUDFLARE_ACCESS.md), [WAF rate limits](WAF_RATE_LIMITS.md), [synthetic monitors](SYNTHETIC_MONITORS.md).

## Evidence status

STATIC REVIEW for every runbook. NOT VERIFIED live. The monitors that will page you (Round 6.5A) ship `off`.
