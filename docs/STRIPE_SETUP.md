# Stripe setup and evidence checklist (Sprint 4.1)

**Preparation only. This document does not mean Stripe was configured or verified.** Apply and record each setting in test mode first; repeat in live mode only after formal approval.

## API keys and API version

- [ ] Create separate restricted API keys for staging/test and production/live. Grant only the permissions required for customers, subscriptions, prices/products, invoices, payment methods, checkout, portal, tax IDs, refunds/disputes and test clocks where applicable. Never put secret keys in source control, client-side code, logs or artifacts.
- [ ] Store keys as environment secrets (`STRIPE_SECRET_KEY` / staging equivalent); keep publishable keys separate. Verify test keys start `sk_test_` and live keys start `sk_live_` only in the approved live environment.
- [ ] Pin `STRIPE_API_VERSION` to the version used by the webhook endpoint. Record the actual value and change-control ticket; do not silently upgrade it.
- [ ] Configure `STRIPE_PORTAL_CONFIG_ID` per environment and verify it references the intended portal configuration.

## Webhook endpoint

- [ ] Register the staging and production endpoint separately; store each signing secret as an environment secret.
- [ ] Pin the endpoint to `STRIPE_API_VERSION` and subscribe to every event in the blueprint's section 12, including checkout, customer/subscription, invoice/payment, payment-method, tax-ID, refund, dispute and credit-note events supported by this integration.
- [ ] Verify signature checking, idempotency, duplicate delivery, out-of-order delivery and wrong-`livemode` rejection. Confirm failed processing is retried and visible in the webhook operations page.
- [ ] Send a test event and record endpoint ID, API version, subscribed event list, delivery ID, HTTP status and timestamp.

## Customer portal

- [ ] Enable updating payment methods, viewing invoices, updating billing details and tax IDs, and cancellation at period end with a cancellation reason.
- [ ] Disable customer plan switching in the portal; plan changes must use Lummet's guarded and audited plan-change flow.
- [ ] Confirm portal return URLs use the correct environment and the customer can recover a failed payment.

## Dunning, emails and statements

- [ ] Configure Smart Retries and ensure the terminal subscription outcome is **mark as unpaid** (not silently cancel or delete).
- [ ] Enable Stripe receipts and card-authentication emails.
- [ ] Keep Lummet's failed-payment email enabled during verification. Do not disable Stripe's corresponding email until Lummet delivery, retries, suppression and support wording have been verified and approved.
- [ ] Set statement descriptor and shortened descriptor within Stripe's limits; verify what appears on a test receipt/statement.
- [ ] Set business branding/logo/colors and support details. Add approved Terms of Service and Privacy Policy URLs.

## Tax (live verification required)

- [ ] Confirm the legal entity, tax registrations, business location and tax obligations with qualified advisers before enabling Stripe Tax.
- [ ] Enter registrations in each applicable jurisdiction; record evidence and effective dates.
- [ ] Assign appropriate Stripe product tax codes to every billable product/plan; verify prices, inclusive/exclusive tax behavior and customer location collection.
- [ ] Verify a domestic transaction, an EU reverse-charge case where applicable, and a no-registration case in test mode.
- [ ] Keep `STRIPE_TAX_ENABLED=false` until the operating model and registrations are approved. A test result is not proof of live tax compliance.

## Evidence per environment

Record date/operator, environment, API version, key type (never key value), webhook endpoint/event set, portal configuration, retry policy, email settings, statement descriptor, branding/legal URLs, tax registrations/product codes, test-event IDs, outcomes and approver. The go-live record must link this evidence before live charges are authorized.


## Phase 4 helper commands (dry-run / read-only by default)

- `npm run stripe:webhook:plan -- --mode test --url https://staging.example.invalid/api/webhooks/stripe` prints the proposed endpoint/event set without network access. Use the real staging HTTPS endpoint only after it is approved.
- `STRIPE_SECRET_KEY=<test key> STRIPE_API_VERSION=<pinned YYYY-MM-DD> STRIPE_WEBHOOK_URL=<HTTPS endpoint> node scripts/stripe-webhook-config.mjs --mode test --apply` creates an endpoint. It is a mutating API call; inspect the dry-run first. The returned signing secret is not retrieved or stored by this script; configure the secret from Stripe's dashboard securely.
- `STRIPE_SECRET_KEY=<test key> STRIPE_API_VERSION=<pinned YYYY-MM-DD> STRIPE_WEBHOOK_ENDPOINT_ID=we_... node scripts/stripe-config-verify.mjs --mode test` performs a read-only check of the endpoint event set, mode, status and API version.
- `node scripts/stripe-clock-suite.mjs` is a local dry-run checklist. Actual test-clock mutation requires `--execute`, test-mode credentials, `STRIPE_CLOCK_ENVIRONMENT=staging`, a pinned API version, and authenticated state/action endpoints. Never provide a live-mode key.
- `ENFORCE_PRODUCTION_HYGIENE=on node scripts/production-hygiene.mjs` enables the local documentation/owner placeholder gate. Default is `off`; it does not replace service-level evidence.

Required event set (as specified in blueprint section 12):
``checkout.session.completed`, `checkout.session.expired`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.trial_will_end`, `invoice.upcoming`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.payment_action_required`, `invoice.marked_uncollectible`, `invoice.voided`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`, `credit_note.created`, `customer.updated`, `customer.tax_id.created`, `customer.tax_id.updated`, `customer.tax_id.deleted`, `payment_method.attached`, `payment_method.detached`, `payment_method.automatically_updated``. The endpoint API may reject events unsupported by a particular account/API version; investigate rather than silently omitting a required event.

**Important:** these scripts are tooling, not evidence of completed Stripe setup. The endpoint creation helper is opt-in and its API mutation is not a substitute for dashboard checks of customer portal, Smart Retries, receipt/authentication emails, legal URLs, branding, tax registrations or product tax codes.
