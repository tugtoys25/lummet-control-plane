# Release: configurable platform (Phase 9 and 10, control plane side)

**Status: NOT production ready.** This page says what is covered by tests that were run, and what was never verified. Nothing here has been run against a real Cloudflare account, D1, Stripe or a real tenant. The tenant side is described in the tenant repository (`en/docs/OPERATOR_CONFIGURATION.md`, `en/docs/LOAD_HARNESS_CONFIGURATION.md`).

## What the release contains
| Area | What | Where |
|---|---|---|
| First configuration | A new site starts from a preset (or a copy of another site of the same organization); applied after the first deploy through Super API (`site-setup`); the request is stored, retried by a sweep, and reported on the Sites page | `worker/site-setup.js`, `worker/repositories/site-setup.js`, migration of Phase 9 |
| Customer screens | Preset picker and "copy from my site" on `/app/sites`, Setup column, Retry (organization admin) | `worker/views/customer-pages/sites.js`, `GET /api/organizations/:id/site-setup/options` |
| Retry sweep | On the 5 minute tick and on `POST /api/ops/alert-check`. Up to 6 tries, growing waits, 5 per run. Two drivers count one attempt (compare-and-swap on `updated_at`). `SETUP_RETRY_SWEEP=off` disables it | `worker/site-setup.js` |
| Staff screen | `/platform/saas/site-presets` (counts, requests, Retry, default preset per plan or product), `GET /api/platform/saas/site-setups` | `worker/views/pages/site-presets-admin.js` |
| Master switch (read only) | `GET /api/platform/saas/sites/:id/site-system` and "Check switch" per site; needs the tenant release with Super API v17 (older tenant: 409 `tenant_not_updated`) | `siteSetup.getSiteSystem` |
| Canary-first rollouts | `canarySiteId` on `POST /api/platform/saas/rollouts` and `POST /api/ci/tenant-release/rollouts`; `ROLLOUT_REQUIRE_CANARY=on` refuses a rollout to every site until a canary of the release has completed; Deployments page controls | `worker/rollouts.js` |
| Draft preview (tenant) | A draft preview is never shown while the master switch is off | tenant `en/worker/site-profile/preview.js` |

No migration was added in Phase 10. Deploy the tenant release **before** the control plane change that reads `site-system`. Config: `SETUP_RETRY_SWEEP` and `ROLLOUT_REQUIRE_CANARY` in `docs/CONFIGURATION.md` (both optional; defaults: sweep on, canary requirement off).

## Verified by tests that were run (one run each, in the integrated tree `1yymostyyd1version`, with the Phase 10 partial H files added)
Control plane:
- `site-setup-phase10.test.js` 16, `site-setup-hooks-phase10.test.js` 12, `site-setup.test.js` 36, `site-setup-routes.test.js` 6, `site-setup-phase10-customer.test.js` 9, `customer-portal-views.test.js` 6: the setup logic, SQL, sweep (backoff, cap, flag, newest only, one failing site, no tenant body stored), both drivers (tick and alert-check), the compare-and-swap, the customer options route and Sites page (same organization only, escaping, Retry for managers).
- `site-presets-staff-phase10.test.js` 7: the staff site-setups route (refusals, shape, filters, read only), the Site presets page (nonce, handlers defined, escaping, Retry only on pending or failed), navigation.
- `phase10-b7-staff-routes.test.js` 14: the `site-system` route (refusals, one tenant call, four fields only, every failure code), the canary start over HTTP (validation, `canary_required`, `rollout_in_progress`), the dashboard canary shape, Deployments page canary controls, "Check switch", the CI path with scopes, and two A5 extras (given up, saved default and sweep text).
- `rollouts-canary-phase10.test.js` 11: `canaryRequired` spellings, validation, a full canary then the rest (the canary site is not deployed twice), failed, cancelled and completed-but-not-succeeded canaries do not pass, dashboard canary shape.
- `preset-ids-pinned.test.js` 1 (control plane) and `en/test/preset-ids-pinned.test.js` 1 (tenant): the preset ids are pinned in both repositories.
- Also run: `csp.test.js` 22, `admin-shell.test.js` 10, `customer-shell.test.js` 7, `rollouts.test.js` 17, `staff-tokens-ci.test.js` 13, `sql-boundary.test.js` 5, `package-phase.test.js` 4.
- Mutation check of the new tests: breaking `canaryRequired`, the canary pass rule, the `site-system` field filter, the no-tenant guard, the disabled button, the escaping of the canary site name and the canary id length each made at least one test fail (the pass rule needed one more test, now added).
Tenant: `preview-system-off.test.js` 8, `config-system-flag.test.js` 25, `site-profile-versions.test.js` 37, `super-handlers-structure.test.js` 4, `super-router-structure.test.js` 6.

## NOT verified (must be done before anyone calls this production ready)
- A full run of the control plane suite and of the tenant suite (only the files listed above were run, never the whole suites).
- Every item of `docs/PHASE_9_LIVE_CHECKS.md` (real tenant apply, retry on a stopped tenant, switch off, staff page on staging, Check switch against old and new tenants, canary on real sites).
- The staging load run of the tenant harness (`en/docs/LOAD_HARNESS_CONFIGURATION.md`).
- Real browser, keyboard and screen reader passes on the Sites page, the Site presets page and the Deployments page.
- The tenant `app-worker` wiring of preview end to end (the unit `resolvePreview` is tested, not a full request through the Worker).
- That the preset list mirrored in `worker/site-setup.js` matches the tenant registry in a future release: each repository pins the same list in its own test, so a change on one side fails a test, but nothing runs both together.
- Behaviour under real D1 (the tests use an in-memory SQLite shim: `meta.changes`, the compare-and-swap and time handling are assumed to match).
- The security review (`docs/SECURITY_REVIEW_PHASE_10_CONTROL_PLANE.md`) is a reading of the code and the tests, not a penetration test.

## Rollout order (recommended)
1. Staging: apply the migrations already in the staff version (none new), deploy the tenant release, run the live checks.
2. Turn `ROLLOUT_REQUIRE_CANARY=on` on staging, roll one tenant as canary, check it, roll out the rest.
3. Production: the same, one low-risk tenant first.
Fast off switches: `SETUP_RETRY_SWEEP=off` (control plane), `CONFIGURABLE_PLATFORM=off` (tenant environment). Neither deletes stored data.
