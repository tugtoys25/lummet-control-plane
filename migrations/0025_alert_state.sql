-- Roadmap 2.2: remembers which operational alerts are currently firing so a
-- problem notifies once (plus periodic reminders) instead of on every check.
CREATE TABLE IF NOT EXISTS alert_state (
    key TEXT PRIMARY KEY,                      -- e.g. failed_jobs, stuck_jobs
    firing INTEGER NOT NULL DEFAULT 0,
    last_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT,
    last_notified_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
