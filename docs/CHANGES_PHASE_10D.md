# Phase 10 partial D (control plane): changes

NOT production ready. Written, mostly never executed. See NOTES_PHASE_10_PARTIAL_D.md at the package root.

- A1 `GET /api/organizations/:orgId/site-setup/options?productId=` (any member; same organization only; productId checked `^[A-Za-z0-9._:-]{1,120}$`, else 422 `invalid_product`).
- A2/A3 Sites page (`worker/views/customer-pages/sites.js`): "How should the site start?" select (first option = recommended default), "copy from my site" select, plain help text, Setup column (`describeSetup`), Retry button for managers, "Skipped: switched off" for `config_system_off`. `renderSitesPage({sites, products, canManage})` still works; `setupOptions` / `setupViews` are optional. `/app/sites` passes both (fail-open if a read fails).
- A4 `runSetupRetrySweep` called from `runScheduled` (ordinary tick) and from `POST /api/ops/alert-check`. `SETUP_RETRY_SWEEP=off` disables.
- A5 `GET /api/platform/saas/site-setups?status=&limit=` (super admin, inside the `/api/platform/saas/` guard); staff page `/platform/saas/site-presets` (`worker/views/pages/site-presets-admin.js`) with counts, request list, Retry, default-per-plan/product form; nav item "Site presets".
- B7 canary-first: `rollouts.startCanaryRollout`, `canaryState`, `canaryRequired`; `canarySiteId` accepted by `POST /api/platform/saas/rollouts` and the CI `POST /api/ci/tenant-release/rollouts`. Env `ROLLOUT_REQUIRE_CANARY=on` makes a rollout to every site answer 409 `canary_required` until a canary of that release has completed (OFF by default). No migration: a canary is a normal `tenant_rollouts` row whose `notes` start with `canary:<siteId>`. Deployments page shows canary controls.
- B7 switch state: `siteSetup.getSiteSystem` + staff `GET /api/platform/saas/sites/:id/site-system` (read-only, one tenant call on demand); organization detail page has a "Check switch" button per site. A tenant without Super API v17 answers 409 `tenant_not_updated` (deploy the tenant release first).
- `staff-saas.js` org detail query now also selects `tenant_id`.
- Test added: `test/site-setup-phase10.test.js` (16 tests).
