# Phase 2 staging verification record

Phase 2 (customer communication, v2.2.x) is approved by a person, against staging, using this record. Nothing here has
been run by the tooling: the code was tested only against the fake billing provider and an in-memory database. A box
counts for the gate (`node scripts/phase-gate.mjs --phase 2`) only when it is ticked **and** has text after `evidence:`
(a link, a log line, a screenshot name, a command output). Leave a box open if you did not see it happen.

Environment under test: <staging URL, Stripe test mode, Resend sending domain>
Version under test: <x.y.z, zip SHA-256>

## Email domain and delivery

- [ ] spf_dkim_dmarc: SPF, DKIM and DMARC pass and align for the billing sending domain (Resend domain page, `dig` output or a received message's headers) — evidence:
- [ ] resend_live_delivery: a real billing email sent through Resend reached an inbox, with the billing From and Reply-To — evidence:
- [ ] resend_webhook_bounce_complaint: a Resend bounce and a complaint (Resend test addresses) each wrote a suppression, and that address was not mailed again — evidence:
- [ ] bounce_rate_alert: the `email_bounce_rate` alert fired at its threshold and cleared afterwards — evidence:

## Stripe events (test mode, Stripe CLI)

- [ ] stripe_events_added: `customer.subscription.created`, `customer.subscription.trial_will_end`, `invoice.payment_action_required`, `checkout.session.expired` and `invoice.upcoming` are in the webhook endpoint's event list — evidence:
- [ ] stripe_cli_payloads: each of the five events was sent once from the Stripe CLI and processed without a failed billing webhook — evidence:
- [ ] welcome_and_reminder_once: a test-mode trial produced exactly one welcome and one reminder — evidence:
- [ ] payment_action_required_once: `invoice.payment_action_required` (and `invoice.upcoming` on an annual plan) produced exactly one email each, also when delivered twice — evidence:
- [ ] checkout_expired_releases_hold: expiring a checkout that held a limited coupon released the hold — evidence:

## Behaviour on real traffic

- [ ] shadow_run_real_traffic: `BILLING_EMAILS=shadow` ran on real traffic; reminder decisions appeared as `billing_email_shadow` log lines and nothing was sent — evidence:
- [ ] at3_dunning_series: AT-3 on staging includes the payment-failed series (attempt 1, 2, 3 and later) as three distinct emails — evidence:
- [ ] staff_resend_safe: on `/platform/saas/notifications`, Resend on a delivered notice was refused, and Resend on a failed one delivered it once; both audited — evidence:
- [ ] stripe_own_failed_payment_email_still_on: Stripe's own failed-payment email is still enabled (it stays on until Phase 4 verifies Lummet's) — evidence:

## Not required by the gate (record the result anyway)

- Node 24 run of the test suite: <result>

## Approval

Approved by:
Approved on: (YYYY-MM-DD)
