# Platform settings (staff console first, wrangler second)

Release 2.7.0, migration 0075. Page: `/platform/saas/settings` (super admin). API: `/api/platform/saas/settings`.

## Precedence

For every managed key the value in force is the first that exists:

1. a value saved in the staff console (table `platform_settings`)
2. the var of the same name in `wrangler.jsonc`
3. the default written in the code that reads it

"Use wrangler" (the clear button, or `DELETE`) removes the console value, so the wrangler value applies again. A `wrangler deploy` never
overwrites a console value; it only changes what applies when no console value is set.

## How it works

`fetch()`, `scheduled()` and `queue()` call `withPlatformSettings(env)` once. It returns a copy of `env` with the console values laid
over it, so every `env.SOMETHING` read in the code sees the console value first with no change to that code. Each isolate caches the
values for 15 seconds: a change reaches every edge location in about that time, and is visible at once in the isolate that saved it.
If the table is missing or unreadable, `env` is returned unchanged (wrangler values apply) and `platform_settings_unreadable` is logged.

## What can be managed

The list is `SETTINGS` in `worker/platform-settings.js`. To make another setting manageable, add one entry with its type, options and help text.
Values are validated on save (for example `BILLING_ENFORCE` accepts only off, shadow or enforce) and a reason is required for every change.

Never manageable: secrets (`STRIPE_SECRET_KEY`, `CREDENTIAL_KEK`, `RESEND_API_KEY`, `NOWPAYMENTS_*`, `TURNSTILE_SECRET_KEY`, ...) and bindings.
A row in `platform_settings` for a key that is not in `SETTINGS` is ignored.

Kept in `wrangler.jsonc` on purpose (`NOT_MANAGEABLE`), because a wrong value can lock staff out of the console used to fix it:
`ENVIRONMENT`, `PLATFORM_ACCESS_JWT_MODE`, `CF_ACCESS_ISSUER`, `CF_ACCESS_AUD`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, `PORTAL_BASE_URL`,
`STAFF_2FA_REQUIRED`, `PASSWORD_HASH_FORMAT`, `PASSWORD_HASH_ITERATIONS`.

## Guards that span two settings

- `HSTS_PRELOAD=on` needs `HSTS_PRELOAD_APPROVED=yes`
- `ERROR_TRACKING=on` needs `ERROR_TRACKING_APPROVED=yes`
- `AUDIT_LOG_STREAM=on` needs `LOG_REDACTION=on`
- `PAYMENT_GATEWAYS` must leave at least one usable gateway (NOWPayments counts only when its API key and IPN secret are set)

## Relation to the payment gateway switch

`PAYMENT_GATEWAYS` is now one managed key. A console value for it beats the wrangler value. The older per-gateway endpoint
(`PUT /api/platform/saas/payment-gateways/:gateway`) still answers `409 controlled_by_config` while ANY `PAYMENT_GATEWAYS` value is in
force (console or wrangler); manage the list from the settings page instead.

## Rollback

Apply nothing: the tables are additive and ignored by older builds. To go back to wrangler-only behaviour without a deploy, clear every
console value (or `DELETE FROM platform_settings`).
