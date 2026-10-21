# v1.1: single subdomains

v1 connected whole root domains by nameserver delegation. v1.1 adds **one subdomain** (`shop.example.com`), including for
customers whose domain is already set up (already delegated to Lummet, or already on their own Cloudflare account).

## What changed

* **Subdomain of an already delegated domain** (same site): added to that zone instantly, attached to the Worker, live
  after a real HTTPS check. If the zone is still waiting for nameservers, the subdomain waits with it. Refused with a clear
  message when the zone belongs to another site or account.
* **Subdomain with DNS kept elsewhere** (any provider, including the customer's own Cloudflare account): the dashboard
  shows a CNAME and a TXT ownership record. After the TXT is seen Lummet registers a Cloudflare for SaaS custom hostname,
  routes the hostname to the site's Worker, lists any extra record Cloudflare asks for, and goes live only after HTTPS works.
  Reminder after 24h, cancelled after 7 days without records, failure after 24h of not serving HTTPS.
* Domains page: "Connect" form with *Whole domain* / *One subdomain*, subdomain cards with the records, copy buttons and the
  same live progress tracking. The maintenance tick advances subdomains too.
* API: `GET/POST /sites/:site/subdomains`, `GET /subdomains/:id`, `POST /subdomains/:id/check` (docs/CUSTOM_DOMAINS.md).
* Operator: `scripts/setup-custom-hostnames.mjs` (fallback origin), `check-config.mjs --online` reports the fallback origin,
  `PLATFORM_CNAME_TARGET`, `SUBDOMAIN_CNAME_FLOW`. Adding a CNAME subdomain is refused with `custom_hostnames_not_configured`
  until the fallback origin is active, instead of failing later.
* Erasure also removes the per-subdomain Worker routes.

## Upgrade

Apply migration `0046_subdomain_domains.sql`. Nothing else is required for subdomains inside delegated domains. For the CNAME
path: enable Cloudflare for SaaS on the platform zone and run `node scripts/setup-custom-hostnames.mjs`.

## Not verified live

Written against Cloudflare's documented custom hostname and fallback origin API and tested through fakes. The staging test in
docs/CUSTOM_DOMAINS.md (steps 7 and 8) covers it. One thing to watch: a Worker route for a custom hostname on the SaaS zone.
