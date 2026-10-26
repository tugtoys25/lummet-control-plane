-- Phase 5.7: dunning comp requires a second staff member. staff_approval_requests is rebuilt so `kind` allows 'dunning_comp'
-- (rows copied unchanged; the requester-cannot-decide CHECK is kept). An expression index allows only one live request per invoice.
CREATE TABLE IF NOT EXISTS staff_approval_requests_v2 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('refund','credit_adjustment','dunning_comp')),
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  amount INTEGER NOT NULL,
  currency TEXT,
  payload_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','executed','failed')),
  requested_by TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  decision_reason TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (decided_by IS NULL OR decided_by <> requested_by)
);
INSERT OR IGNORE INTO staff_approval_requests_v2 (id, kind, organization_id, amount, currency, payload_json, reason, status, requested_by, decided_by, decided_at, decision_reason, failure_code, created_at)
  SELECT id, kind, organization_id, amount, currency, payload_json, reason, status, requested_by, decided_by, decided_at, decision_reason, failure_code, created_at FROM staff_approval_requests;
DROP TABLE staff_approval_requests;
ALTER TABLE staff_approval_requests_v2 RENAME TO staff_approval_requests;
CREATE INDEX IF NOT EXISTS idx_staff_approvals_status ON staff_approval_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_approvals_org ON staff_approval_requests(organization_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_staff_approvals_comp_live ON staff_approval_requests(json_extract(payload_json, '$.invoiceId'))
  WHERE kind = 'dunning_comp' AND status IN ('pending','approved');
