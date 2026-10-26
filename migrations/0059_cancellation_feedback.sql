-- Phase 5.3: explicit cancellation feedback; never store payment credentials or secrets.
CREATE TABLE IF NOT EXISTS cancellation_feedback (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT,
  reason TEXT NOT NULL CHECK (reason IN ('too_expensive','missing_feature','technical_issue','switching','not_using','temporary','other')),
  detail TEXT,
  offer_shown TEXT CHECK (offer_shown IS NULL OR offer_shown IN ('pause','downgrade','coupon','export')),
  offer_accepted INTEGER NOT NULL DEFAULT 0 CHECK (offer_accepted IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cancellation_feedback_org_created ON cancellation_feedback(organization_id, created_at DESC);
