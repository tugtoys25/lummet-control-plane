-- Phase 9: how a new site gets its first configuration (a preset, or a copy of another site), and the default preset per plan or product.
-- Additive, idempotent and forward-only. Nothing here changes an existing table or row.
--   site_setup_requests   one row per request to configure a tenant; site_id is NULL for a manually registered tenant
--                         (then tenant_id says which). status: pending | applied | failed | skipped. last_error holds a short code only.
--   site_preset_defaults  the preset new sites start from, per plan or per product (no row = "full", the whole platform)
CREATE TABLE IF NOT EXISTS site_setup_requests (
    id TEXT PRIMARY KEY,
    site_id TEXT,
    tenant_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('preset', 'clone')),
    preset_id TEXT,
    source_tenant_id TEXT,
    sections TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    requested_by TEXT,
    requested_at TEXT DEFAULT CURRENT_TIMESTAMP,
    applied_at TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_site_setup_requests_site ON site_setup_requests(site_id, requested_at);
CREATE INDEX IF NOT EXISTS idx_site_setup_requests_tenant ON site_setup_requests(tenant_id);
CREATE INDEX IF NOT EXISTS idx_site_setup_requests_status ON site_setup_requests(status);

CREATE TABLE IF NOT EXISTS site_preset_defaults (
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('plan', 'product')),
    scope_id TEXT NOT NULL,
    preset_id TEXT NOT NULL,
    updated_by TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (scope_kind, scope_id)
);
