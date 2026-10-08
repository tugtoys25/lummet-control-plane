-- =====================================================
-- DEVELOPER PLATFORM: API KEYS + WEBHOOKS (Phase 6 —
-- master prompt sections 30-31)
--
-- customer_api_keys is deliberately separate from the
-- internal HMAC-signed tenant Super API credentials
-- (tenant_api_credentials, migration 0001) — section 30's
-- own distinction: "the internal HMAC Super API is not the
-- same as a customer-facing developer API". A customer API
-- key authenticates a THIRD PARTY calling THIS control
-- plane's new /api/v1/* surface on the organization's
-- behalf; it never touches a tenant directly.
--
-- Only the key's hash is ever stored (never the secret) —
-- same "shown once" pattern as invitations/password resets.
-- Webhook signing secrets, by contrast, DO need to be
-- retrievable in plaintext (to sign each outbound delivery),
-- so they reuse crypto.js's existing AES-GCM
-- encryptSecret/decryptSecret — the same mechanism already
-- protecting tenant Super API credentials — rather than a
-- new encryption scheme.
-- =====================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customer_api_keys (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id TEXT REFERENCES sites(id) ON DELETE CASCADE, -- NULL = every site in the org
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,                     -- short, non-secret, shown in the UI for identification
    key_hash TEXT NOT NULL,                       -- sha256 of the full token; the token itself is never stored
    scopes TEXT NOT NULL,                         -- JSON array, e.g. ["sites:read","analytics:read"]
    status TEXT NOT NULL DEFAULT 'active',        -- active | revoked
    created_by TEXT REFERENCES customer_users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_org ON customer_api_keys(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_prefix ON customer_api_keys(key_prefix);

CREATE TABLE IF NOT EXISTS webhooks (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    event_types TEXT NOT NULL,                    -- JSON array, e.g. ["site.provisioned","deployment.active"]
    status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
    created_by TEXT REFERENCES customer_users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks(organization_id);

-- -----------------------------------------------------
-- WEBHOOK DELIVERIES
-- One row per delivery ATTEMPT. This phase only ever makes
-- a single attempt per event (see webhooks.js's header
-- comment) — a 'failed' row is visible to the customer for
-- manual awareness, but there is no automatic retry queue
-- yet. attempt is still a column now (rather than added
-- later) so a future retry job can extend this table without
-- another migration.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id TEXT PRIMARY KEY,                          -- uuid
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL,                        -- JSON — exactly what was sent (never contains secrets)
    status TEXT NOT NULL DEFAULT 'pending',       -- pending | delivered | failed
    response_code INTEGER,
    error_message TEXT,
    attempt INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    delivered_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
