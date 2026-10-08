-- =====================================================
-- LUMMET CUSTOMER IDENTITY (Phase 1 — SaaS foundation)
--
-- Introduces a THIRD identity system, distinct from both
-- lummet_admins (Lummet staff, migrations 0001/0003) and a
-- tenant's own `users` table (content editors on one
-- deployed site). A customer_user is a person; an
-- organization is the billing/ownership unit; membership
-- between them is many-to-many via organization_users so
-- one person can belong to more than one organization
-- (agency staff, consultants) without a duplicate account.
--
-- Nothing here grants Lummet staff access or tenant CMS
-- access — see customer-rbac.js for why these stay separate
-- identity systems rather than being merged.
-- =====================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------
-- ORGANIZATIONS
-- The customer-facing billing/ownership unit. A site
-- (migration 0006) always belongs to exactly one
-- organization; an organization may own many sites.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS organizations (
    id TEXT PRIMARY KEY,                          -- uuid
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'active',        -- active | suspended | closed
    billing_email TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);
CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug);

-- -----------------------------------------------------
-- CUSTOMER USERS
-- One row per person. Never merged with lummet_admins or
-- any tenant's own `users` table.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_users (
    id TEXT PRIMARY KEY,                          -- uuid
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    full_name TEXT,
    status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
    email_verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_users_email ON customer_users(email);

-- -----------------------------------------------------
-- ORGANIZATION MEMBERSHIP
-- role is one of: owner | admin | editor | analyst | viewer
-- (see customer-rbac.js for the ordering each implies).
-- Every organization must keep at least one owner —
-- enforced in organizations.js, not the schema.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'viewer',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_users_org ON organization_users(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_users_user ON organization_users(user_id);

-- -----------------------------------------------------
-- ORGANIZATION INVITATIONS
-- The plaintext token is shown to the inviter once and
-- never stored — only its hash is — matching the "secret
-- shown once" pattern already used in this repo for tenant
-- API credentials (registry.js) and staff temp passwords
-- (auth.js). There is no outbound email delivery yet; the
-- token must be delivered out of band until section 28 of
-- the master prompt (notifications) is built.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS organization_invitations (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer',
    token_hash TEXT NOT NULL,
    invited_by TEXT REFERENCES customer_users(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending | accepted | revoked | expired
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    accepted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_org_invitations_org ON organization_invitations(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invitations_email ON organization_invitations(email);

-- -----------------------------------------------------
-- CUSTOMER SESSIONS
-- Mirrors lummet_sessions' shape (migration 0001) but is a
-- completely separate table/cookie — a customer session
-- must never be readable as a staff session or vice versa.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    active_organization_id TEXT REFERENCES organizations(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_customer_sessions_user ON customer_sessions(user_id);

-- -----------------------------------------------------
-- EMAIL VERIFICATION / PASSWORD RESET
-- Token hashes only, single-use, short expiry.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS customer_email_verifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_verif_user ON customer_email_verifications(user_id);

CREATE TABLE IF NOT EXISTS customer_password_resets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pw_reset_user ON customer_password_resets(user_id);

-- -----------------------------------------------------
-- NOTE: customer auth rate limiting deliberately reuses
-- `lummet_auth_attempts` from migration 0001 rather than a
-- new table — it is already generic (ip_hash, action,
-- created_at) and not admin-specific. Customer actions use
-- action values prefixed "customer_" (e.g. "customer_login")
-- so the two populations of attempts never collide or let
-- one exhaust the other's rate limit.
-- -----------------------------------------------------
