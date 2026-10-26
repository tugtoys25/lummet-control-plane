# Owner decisions required before commercial launch

Status for every item below: **Not verified / owner decision pending**. The software must not silently choose legal, financial, or product policy.

1. Written Stripe confirmation that software serving iGaming-related customers is acceptable; record support reference. No live charge before this decision.
2. Final staging and production hostnames, tenant hostname strategy, and WebAuthn RP ID.
3. Trial duration, card collection timing, no-card trial behavior, grace/restricted/suspended windows, and subscription cancellation policy.
4. Plan prices, annual discounts, add-on/credit pricing, refund policy, statement descriptor, and approved product descriptions.
5. Tax operating model, registrations, tax codes, invoice requirements, and whether Stripe Tax may be enabled. Keep `STRIPE_TAX_ENABLED=false` until approved.
6. Stripe restricted-key scopes, webhook event set/API version, portal configuration, retry schedule ending in mark-as-unpaid, and ownership of failed-payment emails.
7. Cloudflare plan/limits, usage unit costs, retention limits, backup objectives, SLOs, support coverage, and incident escalation.
8. Whether customers can hold multiple products/subscriptions and how credits/add-ons interact with entitlements.
9. Counsel review of Terms, Privacy, DPA, subprocessors, cookie/analytics disclosures, retention/deletion policy, and regional compliance. All generated legal copy remains an unpublished draft marked “Draft, not approved by counsel.”
10. Finance/security approval of go-live record, staging test-clock evidence, restore drill, and live purchase/refund/cancel evidence.
11. GitHub reviewer/team for `.github/CODEOWNERS`; branch protection requiring code-owner review.

These are sign-off blockers, not blockers to shipping safe templates or dry-run tooling. Do not infer approval from missing values.

## Phase F additions (v2.5.1)

12. **GitHub CODEOWNERS owner/team:** OPEN. Supply a real GitHub `@user` or `@org/team` in `docs/release-owner.json`; this repository intentionally does not invent one. Generate CODEOWNERS with `node scripts/check-release-owner.mjs --generate`. Release packaging stays blocked while owner or `[OPEN]` placeholders remain.
13. **AT-14 revenue metric tolerance:** Phase 6 owner/finance decision. Define the accepted reconciliation tolerance and reporting currency before the test fixture is treated as a launch threshold.
14. **AT-15 restore drill:** Phase 6 owner/operator evidence. No restore drill is claimed as run by this release.
15. **Branch protection, required code-owner review, and environment protection:** owner-run GitHub settings; not verifiable from this source tree.

## v2.5.2.4 Phase 5 completion inputs

- Final production portal hostname and `PLATFORM_DOMAIN_SUFFIX` / passkey RP ID.
- `FOUR_EYES_THRESHOLD_CENTS` value.
- Add-on proration policy.
- Founder License commercial terms and counsel approval; keep `FOUNDER_LICENSE_ENABLED=off` until approved.
- Quote entitlement timing confirmation; code defaults to after payment.
