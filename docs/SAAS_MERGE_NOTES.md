# SaaS layer merge notes

This control plane = the "nowmybestversion" stable codebase (AI management chat,
newsroom/research/reports/alerts/analytics pages) **plus** the customer/organization
SaaS layer that was previously built (Phases 1-7) on an older fork.

## How the two lines related

- Migrations `0001`-`0004` were byte-identical in both lines.
- Current added `0005_lummet_ai_management.sql`; the SaaS fork added its own `0005`-`0016`.
- No table names collide. SaaS migrations were renumbered `0006`-`0017`; a catalog seed was added as `0018`.

| SaaS fork file        | Merged as               |
|-----------------------|-------------------------|
| 0005_customer_identity | 0006_customer_identity |
| 0006_sites_and_commerce | 0007_sites_and_commerce |
| 0007_audit_customer_actor | 0008_audit_customer_actor |
| 0008_billing | 0009_billing |
| 0009_jobs_and_provisioning | 0010_jobs_and_provisioning |
| 0010_domains | 0011_domains |
| 0011_deployments | 0012_deployments |
| 0012_phase5_entitlements | 0013_phase5_entitlements |
| 0013_developer_platform | 0014_developer_platform |
| 0014_enterprise | 0015_enterprise |
| 0015_webauthn | 0016_webauthn |
| 0016_sso_oidc | 0017_sso_oidc |
| (new) | 0018_seed_catalog |

**Existing deployments:** if your production D1 already ran the old `0005`-`0016`
from the SaaS fork (it should not have, since current never included them), do NOT
re-run these renumbered files blindly; reconcile first.

## Rebase note
Rebased onto the "monday1version" snapshot (adds AI agent mode, /lu-* commands, web search, casinos.website_url fix). Those files are kept as-is; only wrangler.jsonc needed a manual merge.

## What changed in shared files

- `worker/index.js`: SaaS imports; Stripe webhook route (before login page, unauthenticated by design — the handler verifies the signature); the ~1,345-line customer/org/billing/provisioning/domains/deployments/developer-API/`/app/*` portal block spliced before the staff session gate. Current's AI and newsroom routes untouched.
- `worker/audit.js`: one insert now writes both the AI columns (`initiated_by`, `ai_conversation_id`) and the customer columns (`actor_type`, `customer_user_id`, `organization_id`). Existing callers unchanged (defaults apply).
- `worker/views/layout.js`: also exports `STYLES` (needed by `customer-layout.js`).
- `wrangler.jsonc`, `DEPLOYMENT.md`: documented new secrets and migrations; corrected an existing claim that a Cron Trigger is registered (it is not).
- `test/billing.test.js`: one fixture plan key renamed to avoid colliding with the now-seeded catalog.
- `auth.js`, `client.js`, `resources.js`, `permissions.js`, `crud.js`: kept current's versions (strict supersets).

## Verification actually performed

- All 18 migrations apply in order on SQLite; every plan has the full 13-key entitlement set.
- `node --check` on every worker file; `index.js` imports cleanly.
- 334/334 tests pass (`npm test`).

## NOT verified / known limitations (read before production)

1. **`index.js` routing is not integration-tested.** Tests cover the modules, not the fetch dispatcher. The spliced route block has only been syntax- and import-checked. Smoke test signup → login → org → site → checkout in staging first.
2. **No staff UI for the SaaS entities.** Staff cannot yet browse organizations, subscriptions, plans, jobs from the staff console; catalog edits are SQL. Master-prompt section 45 is largely unbuilt.
3. **Billing is Stripe-only and needs your Stripe price IDs.** `plans.stripe_price_id` is empty for every plan; `startCheckout` refuses unconfigured plans by design. Annual prices are not seeded. Founder License and Master have no self-serve checkout.
4. **Provisioning stops at "provisioned"**, per its own header comment; it requires `CF_API_TOKEN`/`CF_ACCOUNT_ID`. Jobs run via `ctx.waitUntil()` (or a Queue, v7D); since v7D a maintenance sweep retries failed provisioning with backoff and dead-letters what keeps failing (see DURABLE_JOBS.md). No Cron Trigger on the free plan: an external pinger drives the sweep.
5. **Not built from the master prompt:** usage-based billing/overage, AI credit ledger, unified job tables (`job_runs`/`job_attempts`), automation engine, backups/restore workflow, approval workflows beyond change-requests, repository abstraction layer (SQL is still inside modules), multi-provider infra beyond Cloudflare interface, hardcoded-value audit. Treat these as roadmap.
6. Seeded entitlements are enforced only where code checks them (`sites.max`, `ai.enabled`, etc.); some keys are seeded ahead of enforcement.
7. Seed prices are the master prompt's suggestions, not commercial truth.
8. `lummet-tenant` was not modified.
9. `wrangler.jsonc` still contains the original D1 id and contact email from the current codebase; change them for other environments.

## Session 2 — closing the gaps found in review

The previous merge (above) was rebased onto the "monday1version" snapshot
(AI agent mode, `/lu-*` commands, web search — see git log). This session
addressed every gap called out in that review, plus one real bug it found
along the way:

1. **Route-level tests** (`test/routes.test.js`) — the original merge had
   only module tests; nothing drove the hand-spliced `worker/index.js`
   through the real fetch handler. Added tests for signup/login/session
   isolation (staff vs. customer), cross-organization isolation, and the
   Stripe webhook signature check.
2. **Email delivery** (`worker/email.js`, migration `0019`) — a
   provider-neutral outbox: durable, encrypted at rest, retried with
   backoff, wiped after send. Wired into signup verification, forgot
   password, and team invitations. **Fixed a real vulnerability found
   while wiring this up:** `acceptInvitation` didn't check that the
   accepting user's email matched the invited email, so a leaked/forwarded
   invitation link could be used by anyone to join at the invited role.
   Signup and forgot-password are now throttled (per-IP and, for
   forgot-password, per-address) so they can't be used to spam an inbox.
3. **Usage metering** (`worker/usage.js` additions, migration `0020`) —
   idempotent `usage_events` + `usage_monthly` aggregate, one entry point
   (`recordUsage`), metric→entitlement limit checks.
4. **AI credit ledger + gateway** (`worker/ai-credits.js`,
   `worker/ai-gateway.js`, migration `0020`) — append-only ledger,
   atomic reserve/settle/refund (can't overspend under concurrency), a
   fixed task registry (no free-form prompts/tool access), rate limiting,
   provider errors never leak upstream detail to the customer.
5. **Job history** (`worker/jobs.js` additions, migration `0020`) — added
   `job_runs`/`job_attempts`/`job_logs` on top of the existing
   `jobs`/`job_steps` tables (kept, not replaced) so a retry is visibly a
   new run and every step attempt/error is recorded.
6. **Backups** (`worker/backups.js`, migration `0021`) — backs up tenant
   content by reading it through the Super API (never the tenant DB
   directly), stores one checksummed JSON object in an R2 bucket
   (`env.BACKUPS`, fails closed if unbound), scrubs secret-named fields,
   verifies checksums before restore, and restore always targets a
   **different** site than the source.
7. **Automation engine** (`worker/automations.js`, migration `0021`) —
   trigger/conditions/actions off the same event types webhooks use.
   Actions come from a fixed registry (email owners, create an in-app
   alert, count usage) — no arbitrary code. Idempotent per (rule, event),
   rate-limited per rule, and actions cannot themselves emit platform
   events, so it cannot loop into itself.
8. **Staff console for the SaaS layer** (`worker/staff-saas.js`,
   `worker/views/pages/saas-admin.js`) — `/platform/saas/*`: overview,
   organizations (suspend/reactivate, entitlement overrides, AI credit
   grants, per-org audit), subscriptions, plans (price/Stripe-id/status
   editing), jobs (history + retry), email outbox. Super-admin only,
   every mutation audited, HTML-escaped.
9. **Organization suspension is now enforced**, not just recorded: a
   suspended/closed organization's customer session can still read its
   own data (so support can look at it with the customer) but every
   mutating request is refused with `organization_suspended`.

Tests added this session: `test/routes.test.js`, `test/email.test.js`,
`test/usage-ai-jobs.test.js`, `test/staff-console.test.js`,
`test/backups-automations.test.js` (89 new tests). Full suite: 434/434
passing.

### Still not done (see the earlier "not verified" list, which mostly stands)

- **Repository layer** — SQL is still inside the modules, not behind a
  `repositories/` abstraction (master prompt section 43). Everything
  works today; this is a maintainability refactor, not a behavior gap.
- **No staff UI for domains/deployments/webhooks/API keys/SSO** — only
  organizations, subscriptions, plans, jobs, and the email outbox got
  staff screens this session.
- **Automation actions are a small, fixed set** (email owners, in-app
  alert, count usage). Extending it (disable an offer, pause a tracking
  link) means adding to `ACTIONS` in `automations.js` — deliberately a
  registry, not a plugin system.
- **Backups cover tenant CONTENT only** (whatever's registered in
  `resources.js`), not tenant D1 schema/config, Worker code, or KV/R2
  the tenant itself owns.
- **AI gateway has three tasks** (`seo_meta`, `summarize`,
  `draft_article`) as a working example of the registry pattern from
  section 16 — not the full tool list the master prompt sketches.
- Route tests exercise the flows above end to end, but this is still not
  a substitute for a real staging deployment against live Cloudflare/
  Stripe/Resend — nothing here has run outside Node's test runner.

## Session 3 — closing Tier 0 and starting Tier 1 of the production readiness roadmap

Implements the beginning of `PRODUCTION_READINESS_ROADMAP.md` /
`CONTINUATION_PROMPT.md`. Starting point: 469 tests passing. Ending
point: 503 tests passing, all new work tested.

### Tier 0 — closed

1. **0.2 CI test gate** — `.github/workflows/deploy.yml` now runs
   `npm test` before `wrangler deploy`; a failing test blocks the
   deploy.
2. **0.3 Migration automation** — `scripts/migrate.mjs`: applies
   `migrations/*.sql` in order, tracked in a new `schema_migrations`
   table, idempotent re-runs, a `--bootstrap` mode for a database that
   already had migrations applied by hand before this script existed
   (needed because several early migrations use non-idempotent `ALTER
   TABLE ... ADD COLUMN`). Tested end-to-end against a real sqlite file
   through a fake `wrangler` CLI shim (`test/migrate.test.js`,
   `test/support/fake-wrangler.mjs`) — not just unit-tested in
   isolation. Wired into CI as a step before deploy.
3. **0.1 Automated build → deploy → active pipeline** (the largest
   single item) — `worker/tenant-template.js` (new module, migration
   `0022`) holds a shared, versioned, R2-backed release (the tenant
   Worker's bundled script + its migrations) that staff publish via a
   new `/platform/saas/releases` screen. `worker/provisioning.js` gained
   `attemptAutoDeploy()`, called automatically right after a site
   reaches `provisioned`: if a release has been published, it hands off
   to `deployments.js`'s own already-tested job (migrate → upload
   script → health check) and the site reaches `active` with no human
   step. If no release has been published, the site honestly stays
   `provisioned` — never a fake `active` (Rule 5). `scripts/
   build-tenant-worker.mjs` produces the release payload from a
   `lummet-tenant` checkout via `wrangler deploy --dry-run --outdir`
   (asks wrangler to do the actual build, rather than reimplementing
   bundling).

   **Known limitation, found while building this, not yet resolved:**
   `lummet-tenant`'s `wrangler.jsonc` also binds a static assets
   directory (`assets: { directory: "./en" }`, ~4MB of CSS/JS/images/a
   service worker) that this pipeline does not upload — only the script
   and D1 migrations. A site auto-deployed this way gets a working,
   routable application immediately, but not its full styling/client-
   side behavior until Cloudflare's separate Workers-Assets upload flow
   is implemented and verified against a live account (deliberately not
   attempted here — see tenant-template.js's header comment for why a
   speculative, unverified implementation of that API would be worse
   than flagging the gap).

   Circular import note: `provisioning.js` now imports `deployments`
   from `deployments.js`, which already imported
   `computeResourceNames` from `provisioning.js`. Verified this
   resolves correctly under Node's ESM loader (both bindings are only
   used inside function bodies, never at module top-level) — see the
   import-resolution check that was run before trusting this, not just
   assumed safe.

### Tier 1 — in progress

4. **1.2 Organization deletion, deactivation, ownership transfer**
   (`worker/organizations.js`, migration `0023`) — `transferOwnership`,
   `deactivateOrganization`/`reactivateOrganization`,
   `requestDeletion`/`cancelScheduledDeletion` (a 30-day grace period,
   never immediate — actually erasing data on that date is roadmap 1.3,
   deliberately not built here, since it needs a retention-policy
   decision this session doesn't have authority to make).

   **Security bug found and fixed while building this:** the first
   draft let a customer "reactivate" an organization regardless of
   *why* it was closed — which would have let a customer undo a STAFF-
   issued suspension (e.g. for fraud) themselves. Fixed:
   `reactivateOrganization` now only succeeds from a customer's own
   voluntary `closed` status, and returns
   `suspended_by_staff_contact_support` for a staff `suspended` status.
   Covered by a dedicated test
   (`test/organization-lifecycle.test.js`, "SECURITY:" prefixed).

5. **1.6 Trial abuse protection** — verified the gap was real (no prior
   check existed). Added a partial, explicitly-scoped mitigation in
   `plans.js`: refuses a new trial if any email already a member of the
   requesting organization previously had a trial in a *different*
   organization. Does not and cannot catch a fresh email address each
   time — that needs a live payment-provider fingerprint (e.g. a Stripe
   SetupIntent) this environment can't exercise. Documented as partial
   in the function's own header comment, not presented as the full
   fix.

6. **1.1 Customer-facing UI** (2 of ~7 pages from the roadmap's
   priority order) — Domains (`worker/views/customer-pages/domains.js`)
   and a combined Usage + AI page
   (`worker/views/customer-pages/usage.js`, covering both of the
   roadmap's "usage/billing detail" and "AI" items at once, since they
   share one page naturally). Both are UI over backend routes that
   already existed and were already tested in prior sessions — this
   closed the "no page reaches it" gap only. Remaining from 1.1's list,
   not yet built: deployments, API keys/webhooks, backups, automations
   pages.

### Not attempted this session (unchanged from the roadmap)

1.3 (account deletion — blocked on a retention-policy decision), 1.4
(remaining staff screens: domains/deployments/webhooks/API
keys/backups), 1.5 (real coupon management), and all of Tier 2/3.
