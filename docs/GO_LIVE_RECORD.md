# Lummet go-live decision record — v2.5.1 template

> **Status: NOT APPROVED / NOT VERIFIED.** This template is not evidence of a live test. Do not authorize live charges while any required item is open.

- Release/version and SHA-256: **fill after package build; not recorded yet**
- Environment / account / Worker names: **owner to fill**
- Date (UTC):
- Service owner:
- Finance approver:
- Security/privacy approver:
- On-call operator:
- Stripe policy / iGaming policy decision reference: **required before any live charge**

## Phase 4 static/local evidence

- [ ] Node 22 CI passed (link/log): — evidence:
- [ ] Node 24 CI passed (link/log): — evidence:
- [ ] Complete control-plane test suite and per-file timing report (link/log): — evidence:
- [ ] Tenant test suite and release workflow passed (link/log): — evidence:
- [ ] Migration verifier and staging D1 rehearsal passed (history/output/rollback proof): — evidence:
- [ ] `node scripts/stripe-webhook-config.mjs --mode test` dry-run reviewed (redacted output): — evidence:
- [ ] `node scripts/stripe-config-verify.mjs --mode test` read-only verification passed (endpoint ID/output): — evidence:

## AT-1 to AT-13 staging acceptance evidence

- [ ] AT-1 trial lifecycle: clock/customer/subscription/event IDs and Lummet state evidence — evidence:
- [ ] AT-2 trial expiry/no-card behavior: clock/customer/subscription/event IDs — evidence:
- [ ] AT-3 failed payment and full dunning/recovery series: delivery and state evidence — evidence:
- [ ] AT-4 authentication-required flow: event/email/access evidence — evidence:
- [ ] AT-5 plan/price mapping: known and unknown price behavior — evidence:
- [ ] AT-6 upgrade/downgrade guard, usage removal list and audited override behavior — evidence:
- [ ] AT-7 member and pending-invitation limit enforcement — evidence:
- [ ] AT-8 deletion/cancellation/reversal and Stripe-outage retry behavior — evidence:
- [ ] AT-9 duplicate/out-of-order webhook handling: repeated delivery yields one effect/email — evidence:
- [ ] AT-10 timeout/5xx and concurrency/idempotency recovery — evidence:
- [ ] AT-11 Stripe retry/rate-limit/pagination behavior — evidence:
- [ ] AT-12 tax profile and EU reverse-charge test case where applicable — evidence:
- [ ] AT-13 catalog reconciliation, unknown price alert and drift behavior — evidence:
- [ ] AT-14 revenue metrics: computed MRR compared with the Stripe report within the owner-approved tolerance; fixture test plus live report evidence — **Phase 6** — evidence:
- [ ] AT-15 control-plane backup restore into staging; measured recovery time and written restore report attached — **Phase 6** — evidence:
- [ ] Test-clock suite result attached; all scenarios passed on staging — evidence:

## Live verification (must be performed by authorized operators)

- [ ] One real purchase on cheapest approved plan observed through webhook, ledger, email and access state (redacted evidence): — evidence:
- [ ] Refund observed through webhook, ledger, email and access state (redacted evidence): — evidence:
- [ ] Cancellation observed through webhook, ledger, email and access state (redacted evidence): — evidence:
- [ ] Stripe iGaming policy approval/reference is on file: — evidence:
- [ ] Tax registrations/product tax codes approved and `STRIPE_TAX_ENABLED` decision recorded: — evidence:
- [ ] Shadow report has zero unexplained differences; write-gate and serve-gate cutovers/rollbacks rehearsed: — evidence:
- [ ] Alerts, on-call ownership, backup/restore and incident runbooks checked: — evidence:

## Open risks and exceptions

| Item | Severity | Owner | Due date | Approved exception / evidence |
|---|---|---|---|---|
| Stripe iGaming acceptance | Critical | Owner | Before live charge | Not verified |
| Real purchase/refund/cancel | Critical | Finance/operator | Before live charge | Not performed by this package build |
| Staging AT-1..15 | Critical | Engineering | Before live charge | Not verified |
| Tax and legal approval | Critical | Finance/counsel | Before commercial launch | Not verified |

## Decision

- [ ] GO — evidence:
- [ ] NO-GO — evidence:
- [ ] GO WITH EXPLICIT EXCEPTIONS (list above) — evidence:

Decision rationale:

Signatures / timestamps:

**Automated evidence evaluator:** `node scripts/go-live-evidence.mjs` is read-only; it never ticks boxes or authorizes live billing.
