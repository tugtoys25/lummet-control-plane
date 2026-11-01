-- 0077 (release 2.6.1.6): how a customer session was authenticated.
-- Additive only: one nullable column, no backfill, no index. NULL means "not recorded" (every session created before this release)
-- and is treated exactly like a password session, so nothing about an existing session changes.
-- Values written by the application: 'password', 'password_totp', 'passkey', 'passkey_uv' (passkey with user verification),
-- 'sso'. Only 'passkey_uv' is ever read for a decision, and only while ORG_2FA_PASSKEY_COUNTS=on (see org-security-policy.js).
ALTER TABLE customer_sessions ADD COLUMN auth_method TEXT;
