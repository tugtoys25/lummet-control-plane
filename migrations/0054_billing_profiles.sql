-- Phase 3 sprint 3.3: customer billing identity and tax details.
-- Additive only. Do not enable automatic tax until the tax operating model and registrations are approved.
CREATE TABLE IF NOT EXISTS organization_billing_profiles (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  legal_name TEXT,
  billing_email TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  region TEXT,
  postal_code TEXT,
  country TEXT,
  tax_id_type TEXT,
  tax_id TEXT,
  tax_exempt INTEGER NOT NULL DEFAULT 0 CHECK (tax_exempt IN (0,1)),
  po_number TEXT,
  stripe_customer_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_profiles_email ON organization_billing_profiles(billing_email);
