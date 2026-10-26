# Decisions — v2.4.0

- Preserve the existing control-plane and tenant projects; this release is additive and keeps the supplied blueprints unchanged under `specs/`.
- Phase 4 creates no database migrations.
- Stripe webhook creation is dry-run by default; endpoint verification is read-only. Live endpoint creation requires explicit CLI and environment approval.
- Stripe test-clock scenarios are dry-run by default; actual test-clock mutations require `--execute` and staging-only test credentials.
- Staging and live verification are not inferred from static checks. `docs/GO_LIVE_RECORD.md` remains unapproved.
- `ENFORCE_PRODUCTION_HYGIENE` defaults to `off` so the optional hygiene gate does not unexpectedly block existing local workflows; owners may enable it in an approved CI/release context.
- `.github/CODEOWNERS` remains a template because the correct owner/team was not supplied. The placeholder is explicitly documented and the optional hygiene check flags it when enabled.
- Complete lockfile regeneration was attempted but the package registry operation timed out in this environment. Existing lockfiles remain dependency-graph stubs; this is an open foundation item and must not be represented as fixed.
- No legal content was approved or published.
