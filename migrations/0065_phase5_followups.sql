CREATE TABLE IF NOT EXISTS credit_pack_reversals (
  grant_id TEXT PRIMARY KEY REFERENCES credit_pack_grants(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  credits_reversed INTEGER NOT NULL CHECK (credits_reversed > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_credit_pack_reversals_org ON credit_pack_reversals(organization_id);

CREATE TABLE IF NOT EXISTS staff_approval_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('refund','credit_adjustment')),
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
CREATE INDEX IF NOT EXISTS idx_staff_approvals_status ON staff_approval_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_staff_approvals_org ON staff_approval_requests(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS dunning_actions (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('extend_grace','resend_notice')),
  reason TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dunning_actions_sub ON dunning_actions(subscription_id, created_at DESC);
