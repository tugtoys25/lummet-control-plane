-- Phase 5.4: push each provisioned site's plan storage cap to its tenant (monotone generation, durable retry) and keep the
-- tenant's last usage report so the Usage page and daily snapshots show real storage rather than "unknown".
CREATE TABLE IF NOT EXISTS site_storage_limit_sync (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  desired_mb INTEGER NOT NULL CHECK (desired_mb >= 0),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT,
  last_http_status INTEGER,
  pushed_generation INTEGER NOT NULL DEFAULT 0,
  pushed_at TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_storage_sync_due ON site_storage_limit_sync(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_storage_sync_checked ON site_storage_limit_sync(checked_at);
CREATE TABLE IF NOT EXISTS site_storage_usage (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  used_bytes INTEGER NOT NULL CHECK (used_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  limit_bytes INTEGER CHECK (limit_bytes IS NULL OR limit_bytes >= 0),
  limit_generation INTEGER NOT NULL DEFAULT 0,
  reported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
