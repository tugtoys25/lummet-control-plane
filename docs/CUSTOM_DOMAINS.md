# Custom domains by nameserver delegation (v1)

A customer puts their site on their own domain (`example.com` and `www.example.com`) by pointing the domain's
**nameservers** at Cloudflare, through the Lummet dashboard. Lummet tracks the change, connects the site, issues HTTPS
and reports "Live". This replaces the manual TXT/CNAME steps as the default.

## What the customer sees

1. **Domains > Connect your domain**: choose the site, enter `example.com`.
2. The dashboard shows two nameservers (for example `amy.ns.cloudflare.com`, `bob.ns.cloudflare.com`) with Copy
   buttons and plain instructions for their registrar. It also warns about email and DNSSEC.
3. Before switching, they can open **DNS records**: Cloudflare's scan of their existing records can be imported with one
   click, and records (A, AAAA, CNAME, MX, TXT) can be added, so email and other services keep working after the move.
4. They change the nameservers at the registrar. The card shows four steps and updates by itself:
   *Domain added* > *Change nameservers* > *Cloudflare confirms* > *Site is live*.
   "Nameservers detected" appears as soon as public DNS shows the new nameservers, before Cloudflare has confirmed.
5. When Cloudflare confirms, Lummet connects `example.com` and `www.example.com` to the site, HTTPS is issued, and each
   address turns **Live** only after a real HTTPS request to it succeeds. The owners get an email.

## What the platform does

| Step | Trigger | Action |
|---|---|---|
| Add | customer | `POST /zones` (full setup) in the platform account; stores the two nameservers; registers `example.com` and `www.example.com` (status `awaiting_nameservers`); starts Cloudflare's records scan |
| Watch | "Check now" (throttled, 20 s) and the maintenance tick | public DNS lookup of the NS records (progress display only) + zone status from Cloudflare + `PUT /zones/{id}/activation_check` when the registrar shows our nameservers (at most once per `DOMAIN_ACTIVATION_CHECK_MINUTES`) |
| Active | Cloudflare says the zone is `active` | hostnames move to `dns_verified`. Old A/AAAA/CNAME records **at those two names** are deleted (they would block the attachment), then each hostname is attached to the site's Worker with Workers Custom Domains (`PUT /accounts/{id}/workers/domains`); Cloudflare adds the DNS record and certificate. Status `ssl_pending` |
| Live | real `GET https://<hostname>/` succeeds | status `active`. First live hostname becomes the site's primary domain (apex preferred), the site is redeployed so the Worker's own URL is updated, the `domain.verified` webhook fires, owners are emailed |

Check cadence while waiting: every 3 min for the first hour, 10 min to 6 h, 30 min to 24 h, 2 h to 3 days, then 6 h.
All of it is driven by `POST /api/ops/alert-check` (see below) and by the customer's open dashboard tab.

### Why this is safe

* **Ownership proof.** A Cloudflare zone only becomes active when the registrar really delegates the domain. Nobody can
  take over a domain they do not control.
* **No squatting.** A claim whose nameservers are not changed within `DOMAIN_NS_PENDING_DAYS` (7) is cancelled, its
  Cloudflare zone deleted and the name released. A second claim on a name already in use is refused.
* **Platform domains are untouchable.** The platform's own domain, portal host, `workers.dev` and anything above or below
  them are refused; a zone that is not one of Lummet's own claims is never adopted (the platform zone, a claimed zone, or
  an *active* zone nobody here claimed all answer `domain_unavailable`).
* **Plan limits.** `domains.custom.max` is enforced; `example.com` + `www.example.com` count as **one** domain.
* **Removal cannot silently break email.** Removing a still-delegated active domain is refused until the customer
  confirms; deleting the zone while the registrar still points at Cloudflare would stop the whole domain (site and email).
* **Isolation.** Every route is scoped to the caller's organization; another organization's zone answers 404.
* **Honest status.** A hostname is `active` only after a real HTTPS request succeeds, never because time passed.

## Setup (platform operator)

1. **API token.** Create one with these permissions (also listed in `.dev.vars.example`):
   Account: Workers Scripts Edit, Workers KV Storage Edit, Workers R2 Storage Edit, D1 Edit, Account Settings Read.
   Zone: **Zone Edit**, **DNS Edit**, Workers Routes Edit. Resources: the platform account, **all zones**.
   Zone Edit is what allows creating the customers' zones. Set it as the `CF_API_TOKEN` secret.
2. **Apply migration `0045_domain_zones.sql`** (`node scripts/migrate.mjs --db lummet-control-plane-db --remote`).
3. **Run the maintenance tick.** Either a Cron Trigger (`wrangler.jsonc` `triggers`) or an external pinger calling
   `POST https://<control-plane>/api/ops/alert-check` with `Authorization: Bearer <ALERT_CHECK_TOKEN>` every 2 to 5
   minutes. Without it customers only progress while their dashboard tab is open and pressing "Check now".
4. **Check the account's zone limit.** Every customer domain is one zone in the platform Cloudflare account; make sure the
   account's plan allows as many zones as you expect domains. Expired and removed domains delete their zones.
5. `node scripts/check-config.mjs --online` confirms the token can read zones, DNS records and Workers domains.

Optional tuning (defaults shown): `DOMAIN_NS_PENDING_DAYS=7`, `DOMAIN_NS_REMINDER_HOURS=24`,
`DOMAIN_ACTIVATION_CHECK_MINUTES=60`, `DOMAIN_ATTACH_GIVE_UP_HOURS=24`, `DOMAIN_MANUAL_CHECK_SECONDS=20`.

## API

Customer API (session cookie; read = any member, change = admin or owner). `:org` is the organization id.

| Method and path | Purpose |
|---|---|
| `GET /api/organizations/:org/sites/:site/domain-zones` | delegated domains of a site with progress |
| `POST /api/organizations/:org/sites/:site/domain-zones` `{ "domain": "example.com" }` | add; returns `201` with `zone.name_servers`, `hostnames`, `progress` |
| `GET /api/organizations/:org/domain-zones/:zone` | one zone: `zone`, `hostnames`, `progress.phase` / `progress.steps`, `events` |
| `POST /api/organizations/:org/domain-zones/:zone/check` | check now (throttled) |
| `GET .../domain-zones/:zone/records` | zone records (`managed: true` = served by Lummet) and records found by the scan |
| `POST .../domain-zones/:zone/records` `{ type, name, content, priority? }` | add a record (A, AAAA, CNAME, MX, TXT) |
| `POST .../domain-zones/:zone/records/import` | import the scanned records (website records at the connected names are skipped) |
| `DELETE .../domain-zones/:zone/records/:id` | delete a record (managed ones are refused) |
| `DELETE .../domain-zones/:zone` (`?acknowledge=1`) | remove; `409 nameservers_still_delegated` until acknowledged |
| `GET /api/organizations/:org/sites/:site/subdomains` | CNAME-connected subdomains of a site with progress and the records to add |
| `POST /api/organizations/:org/sites/:site/subdomains` `{ "hostname": "shop.example.com" }` | add; `mode: "zone"` (joined an existing delegated zone) or `mode: "cname"` (returns `instructions`) |
| `GET /api/organizations/:org/subdomains/:domain` | one CNAME subdomain: `domain`, `instructions`, `progress`, `events` |
| `POST /api/organizations/:org/subdomains/:domain/check` | check now (throttled) |
| `DELETE .../domains/:id` | disconnect one hostname (delegated, subdomain or earlier TXT flow) |
| `POST .../domains/:id/set-primary` | make a live hostname the primary address |

Developer API: `GET /api/v1/sites/:site/domain-zones` (scope `domains:read`).

Phases (`progress.phase`): `awaiting_nameservers`, `awaiting_dns` (subdomains), `nameservers_detected`, `attaching`, `issuing_certificates`, `live`,
`failed`, `expired`. Error codes: `invalid_domain`, `domain_reserved`, `not_a_root_domain`, `domain_unavailable`,
`domain_already_connected`, `hostname_already_in_use`, `domain_limit_reached`, `site_not_ready`,
`nameservers_still_delegated`, `hostname_managed_by_lummet`, `record_exists`, `record_outside_domain`,
`invalid_record_content`, `invalid_record_priority`, `cname_at_root_not_allowed`, `unsupported_record_type`,
`provider_error`, `managed_by_nameserver_flow` (the old TXT actions on a delegated or subdomain hostname), and for
subdomains `apex_needs_nameservers`, `zone_belongs_to_another_site`, `domain_belongs_to_another_account`,
`custom_hostnames_not_configured`, `subdomain_flow_disabled`.

Staff: **Domains** shows delegated domains (state, whether the nameservers were seen, last check, expiry) above the
hostnames. The `failed_domains` alert fires for a zone that failed in the last 14 days or a hostname that cannot be
attached; a customer who just has not changed nameservers yet is not an incident.

## Single subdomains (v1.1)

For a customer who wants `shop.example.com` (or `www.example.com`) on their site without moving the whole domain.
In the dashboard: Domains > Connect > **One subdomain**. Lummet picks the way:

1. **The parent domain is already delegated to Lummet for the same site** (the whole-domain flow above): the subdomain
   is added to that zone instantly. No new DNS steps. It is attached to the site's Worker like `www`, and any old
   A, AAAA or CNAME record at that exact name is replaced. If the zone is still waiting for nameservers, the subdomain
   waits with it.
2. **The customer's DNS stays where it is** (any provider, including their own Cloudflare account): the dashboard shows
   two records to add:
   * `CNAME  shop.example.com  ->  customers.<PLATFORM_DOMAIN_SUFFIX>` (or `PLATFORM_CNAME_TARGET`). On Cloudflare DNS
     the customer sets it to *DNS only* (grey cloud).
   * `TXT  _lummet-verify.shop.example.com  ->  lummet-site-verification=<token>`: the ownership proof.

   Nothing is registered at Cloudflare until the TXT record is seen (a CNAME alone is shown as progress, never as
   proof). Then Lummet registers a Cloudflare for SaaS custom hostname, routes `shop.example.com/*` to the site's Worker,
   shows any extra record Cloudflare asks for (it appears in the same table), and calls the address live only after a
   real HTTPS request succeeds. The first live address becomes the site's primary domain, the site is redeployed, the
   owners are emailed. A request without records is reminded after 24 hours and cancelled after 7 days; one that is
   registered but never serves HTTPS fails after `DOMAIN_ATTACH_GIVE_UP_HOURS` and can be removed and added again.

Refused with a clear message: a main domain (`apex_needs_nameservers`; use "Whole domain"), a parent domain connected
to a different site (`zone_belongs_to_another_site`) or another account (`domain_belongs_to_another_account`), the
platform's own domains, a name already in use, the plan's domain limit.

Operator setup for the CNAME path (once per platform; the nameserver flow does not need it):

1. **Cloudflare for SaaS** enabled on the platform zone (`CF_ZONE_ID`); check the included hostname allowance for your plan.
2. **A fallback origin.** Run `node scripts/setup-custom-hostnames.mjs` (creates the proxied record
   `customers.<PLATFORM_DOMAIN_SUFFIX>` and sets it as the zone's fallback origin), or do it in the dashboard.
   Until the fallback origin is *active*, adding a subdomain is refused with `custom_hostnames_not_configured`.
3. Apply migration `0046_subdomain_domains.sql`.
4. Optional: `PLATFORM_CNAME_TARGET` (default `customers.<PLATFORM_DOMAIN_SUFFIX>`), `SUBDOMAIN_CNAME_FLOW=off` to turn
   the CNAME path off (subdomains inside an already delegated zone keep working).

## Known limits (be upfront with customers)

* **Delegation is for root domains.** Delegating just `shop.example.com` as its own zone needs Cloudflare Enterprise.
  A customer who must keep their main DNS elsewhere connects a single subdomain instead (next section).
* **All DNS moves.** Anything the domain needs (email, verification TXT, other subdomains) must exist in the zone. The
  dashboard scans, imports and lets customers add records, but it cannot know what a customer forgot.
* **DNSSEC** must be off at the registrar before the change; DNSSEC is not configured for these zones.
* **Redirects.** Both `example.com` and `www.example.com` serve the site; the first live one becomes primary. Redirecting
  one to the other is up to the site itself.
* **Cloudflare timing.** Activation is usually minutes but can take up to 24 to 48 hours after the registrar change.
* **Not yet exercised against live Cloudflare.** The Cloudflare calls follow the documented API (zones, activation check,
  DNS scan/records, Workers custom domains) and are tested through fakes. Run the staging test below before relying on it.

### Earlier flow (TXT + custom hostnames)

Existing TXT-verified domains keep working and keep their actions. That flow only returns a TXT record and does not
tell the customer a CNAME target or route the hostname by itself, so it is not offered for new domains in the dashboard.
The API still accepts it (`POST .../sites/:site/domains`).

## Staging test (run once on real Cloudflare)

Use a spare domain you control and a staging control plane with a provisioned, deployed site.

1. `node scripts/check-config.mjs --online` passes.
2. Dashboard > Domains > connect `<spare-domain>`. Expect two nameservers and phase *Waiting for your nameserver change*.
   In Cloudflare, the zone exists in the platform account as *Pending*.
3. Open DNS records: add a TXT record; if the domain had records, "Import them" appears after a minute or two.
4. At the registrar, set the two nameservers. Expect *Nameservers detected* within minutes, then *Cloudflare confirms*.
   (Press Check now; it also asks Cloudflare to re-check.)
5. Expect both addresses to go *Connecting* then *Live*; `https://<spare-domain>/` shows the site with a valid certificate;
   the Domains page shows the primary badge; the site's latest deployment is a system redeploy.
6. Remove the domain with the nameservers still pointing at Cloudflare: expect the warning; set the registrar back first,
   remove again, and confirm the zone is gone from Cloudflare and the Workers custom domains are detached.
7. Subdomain, DNS elsewhere: run `node scripts/setup-custom-hostnames.mjs`, then connect `shop.<another-domain>` as
   *One subdomain*. Add the CNAME and TXT records at that domain's DNS. Expect *Connecting* within a couple of minutes
   of the TXT record, any extra record Cloudflare asks for listed in the table, then *Live* with a valid certificate. If it
   stays at *Issuing the HTTPS certificate*, check that the CNAME is DNS only and points at the target shown, and that the
   Worker route for `shop.<domain>/*` exists on the platform zone (a Worker route on a SaaS zone for a custom hostname is
   the one thing here that has not been exercised live).
8. Subdomain inside a delegated zone: with step 5 done, connect `blog.<spare-domain>` as *One subdomain*: expect it to be
   attached within a minute and live shortly after, with no DNS steps.
9. Connect a second spare domain and **do not** change nameservers: after `DOMAIN_NS_PENDING_DAYS` it must expire and
   delete its zone (shorten the setting for the test).

If step 2 fails with `provider_error`, the token is missing Zone Edit. If step 5 stays at *Connecting* the Worker may not
be deployed (the hostname fails to attach until it is; it retries and gives up after `DOMAIN_ATTACH_GIVE_UP_HOURS`).
