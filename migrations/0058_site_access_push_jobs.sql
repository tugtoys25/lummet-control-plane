-- Phase 1.3: durable, retryable tenant-edge site-access state pushes.
CREATE TABLE IF NOT EXISTS site_access_push_jobs (
  id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL, desired_state TEXT NOT NULL CHECK (desired_state IN ('serving','suspended','closed')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','superseded')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_error TEXT, last_http_status INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT, UNIQUE(site_id,generation)
);
CREATE INDEX IF NOT EXISTS idx_site_access_push_due ON site_access_push_jobs(status,next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_site_access_push_site ON site_access_push_jobs(site_id,created_at DESC);
