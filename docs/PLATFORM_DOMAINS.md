# Platform domains

A **platform domain** is a domain the platform itself serves customer sites on: a site named `my-brand` runs at
`my-brand.<domain>`. Until now there was one, `PLATFORM_DOMAIN_SUFFIX` (for example `lummet.app`). Now staff can add
more (for example `genteelisms.com`, `luminousagents.com`), choose a default, and let customers pick one when they create
a site. Migrations: `0085_platform_domains.sql` (domains) and `0086_site_domain_moves.sql` (moving a site).

A platform with no extra domains behaves exactly as before.

## The env fallback

The first time anything asks, the platform creates one row from the environment: `PLATFORM_DOMAIN_SUFFIX` (hostname) and
`CF_ZONE_ID` (zone), marked as the default and `active`. Once any row exists the env values are ignored for choosing
domains, but they stay the safety net: with no database rows (or in a sync caller) the old behaviour applies. Sites created
before this feature have no stored domain and resolve to the default. When the default is changed, those sites are first
pinned to the old default so their address never moves by accident.

## Add a second domain, end to end

1. **Cloudflare zone.** Add the domain to the same Cloudflare account as the platform and finish the nameserver change at
   the registrar until the zone shows **Active**. The screen never creates zones.
2. **API token.** Edit the platform's `CF_API_TOKEN` (or create a new one and update the secret) so it has, for the new
   zone: *Zone > Workers Routes > Edit* and *Zone > DNS > Edit* (plus the permissions already listed in DEPLOYMENT.md).
3. **Use the apex.** Enter the registrable domain itself (`example.com`), not a subdomain: Cloudflare's free Universal
   SSL covers `example.com` and `*.example.com` one level down, which is what `<slug>.<domain>` needs.
4. **Staff console, Platform domains, Add a domain.** Enter the domain and a label. The screen runs five checks and the
   domain becomes `active` only when all pass:

| Check | What it does | Typical fix |
|---|---|---|
| Zone | Finds the zone by exact name in the platform account; it must be Active | Add the zone / finish nameservers |
| Token permissions | Harmless reads of Workers routes and DNS on that zone | Add the named permission to the token |
| Wildcard DNS | `*.<domain>` must exist and be proxied. If missing, you are asked to confirm creating a proxied `AAAA *` to `100::` (the same record as the main zone) | Turn the orange cloud on, or confirm creation |
| Certificate | Universal SSL must be enabled for the zone | Cloudflare > SSL/TLS > Edge Certificates |
| Live routing test | A short-lived route `platform-check.<domain>/*` to the platform Worker, request `https://platform-check.<domain>/api/health`, then the route is removed | Wait for DNS/certificate, then re-run |

Failed checks show a plain fix and can be re-run (rate limited: it calls Cloudflare). A domain that never passed stays
`pending` or `failed` and cannot be chosen. Re-running on an `active` non-default domain that now fails marks it `failed`
(it stops being offered; existing sites keep running); the **default** is never demoted by a re-run.

5. **Optional:** make it the default (only an `active` domain; asks for confirmation), switch customer choice off, or set
   an entitlement key an organisation needs to pick it.

Customers can **never** connect any platform domain, or a subdomain of one, as their own custom domain (every row counts,
disabled ones too).

## Rules

* The default cannot be disabled or removed until another default is set.
* Disabling a domain stops new sites choosing it; sites already on it keep running.
* Removing a domain is refused while any site uses it, with the number of sites.
* Site slugs stay globally unique (Worker, D1, KV and R2 names derive from the slug), so the same name on two domains gets
  a numbered slug.
* Customers choose a domain only when creating a site. If only one is offered the picker is hidden.

## Permissions and audit

Area `platform`, resource `platform_domains`: action **read** can view the screen and sites on a domain; action **update**
(shown as `platform_domains.manage`) can add, verify, change and move. Super admins have both. Every write is recorded in
the audit log; no secrets are written.

## Move a site to another domain (staff only)

Organization page, Sites, **Move domain**. Choose the target, the number of days the old address keeps redirecting
(default 30, `PLATFORM_DOMAIN_MOVE_REDIRECT_DAYS` changes the default, 0 = no redirect), read the effect, and type the new
address to confirm. Steps, each recorded so a move can be resumed:

1. Create the route for the new host in the target zone (the old one is untouched).
2. Check the new host answers. If it does not, nothing is switched.
3. Switch in **one database batch**: tenant registry host and URL, the site's domain, and its route record. `primary_domain`
   changes **only if it was the platform host**; a verified custom domain is never overwritten.
4. Redeploy so the site learns its new URL (skipped when a custom domain stays primary).
5. Repoint the old route to the control plane Worker, which answers requests for the old host with a redirect (301 for GET/HEAD,
   308 otherwise) to the same path on the new host. A daily job deletes the old route when the days are up.

At every point the site answers at the old host, the new host, or both. A failure shows the step and a plain reason, the
move becomes `failed`, and **Moves** offers *resume* (re-runs only what is left) or *rollback*.

### Rollback

**Moves**, then `rollback` (works while `failed` or `redirecting`, and even after the redirect expired). Order: the old
host is served by the site again (the route is recreated if needed), then the database goes back in one batch, then the
site is redeployed, and only then is the new route removed. If restoring the old route fails, the database is not touched
and the move stays as it was.

### Manual rollback (if the screen is unavailable)

In Cloudflare, point `<old-host>/*` back at the site's Worker (`lummet-tenant-<slug>`); then, in D1: `UPDATE tenants SET host=<old>, api_base_url='https://<old>' WHERE id=<tenant>;`
`UPDATE sites SET platform_domain_id=<old domain id>, primary_domain=<old> WHERE id=<site>;` (primary only if it was the
platform host), fix the `site_resources` route row to the old route, delete the row in `site_host_redirects`, redeploy.

## Not covered / open

* Cloudflare-for-SaaS custom hostnames and the fallback origin stay on the default zone (`cnameTargetFor` is unchanged).
  [OPEN] if you need them per zone.
* The live routing check was written against the Cloudflare API contract and tested with a fake provider. **Not verified
  against real Cloudflare.** A Worker fetching a hostname in its own zone may not trigger that zone's Workers route; if the
  check fails on a healthy setup, request `https://platform-check.<domain>/api/health` from a browser and report it.
* The old-host redirect is answered only when `PORTAL_BASE_URL` is set (it already must be in production) and the request is
  for a different host, so normal portal and visitor traffic never does the lookup.
* Erasing a site that was moved while its redirect was still live deletes the redirect record but not the leftover old
  route in Cloudflare (it is not in the site's resources). It is harmless (the control plane has no redirect for it any more)
  and can be deleted by hand in Cloudflare > Workers Routes.
* Customers moving their own sites between domains: staff only for now.
