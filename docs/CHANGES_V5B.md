# v5B: what changed from v5A

v5B = v5A (security review, staff 2FA, erasure, repositories layer, alerting,
control-plane backup, key rotation) plus the missing implementations from
v4A and v4B. Tests: 630 -> 671, all passing. Nothing here has run against
live Cloudflare, Stripe or Resend; use `scripts/smoke-test.mjs` on staging.

## From v4A
- `/app/settings`: organization settings page (transfer ownership, deactivate /
  reactivate, request / cancel deletion), nav link "Settings".

## From v4B
- **Deploy pipeline:** static assets uploaded with each release
  (`scripts/publish-tenant-release.mjs`, `worker/asset-hash.js`), full Worker
  bindings (`worker/site-bindings.js`), a per-site route `<slug>.<suffix>/*`,
  tenant cron registration, stylesheet health check, deploy-latest and
  rollback from the stored release. Erasure removes the route first.
- **Billing portal:** `POST /api/organizations/:id/billing/portal` and an
  "Update payment method & invoices" button.
- **Coupon holds:** a pending checkout holds the last uses of a limited coupon
  for up to an hour (migration `0031_coupon_reservations.sql`, renumbered from
  v4B's 0026). Registered in the erasure retention policy.
- **Staff lists** paged at 50 on organizations, subscriptions, jobs, domains,
  deployments, webhooks, API keys and backups.
- **Nav hiding:** Backups / Automations links hidden when the plan lacks them.
- **Test seams:** `__setInfraProviderForTests`, `__setBillingProviderForTests`.
- `scripts/smoke-test.mjs`; DEPLOYMENT.md and GO_LIVE_CHECKLIST.md updated.

## New in v5B (not in any earlier zip)
- **Staff "Stop scheduled deletion"** (`POST /api/platform/saas/organizations/:id/stop-deletion`).
  Fixes a v5A hazard: staff "Reactivate" set an organization active but left its
  erasure scheduled, so the sweep would still have erased it. Reactivating such an
  organization is now refused (409) until the deletion is stopped.

## Deliberately NOT ported (v5A's version is stronger)
v4A `coupons.js` / migration 0024 (counts use at checkout start; v5A counts on
Stripe confirmation); v4A/v4B account deletion (v5A `erasure.js`); v4B alerting,
control-plane backup, secret rotation, webhook SSRF guard, `/api/v1` throttle,
ops panel, checkout page, `RUNBOOKS.md`, `load-test.mjs` (v5A has equivalents).
Migrations 0025-0027 from v4A/v4B must NOT be applied alongside v5's.

## Known limits
Staff lists have paging but no search. Account-deletion retention defaults still
need legal sign-off (`ERASURE.md`).
