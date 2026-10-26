-- Phase 3.4 completion: provider-sourced payment-method lifecycle, without storing PAN or CVC.
CREATE TABLE IF NOT EXISTS billing_payment_methods (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_payment_method_id TEXT NOT NULL,
  type TEXT,
  card_brand TEXT,
  card_last4 TEXT,
  card_fingerprint TEXT,
  status TEXT NOT NULL DEFAULT 'attached' CHECK (status IN ('attached','detached')),
  is_default INTEGER NOT NULL DEFAULT 0,
  last_event_created INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_payment_method_id)
);
CREATE INDEX IF NOT EXISTS idx_billing_payment_methods_org ON billing_payment_methods(organization_id, status);

-- Event creation timestamps prevent an older Stripe delivery from rolling a newer ledger state backwards.
ALTER TABLE invoices ADD COLUMN provider_event_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE refunds ADD COLUMN provider_event_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE disputes ADD COLUMN provider_event_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE credit_notes ADD COLUMN provider_event_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE organization_billing_profiles ADD COLUMN provider_event_created INTEGER NOT NULL DEFAULT 0;

ALTER TABLE lummet_audit_logs ADD COLUMN reason TEXT;
