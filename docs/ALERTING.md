# Alerting (roadmap 2.2)

The platform checks these things and tells a human when one goes wrong:

- failed background jobs (24h) and jobs stuck over 30 minutes
- background jobs the system gave up retrying (dead-lettered, last 7 days; clears when staff retry them)
- webhook deliveries that ran out of retries, only when 10 or more died in 24 hours (one customer's dead
  endpoint is that customer's business; a spike points at a platform problem)
- sites in a failed state
- subscriptions past due (a failed payment)
- emails that could not be delivered, and emails still queued after 30 minutes
- active tenants failing their health check (anything but Online)
- organization or account deletions that could not fully clean up (the latest
  erasure attempt is partial or failed, so Cloudflare resources may be left
  behind; the next run retries, and the alert clears when an attempt completes)
- billing webhook events that failed processing in the last 7 days
- Stripe subscriptions on a price Lummet does not know (`unknown_price_id`, v2.3.1: their plan could not be
  synced; add the price to `catalog/plans.v1.json` and run the sync, or resolve the issue as not ours)
- customer plan changes still unconfirmed by Stripe after an hour (`plan_change_stuck`, v2.3.1: the customer may be
  billed for a plan they do not have yet; see `plan_change_intents`)
- `webhook_lag` (v2.6.0.5): outgoing customer webhook deliveries the retry machinery should already have handled: never
  started or in flight with no activity for over 5 minutes, or failed with the next scheduled retry (1, 5, 30, 120 or
  360 minutes after the last attempt) more than 10 minutes overdue. A delivery simply waiting out its backoff is not lag.
  Deliveries older than the three-day retry window are ignored. Counts only.
- `trial_expired_still_live` (v2.6.0.5): an organization with an expired local trial (no payment provider behind it)
  and no active or past-due subscription whose site is still active after the point the access ladder says it should be
  suspended (trial end plus twice `BILLING_RESTRICTED_DAYS`). Only evaluated when `BILLING_SUSPEND_SITES` is `shadow` or
  `enforce`; with it `off` sites are never suspended by design and the check stays quiet. Counts organizations only.
- `reconcile_drift` (open billing reconciliation findings) is also shown, together with the two checks above, as a tile
  on the staff alerts page (`/platform/saas/alerts`).
- `synthetic_signin`, `synthetic_checkout`, `synthetic_canary_site`, `synthetic_domain_attach` (v2.6.0.12, Round 6.5A):
  the synthetic monitors (`docs/SYNTHETIC_MONITORS.md`). Each counts consecutive failed probes once they reach
  `SYNTHETIC_FAILURE_THRESHOLD`, or the threshold itself when no probe has recorded for `SYNTHETIC_STALE_MINUTES`. They
  count 0, and so never page, unless `SYNTHETIC_MONITORS=on` and the monitor is configured and not skipped. A page names the
  monitor and a reason CODE only. They go through exactly the machinery above: once when it starts, a reminder every
  6 hours, and one message when it clears. Probe state is stored in `alert_state` rows keyed `probe:<monitor>`, which the
  alert list on the staff page hides; the staff Alerts page has its own Synthetic monitors tile.
- production configuration incomplete (names of missing settings, never values; production only; also
  shown as a banner on the staff SaaS overview, which works even when no alert channel is set)
- no successful control-plane backup in 36 hours (only when backup storage exists)

A failed billing webhook is retried automatically when the provider redelivers it (up to 5 attempts, see
`billing_webhook_events.attempts`). The alert means an event is still failing after a day-to-week of
redeliveries or has used up its attempts: see the `billing_webhook_events` table for the error.

A problem notifies **once** when it starts, reminds every 6 hours while it
lasts, and notifies when it clears. Messages contain counts only, never
customer data. If a notification cannot be delivered it is retried on the
next check rather than being lost.

## 1. Pick a channel (one or both)

Set as Worker secrets/variables:

| Name | Purpose |
|------|---------|
| `ALERT_WEBHOOK_URL` | Slack or Discord incoming-webhook URL. **Recommended:** it works even if email is what broke. Must be https and a public address. |
| `ALERT_EMAIL` | Address to email. Uses the normal email provider, so it needs `EMAIL_PROVIDER`, `RESEND_API_KEY` and `EMAIL_FROM` set. |

## 2. Make something run the check

Something has to call the check regularly. Cron Triggers are not on the
current plan (see the note in `wrangler.jsonc`), so either:

- **Paid plan:** re-add `"triggers": { "crons": ["*/5 * * * *"] }`. The
  scheduled handler already runs the alert check.
- **Free plan:** set a long random `ALERT_CHECK_TOKEN` secret, then have a
  free uptime monitor (UptimeRobot, Better Stack, cron-job.org) request
  `https://<your-control-plane>/api/ops/alert-check` every 5 minutes with the
  header `Authorization: Bearer <token>`. With no or a wrong token the
  endpoint returns 404; with no token configured it is disabled.

## 3. Check it works

Open **SaaS > Alerts** in the staff console. It shows which channels are
configured and the state of each check, and has a "Run check now" button.
To test end to end, create a failed job on a staging copy and confirm a
message arrives.

## When an alert fires

Each incident type has a runbook: see [RUNBOOKS.md](RUNBOOKS.md) (webhook backlog, Stripe outage, D1 incident, Cloudflare
incident, mass email failure, mistaken suspension, restore drill). The runbooks are STATIC REVIEW and NOT VERIFIED until exercised.
Who is paged and how is an owner decision that is still **[OPEN]**; the built-in channel is `ALERT_WEBHOOK_URL` and/or `ALERT_EMAIL`.

## Not covered

- A broken Worker, an expired deploy, or the whole platform being down
  cannot alert on itself. Point the uptime monitor at a public page too, so
  it also tells you when the site stops answering.
- Latency and error-rate tracking (Sentry or similar) is a separate project.
