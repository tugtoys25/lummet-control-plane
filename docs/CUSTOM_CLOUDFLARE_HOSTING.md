# Customer-owned Cloudflare hosting

Optional and off by default. When enabled for an organization, a site can run in the customer's own Cloudflare account
instead of Lummet's, on `<worker>.<their-subdomain>.workers.dev` or on a hostname in one of their own zones. Sites hosted
by Lummet are not affected in any way: a site without a `site_custom_hosting` row goes through exactly the code paths it
always did.

## Switching it on

| Control | Where | Effect |
| --- | --- | --- |
| Platform switch `CUSTOM_HOSTING` (`on`/`off`, default `off`) | Staff console > Custom hosting, or Platform settings | Master switch. Off = nobody can add accounts, create custom-hosted sites or start moves. |
| Plan entitlement `hosting.custom_cloudflare.enabled` | Plan catalog / plan entitlements | Organizations on a plan with it get the feature (when the switch is on). |
| Per-organization access (`allow` / `deny` / default) | Staff console > Custom hosting | `allow` grants it regardless of plan, `deny` removes it even when the plan includes it. |

Effective access = switch on AND (allow OR (entitlement AND NOT deny)). Turning access off never breaks running sites:
sites already in a customer's account keep deploying, receiving rollouts and being manageable ("in use"), only new
accounts, new custom-hosted sites and new moves are refused. The customer pages and API answer 404 for organizations that
neither have access nor use the feature.

Staff RBAC: `platform / custom_hosting` read (view) and update (switch, access, retry a move, remove an old copy).

## Customer flow

1. Settings > Cloudflare hosting (`/app/cloud-hosting`): add one or more Cloudflare accounts (account ID, API token,
   optional R2 S3 access key pair and jurisdiction, optional email-sending key and sender). Each account is verified:
   the token is checked, the account ID confirmed, and every capability probed (`CAPABILITIES` in `worker/custom-hosting.js`).
   The page shows which permissions are missing and why each is needed, and includes the full setup guide (token,
   permissions, account ID, R2 activation and payment plan, R2 keys, domains, workers.dev subdomain, troubleshooting).
2. Domains: zones are read from the account through the API. A domain not yet on Cloudflare can be added from the
   dashboard (zone created in the customer's account, nameservers shown, activation re-checked on demand).
3. Create site: the "Where to host" dropdown lists Lummet's platform domains (unchanged behaviour) plus
   "Custom Cloudflare hosting". Choosing the latter shows: account, landing (workers.dev or own domain), zone and optional
   subdomain. Any number of sites can share an account or a zone; one hostname serves one site.
4. Provisioning and deployments use the normal pipeline with a scoped env (`cloudflareEnvFor`): D1, KV, R2, the Worker,
   secrets, bindings, cron and migrations are all created by API in the customer's account. A Turnstile widget is created
   in their account for the site's hostname; the base URL (`SITE_URL`/`PUBLIC_BASE_URL`) is the chosen address; routing is
   workers.dev plus a Workers Custom Domain on their zone. Custom variables (plain or secret) are set on every release.
5. Existing sites can be moved ("Move to my Cloudflare") — see below.

## Security

API tokens, R2 secret keys, email keys, Turnstile secrets and secret variables are encrypted with `CREDENTIAL_KEK`
(`custom_hosting_secrets`, included in key rotation) and never returned by an API, written to logs, job steps, audit
entries or deployment output. Views expose only a short hint (last 4 characters). Lummet's own Turnstile and email
secrets are never sent to a customer account. Customers manage only their own organization's accounts (admin role for
changes); staff work through the existing RBAC.

## Isolation and rollouts

Every call for a custom-hosted site runs with that customer's token and account ID, and nothing touches Lummet's account for
such a site. In a rollout a custom-hosted site is treated exactly like a Lummet-hosted one: **a failure stops the rollout**
(a release that does not start, a failed health check, a failed migration). The single exception is a failure that is clearly
about the customer's account (401/403, revoked or under-permissioned token, quota or plan limit, R2 not enabled,
`custom_hosting_unavailable`; see `isAccountLevelFailure`). That site is recorded as failed in the rollout, the organization is
notified (once a day per account) and the rollout carries on, because it says nothing about the release.

## Token health

Every saved account is re-verified about every six hours (migration 0112, `sweepAccountHealth`, run by the scheduled tick; a
few accounts per tick, read-only calls). A token that was revoked, expired or lost a permission turns the account **invalid**
and the organization gets an in-app + email notice naming the account and the missing capability (never a credential), repeated
weekly while unfixed, plus a "works again" notice. A Cloudflare outage never changes an account's status.

## Suspension and platform control

Two layers. (1) The signed access state pushed to the site (cooperative: the site's own code honours it). (2) Edge
enforcement (`enforceAccessSweep`): when a custom-hosted site, or its organization, is suspended or closed, Lummet uses the
customer's token to switch workers.dev off and detach the Workers Custom Domain, and restores both on reactivation. Releases
are already refused for such sites. Limit, stated plainly: the customer owns the account, so someone who revokes the token or
re-enables the route by hand in their own Cloudflare can undo layer 2; Lummet cannot prevent that. Storage caps are a billing
matter for custom-hosted sites (the storage is in the customer's account); usage is still metered.

## Moving an existing site

Job type `site_hosting_transfer`, steps: validate → create_resources → copy_media → copy_kv → deploy_target → **cutover**.
Slices are budgeted and resumable; cancel is possible before the switch (targets are removed, the site is un-frozen).
Cutover, in this order: (0) guard: if media files above 95 MB cannot be copied the move stops **before touching the site**
until the customer confirms ("Continue without these files") or cancels; (1) the site is put into maintenance (freeze, refreshed
each slice; if it cannot be, nothing is copied); (2) database export → import; (3) delta pass: media modified since the first pass
and the whole cache are copied again; (4) the copy in the customer's account must answer its health check **with the imported
data**; (5) switch. Any failure un-freezes the site (it keeps serving from Lummet) and the next attempt starts with a fresh
database. If a worker dies while frozen, the signed maintenance state expires on its own within minutes. The window is a few
minutes of maintenance, not zero downtime. Deletions made after the first media pass are not propagated.

Old address: its route is repointed to the control plane, which answers with a 301 to the new address for
`CUSTOM_HOSTING_REDIRECT_DAYS` (default 90; 0 removes the route instead), and the site keeps its platform label so nobody else can
claim it. The old D1/KV/R2 copy is kept until the customer (or staff) removes it. A database export above 100 MB is refused.

## Failed moves, retry and clean-up

- **The 503 bug.** The freeze writes a signed maintenance state into the source D1; the export carried that row to the new database, so
  the moved site answered "Temporarily unavailable". The row (`system_settings.__lummet_site_access_state`) is now deleted in the new
  database right after the import, and the target is wiped (views, virtual tables, tables) before any import.
- **R2 name reuse.** Cloudflare blocks a deleted bucket's name for about a minute. Creation waits it out (up to 120 s, then a plain
  message) instead of failing the move.
- **Retry.** `POST /sites/:id/hosting/transfer/retry` re-queues a failed move; finished steps are not repeated.
- **Cancel / Clean up and start over.** Removes the worker domain, Turnstile widget, Worker, D1, KV and R2 the move created, by recorded
  id and, for a half-created resource, by its planned name. The result is stored (`cleanup_report`) and shown; if anything is left the
  move is NOT marked cancelled and the button becomes "Clean up again". The Lummet site is never touched.

## Copy site

`POST /sites/:id/hosting/copy` `{ name, accountId, landing, zoneId?, subdomain? }` makes an exact, separate copy of a Lummet-hosted
site as a new custom-hosted site (job `site_hosting_copy`: provision → deploy at the source's release → copy_media → copy_kv →
copy_database → finalize). The source keeps running and is never frozen or changed; the copy counts toward `sites.max`; the two do
not stay in sync. Retry: `copy/retry`; delete the copy and everything it created: `copy/cancel`. The maintenance-state row is not copied.
Limits: Lummet-hosted sources only; domains connected on Lummet are not copied; the D1 export can briefly slow the source.

## Domains and DNS records

`/cloud-hosting/accounts/:id/zones/:zoneId/dns` (GET list, POST add, DELETE `/:recordId`; add/delete are admin-only and audited as
`cloud_hosting_dns`). The zone must belong to the saved account. Types A, AAAA, CNAME, TXT, MX, CAA; names are normalised to the zone;
proxy only for A/AAAA/CNAME; hostnames a site is served from, and NS/SOA, are locked. The page shows registrar steps with copy buttons,
re-checks a pending zone every 10 s and turns active on its own. The token needs DNS: Edit for these calls.

## Backups, usage, analytics

Backups, storage sync and usage collection call the site's Super API at its own address (`tenants.api_base_url`, updated on
every move) with the per-site credential the deployment binds, so they reach custom-hosted sites without the platform token
(covered by a test). R2 listing uses the object `last_modified` field.

## What has NOT been verified against live Cloudflare

All tests use a fake provider and recorded requests. Not exercised on a real account: Workers Custom Domain over a zone with
existing DNS records, the D1 export/import flow on a real database, the D1 wipe through sqlite_master, the find-by-name endpoints used for clean-up, the DNS record API with a real token, copy provisioning against the real API, the R2 REST listing field names, the exact error codes
Cloudflare returns for quota / R2-not-enabled (classification is by status and message text), and workers.dev toggling. Run one
move, one copy, one cancel with clean-up, one DNS add/delete and one suspension on a throw-away Cloudflare account before enabling `CUSTOM_HOSTING` for customers.

## Files

- `migrations/0113_custom_hosting_copy.sql` — transfer kind (move/copy), target site, clean-up report (additive).
- `migrations/0112_custom_hosting_hardening.sql` — token-health, enforcement and transfer columns (additive).
- `migrations/0111_custom_cloudflare_hosting.sql` — accounts, secrets, site hosting, org access, transfers.
- `worker/repositories/custom-hosting.js` — all SQL.
- `worker/custom-hosting.js` — access, accounts, planning, binding/routing adaptation, teardown hooks.
- `worker/custom-hosting-transfer.js` — moving an existing site.
- `worker/custom-hosting-api.js` — customer API (`/api/organizations/:org/cloud-hosting…`, `/sites/:id/hosting…`).
- `worker/custom-hosting-routes.js`, `worker/views/pages/custom-hosting.js` — staff console.
- `worker/views/customer-pages/cloud-hosting.js` — customer page and guide; `sites.js` — create form.
- `worker/infra-cloudflare.js` / `worker/infra-provider.js` — Cloudflare API calls used for customer accounts.
