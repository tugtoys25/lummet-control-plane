-- =====================================================
-- DEPLOYMENT MANAGEMENT + MIGRATION LEDGER (Phase 4 —
-- master prompt sections 21-22)
--
-- A deployment is tracked SEPARATELY from a site's own
-- lifecycle status (migration 0006). Only the FIRST
-- deployment for a site drives the site status machine
-- (provisioned -> configuring -> deploying -> active) since
-- the site genuinely has no serving code until then. Every
-- deployment after that leaves site.status alone — a failed
-- redeploy must not take down a currently-serving site
-- (deployments.js enforces this; the schema just records
-- both facts independently).
--
-- site_migrations_applied is an explicit ledger, not a
-- guess — "current schema version" for a site is always
-- derivable as "the migrations actually recorded here",
-- never assumed from a deployment's claimed version number.
-- Per section 22, this deliberately does NOT support
-- automatic rollback of a migration — rollbackDeployment()
-- only ever re-deploys old CODE against the current
-- (forward-migrated) schema, never reverses schema changes.
-- =====================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS deployments (
    id TEXT PRIMARY KEY,                          -- uuid
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    version TEXT NOT NULL,                        -- caller-supplied application version tag
    status TEXT NOT NULL DEFAULT 'queued',        -- queued|building|migrating|deploying|checking|active|failed|rolled_back
    is_rollback INTEGER NOT NULL DEFAULT 0,
    is_current INTEGER NOT NULL DEFAULT 0,        -- the most recent deployment to reach 'active' for this site
    target_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL, -- set when is_rollback = 1
    triggered_by TEXT,
    actor_type TEXT NOT NULL DEFAULT 'system',    -- system | customer_user | lummet_admin
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deployments_site ON deployments(site_id);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);

CREATE TABLE IF NOT EXISTS site_migrations_applied (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    migration_name TEXT NOT NULL,
    deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL,
    applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(site_id, migration_name)
);

CREATE INDEX IF NOT EXISTS idx_site_migrations_site ON site_migrations_applied(site_id);

-- -----------------------------------------------------
-- SITES: version tracking (extends migration 0006)
-- -----------------------------------------------------

ALTER TABLE sites ADD COLUMN app_version TEXT;
ALTER TABLE sites ADD COLUMN last_deployment_id TEXT REFERENCES deployments(id) ON DELETE SET NULL;
