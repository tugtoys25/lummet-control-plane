-- v7C: failed (or crashed) billing webhook events are reprocessed when the provider redelivers them.
-- attempts counts processing attempts (the first one included); last_attempt_at is when the latest began.
ALTER TABLE billing_webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE billing_webhook_events ADD COLUMN last_attempt_at TEXT;
