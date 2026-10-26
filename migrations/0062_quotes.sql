-- Phase 5.6: auditable quote lifecycle. Legal/Founder License documents remain drafts until approved by counsel.
CREATE TABLE IF NOT EXISTS quotes (
  id TEXT PRIMARY KEY,
  organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  company_name TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','expired','invoiced','paid','cancelled')),
  currency TEXT NOT NULL DEFAULT 'usd',
  valid_until TEXT,
  notes TEXT,
  created_by TEXT,
  accepted_by TEXT,
  accepted_at TEXT,
  stripe_invoice_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS quote_lines (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  plan_key TEXT NOT NULL,
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_cents INTEGER NOT NULL CHECK (unit_amount_cents >= 0),
  tax_behavior TEXT NOT NULL DEFAULT 'exclusive' CHECK (tax_behavior IN ('inclusive','exclusive','unspecified')),
  entitlement_json TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quotes_status_created ON quotes(status, created_at DESC);
