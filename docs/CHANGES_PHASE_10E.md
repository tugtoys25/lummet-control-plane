# Phase 10 partial E (control plane): changes on top of partial D

**NOT production ready.** Partial E is a small increment: it ran the files partial D never ran, fixed what broke, and added the first block of the missing tests.

## Changed
- `worker/views/layout.js`: the staff nav item **Site presets** (`/platform/saas/site-presets`) moved from the "SaaS Operations" group (it made 11 links) to the "Tenants" group (5 links). The shell test requires at most 10 links per group.
- `test/admin-shell.test.js`: `PREVIOUS_HREFS` now lists `/platform/saas/site-presets`, because the nav gained that link on purpose.

## Added
- `test/site-setup-phase10-customer.test.js` (9 tests), covering Phase 10 A1 to A3:
  - A1 options route: needs a session (401); presets, the resolved default and only this organization's sites; another organization's site name never appears; a non-member is refused; a bad `productId` is 422; a product default changes the resolved default; the route writes nothing.
  - `/app/sites`: preset select with the default label, copy select, Setup column; HTML escaping of site names; another organization's site and setup never shown; "Skipped: switched off" without the raw code and without Retry; Retry for a failed request on an active site.
  - `describeSetup` for every status; `renderSitesPage` shows Retry only when `canManage`, still works with no setup arguments, and a prototype-style site id is not a view.

## Not changed
No tenant change. The tenant code is identical to partial D (and C). No migration.
