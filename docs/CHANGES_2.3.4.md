# Changes in v2.3.4

- Sprint 1.3: signed tenant-edge serve gate, neutral unavailable response, 5-second cache, 10-minute state freshness, fail-open behavior, periodic deny-state refresh, HMAC Super API update route, durable push jobs/retries/outcomes, repeated-failure alert, and audited staff bulk-reactivation API and an audited retry endpoint for failed per-site state pushes.
- Sprint 1.4: added canMutate/canServe checks to site creation, provisioning, both domain-attach implementations, deployment, tenant-portal proxy, AI gateway and API-key paths; structured reason codes; entry-point-labelled shadow logging; staff access-shadow report; rollout skips suspended sites.
- Sprint 0.2/0.4: separate `env.staging` Worker/D1/R2/Queues, Stripe test-mode secret wiring, staging seeds, migration-history preflight, config checks before deploy, D1 Time Travel bookmark artifact, Node 22/24 CI, pinned Wrangler dependencies, package-lock files and per-file test isolation/timing.
- Control-plane migration `0058_site_access_push_jobs.sql`; tenant migration `0005_site_access_state.sql`. Existing migration filenames are unchanged.
- Restored the full pre-existing `docs/CONFIGURATION.md` and appended v2.3.4 settings rather than replacing the prior configuration reference.
- Reconciled the SQL-ratchet baseline for pre-existing v2.3.3 direct-SQL debt; new site-access SQL is isolated in `worker/repositories/site-access.js`.
- Fixed an existing newsroom discovery SQLite test failure by using positional placeholders instead of numbered placeholders in the UNION query; updated Super API handler/route-count fixtures for the new route.
- `BILLING_SUSPEND_SITES` remains off and `STRIPE_TAX_ENABLED` remains false by default.
