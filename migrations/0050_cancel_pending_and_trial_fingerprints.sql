-- Phase 1, sprint 1.5: safe deletion and trial-abuse checks. Additive only.
-- Rollback: stop reading/writing these tables; BILLING_ENFORCE=off disables the new paths.

-- A Stripe cancellation that could not be sent when an organization was deleted. The sweep retries it;
-- alert `cancel_pending_stuck` fires when one is older than 24 hours.
CREATE TABLE IF NOT EXISTS billing_cancel_pending (
    organization_id TEXT PRIMARY KEY,
    provider_subscription_id TEXT,
    at_period_end INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_attempt_at TEXT
);

-- One trial per card fingerprint and per business email domain (hashes only, never the raw values).
CREATE TABLE IF NOT EXISTS trial_fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint_hash TEXT NOT NULL UNIQUE,
    email_domain TEXT,
    organization_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_trial_fingerprints_domain ON trial_fingerprints(email_domain);
