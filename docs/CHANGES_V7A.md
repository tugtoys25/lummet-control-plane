# v7A (from the updated v7A): everything new in wednesday11version

The stable base already had organization-scoped coupons and the four extra alert checks (see CHANGES_V6B.md), so those were
kept as they are; only the Wednesday11 integration was added on top.

## Control plane
- **Public website** (new `worker/public-site/`, `public/` templates, CSS, JS, images): database-driven home, brands,
  updates, insights, partners, authors, `/p/:slug` pages, `/about /security /privacy /terms`, sitemap, robots, edge cache.
  `GET /session-status` drives the header's Sign in / Dashboard link. Replaces the simple v6A homepage
  (`views/pages/home.js` removed). Its SQL lives in `worker/repositories/public-site.js`.
- **Contact and demo forms** (`/contact`, `/demo`, `/forms/:key`) with per-visitor rate limiting, and staff screens
  Site Forms > Forms / Form fields / Inquiries (inquiries are read-only, cannot be created by hand).
- **Staff console redesign**: grouped, collapsible navigation with menu toggle and phone drawer, light/dark theme
  (`views/shell-assets.js`, new `layout.js`). The v6A SaaS links are kept as two super-admin groups (SaaS, SaaS
  Operations); the Two-factor link and the "no second factor" banner are kept.
- **Staff home moved to `/dashboard`** (login, MFA and password-change redirects, 403 links). `/` is now the public site
  for everyone.
- **Analytics page at parity with the tenant** (health, totals, geo, alerts, manual runs: `POST /api/analytics/:kind`),
  **report column picker and group-by** (`GET /api/reports/column-options`), **postback URL shown when creating or
  rotating an integration**, new homepage/site settings keys (titles, intros, canonical URL, form rate limit).
- Migrations renumbered **0006-0010 -> 0033-0037** (v6A already uses 0006-0032). See DEPLOYMENT.md for databases that
  already ran the old ones.
- Test helper `splitSqlStatements` (quote-aware) in `test/support/d1-shim.js`.
- Kept from the base on purpose: customer portal styling (`views/legacy-styles.js`), staff 2FA, key versioning, everything SaaS.
- Not carried over: the standalone repo's one-off integration scripts and manual migrate workflow (obsolete here).

## Tenant (`lummet-tenant`): replaced by the newer wednesday11 code
Header & Hero (dashboards, hero media, online video, component hero), component page types, content landing pages,
admin dashboard shell and grouped menus, generic content engine passes 2-3 (item reviews, geo, related, analytics),
casino/news delete-with-history fix, media range requests, Turnstile site key from an env var (`keep_vars`),
migrations 0059-0061, the second-account deploy workflow and `wrangler.account2.jsonc`. Backup and patch files from the
source zip were left out.

## Things to check
- Visitor inquiries contain personal data and are not tied to an organization; they are NOT covered by customer erasure.
  Staff delete them in Site Forms > Inquiries (see `OUT_OF_SCOPE` in `worker/retention-policy.js`).
- The seeded public navigation has no link to the customer portal (`/app/login`) or sign-up; add one under Navigation links (/cms/nav_links)
  if you want it.
- The tenant build script needs `wrangler`; I could not run it here. Publish a new tenant release to ship the new tenant code.
