-- Phase 3 sprint 3.5: explicit, auditable provider/local drift findings.
CREATE TABLE IF NOT EXISTS reconciliation_findings (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT,
  field TEXT NOT NULL,
  lummet_value TEXT,
  stripe_value TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted_stripe','kept_lummet','resolved')),
  found_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliation_open_field
  ON reconciliation_findings(organization_id, subscription_id, field) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_reconciliation_status_found
  ON reconciliation_findings(status, found_at);
