# v7G: first administrator of a site, annual plans, public pricing page, stronger trial check

Tests: control plane 888 (v7F) -> 913, tenant 924 (all passing). Nothing run against live Cloudflare or Stripe.

## A v7E bug found and fixed first
With `CSP_MODE=enforce`, v7E would have replaced the public site's own policy (`script-src 'self'`) with a nonce-only policy and
blocked the seven same-origin scripts the public pages load (menu, theme, forms...). The report-only default hid it, and my
v7E tests skipped the public pages because they never rendered in the test environment. `finalizeResponse()` now leaves any
response that carries its own policy untouched, and tests render the real public site (home, brands, pricing, contact) in
enforce mode. If you tried enforce on v7E, this is the reason to try again on v7G.

## 1. Customers can get into their own site's dashboard (the top blocker from v7F)
`POST /api/organizations/:id/sites/:siteId/dashboard-admin {password}` (organization admin or owner, site live, rate limited):
the portal hashes the password in the tenant's own format and writes ONLY the hash into the site's own database through
Cloudflare's query API with bound parameters, creating (or resetting) an administrator whose login is the customer's own
verified portal email. Resetting also signs that account out of the site. The password is never stored, logged or audited, and
the hash is not audited either. The Content page has a "Set dashboard password" form per live site (admins only).
- `runD1Query` now accepts `params`; the new statements use `?` placeholders only.
- Tenant: login lookup by email is case-insensitive (`COLLATE NOCASE`).
- This replaces the manual `SETUP_TOKEN` procedure from v7F for normal use; the token-guarded endpoint stays closed otherwise.
- Tests run the exact SQL against the tenant's real schema and verify the hash with the tenant's own `verifyPassword`.

## 2. Annual plans
Migration `0041` adds a RETIRED annual twin of every priced monthly plan (`<id>_annual`, price = 10 x monthly, i.e. two months
free, no second trial, same entitlements copied once). Nothing changes for customers until staff publish one: Staff > Plans >
set its Stripe price id (and price, if different) > Reactivate. Customers then see it on the billing page and can check out on it.
10x is a default, not a commercial decision: edit it before publishing.

## 3. Public pricing page
`/pricing` (in the header, footer and sitemap): active, priced, recurring plans of active products, with price, trial, feature
lines taken from the plan's entitlements, and a Monthly / Annual switch that only appears once an annual plan is published
(annual shows "Save N% compared with paying monthly"). No script, so it is edge-cached like the other public pages. Its words
are editable public UI strings (migration `0041`), and a template test keeps literal text out of the template.
The Get started button goes to the customer sign-in/sign-up; plan choice happens in the portal (billing page).

## 4. Trial abuse: aliases
Customer emails get a comparison key (`email_key`, migration `0042`): lower case, "+tag" removed, and for Gmail dots removed and
googlemail.com unified. The trial check compares keys, so `some.one+promo@gmail.com` no longer gets a second trial after
`someone@gmail.com`. Existing rows are backfilled in SQL; a test proves the SQL and the JavaScript agree. A genuinely different
address is still a new person; closing that needs a payment-method check (not built).

## Test hardening
Two tests waited a fixed 50-100 ms for background work and failed once under load; they now poll up to 5 s.

## Not in v7G
Tax/VAT calculation, refund and cancellation rules as product behavior, a payment-method check for trials, emailing customers when
their dashboard password is set. The SQL ratchet is 484.
