# Durable jobs and webhook retries (v7D)

Before v7D a background job ran only through `ctx.waitUntil()` from the request that started it, and a webhook was
sent once. If the Worker was evicted, or a step failed, nothing picked it up again. Now there is a **maintenance
sweep**, run on every tick of `POST /api/ops/alert-check` (the same external pinger that runs the alert check; or a
Cron Trigger, if you have one). Point your pinger at it **every 5 minutes**. Without the tick (no pinger, no cron)
nothing is retried, and the production configuration check says so.

## What the sweep does to jobs (`worker/job-runner.js`)

| Situation | Action |
|---|---|
| Created but never started (3 minutes) | Started. |
| Running, but no log line or start for 10 minutes (the Worker died) | The abandoned run is closed as failed and the job is **resumed** (steps that already succeeded are skipped). |
| `tenant_provisioning` that failed | **Retried** after 5, 15, 45, 120, 360 minutes (measured from when it failed), through the same path as the staff Retry button. |
| `site_deployment` that failed | **Never retried automatically.** Deploying again is a decision. Only deployments that were *lost* (never started, or the Worker died) are resumed. |
| Used all 5 automatic attempts, or cannot be retried (for example the site is no longer in a failed state) | **Dead-lettered**: status stays `failed`, `dead_lettered_at` and `dead_reason` are set, the job is left alone, and the `dead_jobs` alert fires. |

Safety: every automatic attempt first claims the job with a compare-and-swap, so two overlapping sweeps never run the
same job twice. At most 5 jobs are started per sweep. Each automatic attempt writes a line in the job log
("retried by the sweep ... attempt 2 of 5"). Staff **Retry** on a dead-lettered job gives it a fresh set of retries. For a failed `site_deployment` job, staff Retry is also the only way it is retried: the sweep never does.
Manual retries are not counted against the 5.

## Webhook deliveries (`worker/webhooks.js`)

The first attempt happens inline when the event fires. A failure is retried by the sweep after 1, 5, 30, 120 and 360
minutes: **6 attempts in total**, then the delivery is `dead`. Dead immediately, without retrying: an address that
is no longer allowed, no usable secret, an endpoint answering **410 Gone**, or a webhook that was disabled or deleted.
Failures older than 3 days (from before this release) are closed as dead rather than re-sent.

Every attempt sends the **same body** with the same `id`, plus the headers `Lummet-Delivery-Id` and
`Lummet-Delivery-Attempt`; the signature is computed afresh over the current timestamp. **Receivers should treat a
repeated delivery id as a duplicate** (a retry can be sent twice if a Worker dies mid-request).

Customers see `attempt`, `status` (`delivered`, `failed` = will retry, `retrying`, `dead`) and `next_attempt_at` in
`GET /api/organizations/:id/webhooks/:webhookId/deliveries`, and can re-send a failed or dead delivery with
`POST /api/organizations/:id/webhooks/:webhookId/deliveries/:deliveryId/redeliver` (admin role, audited).

## Optional: Cloudflare Queues (paid plan)

With a queue bound as `JOB_QUEUE` (see the commented block in `wrangler.example.jsonc`) new jobs are put on the queue
instead of `ctx.waitUntil()`, the Worker's `queue` handler runs them, Cloudflare redelivers on error and moves
messages that keep failing to the dead-letter queue, and the sweep enqueues its resumes/retries too. If the queue
refuses a message the code falls back to `waitUntil`. Without the binding nothing changes.

## Alerts

`dead_jobs` (any job dead-lettered in the last 7 days; clears when retried) and `dead_webhook_deliveries` (10 or
more dead in 24 hours: a spike, not one customer's broken endpoint). Both are in the usual once/reminder/resolved flow.

## Not in v7D

A customer-facing notification when their webhook endpoint dies, a per-endpoint circuit breaker, retrying failed
deployments automatically, and moving report/export jobs onto the same runner (they do not exist as jobs yet).
