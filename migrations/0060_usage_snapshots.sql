-- Phase 5.4: immutable daily usage snapshots, safe to re-run for a day/metric.
CREATE TABLE IF NOT EXISTS usage_snapshots (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (length(day) = 10),
  metric TEXT NOT NULL,
  value INTEGER NOT NULL CHECK (value >= 0),
  source TEXT NOT NULL DEFAULT 'control_plane',
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, day, metric)
);
CREATE INDEX IF NOT EXISTS idx_usage_snapshots_day_metric ON usage_snapshots(day, metric);
