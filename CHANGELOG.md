# Changelog

## 2.3.5 — 2026-10-23
- Added Sprint 1.6 enforcement cutover/rollback runbook and unexplained-shadow-difference reporting script.
- Added Sprint 4.1 Stripe setup checklist, guarded test-clock preparation harness and go-live record template; these are preparation artifacts, not execution evidence.
- Added staff site-access operations page with organization/site selection, reason-confirmed bulk reactivation, per-site results, push-failure list and retry controls.
- Tenant-portal public service methods now evaluate billing access before entitlement checks so refused requests retain structured billing reason codes.
- Reworked test runners to try natural process exit first and use `--test-force-exit` only as a fallback; report files requiring the fallback.
- Added behavior-oriented access decision matrices and actual service-entrypoint tests.

## 2.6.0 — 2026-10-24 (release 2.6.0.3)
- Added super-admin revenue analytics (`REVENUE_ANALYTICS`, default off): monthly cohorts with NRR, GRR and logo churn, trial-to-paid and activation funnel, per-currency ARPA, deferred revenue from prepaid annual terms, and gross margin by plan tier. All figures are per currency; unknown stays unknown.
- Added an audited, spreadsheet-safe cohort CSV export and audited finance unit-cost settings (reason required), stored in the existing settings table.
- Integration review fixes over the first build: GRR no longer credits expansion; cohorts no longer add currencies together; same-day trial conversions are counted; deferred revenue excludes tax; analytics aggregate in SQL instead of reading whole ledger tables; the flag is declared in `wrangler.jsonc` and validated by `config-check.js`.
- No MRR/ARR job changes and no database migration.

## 2.6.0 — 2026-10-24 (release 2.6.0.4)
- Added public `/status`, `/security`, `/.well-known/security.txt`, `/changelog` and `/contact-sales` routes in the existing public-site renderer, all behind `PUBLIC_TRUST_PAGES` (`off` default: no behaviour change; `shadow`: noindex review pages; `on`: live).
- Added owner-configured `STATUS_PROVIDER_URL`, `SECURITY_CONTACT` and `SECURITY_TXT_EXPIRES`; production config-check requires all four settings.
- `/contact-sales` reuses the existing contact form and Turnstile configuration. No schema or migration changes.

## 2.6.0 — 2026-10-25 (release 2.6.0.5)
- Added `/legal` and eight `/legal/*` draft pages (terms, privacy, DPA, subprocessors, SLA, refunds, acceptable use, cookies) behind `PUBLIC_LEGAL_PAGES` (`off` default, `draft`, `on`). Draft pages are outlines with `[OPEN]` placeholders, watermarked DRAFT FOR COUNSEL, `noindex` and never cached; `on` publishes a page only with a recorded counsel approval for that market and page and counsel-supplied CMS text. No legal wording is shipped.
- Added `/docs` and `/openapi.json` (OpenAPI 3.1 for the `/api/v1/` API-key endpoints and webhook signing) behind the existing `PUBLIC_TRUST_PAGES` flag, plus `scripts/validate-openapi.mjs`.
- Added alert checks `webhook_lag` and `trial_expired_still_live` through the existing alert-state machinery (fire once, remind, resolve) and reconcile-drift, webhook-lag and expired-trial tiles on the staff alerts page.
- Production config-check requires `PUBLIC_LEGAL_PAGES` (and the market map and approvals when `on`). No database migration.

## 2.6.0 — 2026-10-25 (release 2.6.0.6)
- Added versioned Cloudflare WAF rate-limit rules (`config/cloudflare-waf-rate-limits.v1.json`) for staff and customer auth, invitations, billing and contact endpoints, and `scripts/cloudflare-waf-rate-limit-config.mjs` (dry-run default, `--diff`, explicit `--apply`, environment checks, plan-limit checks, rollback of managed rules only). Runbook in `docs/WAF_RATE_LIMITS.md`.
- Added `Retry-After` on the Worker's own 429 responses behind `RATE_LIMIT_RETRY_AFTER` (`off` default).
- Config-check requires the new settings in production. No database migration.

## 2.6.0 — 2026-10-25 (release 2.6.0.7)
- Added Cloudflare Access JWT verification for `/platform/*` and `/api/platform/*` behind `PLATFORM_ACCESS_JWT_MODE` (`off` default: no behaviour change; `shadow`: log reason codes only; `enforce`: 403 without a valid Access JWT, 503 when verification is unconfigured or the key set is unreachable). RS256 only, exact issuer and audience, expiry required, signature checked before claims, no token data logged. Staff sessions, 2FA and RBAC are unchanged and still apply.
- Added `config/cloudflare-access-policy.v1.json` (reviewed template with `[OPEN]` owner values; machine callers such as the Stripe webhook, CI release API and alert pinger stay outside Access), `scripts/cloudflare-access-config.mjs` (offline validation and plan; never calls Cloudflare) and `docs/CLOUDFLARE_ACCESS.md` (runbook, rollback, recovery).
- Production config-check now requires an explicit `PLATFORM_ACCESS_JWT_MODE`, and `CF_ACCESS_ISSUER` and `CF_ACCESS_AUD` once the mode is not `off`. No schema or migration changes.

## 2.6.0 — 2026-10-25 (release 2.6.0.8-pre, stage 1 of Round 6.3C)
- HSTS: `HSTS_PRELOAD` flag (default off, header unchanged), `worker/hsts.js`, preload-eligibility check and `scripts/hsts-preload-check.mjs`.
- CSP reporting: `CSP_REPORT_MODE` (default basic), `worker/csp-report.js`, review tool `scripts/csp-report-review.mjs`. `CSP_MODE` default NOT changed.
- Production config-check requires `HSTS_PRELOAD` and `CSP_REPORT_MODE`. No migration. Logpush, error tracking and tenant checks arrive in 2.6.0.8.

## 2.6.0 — 2026-10-25 (release 2.6.0.8)
- Round 6.3C complete (builds on the `_pre`, `_pre2` and `_pre3` packages): HSTS preload flag and eligibility check, CSP violation reporting and review procedure (`CSP_MODE` default NOT flipped), PII/secret scrubber (`worker/redact.js`), optional error tracking (`ERROR_TRACKING` off|shadow|on, `SENTRY_DSN` secret), log redaction (`LOG_REDACTION`), audit-row log stream (`AUDIT_LOG_STREAM`), Logpush plan and offline checker, production config-check rules for every new setting.
- Tenant repository: `TENANT_CSP_MODE` (`off` default, `report-only`) adds a report-only CSP to customer-site HTML pages that keeps Cloudflare Turnstile working; new Turnstile and CSP tests.
- All new behavior defaults to off. No database migration (highest stays 0070 control plane, 0008 tenant). Out of scope and untouched: WAF (6.3A) and Access (6.3B).

## 2.6.0 — 2026-10-25 (release 2.6.0.9)
- Round 6.4A: organization security policy. Migration `0072_org_security_policy` (table `organization_security_policies`). Org-wide 2FA requirement enforced at sign-in and on every customer session use behind `ORG_SECURITY_POLICY` (`off` default, `shadow`, `enforce`); owner-only change with a mandatory reason, every change and refusal audited; `GET`/`PUT /api/organizations/:id/security-policy`. Billing role and RBAC unchanged.
- Not built (later rounds): sessions list/revoke and audit CSV (6.4B); IP allowlist, lockout recovery and SSO stub (6.4C). `require_sso` and `ip_allowlist_json` are stored columns only.

## 2.6.0 — 2026-10-25 (release 2.6.0.10)
- Round 6.4B: organization session list and immediate revoke (`GET /api/organizations/:id/sessions`, `POST /api/organizations/:id/sessions/revoke`, flag `CUSTOMER_SESSION_ADMIN=off|shadow|on`, default off) and organization audit-log CSV (`GET /api/organizations/:id/audit-log.csv`, flag `CUSTOMER_AUDIT_CSV=off|on`, default off). Admin or owner only, org-scoped, audited. `revokeAllSessionsForUser()` is the reusable revoke core for SCIM deprovision (7.1C).
- No database migration (highest stays 0072 control plane, 0008 tenant). Not built (later round): IP allowlist, lockout recovery and SSO stub (6.4C). Policy schema and 2FA (6.4A) untouched.

## 2.6.0 — 2026-10-25 (release 2.6.0.11)
- Round 6.4C: organization IP allowlist, lockout protection and SSO requirement stub. IPv4, IPv6 and CIDR matching that fails closed (`worker/ip-allowlist.js`); the client address is `CF-Connecting-IP` only, other proxy headers are ignored. Enforced per organization on `/api/organizations/:id/*`, `/api/sites/:id` and `/app/*` behind `ORG_IP_ALLOWLIST` (`off` default, `shadow`, `enforce`), limited to plans with the new entitlement `security.ip_allowlist.enabled` (granted to no plan until the owner defines "business").
- Lockout protection: owner only, mandatory reason, audit row for every change and refusal; a new list must contain the owner's own current address; clearing never needs the entitlement. Recovery: staff `POST /api/platform/saas/organizations/:id/ip-allowlist/clear`, flag `shadow`/`off`, or a lapsed plan. `GET`/`PUT /api/organizations/:id/ip-allowlist`.
- SSO requirement stub behind `ORG_SSO_REQUIREMENT` (`off` default, `shadow`): stored and audited, never enforced (no IdP named, BLOCKED). `PUT /api/organizations/:id/sso-requirement`.
- No database migration (highest stays 0072 control plane, 0008 tenant). 2FA (6.4A) and sessions/CSV (6.4B) untouched. Not built (next round): synthetic monitors (6.5A).

## 2.6.0 — 2026-10-25 (release 2.6.0.12)
- Round 6.5A: synthetic monitors behind `SYNTHETIC_MONITORS` (`off` default, `shadow`, `on`). Four probes on the existing five-minute tick: customer sign-in (login, session check, logout), test-mode checkout session creation (nothing is paid; Skipped on a live Stripe key unless `SYNTHETIC_CHECKOUT_ALLOW_LIVE=yes`), canary customer site (HTTP 200 and an owner-chosen marker) and Cloudflare for SaaS domain-attach readiness (a readiness check, not a create-and-delete cycle). `worker/synthetic-monitors.js`, `worker/repositories/synthetic-monitors.js`.
- A probe is ok only when every step was confirmed: errors, timeouts, bad bodies and stale results are failures; not configured, skipped and blocked are separate states and never ok. Failures page through the existing alert channel and machinery (`synthetic_*` checks in `worker/alerts.js`: once, reminders, resolved).
- Probe state reuses `alert_state` (rows `probe:<monitor>`, hidden from the alert list). No database migration (highest stays 0072 control plane, 0008 tenant).
- Staff Alerts page gains a Synthetic monitors tile; an unprobed monitor reads Unknown, never ok. `config-check.js` validates the new settings and names coverage gaps when the flag is `on`, including login Turnstile on.
- Fixed the `sql-boundary` failure present on 2.6.0.11: the billing-config import moved out of `repositories/alert-state.js` into `worker/alerts.js`.
- New docs `docs/SYNTHETIC_MONITORS.md`. Not built (next round): runbooks and restore drill tooling (6.5B).

## 2.6.0 — release 2.6.0.13 (Round 6.5B)
- Added incident runbooks (`docs/RUNBOOKS.md`, `docs/runbooks/`): webhook backlog, Stripe outage (queue and retry, never fake success), D1 incident, Cloudflare incident, mass email failure, mistaken suspension (audited bulk reactivation, 100-site limit) and the restore drill. Static review only; NOT VERIFIED until exercised.
- Added restore drill tooling `scripts/restore-drill.mjs` (dry run by default; apply only into a `staging` database with `--confirm`) and `docs/RESTORE_DRILL_REPORT_TEMPLATE.md` (AT-15). Owner-run; the report always says NOT VERIFIED.
- The `bulk_reactivate` audit row now records the sorted, de-duplicated site ids in `resource_id` (bounded to 1000 characters). No behaviour change otherwise.
- No migration, no new Worker setting, no changed default.

## 2.6.0 — release 2.6.0.14 (Round 6.5C)
- Nightly load test with explicit pass thresholds: `node scripts/loadtest.mjs --nightly --thresholds config/loadtest-thresholds.v1.json`. A missed threshold exits 1; a scenario with nothing to evaluate exits 3; a run that sent nothing never passes. Thresholds are placeholders (`confirmed: false`). The scheduled workflow `.github/workflows/nightly-loadtest.yml` is off unless the repository variable `LOADTEST_NIGHTLY` is `on`.
- Read-only D1 size check `scripts/d1-size-check.mjs` and `config/d1-size-policy.v1.json`, with the plan to move high-volume tables in `docs/D1_SIZE_AND_TABLE_MOVE_PLAN.md`. Nothing is moved.
- Started the SOC 2 policy set as four drafts in `docs/compliance/` (Draft, not approved; no compliance claim).
- No migration, no Worker change, no new Worker setting, no changed default.

## 2.6.0 — 2026-10-25 (release 2.6.0.15)
- Added `scripts/phase6-gate.mjs` (33 static checks for 6.1A to 6.5C) and `scripts/phase6-at-report.mjs` (AT-1 to AT-15, one at a time, fake provider), plus AT-labelled tests for AT-5, AT-11, AT-12 and AT-13. No feature, flag, migration or Worker change. Release status: production candidate.

## 2.6.0 — release 2.6.0.16
- Added the customer authenticator enrollment page `/app/security/2fa` behind `CUSTOMER_2FA_ENROLL_PAGE` (default off). No migration, no API change.
