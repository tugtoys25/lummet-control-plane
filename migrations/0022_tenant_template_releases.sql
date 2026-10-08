-- =====================================================
-- TENANT TEMPLATE RELEASES (roadmap 0.1)
--
-- All tenants run the SAME lummet-tenant application code today;
-- configuration lives in each tenant's own D1, not in per-site custom
-- code. So there is one shared, versioned build artifact per release
-- (the bundled tenant Worker script + that release's full migration
-- set), published here by staff, and every new site's automatic
-- first deployment (worker/provisioning.js) uses whatever release is
-- currently marked 'active'. The blob itself lives in R2
-- (env.TENANT_TEMPLATES) -- this table only tracks metadata, the same
-- split worker/backups.js already uses for tenant content backups.
-- =====================================================
CREATE TABLE IF NOT EXISTS tenant_template_releases (
    id TEXT PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,          -- e.g. a git tag/short-sha, staff-supplied
    storage_key TEXT NOT NULL,             -- key inside env.TENANT_TEMPLATES
    migration_count INTEGER NOT NULL DEFAULT 0,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'active', -- active | superseded
    created_by TEXT,                       -- lummet_admins.id (staff only can publish)
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_template_releases_status ON tenant_template_releases(status, created_at);
