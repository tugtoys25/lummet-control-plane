-- Phase 2, sprint 2.1: billing notification engine.
-- Additive only. Rollback: set BILLING_EMAILS=off (the engine becomes inert); the tables and column can be ignored.
--
-- billing_notifications is the durable INTENT to tell an organization something. One row per (subscription, kind, stage):
-- dedupe_key is UNIQUE, so a webhook delivered five times, a sweep run twice, or a staff retry can never produce a
-- second email. queued_at is set only once every recipient has been handed to the email outbox; until then the
-- row is retried from the five-minute tick (payload holds the non-secret facts needed to rebuild the message, and is
-- wiped when the row is complete). sent_at is set when the outbox reports the first message as delivered.
CREATE TABLE IF NOT EXISTS billing_notifications (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    subscription_id TEXT,
    kind TEXT NOT NULL,
    stage TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL UNIQUE,         -- <subscription id or organization id>:<kind>:<stage>
    payload TEXT,                            -- JSON facts (amounts, dates, plan name); NULL once queued
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    recipient_count INTEGER NOT NULL DEFAULT 0,
    suppressed_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    queued_at TEXT,
    sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_billing_notifications_org ON billing_notifications(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_billing_notifications_pending ON billing_notifications(queued_at, created_at);

-- Addresses that must not be mailed again by billing notifications: permanent bounces and spam complaints reported by
-- Resend. Only the SHA-256 of the lowercased address is stored.
CREATE TABLE IF NOT EXISTS email_suppressions (
    email_hash TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,                    -- bounce | complaint
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_suppressions_created ON email_suppressions(created_at);

-- Resend webhook deliveries already handled (Svix message id), so a redelivery changes nothing.
CREATE TABLE IF NOT EXISTS email_webhook_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Which notification an outbox message belongs to (NULL for verification, reset, invitation and alert mail).
ALTER TABLE email_outbox ADD COLUMN notification_id TEXT;
CREATE INDEX IF NOT EXISTS idx_email_outbox_notification ON email_outbox(notification_id);
