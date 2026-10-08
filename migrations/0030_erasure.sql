-- Roadmap 1.3: account and data deletion (privacy erasure).
-- Organizations and users are never hard-deleted: they become anonymous tombstones so
-- every foreign key (invoices, audit rows) stays valid while nothing identifying remains.
ALTER TABLE organizations ADD COLUMN erased_at TEXT;
ALTER TABLE customer_users ADD COLUMN deleted_at TEXT;

-- What was erased and when. Ids and counts only, never personal data.
CREATE TABLE IF NOT EXISTS erasure_log (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,                       -- organization | user | retention_sweep
    subject_id TEXT NOT NULL,
    status TEXT NOT NULL,                     -- complete | partial | failed
    summary TEXT,                             -- JSON: counts, and the external steps still to retry
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_erasure_log_subject ON erasure_log(kind, subject_id);
