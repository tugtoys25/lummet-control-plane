-- Phase 5.7: dunning "comp" action and staff replay of failed billing webhooks.
-- SQLite cannot alter a CHECK constraint, so dunning_actions is rebuilt with 'comp' allowed (rows are copied unchanged).
CREATE TABLE IF NOT EXISTS dunning_actions_v2 (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('extend_grace','resend_notice','comp')),
  reason TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO dunning_actions_v2 (id, subscription_id, organization_id, action, reason, staff_id, detail, created_at)
  SELECT id, subscription_id, organization_id, action, reason, staff_id, detail, created_at FROM dunning_actions;
DROP TABLE dunning_actions;
ALTER TABLE dunning_actions_v2 RENAME TO dunning_actions;
CREATE INDEX IF NOT EXISTS idx_dunning_actions_sub ON dunning_actions(subscription_id, created_at DESC);
-- One comp per invoice, ever: the unique partial index makes a double click or a retry a no-op instead of a second void.
CREATE UNIQUE INDEX IF NOT EXISTS idx_dunning_comp_once ON dunning_actions(subscription_id, detail) WHERE action = 'comp';

CREATE TABLE IF NOT EXISTS billing_webhook_replays (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  staff_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('processed','failed','not_claimable','not_found','mode_mismatch')),
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_webhook_replays_event ON billing_webhook_replays(provider, provider_event_id, created_at DESC);
