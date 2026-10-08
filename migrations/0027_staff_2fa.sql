-- Security review 2.1 follow-up: two-factor authentication (TOTP) for STAFF
-- accounts. Same design as customer_totp, plus a replay guard (a code that was
-- already accepted cannot be used again).
CREATE TABLE IF NOT EXISTS lummet_admin_totp (
    admin_id INTEGER PRIMARY KEY REFERENCES lummet_admins(id) ON DELETE CASCADE,
    encrypted_secret TEXT NOT NULL,           -- encrypted with CREDENTIAL_KEK (covered by key rotation)
    secret_iv TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',   -- pending (set up, not yet confirmed) | active
    backup_codes_hash TEXT,                   -- JSON array of sha256 hashes; each single-use
    last_used_step INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TEXT
);

-- Issued after the password is verified for an admin with active 2FA. No
-- lummet_sessions row exists until a valid code completes this challenge.
CREATE TABLE IF NOT EXISTS lummet_mfa_challenges (
    id TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES lummet_admins(id) ON DELETE CASCADE,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lummet_mfa_challenges_admin ON lummet_mfa_challenges(admin_id);
