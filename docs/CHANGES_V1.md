# v1: custom domains by nameserver delegation, configuration samples, production packaging

Built on the v7J codebase (the uploaded `lummet-full-saas-clean.zip`). Control plane tests: 976 before, all passing after.

## New: custom domains by nameserver delegation (docs/CUSTOM_DOMAINS.md)

* **Customer flow.** Add `example.com` in Domains; the dashboard shows the two Cloudflare nameservers and registrar
  instructions; the customer sets them; the dashboard tracks *Domain added > nameservers changed > Cloudflare confirms >
  live* on its own; both `example.com` and `www.example.com` go live with HTTPS and the first becomes the primary address.
* **Records.** Cloudflare's records scan can be imported, and A/AAAA/CNAME/MX/TXT records added, before the switch, so
  email keeps working.
* **Platform.** Zone creation, delegation tracking (public DNS lookup for progress, Cloudflare for truth), Workers custom
  domain attachment, HTTPS proof by a real request, primary domain, redeploy so the Worker learns its URL, emails and the
  `domain.verified` webhook, expiry of unfinished claims, cleanup on organization erasure.
* **Safety.** Platform domains and unclaimed zones can never be taken; plan limits enforced (apex + www count once);
  removing a still-delegated domain needs confirmation; everything is organization-scoped.
* **Operations.** Driven by the existing maintenance tick (`/api/ops/alert-check`); staff Domains screen shows zones;
  new `failed_domains` alert.
* **Data.** Migration `0045_domain_zones.sql` (new `domain_zones`, `domain_zone_events`; `domains` gains `method`,
  `zone_id`, `custom_domain_id`, `failure_reason`). Additive.
* **Code.** `worker/zone-domains.js` (logic, no SQL), `worker/repositories/domain-zones.js`, Cloudflare calls in
  `worker/infra-cloudflare.js`, `lookupNS` in `worker/dns-doh.js`, page `worker/views/customer-pages/domains.js`.
* **Changed behaviour.** The old TXT actions refuse nameserver-method hostnames (`managed_by_nameserver_flow`); custom
  domain usage counts a zone once; the Domains page lists delegated domains as cards.

## New: configuration samples

* `wrangler.jsonc` completed and commented (every var, optional queue and cron, custom-domain tuning).
* `.dev.vars.example` lists every secret, with the exact Cloudflare token permissions.
* `docs/CONFIGURATION.md` is the reference; `scripts/check-config.mjs [--online]` checks a setup before deploying.

## Finding fixed along the way

The earlier custom domain flow gave customers only a TXT record, no CNAME target, and never attached the hostname to the
site's Worker; custom domain limits were displayed but not enforced. The new flow is the default and enforces the limit.
The old flow stays for existing domains and API clients.

## Not done / still open

* Not run against live Cloudflare. Follow the staging test in docs/CUSTOM_DOMAINS.md.
* Subdomain-only delegation (needs Cloudflare Enterprise); DNSSEC for delegated zones.
* The earlier open items from v7J are unchanged: `/terms` is a seeded draft, CSP is report-only by default, live Stripe and
  Resend validation, and the non-code launch gates.

Apply migration `0045`. Required new setting: the token's Zone Edit and DNS Edit permissions.
