# Signed tenant-edge site-access gate (v2.3.4)

## State flow

1. A control-plane status change writes a durable `site_access_push_jobs` row with a monotonic per-site generation.
2. The retry worker signs `{state, generation, siteId, issuedAt}` with the same per-tenant HMAC secret used by the existing Super API, then sends it through `PUT /en/api/super/site-access-state`.
3. The tenant verifies the normal Super API request signature and the state payload signature, rejects stale generations, and persists the signed state in `system_settings`.
4. The tenant top-level handler reads the state through a 5-second isolate cache. A fresh `suspended`/`closed` state returns a neutral 503 page; `serving` proceeds to the normal handler.
5. Missing/invalid/unreadable state or state older than ten minutes fails open. The five-minute scheduler refreshes denied states while healthy; a prolonged outage intentionally permits serving after the state becomes stale.

## Rollout

- `BILLING_SUSPEND_SITES=off` (default): no billing-driven site suspension.
- `BILLING_SUSPEND_SITES=shadow`: log would-be site gate actions to `subscription_access_shadow`, do not change site status or tenant state.
- `BILLING_SUSPEND_SITES=enforce`: transition site state and queue signed tenant state updates. Legacy `on` is accepted as an alias for `enforce`.

Keep the setting off until the staging push, retry, restore and outage acceptance tests pass. Do not enable Stripe automatic tax as part of this rollout; `STRIPE_TAX_ENABLED` stays false until approved.

## Operations

- Alert `site_access_push_failed` means five attempts failed. Inspect `site_access_push_jobs` for `site_id`, `generation`, `attempts`, `last_error` and `last_http_status`.
- A transient push error is retried with exponential backoff; abandoned `running` jobs are reclaimable after ten minutes.
- A staff bulk reactivation requires a reason, restores the control-plane site status, queues a `serving` state, and writes an audit entry. If a push job cannot be queued, that site is rolled back and the partial failure is included in the audited response. A separate audited `POST /api/platform/saas/sites/:id/access-push/retry` action can enqueue a fresh state after credentials/connectivity are repaired.
- Never patch tenant D1 directly to bypass the HMAC state route. Fix credentials/connectivity and perform an audited state transition.
