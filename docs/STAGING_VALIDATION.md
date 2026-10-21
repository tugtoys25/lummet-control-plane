# Staging validation runbook

Everything in the repository is tested in-process (a simulated database, fake Cloudflare/Stripe/Resend). **None of it has run against the real
services.** This runbook is how you close that gap, in an order where each phase makes the next one meaningful. It is the checklist behind
`GO_LIVE_CHECKLIST.md` section 5, with exact commands, what a pass looks like, and what to write down.

Rules for the whole exercise
- **Staging only.** A separate Cloudflare account (or at least a separate zone and separate D1/R2/KV), Stripe **test mode**, a Resend domain
  you can afford to burn. Never point staging at production data or keys.
- **Record everything** in the results table at the end. "It worked" without a date, a version and a screenshot or log line is not evidence.
- **A failed check is a finding, not an embarrassment.** Write it in the defects table, fix it, re-run that phase and every phase after it.
- Run the phases in order. Phase 1 is automated and takes minutes; phases 4 to 12 need people and real devices and take days (phase 8 alone needs 72 hours).

---

## Phase 0. Prepare (about half a day)

| Step | How | Pass |
|---|---|---|
| Staging environment | `GO_LIVE_CHECKLIST.md` section 1 | separate D1 / R2 / KV / zone |
| Apply every migration | `node scripts/migrate.mjs` against staging D1 | ends "up to date", last file `0046_subdomain_domains.sql` |
| Settings | section 2 table; set **`ENVIRONMENT=production`** on staging too so the configuration check is exercised | Staff > SaaS overview shows **no red banner** except `CSP_MODE` (phase 8) |
| Tenant release | build and publish per `DEPLOYMENT.md` (`scripts/build-tenant-worker.mjs`, `scripts/publish-tenant-release.mjs`) | Staff > Tenant releases shows an active release |
| Test Turnstile | create a Turnstile widget with the Cloudflare test keys (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`) for later; leave `TENANT_TURNSTILE_*` **unset** for phases 1-3 | |
| Alert channel | `ALERT_WEBHOOK_URL` to a channel you watch; `ALERT_CHECK_TOKEN` set; pinger calling `/api/ops/alert-check` every 5 minutes | a test alert arrives (Staff > Alerts > Run check now with an old failed job) |
| Uptime monitor | point it at `GET /api/health` (returns `{"ok":true}`; 503 when the database does not answer) | goes green |

## Phase 1. Automated checks (minutes)

```
node scripts/staging-checks.mjs --base https://<staging control plane> --with-signup --rate-limit
node scripts/smoke-test.mjs      --base https://<staging control plane>
node scripts/staging-checks.mjs  --base https://<staging control plane> --site https://<the smoke test's site>   # after phase 2 has a live site
```
- `staging-checks`: **0 blockers failed.** Every warning is either fixed or written in the defects table with a reason. The launch gates it
  lists (CSP enforcement, `/privacy`, `/terms`) are not staging failures; they are your launch work list (`--launch` makes them fail the run).
- `smoke-test`: all steps pass, including *set dashboard password*, *sign in to the dashboard*, *dashboard opens*. If it says HTTP 403 at the
  login step, the site is asking for Turnstile (see phase 4). `site_database_unavailable` means the Worker's `CF_API_TOKEN` cannot edit the site's D1.
- `--rate-limit` locks your own address out of login for the limiter's window (15 minutes). Run it last, from a throwaway address.

## Phase 2. Provisioning and deletion for real

1. Create **5 sites at the same time** (5 organizations, or one with the plan limit lifted). Pass: all reach `active`; note the slowest time-to-active.
   Typical failures: missing `Workers Routes: Edit` scope, wrong `PLATFORM_DOMAIN_SUFFIX`, no wildcard DNS/certificate (the homepage check in the smoke test names which).
2. For one site open Cloudflare and confirm the resources exist and are named for the site: D1, KV, R2 bucket, Worker script, route, cron schedule if any.
3. **Failure injection.** Temporarily revoke `CF_API_TOKEN` and create a site. Pass: the job fails with a readable step name; the maintenance tick
   retries it after 5, 15, 45... minutes (Staff > Jobs shows the attempts); after the last one the job is dead-lettered and the **`dead_jobs`** alert arrives.
   Restore the token, press **Retry** on the job: the site reaches `active`.
4. **Deletion.** Request deletion of an organization that owns a live site, set its date in the past (`ERASURE.md`), run the tick. Pass: in Cloudflare
   the D1, KV, R2 bucket, Worker, route and custom hostname are **gone** (no orphans), `erasure_log` says complete, Staff > Organizations shows it erased,
   and no `incomplete_deletions` alert is open. Look for orphans by name, not just by count.

## Phase 3. Custom domains and certificates

On a domain you control, via the portal: add the domain, create the TXT record it asks for, verify, wait for the certificate, make it primary, load it over HTTPS,
then remove it. Also try: the same domain from a second organization (must be refused), a domain with a trailing dot or uppercase, a `www` alias.
Pass: HTTPS works with a valid certificate on the first try or after a documented wait; the site's own `/en/` pages load on it; removing it leaves the platform address working.

## Phase 4. The customer's dashboard login (the self-serve path to editing content)

1. As an organization admin: Content page > **Set dashboard password** for the live site. Sign in at `https://<site>/en/login` with your portal email.
   Pass: you reach `/en/dashboard`, can create a page, upload an image (R2) and see it on the public site.
2. As an **editor** and as a **viewer** of the same organization: the form is not shown, and calling `POST .../dashboard-admin` directly returns 403.
3. Set the password again: you are signed out of the dashboard and the old password no longer works.
4. **Turnstile.** Set `TENANT_TURNSTILE_SITEKEY` / `TENANT_TURNSTILE_SECRET` (test keys) on the control plane and redeploy the site. Pass: the login page now shows
   the widget and a login without the token is refused (403); with the test keys it succeeds. Unset both and redeploy: login works without the widget.
   (A real widget's allowed hostnames must include every site hostname; that is a Cloudflare setting, not code.)
5. Analytics: visit the site and follow a tracking link a few times; the portal's Analytics page shows the views and clicks within the documented delay.

## Phase 5. Billing with Stripe test mode

Set up: the Stripe CLI forwarding events (`stripe listen --forward-to https://<staging>/api/billing/webhook/stripe`), `STRIPE_WEBHOOK_SECRET` from it, a Stripe price id on every plan you will test (Staff > Plans).

| Scenario | Card / action | Pass |
|---|---|---|
| Subscribe | `4242 4242 4242 4242` | subscription `active`, invoice recorded, entitlements change immediately |
| Declined renewal | `4000 0000 0000 0341` then advance the clock | `past_due`, the **`past_due`** alert, customer sees the banner, access follows your grace policy |
| Failed payment | `4000 0000 0000 0002` at checkout | no subscription, clear message, no coupon use counted |
| 3-D Secure | `4000 0025 0000 3155` | completes after authentication |
| Upgrade / downgrade | change plan | prorations as Stripe states; entitlements and limits follow; a downgrade below current usage is handled as you decided |
| Cancel at period end, resume | portal buttons | status and dates correct on both sides |
| Customer portal | "Update payment method & invoices" | opens and returns |
| Coupons | a global one, one scoped to organization A used by B (must read "invalid"), a limited one abandoned mid-checkout | counts once; held then released; scoped code never reveals it exists |
| **Annual plan** | create the Stripe price, Staff > Plans > set id, Reactivate | `/pricing` shows the Annual toggle and the saving; checkout charges the annual price |
| **Webhook retry** | send an event the system cannot apply yet (e.g. `customer.subscription.updated` for an unknown subscription): `billing_webhook_events` row `failed`; make it applicable; `stripe events resend <id>` | the row becomes `processed`, attempts = 2, nothing duplicated |
| Replay | resend a processed event | acknowledged, nothing changes |

## Phase 6. Email with Resend

Real inbox, real domain. Sign-up verification, forgot / reset password (the old session must die), team invitation and acceptance (including the wrong-email case), billing and usage notices.
Pass: each arrives in the inbox (not spam) within a minute; links go to the right host; the sending domain passes **SPF, DKIM and DMARC** (check the raw headers or a deliverability tester); unsubscribed/bounced behaviour is understood.
Failure injection: set a wrong `RESEND_API_KEY`; emails queue, the **`failed_emails`** and later **`stale_email_queue`** alerts fire; restore and the queue drains.

## Phase 7. Strong authentication with real devices

TOTP with a real authenticator app (enrol, log in, use a backup code, lose-the-device recovery). A passkey on a phone **and** on a hardware key, on the real origin (`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` must match the host exactly). Staff 2FA enforced (`STAFF_2FA_REQUIRED=true`) and a second admin resetting yours.
SSO with a **real identity provider** (Okta, Entra, Google Workspace): configure, claim the email domain, sign in, second user auto-provisioned with the default role, and a user from another domain refused.
Pass: all work on the real hostnames in Chrome, Safari and Firefox.

## Phase 8. Script policy soak, then enforcement (72 hours minimum)

1. Leave `CSP_MODE` unset (report-only). Browse **every page type** as staff, customer (each role) and visitor, in Chrome, Firefox and Safari, **with the console open**: every portal page, every staff page, the public site, a tenant site and its dashboard (that one has its own pages; note any console errors).
2. Let real use accumulate for 72 hours. Search the Worker logs for `csp_violation`. Pass: **zero**, or every one explained and fixed (a violation from a browser extension is noise; note it).
3. Set `CSP_MODE=enforce`, redeploy, and repeat step 1 plus phase 1. Pass: nothing is blocked, the configuration banner clears, staging-checks `A9` passes.
4. Rollback is unsetting the variable. Practise it once.

## Phase 9. Backups and restore (the part nobody tests until they need it)

- **Site backup**: create, verify, download, restore into a *new* site; open the restored site and compare content counts with the original.
- **Control-plane backup**: wait for the tick to make one (or press Back up now), verify, then do a **full practice restore**: download the parts from R2, create a scratch D1, `node scripts/migrate.mjs` against it, `CREDENTIAL_KEK=<key> node scripts/restore-control-plane.mjs ./restore-in > restore.sql`, `wrangler d1 execute <scratch> --remote --file restore.sql`.
  Pass: row counts per table match the source at backup time; a customer, a subscription and a site can be read from the restored copy; **write down how long it took** (your recovery time) and how old the backup was (your data-loss window).
- Confirm D1 Time Travel is on for production and restore one to a point in time.
- Key rotation: rotate `CREDENTIAL_KEK` end to end per `KEY_ROTATION.md` and prove stored secrets, email bodies and backups still decrypt.

## Phase 10. Failure drills: does a human find out?

For each, cause it, start a stopwatch, and stop it when the alert (or the staff page) tells you. **Pass: under 10 minutes**, and the message names the right thing.

| Cause it by | You should see |
|---|---|
| a webhook pointed at an endpoint returning 500 | retries at 1, 5, 30, 120, 360 minutes, then `dead`; the customer's page shows attempts; **`dead_webhook_deliveries`** (needs 10 dead in 24h) |
| revoke a site's credential / stop a site | **`unhealthy_tenants`** alert |
| make the control-plane database fail a route (staging copy only) | `X-Request-Id` on the error page; the id finds the line in the logs and the row in Staff > Server errors; **`server_errors`** after 5 in 15 minutes |
| stop the pinger for an hour | no retries happen; the alert check itself is silent. Decide how an external monitor notices the pinger died (this is a gap to close with your monitor, not a feature) |
| delete the backup bucket's recent object | the **`backup_stale`** alert |
| fill a mailbox / wrong Resend key | phase 6 |

## Phase 11. Load

`LOAD_TESTING.md`, against a **staging** deployment on the same plan tier you will run in production (D1's limits are the thing being measured).
Scenarios and starting thresholds: `portal-read` 50 users / 20 concurrent / 60 s, **p95 <= 1000 ms and error rate <= 1%**; the same with `ops-ping`; plus **10 sites provisioning at once** (all active within your budget, no job stuck).
Pass: thresholds met, no 5xx burst in Staff > Server errors, no job dead-lettered. Write down the numbers and the plan tier; they are your capacity statement.

## Phase 12. Erasure and export

Create an organization with a site, content, a subscription, a webhook, an API key and an inquiry from its owner's email; request an export (check it downloads once and expires); delete the account. Pass: after the grace date and a tick, no personal data remains outside the documented retention (`ERASURE.md`: financial records, scrubbed audit), the inquiry is gone, Stripe's customer is handled as you decided, and a second organization is untouched.
Counsel must confirm the retention policy before real customers.

## Phase 13. Isolation probes by hand

Two organizations, A and B, each with a site, API key, webhook, domain, backup, automation and notification. Signed in as A, call each route family below **with B's ids** and expect 403 or 404 and no data. Also try with A's *API key* on `/api/v1`.

`/sites/:id` `/sites/:id/dashboard-admin` `/sites/:id/tracking-links/disable` `/sites/:id/analytics/*` `/sites/:id/reports/:id/run` `/sites/:id/alerts/:id/acknowledge`
`/domains` `/deployments` `/backups` `/automations` `/api-keys` `/webhooks/:id/deliveries/:id/redeliver` `/notifications/:id/acknowledge` `/search?q=<B's site name>` `/export` `/members`

`staging-checks --with-signup` already proves the first two (read and create a site); the rest is manual because it needs your real data.

## Phase 14. People, browsers, devices

Customer portal and public site on a phone (iOS Safari, Android Chrome) and one older laptop; Lighthouse on `/`, `/pricing` and a tenant home (record Performance, Accessibility, SEO; set your own floor, 90 is a common one); keyboard-only through sign-up; screen-reader pass on the login and billing pages.

---

## Results table (copy this, fill it in)

| Phase | Date | Build / commit | Tester | Pass / fail | Evidence (log line, screenshot, link) | Notes |
|---|---|---|---|---|---|---|
| 0 Prepare | | | | | | |
| 1 Automated | | | | | | |
| 2 Provisioning / deletion | | | | | | |
| 3 Domains | | | | | | |
| 4 Dashboard login | | | | | | |
| 5 Billing | | | | | | |
| 6 Email | | | | | | |
| 7 Strong auth | | | | | | |
| 8 Script policy soak | | | | | | |
| 9 Backups / restore | | | | | | |
| 10 Failure drills | | | | | | |
| 11 Load | | | | | | |
| 12 Erasure / export | | | | | | |
| 13 Isolation | | | | | | |
| 14 Browsers / devices | | | | | | |

## Defects found

| # | Phase | What happened | Severity (blocker / fix before launch / later) | Fixed in | Re-tested |
|---|---|---|---|---|---|

## Go / no-go

**Technical go** needs: phases 1 to 13 pass; phase 8 ended in enforcement; the practice restore worked and you know your recovery time; the failure drills alerted within 10 minutes; load numbers meet the thresholds; no open blocker in the defects table.

**Business go** is separate and is not something code can pass. Open until someone signs:
- Terms of service and privacy policy written or approved by counsel and published (`staging-checks` `D6`, `D7`); a data processing agreement; the list of sub-processors (Cloudflare, Stripe, Resend, any AI provider).
- Refund and cancellation rules stated, and the product matching them. Tax / VAT decided (Stripe Tax or manual) and shown at checkout.
- A support channel customers can reach and a person who answers; an abuse and fraud process; an incident process and a status page.
- The erasure retention policy approved by counsel.
- Stripe live mode account approved and live price ids entered; production keys set only in production.

## What this plan does not prove
Resilience to a Cloudflare regional incident, behaviour at volumes beyond phase 11, a professional penetration test (the in-repo review is a first pass, `SECURITY_REVIEW_2_1.md`), or legal adequacy of any text. Budget for the penetration test before a public launch.
