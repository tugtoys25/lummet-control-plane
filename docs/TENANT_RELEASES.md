# Tenant releases: publish, roll out, automate (v1.2)

How a change to the tenant code reaches the sites the platform created, and how to automate it.

## The chain (and what is NOT part of it)

```
change tenant code -> publish a RELEASE -> ROLL OUT to the sites
```

* `wrangler deploy` inside `lummet-tenant` updates only the standalone Worker at `lummet-tenant.<you>.workers.dev`. It does
  not touch R2 or any site the platform created. It is not part of this chain. (`deploy-worker.yml` in the tenant repo does
  that on a push to `main`; it is unchanged.)
* **Publishing** (`publish-tenant-release.mjs`) builds the Worker script with wrangler (a dry run, nothing is deployed), uploads
  the script, the static files and the migrations to the control plane, which stores them in the `lummet-tenant-templates` R2
  bucket as a numbered release and marks it active. **No existing site changes.**
* **Deploying to a site** reads that release back from R2 and uploads it to the site's own Worker. The per-site Update button
  does this for one site. A **rollout** does it for all of them, safely.

## What v1.2 adds

1. **Staff API tokens**: a long-lived, scoped secret so a script or a GitHub Actions run can publish and roll out with no
   browser session (the session cookie expires and needs a second factor).
2. **Rollouts**: "deploy the active release to every live site", one at a time, stopping at the first failure.
3. **Progress through the existing machinery**: a rollout advances from the maintenance tick (pinger or Cron), from the open
   staff page, and from the CI script. Progress lives in the database, so nothing is lost if a request dies.
4. **A GitHub Actions workflow** in `lummet-tenant`: tests, publish, optional rollout, on every `v*` tag.

Nothing existing was changed in how a deployment works: a rollout calls the same `startDeployment` the Update button uses,
the durable-job sweep still resumes a deployment whose Worker died, and a failed redeploy still leaves the serving site alone.

## Upgrade

Apply migration `0047_staff_tokens_and_rollouts.sql` (three new tables, nothing existing is altered), then deploy:

```bash
cd lummet-control-plane
npx wrangler d1 execute lummet-control-plane-db --remote --file=migrations/0047_staff_tokens_and_rollouts.sql
npx wrangler deploy
```

## Staff API tokens

Staff console > **Tenant template releases** > *Staff API tokens* > New token. Choose the access:

| Scope | Allows |
|---|---|
| `release:publish` | upload release files and publish a release |
| `rollout:run` | start, advance, read, cancel and resume rollouts |

* The token (`lmst_<8 hex>_<48 hex>`) is **shown once**; only its SHA-256 hash is stored.
* It works **only** on `/api/ci/tenant-release/*`. It cannot sign in, and it reaches no other staff screen or API.
* It expires (default 365 days, at most 730) and can be revoked at once from the same page.
* Wrong tokens are throttled per address (20 failures / window) and every publish, rollout start, cancel and resume made with
  a token is written to the audit log as actor `staff_token` / `token:<prefix>`.
* Super admins only. Treat it like a password: if it leaks, revoke it and create another.

## Rollouts

Staff console > **Deployments** > *Release rollout*. The page shows the active release, how many live sites run it, and a
**Roll out** button when some are behind.

Rules:

* **One site at a time.** The next site is not touched until the previous deployment is active (its health check, including
  a static-asset fetch, passed).
* **Stops at the first failure.** The rollout becomes `failed`; every remaining site is untouched; the failed site keeps serving
  the version it had. An alert (`failed_rollout`) fires if you have alert channels configured. Fix the cause, then **Resume**
  (retries the failed site with a new deployment and continues) or **Cancel**.
* **Skips** sites already on the release, and sites that are not live (provisioning, suspended, failed, deleting). A site with
  another deployment already running is followed if it is the same release, or skipped (`busy_with_another_deployment`) if not.
* **One rollout at a time** (a database constraint). Starting a second returns `rollout_in_progress`.
* **Canary.** The API accepts `siteIds` to limit a rollout to chosen sites: roll out to one site first, check it, then roll out
  to everyone (already-current sites are skipped). In the CI script: `--sites id1,id2`.
* **Timeouts.** A deployment unfinished after 45 minutes, or one the job system gave up on, fails the rollout.
* **Rolling back** = publish/activate the earlier release's version and run a rollout (the API accepts an explicit `version`).
  Migrations are recorded in a ledger and never re-run, same as `rollbackDeployment`.

How it keeps moving, with no setup beyond what you already have:

| Driver | When |
|---|---|
| Staff page | while the Deployments page is open (a step every few seconds) |
| Maintenance tick | each `POST /api/ops/alert-check` from your pinger, and the Cron Trigger if you have one |
| CI script | `--wait` calls advance until the rollout ends |

Any number of drivers can run at once: each step takes a lock, so a site is never deployed twice.

**Note on Workers limits.** Without a `JOB_QUEUE` binding, an interactive step (staff page, CI) runs the deployment job to the
end inside the request, so it is not cut off 30 seconds after the response. The maintenance tick hands the job to
`waitUntil` (it wants a fast reply); if that is cut off, the existing job sweep resumes it within minutes, and the rollout just
waits. On the Workers Free plan the per-request limit on subrequests (about 50) may be too low for a deployment of a site with
many assets; if a deployment fails with a subrequest error, use a paid plan or fewer assets (this limit already applies to the
per-site Update button).

## The CI workflow

`lummet-tenant/.github/workflows/release-tenant.yml`, on every tag `v*` (or run manually):

1. runs the tenant test suite;
2. builds and publishes the release (`tools/release/publish-tenant-release.mjs`, a copy of the control plane script);
3. optionally rolls it out and waits (the job fails if the rollout fails).

One-time setup in the GitHub repository (Settings > Secrets and variables > Actions):

| Name | Kind | Value |
|---|---|---|
| `LUMMET_STAFF_TOKEN` | secret | a staff token with `release:publish` (and `rollout:run` for rollouts) |
| `LUMMET_BASE_URL` | variable | your control plane address, `https://lummet-control-plane.<you>.workers.dev` |
| `AUTO_ROLLOUT` | variable, optional | `true` to roll out automatically on every tag |

**Recommended starting point: leave `AUTO_ROLLOUT` unset.** A tag then only publishes. Look at the release, press **Roll out**
(or run the workflow manually with "rollout" ticked), and switch to `AUTO_ROLLOUT=true` once you trust the pipeline.

Release it:

```bash
git tag v2026.10.21 && git push origin v2026.10.21
```

The version is the tag without the `v`. Re-running the job for a tag that is already published is harmless
(`--allow-existing`).

### Running the script by hand

```bash
cd lummet-tenant        # with wrangler installed
LUMMET_STAFF_TOKEN=lmst_... node tools/release/publish-tenant-release.mjs \
  --base https://your-control-plane --version 2026.10.21 --notes "what changed" \
  [--rollout [--wait] [--sites id1,id2]] [--allow-existing] [--timeout-minutes 90]
```

`--dry-run --skip-build` shows the file count without uploading; `--release-file f.json` publishes a release built earlier.
`LUMMET_STAFF_COOKIE` still works instead of a token.

## API reference

Token API (`Authorization: Bearer lmst_...`):

| Request | Scope | Does |
|---|---|---|
| `GET /api/ci/tenant-release/releases` | publish | list releases |
| `PUT /api/ci/tenant-release/assets?path=/static/app.css` | publish | upload one file (body = bytes) |
| `POST /api/ci/tenant-release/publish` | publish | publish `{version, scriptContent, migrations, assets, notes}` |
| `POST /api/ci/tenant-release/rollouts` | rollout | start `{version?, siteIds?, notes?}`; takes the first step (202) |
| `POST /api/ci/tenant-release/rollouts/:id/advance` | rollout | one bounded step; safe to repeat |
| `GET  /api/ci/tenant-release/rollouts/:id` | rollout | progress and per-site items |
| `POST /api/ci/tenant-release/rollouts/:id/cancel` \| `/resume` | rollout | cancel / retry after a failure |

Staff session API (super admin): `GET/POST /api/platform/saas/rollouts`, `GET .../rollouts/:id`, `POST .../rollouts/:id/advance|cancel|resume`,
`POST /api/platform/saas/staff-tokens`, `POST .../staff-tokens/:id/revoke`.

## Tests

`test/rollouts.test.js` (engine: order, one at a time, stop on failure, resume, cancel, skips, locking, timeouts),
`test/staff-tokens-ci.test.js` (tokens, scopes, throttling, audit, routes, the real script run over HTTP, the tick),
`test/release-tools-sync.test.js` (the tenant repo's copy of the tools has not drifted).

## Not verified live

Written against the deployment engine as it is and tested with a fake Cloudflare provider, like the custom domain work. First
live check: publish a release from CI without `AUTO_ROLLOUT`, roll out to one site with `siteIds`, confirm its CSS loads, then
roll out to the rest.
