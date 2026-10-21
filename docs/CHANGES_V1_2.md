# v1.2: automated tenant releases

Adds, without changing anything that exists: **staff API tokens**, **rollouts to all sites**, and a **GitHub Actions workflow** for
the tenant repo. Guide: `docs/TENANT_RELEASES.md`.

* Migration `0047_staff_tokens_and_rollouts.sql` (three new tables).
* `worker/staff-tokens.js`, `worker/rollouts.js` and their repositories; routes under `/api/ci/tenant-release/*` (token) and
  `/api/platform/saas/rollouts*`, `/api/platform/saas/staff-tokens*` (staff session).
* Staff pages: a *Release rollout* section on Deployments, *Staff API tokens* on Tenant template releases.
* The maintenance tick and the scheduled handler continue a running rollout; new alert `failed_rollout`.
* `scripts/publish-tenant-release.mjs`: `LUMMET_STAFF_TOKEN`, `--rollout`, `--wait`, `--sites`, `--allow-existing`, `--release-file`,
  retries on network errors. `LUMMET_STAFF_COOKIE` still works.
* `lummet-tenant/.github/workflows/release-tenant.yml` and `lummet-tenant/tools/release/` (a checked copy of the tools).
* Retention policy: `tenant_rollout_items` is erased per site; the other new tables are platform data.

## Upgrade

Apply migration 0047 and deploy the control plane. To automate: create a staff token, set the repository secret/variable, push a
`v*` tag. Nothing changes for existing sites until you press Roll out (or set `AUTO_ROLLOUT=true`).
