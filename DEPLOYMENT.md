# Lummet Deployment Guide

This covers deploying both halves of the system:

1. **Tenant side** — the Super API added to each tenant repo (Phase 1).
   Already applied to `freewin.xyz`; repeat for any other tenant.
2. **Control plane** — the standalone `lummet-control-plane/` Worker +
   D1 (Phases 2–8), deployed once, independent of any tenant.

Read this top to bottom the first time. After that, "Adding another
tenant" is the only section you'll repeat regularly.

---

## Architecture recap

```
Lummet (this project)  --HTTPS, HMAC-signed-->  Tenant Worker  -->  Tenant D1
```

- Each tenant is one Cloudflare Worker with its own independent D1.
  Nothing here changes that — the control plane never touches a
  tenant's D1 directly, only its `/en/api/super/*` HTTP endpoints.
- The control plane is its own Worker with its own, separate D1
  (`lummet-control-plane-db`). It stores *metadata about* tenants
  (host, encrypted credential, cached health/capabilities) — never
  tenant content (casinos, reviews, news, users, etc.).
- Deleting a tenant from the control plane's registry only removes
  that metadata. It never deletes anything in the tenant's own D1.

---

## Part 1 — Tenant side (per tenant)

Already done for `freewin.xyz` in this delivery. To add the Super
API to another tenant repo, repeat this section for it.

### 1.1 Apply the code

Copy into the tenant repo, preserving paths:

```
en/worker/super/router.js
en/worker/super/auth.js
en/worker/super/handlers.js
en/worker/super/capabilities.js
en/migrations/0017_super_api.sql
en/docs/super-api.md
```

And apply these two small edits (already done in `freewin.xyz`):

**`en/worker/index.js`** — add the import and one new `case`:
```js
import { handleSuperApi } from "./super/router.js";
// ...
case "superApi":
  return handleSuperApi(request, env, ctx, route.path);
case "api":
  // ...unchanged...
```
(Place `superApi` **before** `case "api"`.)

**`en/worker/routes.js`** — add one match **before** the existing
generic API match:
```js
if (path.startsWith("/en/api/super/")) {
  return { type: "superApi", path };
}
if (path.startsWith("/api/") || path.startsWith("/en/api/")) {
  // ...unchanged...
}
```

Nothing else in the tenant repo changes. Verify with:
```
git diff --stat
```
You should see exactly these two files modified, plus the new files
above as untracked/added.

### 1.2 Run the migration

```
wrangler d1 execute <tenant-db-name> --file=en/migrations/0017_super_api.sql --remote
```

Use `--env <envname>` too if the tenant uses a named environment
block in `wrangler.jsonc` (e.g. `freewin.xyz` deploys via
`--env levelcasino`, `--env clustercasino`, etc. — check the tenant's
`wrangler.jsonc` `env` block names). Drop `--remote` to apply to a
local/dev D1 first if you want to test before touching production.

This migration is additive only (`CREATE TABLE IF NOT EXISTS`) — it
does not touch `casinos`, `news`, `users`, or any existing table.

### 1.3 Set the tenant's Super API secrets

You'll get these values from the control plane in Part 2, step 2.6
(**Register a tenant**) — come back to this step after that.

```
wrangler secret put SUPER_API_CREDENTIAL_ID --env <envname>
wrangler secret put SUPER_API_SECRET --env <envname>
```

Until these are set, the tenant's Super API returns `503
not_configured` for every request — the tenant's normal site, admin,
and login are completely unaffected either way.

### 1.4 Deploy the tenant Worker

```
wrangler deploy --env <envname>
```

### 1.5 Verify nothing broke

Manually check, per the master plan's acceptance criteria:
- Homepage loads normally
- Admin login and dashboard work
- A normal CRUD action (e.g. edit a news post) works
- The tenant's `lummet.<tenant-host>` AI assistant subdomain still
  responds (if configured)
- `GET https://<tenant-host>/en/api/super/handshake` **without**
  auth headers returns `401`, not a crash or a 200

---

## Part 2 — Control plane (deploy once)

### 2.1 Prerequisites

```
cd lummet-control-plane
npm install -g wrangler   # if not already installed
wrangler login
```

### 2.2 Create the D1 database

```
wrangler d1 create lummet-control-plane-db
```

Copy the `database_id` from the output into `wrangler.jsonc`,
replacing `REPLACE_WITH_ACTUAL_D1_DATABASE_ID`.

### 2.3 Run the migrations

**New deployment (fresh D1 database, nothing applied yet):**

```
node scripts/migrate.mjs --db lummet-control-plane-db --remote
```

This applies every file in `migrations/` in order, recording each one
in a `schema_migrations` table it creates automatically, and is safe to
re-run — a second run does nothing (see `test/migrate.test.js` for the
exact guarantees: order, idempotent re-runs, and that a failed
migration is never recorded as applied). This is the step CI now runs
automatically on every deploy (`.github/workflows/deploy.yml`), so once
you're set up you should rarely need to run it by hand again.

**Existing deployment (already ran some or all of `0001`-`0021` by hand
using the old `wrangler d1 execute --file=...` commands, before this
runner existed):** run the one-time bootstrap first, or the runner will
try to re-apply migrations that are already there and fail on the
non-idempotent `ALTER TABLE ... ADD COLUMN` statements in `0005` and
`0008`:

```
node scripts/migrate.mjs --db lummet-control-plane-db --remote --bootstrap
```

`--bootstrap` marks every migration file currently in `migrations/` as
applied **without running any of them** — use it exactly once, only
when you're certain every one of those files has already actually been
applied to this database by hand. After that, use the plain command
above for every future migration.

Use `--dry-run` with either mode first if you want to see what it would
do before it touches the database.

`0018` seeds the actual commercial catalog (10 products, 26 plans,
full entitlement sets) — without it, `0006`/`0007` leave only one
example plan and signup/checkout has almost nothing to sell. `0019`
adds the transactional email outbox. `0020` adds usage metering, the
AI credit ledger, and job run/attempt/log history (additive; existing
`jobs`/`job_steps` from `0010` are untouched). `0021` adds tenant
backups and the automation engine, and seeds two more entitlement
keys (`backups.enabled`, `automations.enabled`) onto every plan. All
four are additive and safe to run on an existing deployment.

`0002` adds Lummet's own CMS tables (pages, authors, brands,
partners, updates, publications, advertisements, homepage settings).
`0003` adds the staff-account RBAC tables. `0004` adds the homepage
sections table (Phase 9.1). `0005` adds the AI management-chat
tables and two columns on `lummet_audit_logs` (`initiated_by`,
`ai_conversation_id`). All of `0001`-`0005` are additive — safe to
run on an existing deployment, and the homepage/nav code falls back
gracefully if a later migration hasn't run yet (new nav sections/CMS
just won't have anywhere to write, and `renderPublicHomepage`
catches the failure and falls back to its built-in defaults). Run
`0002`/`0003` before granting any staff account access, though —
until `0003` is applied, every non-bootstrap admin account creation
will fail since `lummet_admins.status` doesn't exist yet.

`0006` through `0017` are the customer/organization SaaS layer
(master prompt sections 6-45): customer identity and sessions,
sites/products/plans/subscriptions, a shared `actor_type` column on
`lummet_audit_logs` so customer actions land in the same audit log
as staff actions, Stripe billing, the job/provisioning system,
domains, deployments, entitlements, the customer-facing developer
API and API keys/webhooks/export/search, and enterprise features
(branding, change-request approvals, WebAuthn passkeys, SSO/OIDC).
They are independent of `0001`-`0005` (no shared table names) and
must run in order relative to each other, since e.g. `0008` alters a
table `0006`/`0007` don't touch and `0009`+ reference `organizations`
and `sites` created in `0006`/`0007`. None of this SaaS layer is
usable — sign-up, billing, provisioning — until all of `0006`-`0017`
have run; the control plane's existing staff/tenant functionality
works identically whether or not they have.

### 2.4 Generate and set the credential encryption key

This key (KEK) encrypts every tenant's HMAC secret at rest. Losing
it means every tenant credential must be rotated.

```
openssl rand -base64 32
wrangler secret put CREDENTIAL_KEK
# paste the value from openssl rand above
```

### 2.4a SaaS-layer secrets (billing, provisioning, passkeys)

These are only required once you actually want customers to sign
up, pay, or have sites provisioned for them — the pre-existing staff
console and tenant management (Parts 1 and the rest of Part 2) work
with none of them set. Each one fails closed with an explicit error
if missing (rule #5 — no fake billing, no fake provisioning), rather
than silently pretending to succeed:

```
# Billing (Stripe). Without these, /app/billing checkout, cancel,
# resume, and change-plan all return an explicit "billing not
# configured" error, and the webhook endpoint rejects everything.
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET

# Cloudflare infrastructure provisioning. Without these, a new
# site's provisioning job fails at its "create Cloudflare
# resources" step with a visible error in the job's step log —
# it is never marked "active" by mistake.
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ACCOUNT_ID
wrangler secret put CF_ZONE_ID

# WebAuthn/passkeys (Phase 7). Optional — customers can still use
# password + TOTP without these. RP_ID must exactly match the
# hostname the customer portal (/app/*) is served from.
wrangler secret put WEBAUTHN_RP_ID
wrangler secret put WEBAUTHN_ORIGIN

# Transactional email (Resend). Without this, signup verification,
# password reset and team invitation emails stay queued forever in
# email_outbox and are never delivered (check /platform/saas/email).
wrangler secret put RESEND_API_KEY
# EMAIL_PROVIDER and EMAIL_FROM are plain vars in wrangler.jsonc's
# "vars" block (not secret): EMAIL_PROVIDER="resend",
# EMAIL_FROM="Lummet <no-reply@yourdomain.com>".
```

Also set `PORTAL_BASE_URL` in `wrangler.jsonc`'s `vars` to the customer
portal's real origin (e.g. `https://app.yourdomain.com`). Every emailed
link is built from this, never from the request's Host header, so it
is required before any email can be queued at all.

Create an R2 bucket for backups (optional — without it, backups fail
closed with a clear error rather than a fake success):
```
wrangler r2 bucket create lummet-backups
```
and confirm the `r2_buckets` binding in `wrangler.jsonc` points at it.

`CF_API_TOKEN` needs, at minimum: Account → Workers Scripts:Edit,
D1:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit; and
Zone → SSL and Certificates:Edit on the zone named by `CF_ZONE_ID`
(for custom-hostname SSL during domain verification). Create the
Stripe webhook endpoint pointing at
`https://<control-plane-host>/api/billing/webhook/stripe` and select
at least `checkout.session.completed`, `customer.subscription.*`,
and `invoice.payment_failed`.

Optionally also set (both have working defaults):

```
wrangler secret put PLATFORM_DOMAIN_SUFFIX      # default: sites.lummet.app
wrangler secret put CF_WORKERS_DEV_SUBDOMAIN    # default: workers
```

`PLATFORM_DOMAIN_SUFFIX` is the placeholder hostname a newly
provisioned site gets before a customer attaches a real custom
domain — set it to a domain you actually control before going live,
or provisioned sites will register under a domain Lummet doesn't
own.

### 2.5 Deploy

```
wrangler deploy
```

`wrangler deploy` does **not** register a Cron Trigger — see the
`NOTE` at the bottom of `wrangler.jsonc`: it was deliberately removed
because Cron Triggers require a paid Workers plan. The Phase 7
health-check sweep and old-audit-log pruning (`cron.js`) only run
on-demand: click **Test connection** on a tenant's page, or
**Run all now** on the Health page (`POST
/api/tenants/health-check-all`). If/when this control plane moves to
a paid plan, uncomment the `triggers.crons` block in
`wrangler.jsonc` and redeploy — no other code changes needed.

### 2.6 Choose the master hostname

**Do not** use a hostname whose first label is `lummet` (e.g.
`lummet.io`, `lummet.example.com`). Tenant repos route
`hostname.startsWith("lummet.")` to their own per-tenant AI
assistant (`en/worker/lummet/`) — a prefix match, so it would also
match an apex domain like `lummet.io`. This is a real ambiguity in
the existing tenant routing, not a hypothetical one.

Use something unambiguous instead — e.g. `console.yourdomain.com` —
and attach it as a Worker Route or Custom Domain in the Cloudflare
dashboard, or via a `routes` entry in `wrangler.jsonc`.

### 2.7 Bootstrap the first admin

Visit `https://<control-plane-host>/login`. With zero rows in
`lummet_admins`, it automatically shows a "create the first admin"
form instead of a login form, and logs you straight in afterward.

(Or via the API: `POST /api/auth/bootstrap` with
`{"email": "...", "password": "... 12+ chars ..."}`.)

The bootstrapped account is always a super admin — it can grant
itself and anyone else access to anything. Add every other Lummet
staff account from **Platform → Admins → New admin** (super-admin
only): pick "Staff" as the role, and a temporary password is shown
exactly once — copy it before leaving the page, then grant that
staff account whichever tenants and Content/System/CMS resources
they need from their detail page (`/platform/admins/:id`). A fresh
staff account has zero access until you grant it, and is forced to
`/account/password` to set a real password before it can use
anything else. Any admin can change their password later from the
"Change password" link in the topbar.

### 2.8 Set up lummet.com's own homepage/content

Optional, any time after 2.7: **Lummet Site → Homepage settings**
lets you override the hero title/subtitle/CTAs, footer text, and
contact email shown on the public homepage — everything left blank
falls back to sensible built-in copy. **Lummet Site → Pages/Authors/
Brand profiles/Partners/Updates/Publications/Advertisements** manage
the rest of lummet.com's own content (separate from any tenant's
content). Published Updates and Partners show up on the homepage
automatically; a published Page is reachable at
`lummet.com/p/<slug>`.

### 2.9 Register a tenant

From the dashboard: **Tenants → Add Tenant**, enter the tenant's
display name and hostname (e.g. `freewin.xyz`).

The response shows a **credential_id and secret exactly once** —
copy both immediately. This is what goes into Part 1, step 1.3 on
the tenant side:

```
wrangler secret put SUPER_API_CREDENTIAL_ID --env <envname>
# paste credential_id

wrangler secret put SUPER_API_SECRET --env <envname>
# paste secret
```

After setting those and redeploying the tenant Worker, go back to
the tenant's page in the dashboard and click **Test connection**.
You should see `Online` and a populated capability list.

### 2.10 Repeat for each additional tenant

Part 1 (tenant side) + step 2.9 (register + set secrets), once per
tenant. Each tenant gets its own credential — rotating or revoking
one tenant's credential never affects another. Remember: a staff
admin needs to be explicitly granted access to a new tenant before
they can see or manage it (Platform → Admins → that admin →
Tenant access) — a super admin always has access automatically.

---

## Publishing a tenant template release (required before self-serve site creation works)

Before any customer's "Create site" click can produce a live, reachable
site automatically (roadmap 0.1), a staff member must publish at least
one tenant template release — the shared, versioned build every new
site deploys. Without one, provisioning still succeeds and creates real
Cloudflare resources, but a new site honestly stops at status
"provisioned" rather than "active" (see `worker/tenant-template.js`'s
header comment — this is deliberate, not a bug: never claim a site is
live when it isn't).

```
cd lummet-tenant          # the repo root, where wrangler.jsonc lives
wrangler login            # if not already
node ../lummet-control-plane/scripts/build-tenant-worker.mjs \
  --version 2024.06.01 --notes "describe what changed" --out release.json
```

Then, as a super-admin, open **`/platform/saas/releases`** in the
control plane dashboard, paste the contents of `release.json` into the
"Publish a new release" box, and submit. Every site provisioned from
that point on will automatically deploy this release. Roll back to an
older release with the "Activate" button next to it on the same page —
the older artifact is never deleted, only marked superseded.

**Known limitation:** this captures the tenant Worker's *script* and
its D1 *migrations*, not the static assets directory `wrangler.jsonc`
also declares (`assets: { directory: "./en" }` — CSS/JS/images/service
worker, ~4MB). A newly auto-deployed site gets a working, routable
application immediately, but not yet its full styling and client-side
behavior. Closing this needs Cloudflare's separate Workers-Assets
upload flow, not yet implemented — see `tenant-template.js` and
`infra-cloudflare.js`'s comments for exactly where that work plugs in
once it's built and verified against a real Cloudflare account.

## Adding another tenant later (the short version — manual/legacy path)

The steps below register an *already-deployed* tenant Worker with the
control plane by hand — this is the path that existed before automated
provisioning (roadmap 0.1, above) and is still useful for a one-off
tenant you're deploying outside the normal customer signup flow (e.g.
your own reference/demo site).

1. Apply Part 1.1–1.2 to that tenant's repo (copy the 4 files + 2
   edits + run the migration).
2. **Tenants → Add Tenant** in the Lummet dashboard.
3. `wrangler secret put` the two returned values on the tenant
   Worker.
4. Deploy the tenant Worker.
5. **Test connection** from the tenant's page in the dashboard.

---

## Operating the control plane

- **Switch active tenant**: the dropdown in the topbar of every
  dashboard page. This only changes *your session's* selection —
  it never touches the tenant's own auth/session state.
- **CRUD**: Content/System nav items operate against whichever
  tenant is currently active. `casinos`, `reviews`, `news`, `pages`,
  `categories`, `countries`, `authors`, `users` (role-only), `media`
  (edit/delete only — no upload yet), and `settings` (safe keys
  only) are supported. `permissions` and `components` show a
  placeholder — no Super API endpoint exists for them yet.
- **Health**: `Tenants → Health` shows last-known status per
  tenant, refreshed automatically every 5 minutes by the cron, or
  on demand via the **Run all now** button.
- **Rotating a credential**: tenant's detail page → **Rotate
  credential**. The new secret is shown once — update the tenant
  Worker's `SUPER_API_SECRET`/`SUPER_API_CREDENTIAL_ID` immediately,
  or that tenant will start rejecting Lummet's requests as
  unauthorized until you do.
- **Audit trail**: `Platform → Audit Logs` — filterable by tenant,
  action, and success/failure, paginated. Entries older than 180
  days are pruned automatically by the same cron. Never contains
  passwords, decrypted secrets, or the KEK.

---

## Rollback

Everything is additive and isolated in both directions:

- **Tenant side**: revert the two small edits to `index.js` /
  `routes.js`, delete `en/worker/super/`, and optionally drop the
  three new tables (`super_api_nonces`, `super_api_rate_limits`,
  `super_audit_logs`) — nothing else in the tenant's schema or code
  was touched. Removing `SUPER_API_CREDENTIAL_ID`/`SUPER_API_SECRET`
  alone is enough to disable the Super API without any code change
  (it starts returning `503`).
- **Control plane**: not deploying it at all, or deleting the
  Worker entirely, leaves every tenant completely unaffected —
  tenants never call the control plane, only the reverse.
- **A single tenant**: `DELETE /api/tenants/:id` (or the "Delete
  registration" button) removes only that tenant's row from the
  control plane's own D1. It never touches that tenant's D1,
  content, or deployment.

---

## Pre-production checklist

Everything here has been verified by static syntax checking
(`node --check` on every file) and functional tests against mocked
D1/fetch — **not against a live Cloudflare D1 or Workers runtime**.
Before this touches real production traffic:

- [ ] Deploy the control plane to a staging hostname first.
- [ ] Deploy Phase 1 to one non-production tenant (or a tenant's
      staging environment, if it has one) before production tenants.
- [ ] Walk the manual test list from the master plan (§29): reject
      unauthenticated / bad-signature / replayed / expired requests;
      confirm full CRUD round-trip; confirm the tenant's normal
      site/admin/login/AI-assistant are unaffected.
- [ ] Register two tenants and confirm changing one never affects
      the other — live, not just by reading the code.
- [ ] Have another engineer review the HMAC/auth path before
      production data is exposed through it — this is, by design,
      a remote administrative interface.

---

### Stripe Customer Portal (billing page: "Update payment method & invoices")

Stripe rejects portal sessions until a portal configuration is saved once in
the Stripe dashboard (Settings > Billing > Customer portal; do it in test mode
and live mode separately). Until then the button reports "portal is not
available right now". An organization needs a Stripe customer first, which is
created the first time it starts a checkout.

---

## Publishing a tenant release (script + migrations + static assets)

A site needs the tenant Worker script, its migrations AND its static files
(templates, CSS, JS, images; the tenant reads its own HTML templates through
the `ASSETS` binding, so pages cannot render without them). From the
`lummet-tenant` repo root, with `wrangler` installed:

```
LUMMET_STAFF_COOKIE='<staff session cookie>' \
  node ../lummet-control-plane/scripts/publish-tenant-release.mjs \
  --base https://your-control-plane.example.com --version 2026.10.04 --notes "what changed"
```

For unattended use (CI) authenticate with a **staff API token** instead of a
cookie (`LUMMET_STAFF_TOKEN=lmst_...`), and add `--rollout --wait` to also
deploy the release to every site, one at a time. Publishing alone changes no
site. The whole chain, the GitHub Actions workflow and the rollout rules are in
`docs/TENANT_RELEASES.md`.

Add `--dry-run --skip-build` first to see the file count and size. Requires
the `TENANT_TEMPLATES` R2 binding and a super-admin session. Assets come from
`en/static`, `en/templates` and `en/lummet` (not `en/worker`, tests or
migrations). Limit 500 files and 25 MiB each; the current tenant is about 240
files / 4.1 MB. Each deploy reads the needed files back from R2, so very large
asset sets need a Workers plan with the higher subrequest limit.

On every deploy the control plane now also attaches the site's bindings:
`DB` (its D1), `CACHE` (KV), `MEDIA_BUCKET` (R2), `AI`, `ASSETS`, and the
variables `SITE_URL`, `DEPLOYMENT_ID`, `SUPER_API_CREDENTIAL_ID` and secret
`SUPER_API_SECRET`. After rotating a tenant's Super API credential, redeploy
the site so the new secret reaches it. Tenant email (`RESEND_*`) and
`TURNSTILE_SECRET` are not set by the platform.

The asset upload follows Cloudflare's documented Workers Assets flow but has
not been run against a live account. First live check: publish a release,
create a site, and confirm the deployment reaches `active` and the site's CSS
loads.

### How a new site becomes reachable (routing)

Each site is its own Worker. On deploy the control plane creates one Cloudflare
route per site, `<slug>.<PLATFORM_DOMAIN_SUFFIX>/*` -> that site's Worker, on
the zone named by `CF_ZONE_ID`, and remembers it so redeploys and rollbacks
reuse it. It also registers the tenant's cron (`0 */6 * * *`; a failure there
is recorded on the deploy step but does not fail the deploy). A routing
failure DOES fail the deploy, with Cloudflare's reason.

One-time setup you must do for this to work:

1. **Token permission.** `CF_API_TOKEN` needs *Zone: Workers Routes: Edit* on
   the `CF_ZONE_ID` zone (in addition to the permissions already listed).
2. **Wildcard DNS.** In that zone, add a proxied (orange-cloud) wildcard record
   for the platform suffix, e.g. `*.sites` as an `AAAA` record to `100::`.
   Routes only apply to hostnames that resolve through Cloudflare.
3. **Certificate coverage.** Cloudflare's free Universal SSL covers `example.com`
   and `*.example.com` (one level). A suffix like `sites.example.com` makes
   site hostnames two levels deep (`slug.sites.example.com`), which Universal
   SSL does NOT cover; browsers would show certificate errors. Either buy
   Advanced Certificate Manager and add `*.sites.example.com`, or set
   `PLATFORM_DOMAIN_SUFFIX` to the zone apex itself (sites at
   `slug.example.com`).
4. `CF_ZONE_ID` must be set (it was previously only needed for custom
   hostnames). Without it a deploy fails with an explicit message.

Limits: Cloudflare allows on the order of 1,000 routes per zone, and the plan
you are on decides how many Workers an account may hold, so this model suits
early scale. Past that, move sites to Workers for Platforms (a dispatch
namespace with one dispatcher Worker); the deploy step in `deployments.js` and
the route helpers in `infra-cloudflare.js` are the places to change.

Custom domains customers attach later still go through the existing
custom-hostname flow (`domains.js`).

None of this has been run against a live Cloudflare account. First live check:
deploy one site and request `https://<slug>.<suffix>/` in a browser.


### First live check, automated

`node scripts/smoke-test.mjs --base https://<staging control plane>` walks one
new customer through signup, trial, site creation, waiting for `active`, then
loads the site's homepage and stylesheet, and schedules clean-up. It stops at
the first failing step and says what to look at (no release published,
deployment error text, or DNS / route / certificate for an unreachable host).
Run it once after setting up routing and publishing a release. `--keep` leaves
the test organization in place.

## Public website assets (v7A)

`wrangler.jsonc` now has an `assets` binding (`ASSETS`, directory `./public`, `run_worker_first: true`). Nothing else to
create. Migrations 0033-0037 (public site schema, seed content, contact/demo forms, signed-in header link, select-option
repair) are applied by `node scripts/migrate.mjs` like every other migration. If this database already ran the standalone
public-site migrations by hand (the old 0006-0010), do NOT run 0033-0037: record them as applied instead:

    wrangler d1 execute lummet-control-plane-db --remote --command \
      "INSERT OR IGNORE INTO schema_migrations (filename) VALUES ('0033_public_site_schema.sql'),('0034_seed_lummet_content.sql'),('0035_contact_demo_forms.sql'),('0036_signed_in_header.sql'),('0037_repair_select_options.sql')"

---

## Custom domains and configuration (v1)

* Migration `0045_domain_zones.sql` adds delegated custom domains (nameserver flow). It is applied by
* Migration `0046_subdomain_domains.sql` adds single-subdomain support (CNAME + TXT through Cloudflare for SaaS). The CNAME
  path also needs a fallback origin: `node scripts/setup-custom-hostnames.mjs` (docs/CUSTOM_DOMAINS.md).
  `node scripts/migrate.mjs` like every other migration.
* The Cloudflare API token now also needs **Zone Edit** and **DNS Edit** on all zones of the platform account. The full
  permission list is in `.dev.vars.example`; the customer-facing flow, API, limits and the staging test are in
  `docs/CUSTOM_DOMAINS.md`.
* All variables and secrets, what each does and what breaks without it: `docs/CONFIGURATION.md`. Check a setup with
  `node scripts/check-config.mjs` (add `--online` to test the Cloudflare token).
* The maintenance tick (`POST /api/ops/alert-check` or a Cron Trigger) also advances custom domains.
