# Phase 3, sprint 3.2, first half (v2.3.1): plan sync and plan-change intents

Blueprint: Phase 3, sprint 3.2. Builds on v2.3.0. **One new migration: `0053_plan_change_intents`. The tenant repo is
unchanged** (keep the v2.3.0 tenant package). This is **part 1 of v2.3.1**. Part 2 (the rest of 3.2) and sprint 3.3
complete v2.3.1; sprints 3.4 and 3.5 follow. Phase 3 is not approved by this release.

## Scope of this part

| Sprint 3.2 item | Part 1 (this package) | Part 2 (next) |
|---|---|---|
| Migration 0053 `plan_change_intents` | yes (plus `plan_sync_issues`, `subscriptions.plan_synced_event_at`) | |
| Webhook price to plan mapping, `unknown_price_id` (AT-5) | yes | |
| `changePlan` writes an intent, idempotency key, webhook confirms (N2) | yes | |
| Interrupted change recovers from the intent row | yes (sweep retry) | |
| Downgrade at period end through a subscription schedule | | yes |
| Downgrade guard (usage vs target limits, exact removal list) | | yes |
| Staff override with reason, audited (AT-6) | | yes |

## What changed and why

| Area | Before (v2.3.0) | Now |
|---|---|---|
| Plan change | `plan_id` swapped locally the moment Stripe was called, before Stripe confirmed | **enforce:** an intent row is written first, sent to Stripe with its own idempotency key, and `plan_id` changes only when the webhook confirms the new price |
| Stripe price on a subscription event | ignored (only checkout metadata set the plan) | mapped to a plan through `plan_prices` (any version); the plan follows Stripe |
| A price Lummet does not know | nothing noticed | nothing changes, issue raised, alert `unknown_price_id` |
| Interrupted change | lost | pending intents are resent by the sweep with the **same** key |
| Two simultaneous changes | both could reach Stripe | one in flight per subscription (unique index) |
| Late, out-of-order Stripe event | could move the plan backwards | ignored (`subscriptions.plan_synced_event_at`) |

## Behaviour by `BILLING_ENFORCE`

| Mode | Plan change request | Webhook plan sync |
|---|---|---|
| `off` | legacy: immediate local swap, email sent at once | inert |
| `shadow` | legacy (unchanged), the decision enforce would take is logged | records `shadow_plan_change` rows, changes nothing |
| `enforce` | intent, then Stripe, then webhook; **no local swap, no email until confirmed** | applies the plan, confirms the intent, one status event, one email |

The retry of unsent intents runs in **every** mode, so flipping the flag back never strands a customer's request.

## How a change flows (enforce)

1. `POST /api/organizations/:id/billing/change-plan` resolves the target price from `plan_prices` (3.1), refuses the same plan
   (`409 already_on_plan`), and refuses a second different change while one is in flight (`409 plan_change_in_progress`).
   The same request repeated returns the intent already in flight.
2. The intent is inserted (`pending`, direction `upgrade | downgrade | lateral` by monthly-equivalent price) with key `plan-change:<id>`.
3. Stripe is called with that key. Accepted: `submitted`. Refused (4xx): `failed`, customer sees `422 plan_change_rejected`.
   Stripe unreachable: stays `pending`, the customer is told it is being processed, the sweep retries (after 2 minutes, up to 5
   attempts, then `failed` with the reason).
4. `customer.subscription.updated` carries the new price: the plan is applied, the intent becomes `confirmed`, a status event
   `plan synced from provider: A -> B` is written, and the owners get one "plan changed" email. The email's dedupe key uses
   the **event time**, so a redelivered event cannot send a second one.
5. An intent unconfirmed after 60 minutes raises `plan_change_stuck`; a newer request may then replace it (`superseded`).

`billing-stripe.js` `changePlan` takes the intent's key, and a retry that finds the subscription **already on the target
price** sends nothing (covers a lost answer after Stripe's 24-hour idempotency window).

## Files

| File | Purpose |
|---|---|
| `migrations/0053_plan_change_intents.sql` | tables, indexes, column; rollback notes in the header |
| `worker/plan-sync.js` | the sync rules, `classifyDirection`, unknown-price detection |
| `worker/repositories/plan-change-intents.js` | all SQL for intents and issues |
| `worker/billing.js` | `changePlan` (enforce branch), `submitIntent`, `retryPlanChangeIntents`, sync calls in `customer.subscription.created/updated` |
| `worker/billing-stripe.js`, `billing-provider.js` | idempotency key and already-applied check in `changePlan` |
| `worker/billing-lifecycle.js` | sweep resends pending intents |
| `worker/alerts.js`, `repositories/alert-state.js` | alerts `unknown_price_id`, `plan_change_stuck` |
| `worker/index.js` | customer response carries `pending`; staff routes below |
| `worker/retention-policy.js`, `worker/erasure.js` | intents kept with the subscription for the financial retention period; sync issues erased with the organization |
| `worker/views/customer-pages/billing.js` | "being processed" message and three new refusal messages |
| `test/billing-reminders.test.js` | one existing test updated to the new enforce contract (the confirming webhook, not the request, sends the email) |

Staff routes (all paged, 50 per page): `GET /api/platform/saas/plan-sync-issues[?kind=][&all=1]`,
`GET /api/platform/saas/plan-change-intents[?status=][&subscription=]`, and
`POST /api/platform/saas/plan-sync-issues/:id/resolve` (audited), for an unknown price that is not ours.

## Decisions held as editable defaults (nothing invented as policy)

| Decision | Where | Default | Note |
|---|---|---|---|
| Time before an unconfirmed intent may be replaced and alerts | `INTENT_STALE_MINUTES` in `worker/billing.js`; the alert query in `alert-state.js` | 60 | change both together |
| Retry spacing and attempts for an unsent intent | `INTENT_RETRY_AFTER_MINUTES`, `INTENT_MAX_ATTEMPTS` | 2 minutes, 5 | |
| Proration on upgrade | `billing-stripe.js` `changePlan` | `create_prorations` (charged on the next invoice, as in v2.3.0) | "bill the difference now" (`always_invoice`) is your call; decide before part 2 touches schedules |
| Upgrade vs downgrade | `classifyDirection` | monthly-equivalent price (annual / 12); monthly to annual of one tier is `lateral` | recorded only; used by part 2 |

## Known behaviours to accept before approving

* **No downgrade guard yet.** In enforce, a downgrade is still immediate and prorated, exactly as in v2.3.0. The guard and the
  period-end schedule are part 2.
* **Stripe changes now reach Lummet.** In enforce, a plan changed in the Stripe dashboard or Customer Portal is applied to
  the subscription when its event arrives. The blueprint turns portal plan switching off (sprint 4.1); until then it is a path.
* **The webhook must be delivered.** If `customer.subscription.updated` is not subscribed or fails, the plan never changes
  and `plan_change_stuck` fires after an hour.
* Only the **first** subscription item is read (`items.data[0]`, per the blueprint). A multi-item subscription is not supported.
* The plan changes seconds after the request, when the webhook arrives; the customer page says so.
* `customer.subscription.created` for an already-known subscription now also runs the sync.

## Migration 0053: preflight, rollback

* Additive. No existing rows are read or rewritten. `ALTER TABLE subscriptions ADD COLUMN plan_synced_event_at`, two new tables.
* **Rollback:** set `BILLING_ENFORCE=off` (new paths inert) or deploy v2.3.0, which ignores the tables and column. An intent left
  `pending` or `submitted` has already been sent to Stripe or never will be; Stripe stays the truth for what is charged.

## What is verified and what is not

* Verified by running: the migration on a fresh database; a throwaway script (not shipped) exercising the flows above on the
  fake provider and in-memory SQLite: intent and confirm, double click, in-flight conflict, unknown price and alert, shadow
  and off modes, out-of-order events, rejection, outage and retry with the same key, give-up after 5 attempts, stale
  replacement, alerts healthy on a clean system, retention sweep; the Stripe client with a mocked `fetch` (key sent, no write
  when already applied, 4xx as `rejected`); the targeted suites `billing`, `billing-reminders`, `billing-lifecycle`, `plan-prices`,
  `erasure`, `alerts` (119 of 119 passed on Node 22); `sql-ratchet` and `catalog:check`.
* **Not run, by your instruction:** the full test suite for this release and any new tests. The package is stamped
  **NOT RELEASABLE** by `package-phase.mjs` for that reason; run `npm test` (Node 22 and 24) before approving.
* **Not verified:** any call to real Stripe, real D1, Node 24, the billing page in a browser.

## Staging checklist (record evidence; nothing is ticked for you)

- [ ] Migration 0053 applied to staging.
- [ ] Test-mode subscription: change plan with `BILLING_ENFORCE=enforce`; plan unchanged until the webhook; then changed, one email.
- [ ] Same request twice quickly: one Stripe update (check the request log), one intent.
- [ ] Stripe event for a price not in `plan_prices`: `unknown_price_id` alert; add the price via the catalog sync; next event clears it.
- [ ] Block the webhook endpoint for an hour on a test change: `plan_change_stuck` fires.
- [ ] `BILLING_ENFORCE=shadow`: a dashboard plan change appears under `plan-sync-issues?kind=shadow_plan_change`, plan unchanged.

## Integration addendum (full package 1msaadversion-v2.3.1)

This part was merged into the v2.3.0 full package (control plane + unchanged tenant repo) and the **full control-plane suite
was run on Node 22.22.2: 1210 of 1210 passed, 0 failed**. `npm run catalog:check` and the SQL ratchet pass, migrations
0048 to 0053 are consecutive after the baseline, and `package-phase.mjs --phase 3 --version 2.3.1` reports **Releasable**.
The "NOT RELEASABLE" stamp above describes the standalone part-1 package only. Still not done and not claimed: Node 24 (CI),
any call to real Stripe or real D1, and the staging checklist above plus the open items of `npm run check:phase2`.
