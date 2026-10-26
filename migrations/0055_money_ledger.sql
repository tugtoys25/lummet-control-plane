-- Phase 3 sprint 3.4: expanded, provider-sourced financial ledger.
-- Existing columns and records are preserved; all additions are nullable/defaulted for safe rollout.
ALTER TABLE invoices ADD COLUMN number TEXT;
ALTER TABLE invoices ADD COLUMN subtotal_cents INTEGER;
ALTER TABLE invoices ADD COLUMN tax_cents INTEGER;
ALTER TABLE invoices ADD COLUMN discount_cents INTEGER;
ALTER TABLE invoices ADD COLUMN total_cents INTEGER;
ALTER TABLE invoices ADD COLUMN pdf_url TEXT;
ALTER TABLE invoices ADD COLUMN due_at TEXT;
ALTER TABLE invoices ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN next_attempt_at TEXT;
ALTER TABLE payments ADD COLUMN failure_code TEXT;
ALTER TABLE payments ADD COLUMN failure_message TEXT;
CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  provider_line_id TEXT NOT NULL,
  description TEXT,
  quantity REAL,
  unit_amount_cents INTEGER,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  period_start TEXT,
  period_end TEXT,
  price_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(invoice_id, provider_line_id)
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_refund_id TEXT NOT NULL,
  provider_charge_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_refund_id)
);
CREATE INDEX IF NOT EXISTS idx_refunds_org ON refunds(organization_id);
CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_dispute_id TEXT NOT NULL,
  provider_charge_id TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  reason TEXT,
  evidence_due_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_dispute_id)
);
CREATE INDEX IF NOT EXISTS idx_disputes_org_status ON disputes(organization_id, status);
CREATE TABLE IF NOT EXISTS credit_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  provider_credit_note_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider, provider_credit_note_id)
);
CREATE INDEX IF NOT EXISTS idx_credit_notes_org ON credit_notes(organization_id);
