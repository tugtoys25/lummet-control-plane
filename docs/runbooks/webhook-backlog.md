# Runbook: webhook backlog

Two different pipelines are called "webhooks". Work out which one first; the fixes differ.

| | Incoming billing webhooks (Stripe to us) | Outgoing customer webhooks (us to customers) |
|---|---|---|
| Table | `billing_webhook_events` (`status` received, processed or failed; `attempts`) | customer webhook deliveries (see [durable jobs](../DURABLE_JOBS.md)) |
| Alert | `failed_billing_webhooks` (failed in the last 7 days), `webhook_wrong_mode` | `webhook_lag`, `dead_webhook_deliveries` (only at 10 or more dead in 24 hours) |
| Who retries | Stripe redelivers; staff can replay one event | the maintenance sweep, with backoff of 1, 5, 30, 120 and 360 minutes |
| Customer impact | subscriptions, plans and access state lag Stripe | a customer's own endpoint hears late or never |

## Trigger

- An alert above fired, or the staff alerts page (`/platform/saas/alerts`) shows webhook counts rising.
- Stripe's dashboard shows delivery failures to our endpoint, or a customer reports a paid plan not applied.
- A deploy, a `STRIPE_WEBHOOK_SECRET` change or a key rotation happened in the last hour (likely cause).

## First 15 minutes

1. Open [alerting](../ALERTING.md) and note which alert keys are firing and since when. Open the incident record
   ([template](../RUNBOOKS.md#incident-record)).
2. Is the tick running? `cron_not_running` or a silent pinger means nothing is being retried. Fix that first
   ([durable jobs](../DURABLE_JOBS.md)); a backlog with no sweep never drains.
3. Incoming only: list the failures read-only with `GET /api/platform/saas/webhooks/failed?limit=50` (paginated) or:

```sql
SELECT event_type, status, attempts, substr(error_message, 1, 120) AS error, received_at
FROM billing_webhook_events WHERE status = 'failed' ORDER BY received_at DESC LIMIT 50;
```

4. Read the `error_message` pattern. One repeated error is one cause:
   - signature or mode errors: the secret or the `livemode` does not match (`webhook_wrong_mode`); see
     [Stripe setup](../STRIPE_SETUP.md). Do not "fix" by loosening verification.
   - an unknown price (`unknown_price_id`): add the price to the catalog and run the sync; do not hand-edit subscriptions.
   - database errors: switch to the [D1 incident](d1-incident.md) runbook.
   - Stripe itself failing: switch to the [Stripe outage](stripe-outage.md) runbook.
5. Outgoing only: list stuck deliveries from the staff webhooks page (`/platform/saas/webhooks`). A customer endpoint that
   is dead is the customer's problem; a spike across many customers is ours (database, egress, sweep).

## Do not

- Do not delete rows from `billing_webhook_events`. A processed row is what makes a replayed event harmless.
- Do not mark an event processed by hand, and do not edit a subscription to match what you think the event said.
- Do not replay in bulk before the cause is fixed: replays of a still-failing event just add attempts.
- Do not disable signature verification, even temporarily.
- Do not re-send customer webhook payloads yourself; use the retry machinery so the signature and the idempotency key are right.

## Recovery and verification

1. Fix the cause (secret, price catalog, database, sweep). Confirm with one event first.
2. Incoming: replay one failed event with `POST /api/platform/saas/webhooks/:eventId/replay` and a reason (required, audited
   as `webhook_replay`). Check the row turns `processed` and the organization's state is right. Replay the rest one at a time
   or in small groups, oldest first; the same event five times must leave one outcome (AT-9).
3. Stripe redelivers failed events on its own schedule; wait one cycle before replaying the remainder by hand.
4. Compare with Stripe: run `scripts/reconcile-billing.mjs` (read-only; findings are never applied automatically) and look at
   the `reconcile_drift` tile on the staff alerts page. Resolve findings with the audited tools, with a reason.
5. Outgoing: once the cause is fixed the sweep retries on its schedule; a dead-lettered job can be retried with
   `POST /api/platform/saas/jobs/:id/retry` (fresh set of retries). A suspended customer webhook endpoint is changed with the
   staff webhook status action, which is audited.
6. Done when: the failed count is zero or each remaining row has a written reason, the alerts have resolved (one "resolved"
   message each), and reconciliation shows no unexplained drift.

## Record the incident

First and last event ids and times, the error pattern, the cause, the number replayed and by whom, the audit row ids of
`webhook_replay`, the reconcile output (counts), and any customer who was billed or restricted wrongly while the backlog existed.

## Who and how (placeholders)

**[OPEN]** Who owns billing webhook incidents, who may replay events, and the paging order are owner decisions
(`docs/PLACEHOLDERS.md`, Round 6.5B). Until supplied, the incident lead is whoever acknowledges the alert.

## Evidence status

STATIC REVIEW against the code in release 2.6.0.13. NOT VERIFIED: no replay, reconcile or Stripe redelivery was run live,
and the retry intervals are quoted from [alerting](../ALERTING.md), not measured.
