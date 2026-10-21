# v7J: staging validation kit, and the dashboard login fix it uncovered

Tests: control plane 939 (v7I) -> 976, tenant 924 -> 933, all passing. SQL ratchet unchanged at 466. Nothing here has run against real Cloudflare, Stripe or Resend; that is exactly what this kit is for.

## The problem planning the staging run found
A site the platform provisions could not be signed in to. The tenant's login and register pages and server both required a Cloudflare
Turnstile token, and provisioning never configures Turnstile, so nobody (including the administrator v7G lets a customer create) could get
into their own dashboard. Fixed:
- **Tenant server**: with no `TURNSTILE_SECRET` Turnstile is simply off (the 5-attempts-per-15-minutes limiter still applies and is tested);
  with a secret set a valid token is still always required, and a Cloudflare outage fails closed.
- **Tenant pages**: the widget and its script are drawn only when a site key is set, and the page script asks for a token only when a widget exists.
- **Control plane**: set `TENANT_TURNSTILE_SITEKEY` and `TENANT_TURNSTILE_SECRET` and every deploy passes them to every site (both or neither).
  The widget's allowed hostnames must include each site's hostnames; that is a Cloudflare setting.
- Tests: tenant `dashboard-login.test.js` (9: server rules, limiter, register, the real page script run against a stub browser, templates),
  control plane `site-bindings.test.js` (5).

## New: `GET /api/health`
Public, `{"ok":true}` when the database answers, `{"ok":false}` with 503 when it does not (and the failure is recorded). Nothing else is exposed.
For uptime monitors and the staging checks.

## New: `scripts/staging-checks.mjs`
Probes a deployed control plane (and optionally one deployed site) with no secrets: HTTPS and headers, script policy and nonces, request ids,
error pages, who is turned away (portal, staff console, APIs, developer API, maintenance tick), cookie flags, CSRF, cross-organization isolation
(`--with-signup`), the attempt limiter (`--rate-limit`), the public site and sitemap, and for a site: its home and stylesheet, that the open
admin-setup endpoint is gone, that the Super API refuses unsigned requests and the dashboard is not shown signed out. Severities: BLOCKER fails
the run; WARN should be fixed; LAUNCH is the list of things that must be true before taking money (`--launch` fails the run on them).
Run against the real Worker in tests it reports exactly one open launch gate: `/terms` is still a seeded draft. 27 tests, including one that
breaks each thing a check guards and proves that check fails.

## Changed: `scripts/smoke-test.mjs`
After the homepage and stylesheet it now sets the dashboard password, signs in to the site's dashboard and opens it (`--no-dashboard-login`
to skip, `--turnstile-on` when the site has Turnstile and you will sign in by hand). 5 new tests.

## New: `docs/STAGING_VALIDATION.md`
The runbook: 15 phases from preparation to devices, each with exact commands, what a pass looks like, failure injections, and thresholds;
a results table, a defects table, and a go/no-go split into technical and business gates; and what the plan does not prove.

## Not done
Everything in the runbook that needs real services or real people. The legal texts. A penetration test.
