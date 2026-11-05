# Phase 9 (control plane): first configuration of new sites

- `migrations/0084_site_setup.sql`: `site_setup_requests`, `site_preset_defaults` (additive, idempotent).
- `worker/site-setup.js` + `worker/repositories/site-setup.js` (all SQL lives in the repository, per the SQL-boundary rule): preset mirror, `resolveDefaultPreset` (explicit > plan > product > full), `planSetup`/`createSetupRequest`, `applySetup`, `retrySetup`, `getSetupForSite`. 409 `setup_not_pending`/`already_configured` = skipped; 200/alreadyApplied = applied; everything else = failed with a short code. Only codes are stored, never tenant bodies; envelope capped at 900 KB.
- `createSite` accepts `preset`, `cloneFromSiteId` (same organization only). A customer using `cloneFromTenantId` is refused (403). With no choice a request with the resolved default is stored.
- `provisioning.attemptAutoDeploy` applies the pending setup only after a successful deploy; fail-open; result returned as `setup`.
- `tenant-defaults.js`: seed `provision_0002_site_setup_pending` (first deploy only).
- Routes: customer `POST /sites` {preset, cloneFromSiteId, sections}; `GET /sites/:id/setup`; `POST /sites/:id/setup/retry` (admin); staff `GET/PUT /api/platform/site-presets/defaults`; staff `GET/POST /api/platform/saas/sites/:id/setup`; `POST /api/tenants` accepts `preset` / `cloneFromTenantId`.
- Deviation from the prompt: the staff route is under `/api/platform/saas/sites/:id/setup`, not `/api/sites/:id/setup`, because `/api/sites` is the customer-session API.
- `env.SETUP_TENANT_REQUEST` is a test seam; production never sets it.
- Retention: `site_setup_requests` erased per site; `site_preset_defaults` listed out of scope.
- No staff UI was added (optional).
