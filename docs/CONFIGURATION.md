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
