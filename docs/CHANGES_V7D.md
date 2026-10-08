# v7D (from v7C): durable job execution and webhook delivery retries

Planned in `planon-v7B.txt` (item: "durable jobs and webhook delivery retries"); raised by the v7B completeness check
(items 18, 33 and "Should fix before scale").

- **Migration `0040_durable_jobs_and_webhook_retries.sql`**: `jobs.auto_retries`, `dead_lettered_at`, `dead_reason`;
  `webhook_deliveries.last_attempt_at`. Apply with `node scripts/migrate.mjs`.
- **`worker/job-runner.js`** and `repositories/job-sweep.js`: dispatch (Queue or `waitUntil`), the sweep (start lost
  jobs, resume stalled ones, retry failed provisioning with backoff, dead-letter), the Queue consumer. The sweep runs
  on every `POST /api/ops/alert-check` tick and from `scheduled()`. The Worker now also exports `queue()`.
- **Webhook delivery retries** in `worker/webhooks.js` (+ `repositories/webhook-deliveries.js`): 6 attempts with
  backoff, `dead` state, permanent-failure rules, stable delivery id and attempt headers, customer `redeliver` route.
- **Alerts:** `dead_jobs`, `dead_webhook_deliveries` (spike only). **Config check:** `ALERT_CHECK_TOKEN` is now a
  required production setting because retries depend on the tick.
- **Staff UI:** dead-lettered marker in the job list and detail page; Retry also forgives a dead-lettered job.
- All new SQL lives in `worker/repositories/`; `worker/webhooks.js` lost its delivery SQL (baseline lowered).
- Tests: `durable-jobs.test.js` (12), `webhook-delivery-retry.test.js` (12), `v7d-completion.test.js` (6), including failure -> retry -> success. Control plane: 811 (v7C) -> 841.
  end to end and a two-sweeps-at-once race for both jobs and webhooks.

Honest limits: not run against live Cloudflare or a real Queue; Queue behaviour is tested with a fake binding.
Deployments that fail are not retried automatically by design. The tenant package is unchanged from v7C.


## Completion pass (added after review of the first v7D build)
The first build's notes promised things the code did not yet reach. These are now in place and tested:
- **Customer webhook page** shows Attempt and Next attempt for every delivery, "gave up" for dead ones, a note that a repeated
  delivery id is a duplicate, and a **Re-send** button on failed and dead deliveries (admins only; the endpoint also refuses
  roles below admin). A test runs the page script against a stub browser; it caught a quoting error in the first version of the button.
- **Staff Retry now works for a failed deployment job** (it used to answer `retry_not_supported_for_type`). It clears any
  dead-letter, resets the automatic retries, resumes the job, and is audited. This is the human decision the sweep deliberately
  does not make for failed deployments, and it is how a `dead_jobs` alert on a deployment is cleared.
- **`ALERT_CHECK_TOKEN` configuration message** now says plainly what stops working without it (the external pinger cannot call
  `/api/ops/alert-check`; alert checks, job retries and webhook retries then run only from a Cron Trigger).

## Known limits (unchanged)
Automatic retry of failed deployments, customer emails when an endpoint dies, and moving report/export work onto the same
runner are not in v7D. Without the pinger (or a Cron Trigger) nothing retries. With a Queue bound, a job whose queue message is
delayed more than 3 minutes can also be picked up by the sweep; steps are idempotent, so the worst case is a repeated check, not a repeated resource.
