# Phase 10 partial F (control plane): changes on top of partial E

**NOT production ready.** Partial F finishes TODO 2 of PROMPT_NEXT (hook tests and the double-driver decision). Nothing else from the list was started in code.

## Decision: double-driver attempts count (implemented)
The 5 minute tick and `POST /api/ops/alert-check` both run the retry sweep, so both can pick the same request. Before, each called `bumpAttempts`, so `attempts` could count twice (the tenant treats the repeat as already applied, so the site was safe; only the count was wrong).

Now `bumpAttempts(env, id, expectedUpdatedAt)` is a compare-and-swap:
`UPDATE ... SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND updated_at = ? AND status IN ('pending','failed')`.
It returns true when this call counted the attempt, false when another driver did first.
- `sweepSetupRetries` passes the `updated_at` it read (`opts.expectedUpdatedAt`) to `applySetup`.
- `applySetup` returns `{ ok: true, status: "busy", busy: true }` when the swap lost, and does not call the tenant.
- The sweep summary has a new `busy` counter. Busy is never counted as failed.
- Deploy-time apply, staff apply and manual retry pass nothing and always run (unchanged behaviour).

## Changed
- `worker/repositories/site-setup.js`: `bumpAttempts` as above (returns boolean).
- `worker/site-setup.js`: `applySetup` honours `opts.expectedUpdatedAt`; sweep passes it and counts `busy`.

## Added
- `test/site-setup-hooks-phase10.test.js` (12 tests): `worker.scheduled({cron: TICK_CRON})` applies a stale pending request through `env.SETUP_TENANT_REQUEST`; `SETUP_RETRY_SWEEP` off spellings leave it; a failing tenant leaves a short code only; `POST` and `GET /api/ops/alert-check` with the token apply it, without the token 404 and nothing happens, sweep off leaves it; repository swap; applied request not bumped; two drivers (sequential and `Promise.all`) give one tenant call and `attempts` 1; two concurrent sweeps; manual retry and deploy path unaffected; `busy` counter.

## Not changed
No tenant change (identical to C, D, E). No migration.
