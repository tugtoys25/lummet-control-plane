# Phase 3, sprint 3.1 (v2.3.0): catalog as code and plan prices

Blueprint: Phase 3, sprint 3.1. Builds on v2.2.2.final. **One new migration: `0052_plan_prices`. The tenant repo is
unchanged.** This is the first half of Phase 3; v2.3.1 (sprints 3.2 to 3.5: plan sync and guarded plan changes, tax and billing
profile, money ledger, reconciliation) completes it. Phase 3 is not approved by this release.

## What changed and why

Before this release a plan held one free-text `plans.stripe_price_id` that any staff member could overwrite from the console,
alongside a separately editable `price_cents`. Nothing tied the two together or to Stripe, and nothing prevented a price being
edited under live subscribers. Now:

| Area | Before | Now |
|---|---|---|
| Where a price comes from | free-text field, staff-editable | `plan_prices` rows, written only by `scripts/stripe-sync.mjs` from `catalog/plans.v1.json` |
| Changing a price | edit in place | add version N+1 in the catalog; the old version is retired, never edited or deleted |
| Checkout and plan change | `plans.stripe_price_id` | the **active** `plan_prices` row for the plan's currency and interval |
| Webhook price to plan mapping | `plans.stripe_price_id` | `plan_prices`, **any version**, so a subscriber still on version 1 keeps mapping after version 2 goes live |
| Test price in a live account (or the reverse) | would fail inside Stripe | refused by Lummet first: `409 price_mode_mismatch` |
| Staff plans screen | Stripe id and Price buttons | read-only price, lookup key, version, mode and an "amount differs" flag; Retire/Activate stays |
| `POST /api/platform/saas/plans/:id` with `priceCents` or `stripePriceId` | accepted | `422 price_managed_by_catalog` (audited like every plan edit) |

## Files

| File | Purpose |
|---|---|
| `migrations/0052_plan_prices.sql` | table, one-active-price index, backfill from `plans.stripe_price_id`, preflight and rollback notes in the header |
| `catalog/plans.v1.json` | 10 products, 50 plans, 48 prices, limits, tax defaults, the two owner decisions (below). Generated from the seeded plans, so **it starts out equal to what you sell today**; a test keeps it equal to the seeds |
| `worker/catalog.js` | pure rules shared by the script, the tests and `npm run catalog:check`: lookup key, validation |
| `worker/plan-prices.js`, `worker/repositories/plan-prices.js` | `resolveCheckoutPrice`, `planIdForPrice`, `stripeModeFromEnv`, paged list |
| `scripts/stripe-sync.mjs`, `scripts/stripe-sync-lib.mjs` | the sync (dry run by default) |
| `GET /api/platform/saas/plan-prices` | staff, paged (50), filter `?plan=<plan id>` |
| `test/catalog.test.js`, `test/plan-prices.test.js`, `test/stripe-sync.test.js`, `test/support/plan-prices.js` | 46 new tests |

`worker/billing-stripe.js` only gains `export` on the existing `stripeRequest`, so the script reuses the same client (pinned API
version, idempotency key on every POST, timeout, jittered retry on 5xx, never on 4xx).

## How prices work

* **Lookup key** = `<plan key>_<interval>_<currency>_v<version>`, for example `casino_news_starter_month_usd_v1`. Never reused.
* **Product ids** are fixed (`prod_lummet_<product key>`), so a sync can never create a duplicate product.
* **Immutability.** Stripe cannot edit an amount; Lummet does not either. Nothing under `worker/` updates or deletes a
  `plan_prices` row or writes `plans.stripe_price_id` (a test greps for it). The sync writes SQL that only inserts, stamps the
  Stripe mode and flips `active`. Editing an already-synced amount in the catalog is reported as a conflict.
* **One active price** per plan, currency and interval (a unique partial index). Existing subscribers stay on the price they
  bought; only new checkouts use the active version.
* **Rollback support.** The sync also mirrors the active price into `plans.stripe_price_id` and `plans.price_cents`, so v2.2.2
  keeps selling what the catalog says if you roll back.

## Changing a price (the only way)

1. In `catalog/plans.v1.json`, on the plan: set the old price entry `"active": false` and add
   `{ "version": 2, "currency": "usd", "interval": "month", "unit_amount_cents": 600, "tax_behavior": null, "active": true }`.
2. `npm run catalog:check`
3. Staging first: `node scripts/stripe-sync.mjs --mode test --db <staging-db> --remote` (dry run, read-only). Read it.
4. Same command with `--apply`. Check the staff plans screen.
5. Repeat for production with `--mode live` and the live key, **only after the Stripe iGaming policy answer is on file**.

## The sync, in detail

```
node scripts/stripe-sync.mjs --offline                                              validate only (no key, no network)
STRIPE_SECRET_KEY=... node scripts/stripe-sync.mjs --mode test --db <d1> [--remote]           dry run
STRIPE_SECRET_KEY=... node scripts/stripe-sync.mjs --mode test --db <d1> [--remote] --apply   create, then write plan_prices
   --catalog <file>   --sql-out <file>   (keep the exact SQL that ran)
```

* It refuses when `--mode` differs from the key's mode, when the key is missing, when `--db` is missing (existing prices must
  be read first), and when the catalog is invalid or breaks the entry price floor. All before any call.
* Per catalog price it finds the Stripe price by lookup key; otherwise **adopts** the legacy price the database already holds
  (sets the lookup key on it, so customers already paying keep their price id) or creates one.
* **Conflicts stop everything and write nothing:** Stripe's amount/currency/interval differs from the catalog; a legacy price in
  use charges a different amount than the catalog says; the database maps a lookup key to a different Stripe id; a price is archived
  in Stripe but active in the catalog; `livemode` disagrees with `--mode`; the database already holds prices of the other mode; a
  tax behavior would have to change once set.
* **A legacy id that does not exist in this Stripe mode** never worked here, so no subscription in this mode can use it: it is
  replaced by the catalog price.
* **Part-way failure is safe.** The database is written only after every Stripe step succeeded; Stripe creates are idempotent and
  found again by lookup key on the next run. A second run on a finished sync sends no write to Stripe and changes no row.
* Every applied run writes one `lummet_audit_logs` row (`plan_prices`, `catalog_sync:<mode>:v<n>:<count> prices`, operator from
  `GITHUB_ACTOR` or `USER`).

## Owner decisions held as editable data (generic defaults, nothing invented)

Your instruction was to use generic, editable data where a decision is needed. These live in `catalog/plans.v1.json`; change them
there, never in code:

| Decision | Where | Default | Effect |
|---|---|---|---|
| Entry price floor (blueprint decision 3) | `decisions.entry_price_floor_cents` | `null` (no floor) | when set, `catalog:check` and the sync refuse any active price below it. The cheapest seeded price is 500 cents |
| Annual by default (decision 6) | `decisions.annual_default` | `false` | read by the pricing page in Phase 5.1; no effect on checkout today |
| Prices and trial days | `plans[].prices`, `trial_days` | exactly the seeded plans (monthly 500 to 149900 cents, annual twins at 10x, 7-day trials on self-serve) | these are the project's earlier suggested figures, not commercial truth; change before the first live sync |
| Tax code | `tax.default_tax_code`, `products[].tax_code` | `txcd_10103001` (Stripe "SaaS, business use") | sent on product creation; confirm with your accountant in sprint 3.3 |
| Tax behavior | `tax.default_tax_behavior`, `prices[].tax_behavior` | `unspecified` | chosen deliberately: it can still be set **once** later without a new price; `exclusive` or `inclusive` cannot be changed afterwards |

## Migration 0052: preflight, rollback

* Additive. Creates `plan_prices`, two indexes, and backfills one row per existing `plans.stripe_price_id` (version 1, active,
  mode `unknown`, because a Stripe price id does not say which mode it belongs to). The first sync stamps the real mode.
* Never fails the migration: a row that would break a constraint is skipped. The header of the file has three preflight queries
  (shared price ids, non-monthly/annual plans, plans with a price id but no amount); run them before applying and accept or fix
  what they return.
* **Rollback:** deploy v2.2.2. It ignores the table, and the mirrored `plans` columns keep it selling the catalog price.
  There is no rollout flag for this sprint: checkout reads `plan_prices` as soon as the code is deployed, so **run the sync against
  staging, then production, before or at the same time as the first deploy**; until then a plan with no price row answers
  `409 plan_not_billing_configured` (the same answer an unconfigured plan gave before).

## Known behaviours to accept before approving

* A backfilled row's amount is the plan's display amount at the time of the migration, not a verified Stripe amount. The first
  sync checks it against Stripe and stops with `legacy_price_differs` if it is wrong.
* Retired annual twins keep a price row but stay `retired` as plans: activating one is still a staff decision on the plans screen.
* The customer billing page shows "Not available online" for any plan without an active price in its own currency and interval.
* Nothing yet compares `plans.price_cents` with the active price amount at checkout. The staff screen flags a difference; Stripe's
  checkout page always shows the amount actually charged. Sprint 3.2 revisits this with plan changes.

## What is verified and what is not

* Verified: the full control-plane suite on Node 22 (see `REPORT.md` for the count), migration 0052 on a fresh database and on one
  with legacy price ids, and the sync library and command line against a fake Stripe and a sqlite stand-in for D1 (including the
  real `scripts/migrate.mjs` building the database through a fake `wrangler`).
* **Not verified, and not claimed:** any call to real Stripe (the script's request shapes follow Stripe's documented API and reuse
  the existing client, but have never run against an account), real D1 via `wrangler d1 execute`, Node 24 (CI runs it), and the
  staff screen in a browser. The test-mode dry run and apply on staging are the evidence still owed (checklist below).

## Staging checklist for this sprint (record evidence; nothing here is ticked for you)

- [ ] Migration 0052 applied to staging; preflight queries reviewed.
- [ ] `node scripts/stripe-sync.mjs --mode test --db <staging> --remote` dry run read and understood.
- [ ] Same with `--apply`; 48 prices visible in the Stripe test dashboard with lookup keys; `plan_prices` has 48 rows, mode `test`.
- [ ] A second `--apply` sends no write to Stripe (check the Stripe request log) and changes no row.
- [ ] Test-mode checkout on one monthly and one annual plan opens Stripe Checkout at the catalog amount.
- [ ] A price change rehearsal (version 2 of one plan): new checkout uses v2, an existing test subscription stays on v1 and still syncs.
- [ ] Staff plans screen: no edit buttons for price; "amount differs" flag appears when `plans.price_cents` is changed by SQL.

## Rollout order

1. Deploy to staging, run migration 0052 (`scripts/migrate.mjs`), run the sync in test mode (dry run, then apply).
2. Work through the checklist above.
3. Production: migrate, deploy, run the sync with `--mode live` **after** Phase 4's Stripe configuration and the iGaming policy
   answer. Until then production has no live prices and checkout answers `plan_not_billing_configured`, as it did.
