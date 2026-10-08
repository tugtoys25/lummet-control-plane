# v6B (updated): v5B + v6A changes + small stability fixes

v6A = v5B plus the two real gaps found when comparing v5B with v4A and v4B.
Tests: 671 -> 683 (control plane), all passing. Nothing here has run against
live Cloudflare, Stripe or Resend.

## Organization-scoped coupons (from v4A)
- Migration `0032_coupon_organization_scope.sql` adds nullable
  `coupons.organization_id`. Existing coupons stay unscoped and keep working.
- A scoped coupon is usable only by that organization. Anyone else gets
  `invalid_coupon`, identical to an unknown code, from both the validate
  endpoint and checkout, and no hold is taken on a limited coupon.
- Staff: optional "Only this organization" field on the Coupons page and a
  Scope column. The organization must exist and not be erased. The scope is
  fixed at creation (disable and recreate to change it).
- Erasure: `coupons` is in the retention policy; erasing an organization
  deletes coupons reserved for it. Its past subscriptions keep their billing
  records but lose the link to that coupon.
- v5B's behavior is unchanged otherwise (redemption counted on completion, holds).

## Four alert checks (from v4B), adapted to v5B's schema
- `stale_email_queue`: email queued for over 30 minutes.
- `unhealthy_tenants`: active tenants whose health is not Online/Disabled.
- `incomplete_deletions`: the latest erasure attempt for a subject is
  partial/failed. v4B used `organizations.deletion_state`, which v5B does not
  have; this reads v5B's `erasure_log` instead.
- `failed_billing_webhooks`: failed events in the last 7 days.
- No migration needed (alert state is keyed by check name). Messages stay
  counts-only.

## v6B additions on top of v6A
- `incomplete_deletions` ignores an organization whose scheduled deletion staff
  later stopped (it is no longer retried, so the alert would never clear).
- Coupons page Scope column falls back to the organization id when the name is missing.
- Apply migration `0032` to the control-plane D1 before deploying.

## Not ported
`RUNBOOKS.md` (backup/restore rehearsal and Stripe/Cloudflare/Resend key
rotation steps) and a manual deletion-sweep button. Migrations 0024-0027
from v4A/v4B must still NOT be applied.

## Known issue found while doing this (not changed)
A billing webhook that fails processing is recorded as `failed`, but when the
provider retries the same event id, the insert is treated as a duplicate and
acknowledged without reprocessing. So a failed event is never retried
automatically. This exists in v4A, v4B and v5B. The new alert makes it
visible; a fix would reprocess events whose stored status is `failed`.
