-- v7D: durable background jobs and webhook delivery retries.
--
-- jobs: auto_retries counts the retries/resumes the sweep has started on its own (manual retries are not
-- counted). A job that used them all, or cannot be retried at all, is dead-lettered: its status stays
-- 'failed' (so nothing that reads status changes meaning) and dead_lettered_at says the sweep gave up.
ALTER TABLE jobs ADD COLUMN auto_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN dead_lettered_at TEXT;
ALTER TABLE jobs ADD COLUMN dead_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_jobs_dead ON jobs(dead_lettered_at) WHERE dead_lettered_at IS NOT NULL;

-- webhook_deliveries: attempt (already there) now counts attempts made. Status lifecycle:
--   failed -> retrying -> delivered | failed | dead.   last_attempt_at is when the latest attempt began.
ALTER TABLE webhook_deliveries ADD COLUMN last_attempt_at TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_retry ON webhook_deliveries(status, last_attempt_at);
