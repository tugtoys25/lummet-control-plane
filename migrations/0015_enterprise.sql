-- =====================================================
-- ENTERPRISE FEATURES (Phase 7 — master prompt section 35
-- white-label, section 40 2FA, section 34 approval workflows)
--
-- SCOPE NOTE (see the completion report for the full
-- reasoning): SSO (SAML/OIDC) and WebAuthn/passkeys are
-- deliberately NOT represented here at all — not even as a
-- placeholder table. Both are security-critical enough that a
-- half-built schema implying progress would be worse than
-- honestly having nothing; either needs a dedicated,
-- security-reviewed implementation with a real assertion/
-- attestation validation library, not a first pass.
-- "Dedicated infrastructure" isn't a new schema concept
-- either — Phase 3's provisioning already creates isolated
-- per-site D1/KV/R2 for every site regardless of plan, so the
-- entitlement key below is documentary (which plans are
-- ALLOWED to rely on that), not a new provisioning mode.
-- =====================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------
-- WHITE-LABEL BRANDING
-- One row per organization (not per site — matches section
-- 35's "organization-level branding" for the common case;
-- an agency with per-client branding would need one
-- organization per client, which the existing organization
-- model already supports). Gated on the existing
-- white_label.enabled entitlement (migration 0006) — no new
-- entitlement key needed here.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_branding (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    brand_name TEXT,
    logo_url TEXT,
    favicon_url TEXT,
    primary_color TEXT,
    support_url TEXT,
    hide_lummet_branding INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------
-- TWO-FACTOR AUTHENTICATION (TOTP, RFC 6238)
-- Available to every customer_user regardless of plan —
-- security features are never paywalled on this platform.
-- The secret is encrypted at rest via crypto.js (the same
-- mechanism already protecting tenant Super API credentials
-- and webhook signing secrets), never stored in plaintext.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_totp (
    user_id TEXT PRIMARY KEY REFERENCES customer_users(id) ON DELETE CASCADE,
    encrypted_secret TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending (set up, not yet confirmed) | active
    backup_codes_hash TEXT,                       -- JSON array of sha256 hashes; each single-use
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TEXT
);

-- A short-lived challenge issued after password verification
-- succeeds for a user with active 2FA — login is NOT complete,
-- and no customer_sessions row exists, until the matching
-- code is verified against this challenge.
CREATE TABLE IF NOT EXISTS customer_mfa_challenges (
    id TEXT PRIMARY KEY,                          -- uuid
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_mfa_challenges_user ON customer_mfa_challenges(user_id);

-- -----------------------------------------------------
-- APPROVAL WORKFLOWS (change requests)
-- Generic on purpose — `type` is extensible, but the only
-- type actually wired to an enforcement point in this phase
-- is 'site_deletion' (change-requests.js). Gated on the new
-- approval_workflows.enabled entitlement; an organization
-- without it keeps today's direct-action behavior unchanged.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS change_requests (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                           -- 'site_deletion' today
    resource_id TEXT NOT NULL,                    -- e.g. the site_id being requested for deletion
    status TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | rejected | canceled
    requested_by TEXT REFERENCES customer_users(id) ON DELETE SET NULL,
    approved_by TEXT REFERENCES customer_users(id) ON DELETE SET NULL,
    reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_change_requests_org ON change_requests(organization_id);
CREATE INDEX IF NOT EXISTS idx_change_requests_status ON change_requests(status);

-- -----------------------------------------------------
-- New entitlement keys. Both default to false via
-- entitlements.js's ZERO_ACCESS_ENTITLEMENTS floor for any
-- plan without an explicit row; seeded false onto the one
-- example Starter plan here for the same "stay a complete,
-- explicit record" reasoning as migration 0012.
-- -----------------------------------------------------

INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value) VALUES
    ('plan_casino_news_starter', 'approval_workflows.enabled', 'boolean', 'false'),
    ('plan_casino_news_starter', 'dedicated_infrastructure.enabled', 'boolean', 'false');
