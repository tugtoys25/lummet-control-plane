-- Phase 0, sprint 0.2: scheduler heartbeat.
-- One row per scheduled tick, so the platform can PROVE its Cron Trigger runs (alert `cron_not_running`).
-- Additive only. Rollback: stop writing (the table is ignored by older code) and drop it.
CREATE TABLE IF NOT EXISTS scheduler_ticks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cron TEXT NOT NULL,                              -- the cron expression that fired, e.g. "*/5 * * * *"
    ran_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ok INTEGER NOT NULL DEFAULT 1,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_scheduler_ticks_cron_ran ON scheduler_ticks(cron, ran_at);
