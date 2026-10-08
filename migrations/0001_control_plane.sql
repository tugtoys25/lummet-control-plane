-- =====================================================
-- LUMMET CONTROL PLANE — D1 SCHEMA
-- This database holds ONLY control-plane metadata.
-- It never holds tenant content (casinos, reviews, news,
-- pages, tenant users, etc.) — that stays in each
-- tenant's own independent D1, reachable only over
-- HTTPS through /en/api/super/*.
-- =====================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------
-- TENANT REGISTRY
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,                     -- uuid
    name TEXT NOT NULL,                      -- display name
    host TEXT NOT NULL UNIQUE,                -- e.g. example.com
    api_base_url TEXT NOT NULL,               -- e.g. https://example.com
    status TEXT NOT NULL DEFAULT 'active',    -- active | disabled
    description TEXT,
    deployment_identifier TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_host ON tenants(host);

-- -----------------------------------------------------
-- TENANT CREDENTIALS
-- The HMAC secret is stored only as AES-GCM ciphertext.
-- The plaintext key (CREDENTIAL_KEK) lives solely as a
-- Worker secret on this control-plane Worker, never in
-- D1 — see docs/architecture.md.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_api_credentials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL UNIQUE,
    encrypted_secret TEXT NOT NULL,   -- AES-GCM ciphertext, base64
    secret_iv TEXT NOT NULL,          -- AES-GCM nonce, base64
    status TEXT NOT NULL DEFAULT 'active',   -- active | rotated | revoked
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    rotated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_tenant_credentials_tenant ON tenant_api_credentials(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_credentials_status ON tenant_api_credentials(status);

-- -----------------------------------------------------
-- TENANT CAPABILITIES
-- Cached from each tenant's /en/api/super/capabilities
-- response, so the dashboard can show/hide features per
-- deployment version without a live call on every render.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    capability TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    UNIQUE(tenant_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_tenant_capabilities_tenant ON tenant_capabilities(tenant_id);

-- -----------------------------------------------------
-- TENANT HEALTH
-- One row per tenant, updated by test-connection calls
-- and (in Phase 7) the scheduled health-check cron.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_health (
    tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    status TEXT NOT NULL,             -- Online | Timeout | Unauthorized | Unavailable | Disabled | Configuration Error
    last_checked_at TEXT,
    last_error TEXT,
    api_version INTEGER
);

-- -----------------------------------------------------
-- LUMMET MASTER ADMINISTRATORS
-- Deliberately a completely separate identity system
-- from any tenant's `users` table (rule #27). A tenant
-- admin never gains Lummet master access, and vice versa.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'master_admin',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lummet_sessions (
    id TEXT PRIMARY KEY,
    admin_id INTEGER NOT NULL REFERENCES lummet_admins(id) ON DELETE CASCADE,
    active_tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_sessions_admin ON lummet_sessions(admin_id);

-- -----------------------------------------------------
-- LUMMET AUDIT LOG (control-plane side)
-- Records who (which Lummet admin), against which
-- tenant, did what — including failures where the
-- tenant never received the request at all (e.g. a
-- credential-decryption failure before the call went out).
-- Never store secrets/credentials here.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER,
    tenant_id TEXT,
    endpoint TEXT,
    method TEXT,
    resource TEXT,
    resource_id TEXT,
    action TEXT,
    success INTEGER NOT NULL,
    status_code INTEGER,
    error_message TEXT,
    request_id TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_audit_created ON lummet_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_lummet_audit_tenant ON lummet_audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_lummet_audit_admin ON lummet_audit_logs(admin_id);

-- -----------------------------------------------------
-- AUTH RATE LIMITING (mirrors the tenant repo's pattern)
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_auth_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip_hash TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_lummet_auth_attempts_ip ON lummet_auth_attempts(ip_hash, action, created_at);
