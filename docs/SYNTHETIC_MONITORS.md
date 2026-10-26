# Synthetic monitors (Round 6.5A, release 2.6.0.12)

Four probes run on the existing five-minute scheduled tick and tell a human, through the **existing alert channel**
(`ALERT_WEBHOOK_URL` and/or `ALERT_EMAIL`), when a customer-facing path stops working. They exist to catch the case where
every internal check is green and a customer still cannot sign in, pay, see their site or attach a domain.

This is the first half of "monitors you can trust". It adds no database migration: probe state lives in the existing
`alert_state` table under keys `probe:<monitor>`, and the page itself goes through the existing alert machinery
(`worker/alerts.js`: one notification when it starts, a reminder every 6 hours, a notification when it clears).

## The rule that never bends

A monitor is **ok only when every step was positively confirmed.** An exception, a timeout, an unexpected status code, a
body that is not what was expected, a missing marker: each is a failure. Nothing is reported ok by default, and these
states are all different and none of them is ok:

| Status (staff tile) | Meaning |
|---|---|
| Passing | The latest probe confirmed every step. The only healthy state. |
| Failing | The latest probe failed. The reason is a code such as `canary_http_500`. It pages once it has failed `SYNTHETIC_FAILURE_THRESHOLD` times in a row. |
| Stale | No probe result for longer than `SYNTHETIC_STALE_MINUTES`. Treated as a failure and paged: a monitor that stopped reporting must not look healthy. |
| Unknown | Configured but never probed yet. Not healthy. |
| Blocked | Checkout only: sign-in is failing, so checkout could not be tried. Leaves the checkout failure count alone. |
| Skipped | Configured, but deliberately not run (checkout against a live Stripe key without permission). Never paged, never ok. |
| Not configured | A setting is missing (the tile names the setting, never its value). Under `on` this is also a production config-check issue (a coverage gap). |
| Off | `SYNTHETIC_MONITORS=off`: nothing is probed. |

Only reason **codes** ever leave a probe. The monitor password, cookies, checkout URLs, response bodies and error messages are
never logged, stored, shown on the staff page or sent in a page.

## Flag

`SYNTHETIC_MONITORS` (declared `"off"` in `wrangler.jsonc`):

- `off` (default, also unset or invalid): nothing is probed or written.
- `shadow`: probes run and are recorded and shown on the staff Alerts page, but **nothing is paged**. Use this first.
- `on`: failures page through the alert channel.

Turn it on in steps: configure the settings, run in `shadow`, watch the staff tile for a day (every monitor should read
Passing, or Skipped by choice), then set `on`.

## What each probe does, and does not, prove

### Sign-in (`synthetic_signin`)
Does: `POST /api/customer/login` as the monitor account, expects 200 with `success: true` and a non-empty session cookie,
then `GET /api/organizations` with that cookie (and confirms the monitor organization is in the list), then
`POST /api/customer/logout` (always attempted, so no session is left behind).
Does not prove: that sign-in works from a browser (no JavaScript, no Turnstile, no passkey or MFA), from other regions, or for
any account other than the monitor account.

### Test-mode checkout (`synthetic_checkout`)
Does: with the sign-in session, `POST /api/organizations/:id/billing/checkout` for `SYNTHETIC_CHECKOUT_PLAN_ID` and expects a
Stripe checkout session with an `https` URL. It **creates a session; nothing is ever paid** and the session expires by itself.
Does not prove: that a card can be charged, that webhooks arrive, or that a subscription becomes active. It never opens the
checkout URL.
Safety: it runs only against a Stripe **test-mode** key (`sk_test_`/`rk_test_`). With a live key it is **Skipped** unless
`SYNTHETIC_CHECKOUT_ALLOW_LIVE=yes`, and an unrecognised or missing key is also Skipped. It also depends on sign-in: if
sign-in fails it is Blocked, never ok.

### Canary customer site (`synthetic_canary_site`)
Does: fetches `SYNTHETIC_CANARY_URL` (https only, no redirects followed) and expects HTTP 200 **and** the owner-chosen
`SYNTHETIC_CANARY_MARKER` text in the page. The marker is what stops a generic error or parking page from counting as up.
Does not prove: that every customer site is up, only that the tenant serving path works for this one site.

### Domain attach readiness (`synthetic_domain_attach`)
Does: checks that the Cloudflare API credentials work and that the Cloudflare for SaaS fallback origin reports `active`; if
`SYNTHETIC_DOMAIN_RESOURCE_ID` is set, also that the owner's permanent canary custom hostname still reports `active`.
Does not prove: that a **new** custom hostname can be created, validated and issued a certificate. It deliberately does not
create and delete a hostname on every run (that would churn Cloudflare for SaaS quota and leave orphans on failure). A real
create-and-delete cycle is an owner decision (see PLACEHOLDERS.md).

## Settings

| Setting | Kind | Default | Meaning |
|---|---|---|---|
| `SYNTHETIC_MONITORS` | var | `off` | `off`, `shadow` or `on`. |
| `SYNTHETIC_BASE_URL` | var | `PORTAL_BASE_URL` | https base the sign-in and checkout probes call. |
| `SYNTHETIC_SIGNIN_EMAIL` | var | none | The monitor account's email. |
| `SYNTHETIC_SIGNIN_PASSWORD` | **secret** | none | The monitor account's password. `wrangler secret put`, never a var. |
| `SYNTHETIC_ORGANIZATION_ID` | var | none | The monitor organization (checkout, and the membership check). |
| `SYNTHETIC_CHECKOUT_PLAN_ID` | var | none | An active plan with a price, used only to create a test-mode session. |
| `SYNTHETIC_CHECKOUT_ALLOW_LIVE` | var | `no` | `yes` lets the checkout probe run with a **live** Stripe key. Leave `no` unless the owner decides otherwise. |
| `SYNTHETIC_CANARY_URL` | var | none | https URL of the canary customer site. |
| `SYNTHETIC_CANARY_MARKER` | var | none | Text that must appear in the canary page. |
| `SYNTHETIC_DOMAIN_RESOURCE_ID` | var | none | Optional: id of the permanent canary custom hostname to also check. |
| `SYNTHETIC_FAILURE_THRESHOLD` | var | `2` | Consecutive failed probes before paging (1 to 10). Two avoids paging on one network blip. |
| `SYNTHETIC_STALE_MINUTES` | var | `20` | Minutes without a result before the monitor counts as stale (10 to 120). |

Domain attach also needs the existing `CF_API_TOKEN`, `CF_ACCOUNT_ID` and `CF_ZONE_ID`.

## The monitor account's requirements

Create a dedicated customer account and organization used for nothing else:

1. A normal customer user with a long random password, stored only as the Worker secret `SYNTHETIC_SIGNIN_PASSWORD`.
2. **No two-factor, no passkey requirement.** The probe cannot answer an MFA challenge. If MFA or the organization 2FA policy
   (`ORG_SECURITY_POLICY=enforce`) blocks the account, sign-in fails with `login_mfa_required` or
   `login_org_2fa_enrollment_required`. That is a failure, not a pass.
3. An organization the user belongs to, that is **not already subscribed** (checkout refuses a second subscription with
   `checkout_http_409`) and not covered by an IP allowlist that excludes the Worker.
4. **Customer-login Turnstile must be off** (`CUSTOMER_TURNSTILE_REQUIRED=off`). The probe cannot solve a challenge, so with it on
   sign-in and checkout fail on every run (`login_http_422`). `config-check` names this conflict when monitors are `on`. No
   bypass was built; how to handle it is an owner decision (see PLACEHOLDERS.md).
5. Use a Stripe **test-mode** key for the checkout probe, or leave it Skipped.
6. Exclude the monitor organization from revenue, marketing and trial reports, and from any "customers" count.

The probes call the control plane's own public URL from inside the Worker. If a WAF rule, Cloudflare Access policy or rate limit
blocks that request, the probe fails with an HTTP status code (never ok). Allow-list accordingly.

## Staff view

`/platform/saas/alerts` shows a "Synthetic monitors" tile: each monitor's status, reason code, failures in a row, last probe and
last pass. A monitor that was never probed reads **Unknown**, never ok.

## Reading a page

A page names the monitor and a reason code, for example `Reason: canary_http_500. 2 failed probes in a row since <time>`.
Common codes: `login_http_401` (wrong or changed password), `login_mfa_required`, `login_org_2fa_enrollment_required`,
`login_http_422` (Turnstile), `session_check_http_*`, `monitor_organization_missing`, `checkout_http_409` (already
subscribed), `checkout_http_500` (provider or billing error), `canary_http_*`, `canary_marker_missing`,
`domain_fallback_origin_*`, `domain_canary_hostname_*`, `domain_cloudflare_error`, `*_timeout`, `*_request_failed`,
`probe_exception`. A "No probe result for N minutes" page means the **monitor itself** stopped (scheduler, database or Worker
trouble): check the Cron Trigger or external pinger and the logs first.

## Recovery

1. **Sign-in or checkout failing:** open the staff tile for the reason code. Check the monitor account (password rotated?
   MFA or organization 2FA added? subscribed? Turnstile on? IP allowlist?). Fix the account or the setting; the next tick passes.
2. **Canary failing:** open the canary URL yourself. A 200 without the marker means the site is serving something else.
3. **Domain attach failing:** check the Cloudflare for SaaS fallback origin and the canary hostname in the dashboard.
4. **Stale:** the probes did not record. Confirm the Cron Trigger or the pinger on `/api/ops/alert-check` is running.
5. A page resolves on its own after the first passing probe: one "resolved" notification is sent.
6. To stop paging while you fix something, set `SYNTHETIC_MONITORS=shadow` (still recorded, never paged), not `off`.

If both a Cron Trigger and an external pinger call the check, probes run once per call. That doubles the probe rate but is safe.

## Not covered (later or never)

Runbooks and restore drills are Round 6.5B; load tests and SOC 2 drafts are 6.5C. A live end-to-end through a browser, the
public hostname from outside Cloudflare, and a real domain-attach create-and-delete cycle are **not verified** here.
