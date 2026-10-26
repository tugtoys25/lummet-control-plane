# Runbook: Stripe outage

The rule for this runbook is the blueprint's: **queue and retry, never fake success.** While Stripe is unavailable the
platform may be slower, may refuse to take a payment, and may show "pending". It must never show or record a payment, plan
change, refund or cancellation that Stripe has not confirmed.

## What the code already does (STATIC REVIEW)

| Situation | Behaviour |
|---|---|
| Stripe API write | `stripeRequest` refuses to send a POST without an idempotency key, so a retry cannot apply twice. |
| Organization deleted during the outage (AT-8) | The cancellation is queued in `billing_cancel_pending` and retried on every sweep, in every billing mode. `cancel_pending_stuck` fires when one is older than 24 hours. |
| Customer plan change | Written to `plan_change_intents` (`pending`), resent with the same key until Stripe accepts it, then `submitted`, then `confirmed` only by the Stripe webhook. `plan_change_stuck` fires after an hour unconfirmed. |
| Webhooks | Not received during the outage. Stripe redelivers afterwards; failures show in `billing_webhook_events`. |
| Checkout | A session that cannot be created is an error to the customer; nothing is recorded as paid. |

## Trigger

- Stripe status page reports an incident, or checkout, plan changes or portal links fail across many customers.
- `plan_change_stuck`, `cancel_pending_stuck` or `failed_billing_webhooks` fires with Stripe errors (5xx, timeouts) in the logs.
- The `synthetic_checkout` monitor (if switched on; [synthetic monitors](../SYNTHETIC_MONITORS.md)) is failing and sign-in is not.

## First 15 minutes

1. Confirm it is Stripe, not us: one failing call with a request id, the Stripe status page, and whether sign-in and the
   database are healthy. If the database is unhealthy use the [D1 incident](d1-incident.md) runbook instead.
2. Open the incident record ([template](../RUNBOOKS.md#incident-record)) and post to the status page (wording and who may post
   are **[OPEN]**; state only what is confirmed).
3. Read-only look at what is queued:

```sql
SELECT organization_id, attempts, substr(last_error, 1, 100) AS error, created_at FROM billing_cancel_pending ORDER BY created_at LIMIT 50;
SELECT status, COUNT(*) AS n FROM plan_change_intents GROUP BY status;
```

4. Check the enforcement settings (`BILLING_ENFORCE`, `BILLING_SUSPEND_SITES`; see [enforcement cutover](../ENFORCEMENT_CUTOVER.md)).
   If either is `enforce`, decide with the owner whether to move it to `shadow` for the duration (a configuration change and a
   redeploy, recorded). Reason: late `invoice.payment_failed` or subscription events arriving after the outage can move
   customers through restricted and suspended on stale information. Do not change the default permanently.
5. Tell support what customers can be told: payments and plan changes are delayed, nothing has been charged or changed that
   they have not seen confirmed.

## Do not

- Do not mark an invoice paid, set a subscription to `active`, grant an entitlement, apply a plan change or issue a credit
  because Stripe is down. This is the fake-success failure the blueprint forbids.
- Do not cancel or delete from the database to "clear" the queue; `billing_cancel_pending` is what stops a deleted customer
  being billed.
- Do not retry in a loop from a script or shell. The sweep is the retry; staff replay is for individual webhook events.
- Do not rotate or paste Stripe keys during the incident unless the key itself is the cause ([key rotation](../KEY_ROTATION.md)).
- Do not suspend customers for non-payment while the cause of non-payment may be the outage.

## Recovery and verification

1. When Stripe reports recovery, confirm with one real call (a read) before relying on it. Do not test with a live charge.
2. Let the sweep drain the queues (about one tick, five minutes, per batch). Check `billing_cancel_pending` empties and
   `plan_change_intents` rows move to `submitted` then `confirmed`. A row that went `failed` was refused by Stripe: read its
   `last_error` and handle it as a normal failed change, with the customer told.
3. Webhooks: follow [webhook backlog](webhook-backlog.md): wait for Stripe's redelivery, then replay what is still failed,
   one at a time, with a reason.
4. Run `scripts/reconcile-billing.mjs` and review the `reconcile_drift` tile. Findings are never applied automatically; resolve
   each with the audited tool and a reason.
5. Customers who were restricted or suspended in the window: give a grace extension with the audited dunning action rather
   than editing state, and use the [mistaken suspension](mistaken-suspension.md) runbook for sites.
6. If `BILLING_ENFORCE` or `BILLING_SUSPEND_SITES` was moved to `shadow`, put it back only after the backlog is empty,
   reconciliation is clean and the owner approves; record the time.
7. Done when: queues are empty, alerts resolved, reconciliation clean, status page updated, and the incident record lists every
   customer-visible effect.

## Record the incident

Stripe incident reference, first and last failed call (UTC), the counts in each queue at start and end, settings changed and
restored with times, customers given grace (count), audit row ids, and the reconcile summary.

## Who and how (placeholders)

**[OPEN]** Who may change enforcement settings during an incident, who talks to Stripe support, and the customer wording are
owner decisions (`docs/PLACEHOLDERS.md`, Round 6.5B). Account-level facts (Stripe plan, support contact) are not in this repository.

## Evidence status

STATIC REVIEW. NOT VERIFIED: no outage was simulated against Stripe. The fake provider tests prove the queue and retry code
paths locally (TESTED LOCALLY in earlier releases), not behaviour under a real Stripe incident.
