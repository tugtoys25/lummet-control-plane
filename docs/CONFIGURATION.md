# Configuration reference (control plane)

Two places: **`wrangler.jsonc` `vars`** (not secret) and **secrets** (`wrangler secret put NAME`; local copy in `.dev.vars`,
see `.dev.vars.example`). `node scripts/check-config.mjs` lists what is missing; `--online` also tests the Cloudflare token.
In production the staff overview and the `config_incomplete` alert report missing names (never values).

## Required for production

| Name | Kind | What it is | Breaks without it |
|---|---|---|---|
| `CREDENTIAL_KEK` | secret | 32 random bytes, base64 (`openssl rand -base64 32`) | stored secrets cannot be encrypted |
| `PORTAL_BASE_URL` | var | public URL of this control plane | no verification, reset or invitation emails; wrong links |
| `PLATFORM_DOMAIN_SUFFIX` | var | customer sites live at `<slug>.<suffix>` | sites get the default `sites.lummet.app` address |
| `CF_API_TOKEN` | secret | Cloudflare token (permissions in `.dev.vars.example`) | nothing can be provisioned, deployed or connected |
| `CF_ACCOUNT_ID` | secret/var | Cloudflare account id | same |
| `CF_ZONE_ID` | secret/var | zone id of `PLATFORM_DOMAIN_SUFFIX` | site routes fail; it also protects that zone from being claimed as a customer domain |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | secret | billing | checkout fails; webhooks rejected |
| `EMAIL_PROVIDER` (`resend`), `RESEND_API_KEY`, `EMAIL_FROM` | var, secret, var | outgoing email | queued emails are never sent (including "your domain is live") |
| `ALERT_CHECK_TOKEN` | secret | bearer token for `POST /api/ops/alert-check` | the maintenance tick cannot run unless a Cron Trigger exists: no alert checks, job and webhook retries, backups **or custom domain progress** |
| `ALERT_WEBHOOK_URL` or `ALERT_EMAIL` | secret/var | where alerts go | alerts never reach a human |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | var | passkeys | passkeys fail |
| `CSP_MODE` | var | `report-only` then `enforce` | `report-only` does not block injected scripts |
| `ENVIRONMENT` | var | `production` (or `staging`, `development`) | the Stripe livemode guard cannot tell test events from live ones; strict checks do not run |
| `BILLING_ENFORCE` | var | rollout flag: `off`, then `shadow`, then `enforce` (see `docs/CHANGES_PHASE_1.md`) | the lifecycle rollout state is undefined; a bad value behaves as `off` |
| `STRIPE_API_VERSION` | var | pin, e.g. `2024-06-20`; create the Stripe webhook endpoint on the same version | the API version is not pinned by configuration (code falls back to `2024-06-20`) |
| `BILLING_TRIAL_DAYS_DEFAULT` | var | trial length in days for every plan that offers a trial (empty or 0 = each plan's own `trial_days`); drives the pricing page, billing page, Checkout and the no-card trial | each plan's own trial length applies |
| `COOKIE_BANNER` | var | `on` (default) or `off`: cookie consent banner on the public site, sign-in pages and dashboard; its words and links are Interface text, group `cookies` | banner stays as configured |
| `COOKIE_CONSENT_DAYS` | var | days a visitor's cookie choice is remembered (1 to 400, default 180) | 180 days |
| `BILLING_GRACE_DAYS` | var | days a failed payment stays usable before `restricted` (14) | undefined grace period |
| `BILLING_RESTRICTED_DAYS` | var | days `restricted` (read-only, sites live) lasts before `suspended` (7); also how long an expired trial stays live | undefined restricted period |
| `BILLING_SUSPENDED_DAYS` | var | days `suspended` lasts before `closed` (30) | undefined suspended period |
| `BILLING_EMAILS` | var | billing email rollout flag: `off` (default, inert), `shadow` (decisions logged, nothing sent), `on` (emails queued). See `docs/CHANGES_PHASE_2_1.md` | a bad value behaves as `off`; production requires it to be set explicitly |
| `RESEND_WEBHOOK_SECRET` | secret | Svix signing secret of the Resend webhook (`whsec_...`) for `POST /api/email/webhook/resend`; required once `BILLING_EMAILS=on` | bounces and complaints are not recorded; the endpoint answers 503 |
| `BILLING_EMAIL_FROM` | var (optional) | verified sender for billing mail, e.g. `Lummet Billing <billing@yourdomain.com>`; defaults to `EMAIL_FROM` | billing mail uses `EMAIL_FROM` |
| `BILLING_EMAIL_REPLY_TO` | var (optional) | reply-to address on billing mail | no reply-to header |
| `BRAND_NAME` | var (optional) | product name in billing mail (default `Lummet`) | `Lummet` |
| `BILLING_REMINDER_DAYS` | var | days before a trial end, renewal, grace end, cancellation or deletion that a reminder goes out, e.g. `3,1` (v2.2.1) | defaults to `3,1` |
| `BILLING_RENEWAL_NOTICES` | var | `yearly` (default, annual plans only), `all`, or `off`: which renewals get a "renews soon" email | a monthly customer may get an extra email each month (`all`) |
| `BILLING_WINBACK_EMAILS` | var | `off` (default) or `on`: promotional win-back mail. Keep `off` until an unsubscribe path exists | none while off; no trigger sends win-back in v2.2.1 even when `on` |
| `TRIAL_FINGERPRINT_SALT` | secret (optional) | salt for the stored card and business-domain trial hashes (`openssl rand -base64 24`). Set once and never change it: changing it makes earlier hashes unmatchable | trial hashes are unsalted (still hashes, but guessable from a list of domains) |
| `PUBLIC_TRUST_PAGES` | var | `off` (default), `shadow` or `on`; set explicitly for production. `off`: `/status`, `/security`, `/changelog`, `/contact-sales` and `/.well-known/security.txt` are inert (legacy behaviour kept, including a CMS page at `/security`). `shadow`: the four pages render for owner review (noindex, preview notice, `[OPEN]` markers, no outbound status link); `security.txt` is not served. `on`: live pages without `[OPEN]` markers, and `security.txt` is served | trust-page rollout is not explicitly configured or is invalid |
| `PUBLIC_LEGAL_PAGES` | var | `off` (default), `draft` or `on`; set explicitly for production. `off`: `/legal` and `/legal/*` behave as unknown paths. `draft`: skeleton pages watermarked "DRAFT FOR COUNSEL", `noindex`, never cached, every clause an `[OPEN]` placeholder (for owner and counsel review only). `on`: a page is published only for a market whose counsel approval is recorded for that exact page (see below). Lummet supplies no legal wording. |
| `LEGAL_MARKET_BY_HOST` | var (JSON) | Required when `PUBLIC_LEGAL_PAGES=on`. Maps request host to market id, e.g. `{"www.example.com":"uk"}`. Market ids match `[a-z0-9_-]{1,64}`. |
| `LEGAL_COUNSEL_APPROVALS` | var (JSON) | Required when `PUBLIC_LEGAL_PAGES=on`. Recorded approvals per market and page: `{"uk":{"terms":{"approvedBy":"<counsel name or firm>","approvedAt":"2026-11-01T10:00:00Z"}}}`. A page with no entry, a blank `approvedBy`, an invalid or future `approvedAt` is not published. Pages: terms, privacy, dpa, subprocessors, sla, refunds, acceptable-use, cookies. |
| `STATUS_PROVIDER_URL` | var | HTTPS URL of the external status provider linked from `/status` (owner-verified) | `/status` cannot link to the authoritative provider |
| `SECURITY_CONTACT` | var | security.txt contact: `mailto:security@yourdomain` or an HTTPS reporting URL | vulnerability reports have no configured destination; security.txt answers 503 |
| `SECURITY_TXT_EXPIRES` | var | RFC 3339 timestamp in the future, e.g. `2027-01-01T00:00:00Z`; renew before it passes | security.txt is invalid or stale; it answers 503 once expired |

**Prices are not configuration (v2.3.0).** They live in `catalog/plans.v1.json` and reach the database through
`scripts/stripe-sync.mjs` (see `docs/CHANGES_PHASE_3_1.md`). No variable sets or overrides a price. Two existing variables
matter to the sync: `STRIPE_SECRET_KEY` (its prefix, `sk_`/`rk_` + `test`/`live`, is the Stripe mode; checkout refuses a
price stamped with the other mode) and `STRIPE_API_VERSION`. The sync reads the key from the environment, never from a flag.

**Trust pages (v2.6.0.4).** These four settings are production-required even while `PUBLIC_TRUST_PAGES=off`. Use owner-approved values only. `/contact-sales` reuses the published `contact` form and the existing `PUBLIC_FORMS_TURNSTILE_REQUIRED` setting (Turnstile stays opt-in and needs both `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`). Move to `on` only after every Round 6.2A `[OPEN]` item in `docs/PLACEHOLDERS.md` is closed.

Bindings (in `wrangler.jsonc`): `LUMMET_DB` (D1), `AI`, `BACKUPS` and `TENANT_TEMPLATES` (R2), `ASSETS`; optional
`JOB_QUEUE` (Queue).

## Optional

| Name | Default | Meaning |
|---|---|---|
| `DOMAIN_NS_PENDING_DAYS` | 7 | days a customer has to change nameservers before the claim is released |
| `DOMAIN_NS_REMINDER_HOURS` | 24 | one reminder email after this long without a nameserver change |
| `DOMAIN_ACTIVATION_CHECK_MINUTES` | 60 | minimum gap between "re-check now" requests to Cloudflare, per domain |
| `DOMAIN_ATTACH_GIVE_UP_HOURS` | 24 | a hostname that will not connect or serve HTTPS this long after activation fails |
| `DOMAIN_MANUAL_CHECK_SECONDS` | 20 | minimum gap between a customer's "Check now" presses |
| `PLATFORM_CNAME_TARGET` | `customers.<PLATFORM_DOMAIN_SUFFIX>` | what a customer's CNAME must point at for a single subdomain; must be the SaaS fallback origin |
| `SUBDOMAIN_CNAME_FLOW` | on | set to `off` to disable connecting subdomains by CNAME (subdomains inside a delegated zone still work) |
| `STAFF_2FA_REQUIRED` | false | require two-factor sign-in for staff |
| `CREDENTIAL_KEK_PREVIOUS`, `STRIPE_WEBHOOK_SECRET_PREVIOUS` | unset | only during a rotation |
| `BILLING_SUSPEND_SITES` | off | `off`, `shadow`, then `enforce` controls the signed tenant-edge state push. Legacy value `on` is accepted as an alias for `enforce`. `shadow` logs would-be site gating without changing the site state. `enforce` makes the lifecycle sweep set a customer's sites to `suspended` when the organization is suspended or closed for non-payment. Leave off until the signed tenant-edge gate passes staging restore, retry and outage acceptance tests |
| `STRIPE_RETRY_BASE_MS` | 250 | base of the jittered backoff for Stripe retries (tests set it to 0) |
| `TENANT_TURNSTILE_SITEKEY`, `TENANT_TURNSTILE_SECRET` | unset | Turnstile on the sites' own login pages |
| `TENANT_COMPAT_DATE` | `2026-01-01` | Workers compatibility date for uploaded tenant sites (match `lummet-tenant/wrangler.jsonc`) |
| `CF_WORKERS_DEV_SUBDOMAIN` | `workers` | your `workers.dev` subdomain (first health check only) |
| `INQUIRY_WEBHOOK_URL` | unset | forward public contact/demo submissions |
| `WEB_SEARCH_ENDPOINT`, `WEB_SEARCH_API_KEY` | unset | staff AI assistant web search |
| `OUTBOUND_DNS_CHECK`, `OUTBOUND_DNS_RESOLVER` | on | private-address check for customer webhook/SSO hostnames |
| `LOG_REQUESTS`, `SLOW_REQUEST_MS` | false, 2000 | structured request logging |
| `CONTACT_EMAIL` | empty | shown on the public site |
| `LOADTEST_PASSWORD`, `LUMMET_STAFF_COOKIE` | unset | load testing / tests only; never in production |

## Cloudflare setup that is not an environment variable

* A **proxied wildcard DNS record** `*.<PLATFORM_DOMAIN_SUFFIX>` in the platform zone (DEPLOYMENT.md).
* The **API token** with Zone Edit and DNS Edit for custom domains (list in `.dev.vars.example`).
* For single subdomains: **Cloudflare for SaaS** on the platform zone and a **fallback origin** (`node scripts/setup-custom-hostnames.mjs`).
* A zone allowance on the account that fits the number of customer domains you expect.

## v2.3.4 site access gate and staging

- `BILLING_SUSPEND_SITES=off|shadow|enforce` defaults to `off`; legacy `on` remains an alias for `enforce`. In `shadow`, would-be site gate actions are logged without changing site status.
- `STRIPE_TAX_ENABLED=false` by default. Do not enable automatic tax until the operating model and registrations are approved.
- `X-Test-Now` is honoured only when `ENVIRONMENT=staging`; production ignores it.
- Staging uses `env.staging` with a separate Worker, D1, R2 buckets and Queues. Set the GitHub environment secret `STAGING_D1_DATABASE_ID` to the actual D1 ID and configure `STAGING_STRIPE_SECRET_KEY` (`sk_test_...`) and `STAGING_STRIPE_WEBHOOK_SECRET` (`whsec_...`) before deployment.
- The CI workflow records a bookmark from the Cloudflare D1 Time Travel bookmark API in `d1-time-travel-bookmark.json`; the workflow must succeed before production deploy. Treat the bookmark as rollback evidence and verify the restore path separately.

Owner decisions intentionally unchanged: `workers_dev` remains enabled in the base configuration; `CONTACT_EMAIL` remains its existing value. Confirm both before release.


## Phase 4 preparation-only Stripe clock suite

`STRIPE_CLOCK_ENVIRONMENT=staging`, `STRIPE_CLOCK_PRICE_ID` and `STRIPE_CLOCK_LUMMET_STATE_URL` are required only when manually invoking `scripts/stripe-clock-suite.mjs`; they are not production Worker bindings. `STRIPE_CLOCK_LUMMET_STATE_TOKEN` is optional and should be a staging-only token. The suite refuses keys other than `sk_test_`/`rk_test_` and refuses a custom API base. Never set these to production values. See `docs/STRIPE_SETUP.md`.


## Phase 5 commercial surface

- `CUSTOMER_TURNSTILE_REQUIRED`: `off` by default; set to `on` only after the site and secret keys are configured and staging verification succeeds. When enabled, customer signup/login fail closed if verification is missing or unavailable; the CSP permits the Turnstile origin only when enforcement and both keys are present. Never put the secret key in a public variable or repository. `TURNSTILE_SITE_KEY` is public and may be rendered on the customer login/signup page.
- `STAFF_TURNSTILE_REQUIRED`: `off` by default; set in `wrangler.jsonc` (not the console, so a wrong value cannot lock staff out). `on` adds Turnstile to the staff sign-in once `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` are set; without both keys it stays off. Break-glass: set it to `off` and deploy. `CUSTOMER_TURNSTILE_REQUIRED` also covers customer forgot-password. Console toggles for the customer pages and the public forms take effect on the next request.
- `TENANT_RESEND_API_KEY` / `TENANT_RESEND_FROM_EMAIL`: optional. Sites send mail through the control plane's own `RESEND_API_KEY` and `EMAIL_FROM` (when `EMAIL_PROVIDER` is `resend`); set these two only to give sites their own Resend key or sender. Passed to each site on deploy, so existing sites pick them up on their next deploy or rollout.
- `BILLING_ENFORCE`: existing rollout flag remains authoritative; Phase 5 does not turn it on automatically.
- Storage quota: the tenant migration `0006_storage_metering.sql` adds `platform_storage_limits`. `STORAGE_METERING_MODE` is `off` by default; use `shadow` to compute would-exceed decisions without blocking, then `enforce` only after migration and a trusted control-plane-to-tenant sync sets `max_bytes`. An absent limit is not inferred; enforce mode refuses uploads if the limit cannot be verified.
- Add-on catalog entries and credit packs are inactive by default. Populate `addons` / `credit_packs` only after Stripe price IDs, currency, tax behavior and entitlement keys are verified in staging.
- Quotes are not self-executing. Acceptance records intent only; it does not provision entitlements or assert that an invoice has been paid.


## Reproducible dependency and release-owner gates (v2.5.1)

- Run `node scripts/lockfile-check.mjs` before installing. It rejects a root-only/stub graph, dependency omissions, and version drift. Regenerate only with `node scripts/regenerate-lockfiles.mjs`; that invokes npm's lockfile generator and must have registry access. Never hand-write a lockfile. Run `npm ci --no-audit --no-fund` after regeneration.
- The tenant repository has equivalent scripts at `lummet-tenant/scripts/lockfile-check.mjs` and `regenerate-lockfiles.mjs`; they check both the tenant release-tools root and `en/` Worker root.
- `docs/release-owner.json` is the single source of truth for GitHub code ownership. The owner is intentionally empty until supplied by the repository owner. After setting a real `@user` or `@org/team`, run `node scripts/check-release-owner.mjs --generate`, then `node scripts/check-release-owner.mjs --owner-only`. Do not invent an owner.
- Release packaging runs the full ownership/placeholder gate. It fails while `@OWNER` or any `[OPEN]` item remains in `docs/PLACEHOLDERS.md`. `--development-check` is only for local/PR static packaging and never makes a release package releasable.
- Human-only GitHub setup: in repository Settings, configure branch protection/rulesets for `main`, require pull requests and code-owner review, require the applicable CI checks, and protect the `staging` and `production` environments with required reviewers. These settings cannot be proven from the repository and remain owner-run.
- Test runner variables: `TEST_FILE_TIMEOUT_MS` controls per-file timeout; `TEST_FILTER` selects matching test paths for focused runs; `TEST_FORCE_EXIT_ALLOWLIST` is an explicit comma-separated list of test paths permitted to use Node's force-exit fallback. The default allow-list is empty; any forced exit fails the suite and is reported separately.


- `PUBLIC_FORMS_TURNSTILE_REQUIRED`: `off` by default. Set to `on` only after Turnstile site/secret keys are configured and contact/demo have been verified in staging. When enabled, `/contact` and `/demo` fail closed on a missing token, bad token, hostname mismatch, missing keys, or verification outage. Custom `/forms/:key` forms are not covered by this flag. The public-site CSP allows only `https://challenges.cloudflare.com` for script/connect/frame on those two routes when the flag and both keys are present. Never commit the secret key.

- `BILLING_SAVE_FLOW`: `off` by default. When `on`, admin users can request a subscription pause with an explicit provider-side resume timestamp. The current Stripe adapter uses `pause_collection[behavior]=void`; confirm the desired pause billing behavior and customer-facing terms with the owner before enabling.

### Phase 5.4/5.6/5.7 additions (v2.5.2.4)

| Variable | Type | Default | Purpose |
|---|---|---|---|
| `FOUNDER_LICENSE_ENABLED` | var | `off` | Enables the owner-approved Founder License invoice flow; keep off until commercial terms and counsel approval exist. |
| `PLATFORM_DOMAIN_SUFFIX` | var | none | Production-required tenant hostname suffix; must not be a workers.dev/localhost value in production. |
| `FOUR_EYES_THRESHOLD_CENTS` | var | unset/0 | Owner-set threshold for second-staff approval of refunds/credits. Unset fails closed to requiring approval for every such action. |
| `BILLING_SAVE_FLOW` | var | `off` | Customer save-flow rollout flag. Existing pause/cancel routes remain inert until explicitly enabled. |

Storage limits are synced from control-plane entitlements to the tenant Super API; the tenant reports measured bytes back through the same authenticated boundary. Unknown storage remains unknown rather than becoming zero.

| `REVENUE_ANALYTICS` | var | `off` (production), `shadow` (staging) | Phase 6.1C staff revenue analytics. `off`: the page shows a disabled notice and the CSV returns 404. `shadow` and `on`: read-only cohort, funnel, ARPA, deferred-revenue and margin views for super-admin staff (identical behaviour; `shadow` marks definitions as not yet validated). Unset or invalid reads as `off`; `config-check.js` flags an invalid value. Never changes the daily MRR/ARR job. |
| `ORG_SECURITY_POLICY` | var | `off` | Round 6.4A organization security policy (org-wide 2FA). `off` (default, also for unset or invalid): nothing is read or blocked and `GET`/`PUT /api/organizations/:id/security-policy` answer 404. `shadow`: the policy can be set and read; nothing is blocked. `enforce`: a member of an organization that requires 2FA, with no active authenticator factor, gets a restricted session (only `/api/customer/2fa/*` and logout work; everything else answers 403 `org_2fa_required`; sign-in answers `twoFactorEnrollmentRequired`). Only an owner can change the policy, with a reason. `config-check.js` refuses an invalid value in production. Do not set `enforce` before OPEN_ITEMS_v2.6.0.9.md items 1 to 3 are answered. |
| `CUSTOMER_SESSION_ADMIN` | var | `off` | Round 6.4B organization session list and revoke. `off` (default, also for unset or invalid): `GET /api/organizations/:id/sessions` and `POST /api/organizations/:id/sessions/revoke` answer 404. `shadow`: the list works and a revoke is a dry run (nothing is deleted; the response says `wouldRevoke`; an audit row is written). `on`: a revoke deletes the session rows and the very next request with that cookie is unauthenticated. Admin or owner only; a revoke needs a written reason and is audited; an admin cannot end an owner's session; nobody can end their own current session this way (use logout). `config-check.js` refuses an invalid value in production. |
| `CUSTOMER_AUDIT_CSV` | var | `off` | Round 6.4B organization audit-log CSV. `off` (default, also for unset or invalid): `GET /api/organizations/:id/audit-log.csv` answers 404. `on`: admin or owner only; one page per request (`limit`, default 1000, at most 5000; `cursor` is the previous response's `X-Next-Cursor`); cells are escaped and formula-injection safe; every export, and every refused attempt, is audited. `config-check.js` refuses an invalid value in production. |
| `CUSTOMER_2FA_ENROLL_PAGE` | var | `off` | Release 2.6.0.16 customer authenticator enrollment page. `off` (default, also unset or invalid): `GET /app/security/2fa` is not served, as for any unknown `/app` path (a restricted session still gets the existing 403 notice, without a link). `on`: the page is served to any signed-in customer, including a session an organization policy restricts, and drives the existing `/api/customer/2fa/*` routes. No new API, no migration. Needed before `ORG_SECURITY_POLICY=enforce` unless the owner accepts API-only enrollment. |
| `PASSWORD_HASH_FORMAT` | var | `legacy` | Release 2.6.0.17. `legacy` (default, also unset or invalid): new password hashes are written as before (`<saltHex>:<hashHex>`, PBKDF2-SHA256, 100,000 iterations). `v2`: new hashes are written as `pbkdf2-sha256$<iterations>$<salt>$<hash>` and a correct login rewrites an older hash in that format. Verification always accepts both. **Rollback hazard:** a build older than 2.6.0.17 cannot verify v2 hashes. |
| `PASSWORD_HASH_ITERATIONS` | var | `100000` | Target cost for v2 hashes, integer 10000 to 100000. Cloudflare Workers documents 100,000 as the PBKDF2 ceiling (not verified in this release), so this cannot raise strength on Workers today; any other value is ignored. |
| `ORG_IP_ALLOWLIST` | var | `off` | Round 6.4C organization IP allowlist. `off` (default, also unset or invalid): nothing is read or blocked, and `GET`/`PUT /api/organizations/:id/ip-allowlist` answer 404 (the staff clear route always works). `shadow`: lists can be set and read; a request that would be denied is only logged (`org_ip_allowlist_would_deny`, no address, no list). `enforce`: a request to an organization whose stored list excludes the client address answers 403 `ip_not_allowed` (`/app/*` shows a plain notice). The client address is `CF-Connecting-IP` only; `X-Forwarded-For`, `X-Real-IP`, `Forwarded` and `True-Client-IP` are ignored; an unreadable address is denied. Enforced per organization, and only while the plan has entitlement `security.ip_allowlist.enabled` (granted to no plan until the owner answers OPEN_ITEMS_v2.6.0.11.md question 1). Lockout recovery: setting `shadow` or `off` lifts every denial at once; staff `POST /api/platform/saas/organizations/:id/ip-allowlist/clear`; a lapsed plan stops enforcement. `config-check.js` refuses an invalid value in production. |
| `ORG_SSO_REQUIREMENT` | var | `off` | Round 6.4C SSO requirement STUB. `off` (default, also unset or invalid): `PUT /api/organizations/:id/sso-requirement` answers 404. `shadow`: an owner can record that SSO is required (reason, audit); the answer says `enforced: false, status: "stub_no_idp"`. There is no `enforce`: no identity provider is named (BLOCKED), and enforcing would lock every member out. `config-check.js` refuses any other value in production. |
| `IP_ALLOWLIST_MAX_ENTRIES` | var | `50` | Round 6.4C: most entries one organization allowlist may hold (a bare address or a CIDR is one entry). Whole number 1 to 999; values above 200 are clamped to 200; unset or invalid means 50. |
| `SYNTHETIC_MONITORS` | var | `off` | Round 6.5A synthetic monitors (sign-in, test-mode checkout, canary site, domain attach readiness). `off` (default, also unset or invalid): nothing is probed or written. `shadow`: probe and record, shown on the staff Alerts page, never paged. `on`: failures page through the existing alert channel. `config-check.js` refuses an invalid value in production and, under `on`, names every monitor that cannot run (coverage gap). See `docs/SYNTHETIC_MONITORS.md`. |
| `SYNTHETIC_BASE_URL` | var | `PORTAL_BASE_URL` | Round 6.5A: https base URL the sign-in and checkout probes call. |
| `SYNTHETIC_SIGNIN_EMAIL` | var | none | Round 6.5A: the monitor account's email (no MFA, not a real customer). |
| `SYNTHETIC_SIGNIN_PASSWORD` | secret | none | Round 6.5A: the monitor account's password. A Worker secret (`wrangler secret put`), never a var; never logged, stored or shown. |
| `SYNTHETIC_ORGANIZATION_ID` | var | none | Round 6.5A: the monitor organization used for the checkout probe and the membership check. |
| `SYNTHETIC_CHECKOUT_PLAN_ID` | var | none | Round 6.5A: an active plan with a price; used only to create a test-mode checkout session (nothing is paid). |
| `SYNTHETIC_CHECKOUT_ALLOW_LIVE` | var | `no` | Round 6.5A: `yes` lets the checkout probe run against a LIVE Stripe key. Default `no`: with a live key the checkout monitor is Skipped (never ok). `config-check.js` refuses a value other than yes or no. |
| `SYNTHETIC_CANARY_URL` / `SYNTHETIC_CANARY_MARKER` | var | none | Round 6.5A: https URL of the canary customer site and the text that must appear in its page. |
| `SYNTHETIC_DOMAIN_RESOURCE_ID` | var | none | Round 6.5A, optional: id of the owner's permanent canary custom hostname; when set, the domain probe also requires it to be active. |
| `SYNTHETIC_FAILURE_THRESHOLD` | var | `2` | Round 6.5A: consecutive failed probes before paging, 1 to 10. `config-check.js` refuses anything else in production. |
| `SYNTHETIC_STALE_MINUTES` | var | `20` | Round 6.5A: minutes without a probe result before a monitor counts as stale and pages, 10 to 120. `config-check.js` refuses anything else in production. |

### Phase 6.1C revenue analytics

- Super-admin only (`/platform/saas/revenue-analytics`, `/api/platform/saas/revenue-analytics/*`). Every CSV export and every finance-cost change is written to the audit log; a cost change requires a reason of 5 to 500 characters.
- Money is reported per currency and never added across currencies. Unknown is shown as `unknown`, never zero.
- Finance unit costs live in the existing `lummet_site_settings` table under `finance_unit_costs_by_tier`: a JSON object mapping each plan key to the monthly unit cost in integer cents, in that plan's currency. A plan with no entry, a corrupt setting, or a plan with any live subscription missing from the revenue ledger shows margin as `unknown`. An explicit `0` is a real zero cost.
- Definitions (confirm before relying on them, see OPEN_ITEMS): cohort month = month of an organization's first provider-confirmed `new` movement; NRR = current ledger MRR / cohort starting MRR; GRR = sum over organizations of min(current, starting) / starting (no expansion credit); logo churn = organizations with a churn movement and zero MRR now / organizations in the cohort; trial-to-paid = organizations whose trial has ended and that reached `active` by 14 days after the trial end / organizations whose trial has ended; activation = a live site and an active domain with active SSL, both created within 14 days of the organization, among organizations whose 14 days have closed; deferred revenue = paid invoices whose service period is 300 days or longer and still running, net of tax, recognized straight-line over the invoice's own period.
- Cohort CSV export is no-store, formula-injection safe, one row per cohort month and currency, newest 120 months at most.

**Legal pages and API docs (v2.6.0.5).** Counsel-approved text is NOT stored in variables (a Workers variable is limited to 5 KB). For each approved page create a published CMS page whose slug is `legal-<market>-<page>` (for example `legal-uk-terms`) containing the counsel-supplied text, then record the approval in `LEGAL_COUNSEL_APPROVALS`. Text that still contains `[OPEN` or `DRAFT FOR COUNSEL` is never published. `/docs` and `/openapi.json` follow `PUBLIC_TRUST_PAGES` (`off` = unknown path, `shadow` = `noindex` preview, `on` = live). `PUBLIC_LEGAL_PAGES` must be set explicitly in production; `LEGAL_MARKET_BY_HOST` and `LEGAL_COUNSEL_APPROVALS` are production-required only when it is `on`. The alert checks `trial_expired_still_live` and `webhook_lag` need no new settings (see `docs/ALERTING.md`).

**Edge rate limiting (v2.6.0.6).** `RATE_LIMIT_RETRY_AFTER` (`off` default, `on`) adds `Retry-After` to the Worker's own 429 responses. `CF_WAF_ZONE_ID`, `CF_WAF_MAX_RULES`, `CF_WAF_ALLOWED_PERIODS`, `CF_WAF_MAX_TIMEOUT` and `WAF_THRESHOLDS_CONFIRMED=yes` are production-required: they record the owner's zone, Cloudflare plan limits and confirmed thresholds, and are read by `scripts/cloudflare-waf-rate-limit-config.mjs`. `WAF_RATE_LIMIT_THRESHOLDS` (JSON, optional) overrides rule thresholds. Script-only variables (not Worker settings): `CF_API_TOKEN`, `CF_WAF_ENVIRONMENT` (staging or production, must match `--mode`), `CF_WAF_CHANGES_APPROVED`. See `docs/WAF_RATE_LIMITS.md`.

**Cloudflare Access for platform routes (v2.6.0.7).** `PLATFORM_ACCESS_JWT_MODE` (`off` default, `shadow`, `enforce`; any other value is refused with 503) must be set explicitly in production. `off` changes nothing and never contacts Cloudflare. `shadow` verifies the Access JWT on `/platform/*` and `/api/platform/*` and only logs a reason code. `enforce` refuses (403) a missing or invalid JWT and answers 503 when `CF_ACCESS_ISSUER` or `CF_ACCESS_AUD` is invalid or the key set cannot be fetched. `CF_ACCESS_ISSUER` (`https://<team>.cloudflareaccess.com`) and `CF_ACCESS_AUD` (the Access application AUD tag) are production-required whenever the mode is not `off`. Staff sessions, 2FA and RBAC still apply. See `docs/CLOUDFLARE_ACCESS.md`.

**HSTS preload and CSP reporting (v2.6.0.8).** `HSTS_PRELOAD` (`off` default, `on`) must be explicit in production; `on` adds `preload` and a two-year max-age and also needs `HSTS_PRELOAD_APPROVED=yes` (owner approval, `[OPEN]`). `CSP_REPORT_MODE` (`basic` default, `full`) must be explicit in production; `CSP_REPORT_MAX_PER_MINUTE` (optional, default 60, 0 = unlimited) applies in `full`. `CSP_MODE` is unchanged and still defaults to report-only. See `docs/HSTS_PRELOAD.md` and `docs/CSP_REPORTING.md`.

**Error tracking, log redaction and audit stream (v2.6.0.8).** `ERROR_TRACKING` (`off` default, `shadow`, `on`), `LOG_REDACTION` (`off` default, `on`) and `AUDIT_LOG_STREAM` (`off` default, `on`) must each be set explicitly in production. `ERROR_TRACKING=on` also needs `SENTRY_DSN` (a Worker secret holding a public HTTPS tracker address) and `ERROR_TRACKING_APPROVED=yes` (owner approval, `[OPEN]`). `ERROR_TRACKING_MAX_PER_MINUTE` (optional, default 30, 0 = unlimited) and `ERROR_TRACKING_RELEASE` (optional label) tune it. `AUDIT_LOG_STREAM=on` requires `LOG_REDACTION=on`. See `docs/ERROR_TRACKING.md` and `docs/LOGPUSH.md`. Customer sites: `TENANT_CSP_MODE` (`off` default, `report-only`) and `TENANT_CSP_REPORT_URI` (optional) are tenant Worker variables, see the tenant repository's `docs/TENANT_CSP.md`.

**Runbooks and restore drill (v2.6.0.13, Round 6.5B).** No new Worker variable and no secret. `scripts/restore-drill.mjs` reads `CREDENTIAL_KEK` (and optionally `CREDENTIAL_KEK_PREVIOUS`) from the environment of the person running it, never from the Worker, and optionally `RESTORE_RTO_MINUTES` (a positive number of minutes; the same as `--rto-minutes`). `RESTORE_RTO_MINUTES` is read only by the script and is not checked by `config-check.js`; leave it unset while the restore-time objective is **[OPEN]**, and the report then says `unknown`. See `docs/runbooks/restore-drill.md`.
