# Phase 10 partial H (control plane): changes on top of the integrated version

**NOT production ready.** Partial H is a small completion patch for the integrated tree (`1yymostyyd1version`, which had partial F plus its own G with TODO 3). It adds the tests and documents of TODO 4, 5 and 6 and one small tenant change. No production code of the control plane changed.

## Added
- `test/phase10-b7-staff-routes.test.js` (14): `site-system` route, canary start over HTTP, dashboard canary shape, Deployments canary controls, "Check switch", CI canary path, two A5 extras.
- `test/rollouts-canary-phase10.test.js` (11): canary rollouts on the real deployment engine with a fake provider.
- `test/preset-ids-pinned.test.js` (1): the preset ids mirrored in `worker/site-setup.js` equal the pinned list (the tenant pins the same list).
- `docs/RELEASE_CONFIGURABLE_PLATFORM.md`, `docs/SECURITY_REVIEW_PHASE_10_CONTROL_PLANE.md`.
- `docs/CONFIGURATION.md` rows and `.dev.vars.example` lines for `SETUP_RETRY_SWEEP` and `ROLLOUT_REQUIRE_CANARY`.

## Tenant (separate patch)
- `en/worker/site-profile/preview.js`: `resolvePreview` returns null while the master switch is off (environment or settings key). Decision recorded in `en/docs/OPERATOR_CONFIGURATION.md`.
- `en/test/preview-system-off.test.js` (8), `en/test/preset-ids-pinned.test.js` (1).

## Not changed
No migration. No change to `worker/` in the control plane.
