# Lummet v2.3.5 release notes

## Scope
- Sprint 1.6 cutover and rollback documentation plus shadow-difference report script.
- Staff site-access UI for bulk reactivation and push retry, linked from staff navigation.
- Tenant-portal billing-gate ordering fix.
- Test runner natural-exit detection and per-file handle-leak reporting.
- Sprint 4.1 setup checklist, Sprint 4.2 test-clock harness (preparation only), and go-live record template.

## Safety defaults
- `BILLING_ENFORCE` default remains `off`.
- `BILLING_SUSPEND_SITES` default remains `off`.
- `STRIPE_TAX_ENABLED` remains `false`.

## Verification caveat
The Stripe test-clock suite was not run. This release is not production-ready; see `VERIFICATION_REPORT_v2.3.5.md` and `OPEN_ITEMS_v2.3.5.md`.
