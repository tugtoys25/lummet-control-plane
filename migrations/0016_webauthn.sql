-- =====================================================
-- WEBAUTHN / PASSKEYS (master prompt Phase 7)
--
-- Scope: registration and authentication ceremonies for a
-- security key or platform authenticator (Touch ID, Windows
-- Hello, a hardware key) as a genuine passwordless login
-- method — not just an additional factor layered on a
-- password. Attestation conveyance is NOT verified against
-- manufacturer certificate chains ("full attestation") — this
-- codebase only checks that the browser/authenticator signed
-- what it was asked to sign (rpIdHash, challenge, user
-- presence), which is what "none"/self attestation covers and
-- is what the overwhelming majority of production WebAuthn
-- relying parties actually rely on for consumer/enterprise
-- login (full attestation chain verification is mainly used
-- for device-attestation/compliance scenarios, not ordinary
-- login).
-- =====================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customer_webauthn_credentials (
    id TEXT PRIMARY KEY,                          -- uuid, internal row id
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,            -- base64url, from the authenticator
    public_key_raw TEXT NOT NULL,                  -- base64, uncompressed EC point (0x04||x||y)
    sign_count INTEGER NOT NULL DEFAULT 0,         -- cloned-authenticator detection
    nickname TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON customer_webauthn_credentials(user_id);

-- One challenge row per in-progress ceremony (registration or
-- authentication). Single-use and short-lived, same pattern as
-- customer_mfa_challenges (migration 0014).
CREATE TABLE IF NOT EXISTS webauthn_challenges (
    id TEXT PRIMARY KEY,                          -- uuid
    user_id TEXT REFERENCES customer_users(id) ON DELETE CASCADE, -- NULL for a passwordless-login attempt before identity is known
    challenge TEXT NOT NULL,                       -- base64url
    type TEXT NOT NULL,                            -- registration | authentication
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_challenge ON webauthn_challenges(challenge);
