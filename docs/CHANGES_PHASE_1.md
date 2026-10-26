# Phase 0 and Phase 1 (v2.1.0, final): release foundation and revenue integrity

Built from `1msaadversion.zip` (control plane at migration 0047) following `Lummet_Phased_Production_Blueprint.md`.
Nothing existing was removed. Every enforcing change is behind **`BILLING_ENFORCE`** and ships `off`.

## What is in this package

| Sprint | Done | Where |
|---|---|---|
| 0.1 Pipeline controls | Packaging script with its gates; CODEOWNERS; Dependabot; PR CI; lint test that fails on a swallowed error on money/access paths; the missing `deployments.js` hunk from `fixes.patch` applied and tested, `fixes.patch` removed | `scripts/package-phase.mjs`, `.github/*`, `test/no-swallowed-errors.test.js`, `worker/deployments.js` |
| 0.2 Configuration truth | Three crons declared and `scheduled()` branches on `event.cron` (unknown cron runs the tick); heartbeat table; alert `cron_not_running`; new production-required settings in `config-check.js`; stale wrangler comment replaced | migration 0048, `worker/scheduler.js`, `worker/config-check.js` |
| 0.3 Stripe client safety | `Idempotency-Key` on every POST (a POST without one is refused), 10 s timeout, jittered retry on network/5xx only, never 4xx, `StripeError` with `rejected` vs `unreachable`, API version pinned from `STRIPE_API_VERSION`, `livemode` guard with counter and alert `webhook_wrong_mode`, customer creation keyed by organization (no orphan on a race) | `worker/billing-stripe.js`, `worker/billing.js` |
| 1.1 Access state machine | `resolveAccess` / pure `computeAccess` (trialing, trial_expired, active, past_due, restricted, suspended, closed) with write and serve gates; shadow log; `unpaid` maps to `restricted` under `enforce`; entitlements route through it under `enforce` | migration 0049, `worker/access.js`, `worker/entitlements.js` |
| 1.2 Sweep and trial correctness | `billingLifecycle.sweep` in the tick (idempotent, event per change); checkout sends the REMAINING local trial as `trial_end`; `active` only when Stripe says so; grace clock starts at the first failure and is never extended; `invoice.paid` clears it and revives restricted/suspended | `worker/billing-lifecycle.js`, `worker/billing.js` |
| 1.4 Enforcement points (partial) | Write gate on every customer organization mutation (402 with a reason code), billing/trial/export routes exempt; seat limit on invitations and acceptance | `worker/index.js`, `worker/access.js`, `worker/organizations.js` |
| 1.5 Safe deletion and trial abuse | A Stripe failure on deletion is queued and retried (never swallowed); cancel at period end by default, owner may delete now; cancelling a deletion withdraws the queue and resumes the subscription; alert `cancel_pending_stuck`. **Trial abuse (closed in v2.1.0.final):** one trial per business email domain (free-mail excluded) and per card; card fingerprint captured after a trial checkout and stored as a salted hash; a second trial on the same card is ended at once (`enforce`) or recorded (`shadow`); checkout for an owner or domain that already trialed carries no trial and returns `trialRefused`. **N3 fixed:** only OWNERS of the organization are compared, so agency staff invited into a client organization no longer block the client's trial | migration 0050, `worker/organizations.js`, `worker/billing-lifecycle.js`, `worker/trial-abuse.js`, `worker/plans.js` |

Tests added: `test/billing-lifecycle.test.js` (33), `test/no-swallowed-errors.test.js`, `test/package-phase.test.js`, `test/trial-abuse-phase1.test.js` (10; the N3 test was run against the old code and fails there). They cover AT-1, AT-2, AT-3, AT-4, AT-7, AT-8 and AT-10 on the fake provider.

## Rollout (do this in order; each step is a configuration change)

1. Deploy with `BILLING_ENFORCE=off` (default). Behaviour is the same as before, except: Stripe calls now carry idempotency keys and retry, deletion no longer swallows a Stripe failure, and wrong-mode webhooks are rejected.
2. Set `shadow`. The sweep and the write gate only record what they WOULD do (`subscription_access_shadow`). Review it: every organization in it should be explainable.
3. Set `enforce`. Trials expire, past-due ends in restricted, restricted in suspended, writes are refused with 402, seats are limited, new checkouts carry the remaining trial.
4. Only after the serve gate exists (see below) set `BILLING_SUSPEND_SITES=on`.

**Rollback:** set `BILLING_ENFORCE=off`. New columns and tables are additive and simply ignored. A subscription the sweep already moved to `expired`, `restricted` or `suspended` stays in that status; revive it by hand (or let a paid invoice do it) if you roll back mid-flight.

## Decisions made in code (change them if you disagree)

- `trial_expired` and `restricted` each last `BILLING_RESTRICTED_DAYS` (7); the blueprint's "live for 7 days" default.
- `incomplete_expired` is left terminal (not mapped to `restricted` as the blueprint says): it is excluded from the live-subscription lookup everywhere today, and mapping it would revive a dead checkout.
- A `closed` access state is computed, but the organization row is NOT set to `closed` by the sweep; erasure stays driven by `scheduled_deletion_at` as before.
- Stripe will not start a Checkout trial ending in under 48 hours; below that the customer is charged at checkout. **Verify live.**
- Anti-abuse trial fingerprints (table created) are deleted with the organization on erasure.

## Trial-abuse behaviour to know before enforcing

- A second trial from a business domain is refused with `trial_already_used` (`reason: domain`). A company with several unrelated teams signing up separately will hit this: staff can remove the row in `trial_fingerprints` for that domain to allow it (a staff screen is a later sprint).
- The card check happens AFTER Stripe Checkout (the card is only known then). The customer is not refused at the door: the trial is ended and the first invoice is charged immediately. Test this in Stripe test mode with the same card in two organizations **[Verify live]**.
- A failed card lookup fails the webhook so Stripe redelivers; it is never swallowed. Alert `failed_billing_webhooks` covers one that never succeeds.
- Hashes are salted with `TRIAL_FINGERPRINT_SALT` (optional secret; set it before the first trial under `shadow`/`enforce` and never change it).
- Checkout metadata now marks every trial checkout (`has_trial`), including a brand-new plan-days trial, so such a subscription starts as `trialing` rather than `active`.

## NOT in this package (still open from the blueprint)

- **1.3 Serve gate on the tenant edge** (tenant repo): until it exists, suspending a site changes a database row only. `BILLING_SUSPEND_SITES` stays off.
- 1.4: enforcement inside provisioning, domain attach, deployments/rollouts, tenant-portal proxy, AI gateway and API keys beyond the shared write gate; the staff shadow report page (data is in `subscription_access_shadow`).
- 0.2: `workers_dev` is still `true` and `CONTACT_EMAIL` is unchanged (your call: verify the custom domain first); deploy-time failure on a missing var (CI cannot see secrets).
- 0.4 staging environment and promotion pipeline; lockfile and pinned wrangler (needs network and your Cloudflare ids).
- Phases 2 to 7 (emails, catalog, tax, ledger, reconciliation, live verification, commercial surface, trust, enterprise).
- Nothing was run against real Stripe, Cloudflare or Resend. Node 24 was not run (Node 22.22.2 only).
