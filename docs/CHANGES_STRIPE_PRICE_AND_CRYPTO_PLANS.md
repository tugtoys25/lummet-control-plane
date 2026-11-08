# Create-in-Stripe, and selling plans that have no Stripe price yet

Additive: no migration, no new settings, nothing changes while crypto checkout is off.

## 1. Create the Stripe price from the console
Staff console, Plans, a recurring plan, Pricing tab, "Create the price in Stripe for me".
`POST /api/platform/saas/plan-catalog/:id/stripe-price { amountCents?, taxBehavior?, reason, confirmLive? }` (worker/plan-stripe.js).

- Finds the Stripe product `prod_lummet_<product key>` (the id scripts/stripe-sync.mjs uses) and creates it only when missing. Never renames it.
- Creates the recurring price with lookup key `<plan key>_<interval>_<currency>_v<version>` and idempotency key `price:<lookup key>`.
- Then runs the existing attach step (`setPlanPrice`): Stripe is asked about the id, amount, currency, interval and mode must match, a price id is never reused, a new immutable price version is recorded.
- A LIVE key needs `confirmLive: true` (the console asks). Prices cannot be edited in Stripe afterwards.
- A price already under the lookup key (a half-finished earlier attempt) is adopted when it matches exactly, refused (`lookup_key_in_use`) when it does not.
- If Stripe succeeded but the attach step refused, the error carries `stripePriceId` so nothing is lost; the manual form still works.
- Audited as plan / `create_stripe_price`. The manual "attach an id" form is unchanged.

## 2. Plans with no Stripe price yet are sellable by crypto
Only when crypto checkout is ON and configured (Platform settings, or `PAYMENT_GATEWAYS`). With it off, every behaviour below is exactly as before.

- Registration with a chosen plan no longer fails `plan_not_billing_configured` for a priced plan without a Stripe price.
- `POST /billing/checkout` with no gateway named sends such a plan to crypto instead of failing. An explicit `gateway` is never overridden.
- Billing page: such a plan shows "Subscribe with crypto" instead of "Not available online", and is no longer hidden when `CARD_REQUIRED_TRIAL=on`.
- Public pricing page with `CARD_REQUIRED_TRIAL=on`: such plans are listed, with no trial advertised (a card-required trial starts in Stripe Checkout). With it off the page already listed every active priced plan.
- Crypto bills the plan's list price (`plans.price_cents`) for one prepaid period; it has no trial, coupons or in-place plan change (existing behaviour).

## Rollout
1. Deploy (no migration).
2. Staff console: attach or create Stripe prices where you want card checkout.
3. For crypto-only plans, make sure the NOWPayments gateway is switched on.
