# Alerting (roadmap 2.2)

The platform checks thirteen things and tells a human when one goes wrong:

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

## Not covered

- A broken Worker, an expired deploy, or the whole platform being down
  cannot alert on itself. Point the uptime monitor at a public page too, so
  it also tells you when the site stops answering.
- Latency and error-rate tracking (Sentry or similar) is a separate project.
