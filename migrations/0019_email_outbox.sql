-- =====================================================
-- TRANSACTIONAL EMAIL OUTBOX (master prompt sections 7, 26, 28)
--
-- Signup verification, password reset and team invitations
-- previously generated tokens that nothing delivered. Every
-- message now goes through this outbox: queued durably first,
-- then delivered by worker/email.js with retry/backoff.
--
-- The message body contains one-time links, so it is stored
-- ENCRYPTED (AES-GCM under CREDENTIAL_KEK) while queued and
-- wiped as soon as the provider accepts the message.
-- "sent" is only ever set after the provider returned success.
-- =====================================================
CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY,
    organization_id TEXT,
    to_email TEXT NOT NULL,
    template TEXT NOT NULL,           -- verify_email | password_reset | invitation | notification
    subject TEXT NOT NULL,
    body_encrypted TEXT,              -- NULL once sent
    body_iv TEXT,
    status TEXT NOT NULL DEFAULT 'queued',  -- queued | sent | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    provider_message_id TEXT,
    dedupe_key TEXT,
    next_attempt_at TEXT DEFAULT CURRENT_TIMESTAMP,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    sent_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox(status, next_attempt_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_email_outbox_dedupe ON email_outbox(dedupe_key) WHERE dedupe_key IS NOT NULL;
