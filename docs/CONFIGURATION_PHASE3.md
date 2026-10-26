# Phase 3 configuration

- `STRIPE_TAX_ENABLED`: opt-in boolean string. Set to `true` only after tax operating model and applicable registrations are confirmed. Unset is off.
- Stripe API credentials must match catalog sync `--mode` (`test` or `live`); never put secrets on the command line.
- Billing profile: customer admins edit it at `/app/billing`; profile changes are sent to Stripe before local persistence. Tax IDs remain Stripe-managed.
- Downgrade guard: compares sites, members + pending invitations, and custom domains against the target plan. If the target reduces storage allowance, it blocks until storage usage is verified because this version has no reliable storage meter. Staff override requires a reason and is audited.
- Drift UI: super-admin `/platform/saas/reconciliation`; decisions require a reason and are audited. The `reconcile_drift` alert fires for open findings; `dispute_open` alerts for unresolved disputes.
- Reconciliation CLI: `node scripts/reconcile-billing.mjs --db <d1-name> [--remote] [--limit 100]`. Start with staging and a small limit. It creates drift findings and does not automatically apply Stripe values.
- Migrations: preflight the target D1 migration history and take a backup before applying 0054–0057. Migration 0057 adds billing payment-method records and provider event-order timestamps.
