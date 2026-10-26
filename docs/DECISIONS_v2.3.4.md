# Decisions — v2.3.4

- **D1 — Fail-open edge gate:** A tenant blocks public serving only when a valid, fresh signed state explicitly says `suspended` or `closed`. Missing, invalid, stale, or unreadable state fails open. This matches the requested availability rule; it means a long control-plane outage can restore serving after the ten-minute state TTL.
- **D2 — State freshness:** Tenant cache TTL is five seconds. Signed deny-state freshness is ten minutes; control-plane scheduled refresh runs every five minutes. This keeps normal state refresh bounded while allowing stale-state fail-open. The TTL/cron interaction still requires staging load and outage tests.
- **D3 — Rollout flag:** `BILLING_SUSPEND_SITES` defaults to `off`, supports `shadow`, then `enforce` (`on` is a backward-compatible alias); no billing-driven suspension is enabled by default. Manual staff suspend/reactivate operations are explicit audited actions and use the same durable push queue.
- **D4 — Persistence:** Site state payloads use the existing HMAC Super API and existing tenant `system_settings`; only durable push outcomes/jobs are added to control-plane D1. No parallel transport or separate tenant state table was introduced.
- **D5 — Migrations:** Add control-plane `0058_site_access_push_jobs.sql` and tenant `0005_site_access_state.sql`; never edit or renumber prior migration files.
- **D6 — Tax:** `STRIPE_TAX_ENABLED` remains false until the owner confirms the tax operating model and registrations.
- **D7 — Test isolation:** `npm test` runs each test file in a bounded subprocess and records per-file timing so leaked handles in one file do not block the whole suite. This changes test execution isolation, not application behavior.
- **D8 — Deployment:** Staging resources are isolated and staging must pass before the production Environment job. The repository owner must configure production reviewers and confirm `workers_dev` and `CONTACT_EMAIL`.
