# Phase 9 / 10 live checks: ALL NOT RUN

Nothing below has been done against a real Cloudflare account, D1, Stripe or tenant. Do them on staging first.

1. Create a site with each preset and with "copy from my site"; confirm the tenant starts in that configuration after the first deploy.
2. Stop a tenant (or break its credential), create a site, confirm the request shows "Could not apply yet, will retry", then confirm the 5 minute tick retries it with growing waits and stops after 6 tries (watch `site_setup_retry_sweep` log lines).
3. Set `SETUP_RETRY_SWEEP=off`, confirm no retries happen; remove it, confirm they resume.
4. Switch the tenant master switch off (`CONFIGURABLE_PLATFORM`), confirm a pending request ends "Skipped: switched off".
5. Staff: open /platform/saas/site-presets, retry a failed request, set and clear a default for a plan and a product.
6. Organization detail > "Check switch" on a site with the new tenant release and on one with an older release (expect "Deploy the tenant release first").
7. Canary: publish a release, roll out to one site with the canary control, check the site, then roll out to the rest. Repeat with `ROLLOUT_REQUIRE_CANARY=on` and confirm a full rollout is refused first.
8. Browser, keyboard and screen reader pass on the Sites page and the staff Site presets page.
