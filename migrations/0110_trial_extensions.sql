-- Trial extension requests. A customer whose free trial has ended cannot start another one; they ask for an extension instead, and
-- staff approve it (with a number of days) or decline it (with a comment). Additive and idempotent: nothing existing is changed.
CREATE TABLE IF NOT EXISTS trial_extension_requests (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  requested_by TEXT,
  message TEXT,
  wanted_days INTEGER,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  decided_by TEXT,
  decided_days INTEGER,
  decision_comment TEXT,
  decided_at TEXT,
  granted_subscription_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trial_ext_org ON trial_extension_requests(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trial_ext_status ON trial_extension_requests(status, created_at);
-- At most one open request per organization, enforced by the database as well as by the code.
CREATE UNIQUE INDEX IF NOT EXISTS uq_trial_ext_one_pending ON trial_extension_requests(organization_id) WHERE status = 'pending';
