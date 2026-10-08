-- Roadmap 2.3: records of backups of the control plane's OWN database
-- (organizations, subscriptions, billing, audit logs, ...). The data itself
-- is stored encrypted in R2; this table only tracks that it exists.
CREATE TABLE IF NOT EXISTS control_plane_backups (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',     -- running | complete | failed | expired
    storage_prefix TEXT NOT NULL,
    part_count INTEGER NOT NULL DEFAULT 0,
    row_counts TEXT,                            -- JSON {table: rows}
    size_bytes INTEGER,
    error_message TEXT,
    verified_at TEXT,
    verification_status TEXT,                   -- ok | <error code>
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cp_backups_status ON control_plane_backups(status, created_at);
