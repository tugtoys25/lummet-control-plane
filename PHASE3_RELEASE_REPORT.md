# Lummet v2.3.4 — Release verification report

## Status

**Not production-ready.** This is a staging candidate. The local test suites complete with per-file isolation, but the remote Cloudflare/Stripe acceptance and approval gates have not been executed.

## Implemented

- **Verified (source and tenant tests):** Tenant edge verifies signed site-access state, caches for five seconds, serves a neutral 503/no-store/noindex page for a fresh `suspended` or `closed` state, and fails open on missing, invalid, stale (>10 minutes), or unreadable state. The HMAC Super API remains reachable while public page and public API requests are gated.
- **Verified (source and control-plane tests):** `site_access_push_jobs` is a durable generation-based queue with per-site outcomes, retry/backoff, recovery of abandoned `running` jobs, and terminal `failed` status after five attempts. Denied states refresh on the five-minute scheduler; repeated failures feed `site_access_push_failed` alerting.
- **Verified (source and tests):** `suspendSite`/`reactivateSite`, billing lifecycle and staff organization status changes queue state pushes. Staff bulk-reactivation requires a reason, transitions suspended sites to active, queues `serving`, and writes an audit record. Queue insertion failure rolls that site back and is reported as a partial failure. An audited retry action requeues a fresh desired state after an outage.
- **Verified (source and tests):** `BILLING_SUSPEND_SITES=off|shadow|enforce` rollout (legacy `on` alias) is off by default; shadow mode logs would-be site gating without changing site state. `STRIPE_TAX_ENABLED=false` remains the default.
- **Verified (source and static regression tests):** Mutation/serve guards cover site creation, provisioning, both domain-attach implementations, deployments, tenant-portal proxy, AI gateway, and API-key paths. Refusals include structured reason codes; shadow logs identify the entry point; rollout processing skips suspended sites. The staff access-shadow report reads `subscription_access_shadow`.
- **Verified (source):** staging config and workflow include separate Worker/D1/R2/Queues, Stripe test secrets, `ENVIRONMENT=staging`, migration-history preflight, staging state fixtures, smoke checks, D1 Time Travel bookmark evidence, and a production job behind the `production` GitHub Environment.
- **Verified (source):** Wrangler is an exact `4.46.0` devDependency in the control-plane and tenant release-tools manifests; `npm install -g wrangler` has been removed from the workflows.
- **Verified (local migration rehearsal):** new additive migrations are control-plane `0058_site_access_push_jobs.sql` and tenant `0005_site_access_state.sql`; earlier migration files were not renumbered or edited.

## Verified commands and outputs

- **Verified:** From `lummet-control-plane`, `TEST_FILE_TIMEOUT_MS=60000 npm test` — `SUMMARY files=129 tests=1241 failed=0` (Node v22.16.0). Full per-file durations are in `TEST_TIMINGS_CONTROL_PLANE_v2.3.4.md`.
- **Verified:** From `lummet-tenant/en`, `TEST_FILE_TIMEOUT_MS=60000 npm test` — `SUMMARY files=111 tests=1322 failed=0` (Node v22.16.0). Full per-file durations are in `TEST_TIMINGS_TENANT_v2.3.4.md`.
- **Verified:** `node --test --test-force-exit test/phase-1-3-site-access.test.js` — 10 tests passed, 0 failed.
- **Verified:** `node --test --test-force-exit test/site-access-gate.test.js` — 8 tests passed, 0 failed.
- **Verified:** `node --test --test-force-exit test/super-handlers-structure.test.js test/super-router-structure.test.js` — 9 tests passed, 0 failed.
- **Verified:** `node --test --test-force-exit test/release-tools-sync.test.js` — 2 tests passed, 0 failed.
- **Verified:** `node --test --test-force-exit test/newsroom-authors-discovery.test.js` — 15 tests passed, 0 failed after correcting the existing numbered-parameter query that the SQLite test shim rejected.
- **Verified:** `node scripts/phase-gate.mjs --phase 2 --static-only` — exit 0.
- **Verified:** `node scripts/sql-ratchet.mjs` — exit 0. The baseline records pre-existing v2.3.3 direct-SQL debt; new site-access SQL is isolated in `worker/repositories/site-access.js`.
- **Verified:** `node scripts/migrate.mjs --db lummet-control-plane-db --dry-run` — exit 0; listed migrations through `0058_site_access_push_jobs.sql`; output explicitly says `--dry-run: not applying anything.`
- **Verified:** `python lummet-control-plane/scripts/verify-sqlite-migrations.py` — `PASS control-plane migrations=58 last=0058_site_access_push_jobs.sql`.
- **Verified:** `python lummet-tenant/en/scripts/verify-sqlite-migrations.py` — `PASS tenant migrations=5 last=0005_site_access_state.sql`.
- **Verified:** `node --check` passed for the changed Worker modules, test runners, migration scripts, staging resource scripts and bookmark script checked during this work.
- **Verified:** The tenant test suite caught an existing newsroom discovery failure (`column index out of range`) and two stale structure-count fixtures; these were corrected and the final tenant suite passed.
- **Not verified:** A native all-files `node --test` run was inconsistent in this environment and stalled on later files under aggregate concurrency. `npm test` now uses isolated child processes with a bounded per-file timeout; both complete suites passed with no timeouts.
- **Not verified:** `node scripts/check-config.mjs --staging` was run locally and exited 1 with three expected blockers: the local `wrangler.jsonc` still has the staging D1 placeholder and no `STAGING_STRIPE_SECRET_KEY` / `STAGING_STRIPE_WEBHOOK_SECRET` values. The CI workflow prepares D1 and supplies secrets; it has not been run here.
- **Not verified:** Node 24 was not available locally. The CI workflow matrix is configured for Node 22 and 24.
- **Not verified:** package registry access was unavailable during lock generation. `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` timed out and the offline attempt failed `ENOTCACHED`. Lockfiles exist and Wrangler is pinned, but their full transitive graph has not been validated locally; CI currently uses `npm install` to resolve the dependency graph.
- **Not verified:** no Cloudflare API call, remote D1 migration, staging deployment, staging smoke run, Stripe test-mode acceptance run, Time Travel bookmark capture, GitHub Environment approval or production deployment was executed here.

## Defaults and owner decisions

- `BILLING_SUSPEND_SITES=off` — do not enforce before staging evidence.
- `STRIPE_TAX_ENABLED=false` — keep off until tax registrations and operating model are approved.
- `workers_dev` remains enabled in the base config; owner decision remains open.
- `CONTACT_EMAIL` is unchanged; owner must confirm it.
- GitHub `production` Environment must have required reviewers configured in repository settings.

## Open gates

See `OPEN_ITEMS_v2.3.4.md` and `ACCEPTANCE_CHECKLIST_v2.3.4.md`. In particular, live staging acceptance, Node 24 CI, lockfile regeneration/verification and operator sign-off remain open.
