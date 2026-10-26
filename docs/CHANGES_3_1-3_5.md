# Phase 3 implementation notes — v2.3.3

## Sprint 3.1 — catalog and prices
Preserved the versioned catalog, dry-run-by-default Stripe catalog sync, immutable price records, and mode checks. Migration 0052 remains unchanged.

## Sprint 3.2 — plan sync and guarded changes
Migration 0053 and idempotent plan-change intents remain in place. `planById` now supplies the pricing/currency fields required to classify upgrades vs. downgrades correctly. Downgrades check live site, member + pending invitation, and custom-domain usage against target entitlements and return a specific excess/removal list. Because storage is not metered yet, a downgrade that lowers the storage cap is blocked pending verification rather than assuming zero usage. A permitted downgrade uses a Stripe subscription schedule at the current period end; current entitlements stay in force until Stripe's webhook confirms the target plan. Existing schedules and discounted subscriptions are refused for manual review rather than overwritten. Staff can override the guard only with a reason; the override is written to subscription history and the staff audit log.

## Sprint 3.3 — billing profile and tax collection
Migration 0054 adds billing-profile persistence. The customer Billing page supports legal name, billing contact, address, country, tax-exempt flag, and PO number. Editable details are sent to Stripe with an idempotency key before local persistence; Stripe-managed tax IDs are preserved and synchronized from `customer.tax_id.*` events. Checkout requests a billing address, tax-ID collection, and payment-method collection. Stripe Tax is opt-in with `STRIPE_TAX_ENABLED=true`; do not enable before tax registrations and the operating model are approved.

## Sprint 3.4 — financial ledger and payment methods
Migration 0055 adds invoice totals/attempt metadata, invoice lines, refunds, disputes, credit notes, and payment failure details. Migration 0057 adds payment-method metadata without PAN/CVC storage and event-order timestamps for ledger/profile state. Handlers cover invoice finalized/uncollectible/void, charge refunds, dispute create/close, credit-note create, customer updates, tax-ID create/update/delete, and payment-method attached/detached/automatically-updated. Older event deliveries cannot roll a newer ledger or payment-method state backward. Refunds intentionally do not change MRR or subscription entitlements. Open disputes raise the `dispute_open` alert.

## Sprint 3.5 — reconciliation and drift
Migration 0056 stores reconciliation findings. Daily paginated reconciliation compares subscription status, mapped price, period end, and cancel flag, raises `reconcile_drift`, and never silently overwrites state. The super-admin Billing reconciliation screen exposes “Accept Stripe value” and “Keep Lummet value” actions; both require a reason and are audited. Accepted Stripe values update only allowlisted subscription fields. A deliberate “Keep Lummet value” decision does not reopen the same unchanged finding every day. `scripts/reconcile-billing.mjs` remains available for operational reconciliation.

## Rollback and migration safety
Set `STRIPE_TAX_ENABLED=false` to disable automatic tax. Do not delete migrations or re-run already-applied migrations blindly. Migrations 0054–0057 are additive; review the remote D1 migration history and take a backup before staging rollout. Do not deploy migration 0057 to an environment where a different migration already uses that version number.

## Verification limits / release gate
Local acceptance fixtures cover the downgrade guard/override, schedule construction, profile-to-Stripe request shape, ledger and payment-method handlers, duplicate delivery, and out-of-order state updates. Focused billing/Phase 3 regression run: **130 tests passed, 0 failed** on Node 22.16.0. The entire 126-file test suite did not complete within the available 300-second execution window, so a full-suite pass is **not claimed**. Node 24 CI is configured in `.github/workflows/ci.yml` but was not run in this environment. No live Stripe test account, remote D1, or Cloudflare staging deployment was available here.

Before commercial production, run CI on Node 22 and 24, apply migrations to a disposable/staging D1 after history preflight, run Stripe test-mode AT-5/6/9/11/12/13, validate tax/profile round-trip and pagination beyond 100 subscriptions, and sign the phase gate. This package is **not certified production-ready** until those external gates pass.
