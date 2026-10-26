# Go-live checklist

Everything the build environment could not do for you, in the order to do it.
Built from the code as it stands (every setting below is read somewhere in
`worker/`); anything not verified against real Cloudflare, Stripe, Resend or an
authenticator app is marked **[verify]**.

## 0. Decide the plan first

Several features need the **Workers Paid plan**. `wrangler.jsonc` records that
Cron Triggers are currently off, which suggests the Free plan.

| Feature | Free plan | Paid plan |
|---------|-----------|-----------|
| Cron Triggers (scheduled health checks, backups purge, alerts) | Not available | Available |
| Control-plane database backup (100+ queries per run) | Will fail (about 50 subrequests, tiny CPU budget) | Works **[verify]** |
| Password sign-ins (PBKDF2, CPU heavy) | May fail under any load (about 10 ms CPU) | Works **[verify]** |

Without cron you can still get alerting and backup ticks from an external
uptime monitor (see section 4), but the backup and sign-in limits are plan
limits. Budget for Workers Paid before real customers.

## 1. Create a staging environment (do this before production)

Separate Worker, separate D1 database, separate R2 buckets, separate Stripe
**test-mode** keys. The load test, backup verification, key rotation practice
and the 2FA app check all need it. Suggested `wrangler.jsonc` addition:

```jsonc
"env": {
  "staging": {
    "name": "lummet-control-plane-staging",
    "d1_databases": [{ "binding": "LUMMET_DB", "database_name": "lummet-control-plane-db-staging", "database_id": "<new id>" }],
    "r2_buckets": [
      { "binding": "BACKUPS", "bucket_name": "lummet-backups-staging" },
      { "binding": "TENANT_TEMPLATES", "bucket_name": "lummet-tenant-templates-staging" }
    ],
    "ai": { "binding": "AI" },
    "vars": { "ENVIRONMENT": "staging", "PORTAL_BASE_URL": "https://<staging-host>" }
  }
}
```

Then `wrangler secret put <NAME> --env staging` for each secret below, and
`node scripts/migrate.mjs --db lummet-control-plane-db-staging --remote`.

## 2. Configuration inventory

Bindings (already in `wrangler.jsonc`): `LUMMET_DB` (D1), `AI`, `BACKUPS` (R2),
`TENANT_TEMPLATES` (R2).

| Name | Kind | Needed for | If missing |
|------|------|-----------|------------|
| `CREDENTIAL_KEK` | secret, `openssl rand -base64 32` | Encrypting every stored secret, email bodies, DB backups | Nothing that stores a secret works. **Keep a copy outside Cloudflare.** |
| `CREDENTIAL_KEK_PREVIOUS` | secret, temporary | Only during a key rotation | n/a (see `KEY_ROTATION.md`) |
| `STRIPE_SECRET_KEY` | secret | Checkout, billing | Billing fails |
| `STRIPE_WEBHOOK_SECRET` | secret | Verifying Stripe events | Events rejected |
| `STRIPE_WEBHOOK_SECRET_PREVIOUS` | secret, temporary | Stripe secret rollover | n/a |
| `CF_API_TOKEN`, `CF_ACCOUNT_ID` | secret | Creating each customer's database, storage, Worker | Provisioning fails with an explicit error |
| `CF_ZONE_ID` | secret/var | Custom domains (SSL for SaaS) **and** each site's route | Domain verification fails; **deploys fail with an explicit message** |
| `CF_API_TOKEN` permission *Zone: Workers Routes: Edit* | token scope | Creating `<slug>.<suffix>` routes | Deploys fail at the routing step |
| `PLATFORM_DOMAIN_SUFFIX` | var | `<slug>.<suffix>` addresses for new sites | Falls back to `sites.lummet.app`, **a domain you probably do not own** |
| `CF_WORKERS_DEV_SUBDOMAIN` | var | Health check target before a custom domain | Defaults to `workers` |
| `PORTAL_BASE_URL` | var | Every emailed link | **Emails are not queued at all** |
| `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM` | var / secret / var | Sending email | Messages queue forever |
| `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN` | var | Passkeys for customers | Passkeys fail |
| `ALERT_WEBHOOK_URL` and/or `ALERT_EMAIL` | secret / var | Alerts reaching a human | **No alerts are sent** |
| `ALERT_CHECK_TOKEN` | secret | External pinger endpoint; also the only thing that drives failed-job retries and webhook retries without a Cron Trigger | Endpoint disabled (404); no retries |
| `STAFF_2FA_REQUIRED=true` | var | Forcing staff 2FA | Optional (see section 6) |
| `WEB_SEARCH_ENDPOINT`, `WEB_SEARCH_API_KEY` | secret | AI assistant web search | Feature off |
| `CONTACT_EMAIL` | var | Public homepage mailto link | Neutral text shown |
| `CSP_MODE` | var | `enforce` turns the script policy on (default: report only; see `CSP.md`) | Injected scripts are reported, not blocked; the configuration banner stays on |
| `OUTBOUND_DNS_CHECK` | var, optional | `off` disables the check that webhook and SSO hostnames do not resolve to private addresses | On by default in production |
| `TENANT_TURNSTILE_SITEKEY`, `TENANT_TURNSTILE_SECRET` | var / secret, both or neither | Turnstile on every site's own login and register pages (passed to each site on every deploy) | Sites have no Turnstile and rely on their attempt limiter |
| `LOG_REQUESTS`, `SLOW_REQUEST_MS` | var, optional | `all` logs every request; slow-request threshold (default 2000) | Failures and slow requests only |

## 2a. Configuration check (v7C)

With `ENVIRONMENT=production`, the staff SaaS overview shows a red banner naming every missing setting from the table
above, and the alert check reports it. Treat an empty banner as part of the go-live gate. `wrangler.jsonc` ships with placeholder ids only;
replace the D1 database id, `PORTAL_BASE_URL` and `CONTACT_EMAIL` before deploying.

## 2b. First administrator of each new site (v7G)

Customers set their own dashboard login from the portal (Content page > "Set dashboard password"): their portal email, role admin,
only a hash written into the site's database. No operator step. (The old `SETUP_TOKEN` procedure in `CHANGES_V7F.md` still works
but is no longer needed.) The Worker's `CF_API_TOKEN` must be allowed to query the site databases (D1 edit).

## 2c. Publishing annual plans and the pricing page (v7G)

Annual plans exist but are retired. For each one you want to sell: create the Stripe price, then Staff > Plans > "Stripe id",
check "Price", and "Reactivate". `/pricing` lists only active plans, so it shows nothing until you do (monthly plans are
already active). Review the public pricing words under public UI strings.

## 2d. Automations on tracking-link health (v7H)

The `tracking_link.unhealthy` trigger is fed by the maintenance tick, so it works only when the pinger (or a Cron Trigger) calls
`/api/ops/alert-check` regularly. Apply migration `0043`. The portal's Disable button works without the tick.

## 2e. Finding a failure (v7I)

Every response has an `X-Request-Id`; a failed page shows it as "quote this reference". Search the Worker logs for that id and open
Staff > Server errors. The `server_errors` alert (5+ in 15 minutes) needs the alert channel from section 2a. Apply migration `0044`.

## 3. Deploy order

1. Apply migrations to the target database: `node scripts/migrate.mjs --db <name> --remote`.
   This round added `0024` (coupon redemptions), `0025` (alert state), `0026`
   (control-plane backups), `0027` (staff 2FA), `0028` (SSO-managed accounts),
   `0029` (SSO verified domains), `0030` (erasure), `0031` (coupon holds), `0032` (coupon organization scope), `0033`-`0037` (public site), `0038` (webhook retries), `0039` (portal sign-in links).
   They are additive; existing rows are unaffected. Take a D1 Time Travel note
   (`wrangler d1 time-travel info <db>`) first so you have a restore point.
2. Set the secrets in section 2 and deploy (the GitHub workflow runs the tests
   first, then deploys).
3. Publish a tenant template release **including its static files** and activate it
   (`scripts/publish-tenant-release.mjs`, see `DEPLOYMENT.md`; or SaaS > Tenant releases for the script alone).
   Sites cannot go live without an active release, and pages cannot render without the assets.
3a. One-time Cloudflare setup so sites are reachable: wildcard proxied DNS for the platform suffix,
   certificate coverage for it, and the Workers Routes token permission (`DEPLOYMENT.md`, "How a new site becomes reachable").
3b. Save the Stripe Customer Portal configuration once, in test and live mode (`DEPLOYMENT.md`).
4. Open the staff console, bootstrap the first admin if needed, and enrol 2FA
   (section 6).

## 4. Alerting and the scheduler

1. Set `ALERT_WEBHOOK_URL` (Slack/Discord, recommended) and/or `ALERT_EMAIL`.
2. Paid plan: add `"triggers": { "crons": ["*/5 * * * *"] }`. Free plan: set
   `ALERT_CHECK_TOKEN` and point a free uptime monitor at
   `POST https://<host>/api/ops/alert-check` every 5 minutes with header
   `Authorization: Bearer <token>`. That one tick also creates the daily DB backup.
3. Add a second monitor on a public page so you hear if the whole Worker is down.
4. **Test it:** SaaS > Alerts > Run check now; create a failed job on staging and
   confirm a message arrives and that clearing it sends "resolved". **[verify]**

## 5. Staging verification script

The full, ordered runbook with commands, thresholds and a results table is **`STAGING_VALIDATION.md`**; start there. The short list below is
the minimum. Do each once on staging, tick it off, and record the date.

- [ ] Run `node scripts/staging-checks.mjs --base https://<staging control plane> --with-signup`: **0 blockers**.

- [ ] Run `node scripts/smoke-test.mjs --base https://<staging control plane>`: signup, trial, site creation, **active**,
      then the site's homepage and stylesheet load over HTTPS. **[verify]**
- [ ] Sign up, verify email, log in, create a site, watch it reach **active** without help.
- [ ] Add a custom domain through the portal and see it verify. **[verify]**
- [ ] Stripe test mode: use the Billing page to subscribe (with and without a coupon), pay on the
      Stripe page, return, confirm the subscription activates and the coupon use is counted once;
      then switch plan and cancel at period end.
- [ ] Erasure: schedule deletion of a staging organization with a real site, set its date in the
      past, run the pinger tick, confirm the Cloudflare resources are gone and `erasure_log` says complete.
- [ ] Stripe: replay the same webhook event; nothing duplicates.
- [ ] Billing page: "Update payment method & invoices" opens the Stripe portal and returns. **[verify]**
- [ ] Limited coupon: start a checkout and abandon it; confirm the use is held for up to an hour, then released.
- [ ] Deploy-latest and rollback from the portal on a real site. **[verify]**
- [ ] Customer backup create, verify, download, restore (owner). **[verify]**
- [ ] DB backup: "Back up now", then "Verify" (checks the table-ordering step
      against real D1). Do a **practice restore** into a scratch database.
      Use the restore drill tooling and report (`runbooks/restore-drill.md`, AT-15; owner-run, NOT VERIFIED until executed with evidence).
- [ ] Read the incident runbooks (`RUNBOOKS.md`: webhook backlog, Stripe outage, D1, Cloudflare, mass email failure, mistaken suspension) and fill the **[OPEN]** owner decisions in `PLACEHOLDERS.md` (Round 6.5B).
- [ ] Rotate `CREDENTIAL_KEK` per `KEY_ROTATION.md`, end to end.
- [ ] Staff 2FA with your own authenticator app; log out and in; use one backup
      code; have a second admin reset your 2FA.
- [ ] Load test per `LOAD_TESTING.md`; write down the numbers and your budget.
- [ ] Nightly load test thresholds approved by the owner (`confirmed: true` in `config/loadtest-thresholds.v1.json`) and one staging report attached.
- [ ] `scripts/d1-size-check.mjs` run on staging and production with the plan's size limit set; output attached.
- [ ] External penetration test scheduled with a vendor and date (owner task).
- [ ] Security headers present (browser dev tools > Network) and a page cannot be framed.
- [ ] Confirm D1 Time Travel is enabled for production and test a restore of it.

## 6. Turning on staff 2FA

1. Deploy. Every admin opens **Two-factor** and enrols; store backup codes
   somewhere safe (not in the same place as the password).
2. Once everyone is enrolled, set `STAFF_2FA_REQUIRED=true`.
3. If the only super admin is ever locked out, see "Lost phone" in `STAFF_2FA.md`.

## 7. Known gaps (nothing here blocks staging; read before charging customers)

- **Retention policy needs a lawyer** (`ERASURE.md`): account and organization deletion is built, with
  draft defaults. Stripe, Resend and other processors are not asked to erase anything.
- **Business and legal** (roadmap Tier 3): terms of service, privacy policy, DPA, tax setup, refund
  policy, a support channel, a public pricing page.
- **Checkout and the billing portal are built but never run against Stripe.** Card entry happens on Stripe's hosted page.
- **Static asset upload, per-site routes and the tenant cron have never run against a live Cloudflare account.** Use the smoke test.
- **Staff lists are paged at 50 and have no search**; add filters before you have hundreds of organizations.

## Custom domains (v1)

Apply migration `0045`. Give `CF_API_TOKEN` Zone Edit and DNS Edit (list in `.dev.vars.example`) and make sure the
Single subdomains by CNAME (optional, v1.1): apply migration `0046`, enable Cloudflare for SaaS on the platform zone and run
`node scripts/setup-custom-hostnames.mjs` (see docs/CUSTOM_DOMAINS.md). Until the fallback origin is active, adding a
subdomain that is not inside an already delegated domain is refused with a clear message.
maintenance tick runs, because it drives nameserver tracking, certificates and expiry of unfinished claims. Run
`node scripts/check-config.mjs --online`, then the staging test in docs/CUSTOM_DOMAINS.md with a spare domain. Confirm the
Cloudflare account's zone allowance fits the number of customer domains you expect.
