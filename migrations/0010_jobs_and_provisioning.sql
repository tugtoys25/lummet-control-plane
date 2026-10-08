-- =====================================================
-- JOB SYSTEM + SITE RESOURCES (Phase 3 — master prompt
-- sections 17-19, 38)
--
-- A generic job framework, first used by automated tenant
-- provisioning but not specific to it — report generation,
-- exports, and deployments (later phases) reuse the same
-- jobs/job_steps tables rather than each inventing their own
-- status tracking.
--
-- site_resources records Cloudflare resource METADATA only
-- (ids, names, status) — never secrets. The one secret this
-- phase generates (a tenant's Super API credential) goes
-- through registry.js's existing encrypted-at-rest storage
-- (tenant_api_credentials, migration 0001), not a new table —
-- reusing it, not duplicating it (rule against duplicate
-- credential storage).
-- =====================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------
-- JOBS
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,                          -- uuid
    type TEXT NOT NULL,                           -- e.g. 'tenant_provisioning'
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
    created_by TEXT,                              -- customer_users.id or lummet_admins.id, depending on actor_type
    actor_type TEXT NOT NULL DEFAULT 'system',    -- system | customer_user | lummet_admin
    status TEXT NOT NULL DEFAULT 'queued',        -- queued|running|waiting|success|failed|retrying|cancelled
    priority INTEGER NOT NULL DEFAULT 0,
    progress INTEGER NOT NULL DEFAULT 0,          -- 0-100, derived from completed/total steps
    payload TEXT,                                 -- JSON — job-type-specific input
    result TEXT,                                  -- JSON — job-type-specific output (e.g. a one-time credential)
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    canceled_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_site ON jobs(site_id);
CREATE INDEX IF NOT EXISTS idx_jobs_org ON jobs(organization_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type);

-- -----------------------------------------------------
-- JOB STEPS
-- The ordered, individually-tracked plan for one job — see
-- master prompt section 17 ("every step must be idempotent",
-- "if provisioning fails, the system must know which step
-- failed"). step_order is fixed at creation time so retrying
-- a job always resumes in the same sequence.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS job_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    step_key TEXT NOT NULL,                       -- e.g. 'create_database'
    step_order INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending|running|success|failed|skipped
    attempt INTEGER NOT NULL DEFAULT 0,
    output TEXT,                                  -- JSON — never contains secrets (see header comment)
    error_message TEXT,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(job_id, step_key)
);

CREATE INDEX IF NOT EXISTS idx_job_steps_job ON job_steps(job_id);

-- -----------------------------------------------------
-- SITE RESOURCES
-- One row per Cloudflare resource created for a site
-- (worker | d1 | kv | r2 today — see infra-provider.js).
-- Resource IDs/names only, never secrets or API tokens
-- (master prompt rule #4 / section 18).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS site_resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                       -- 'cloudflare' today
    resource_type TEXT NOT NULL,                  -- worker | d1 | kv | r2
    resource_id TEXT NOT NULL,                    -- the provider's own id for this resource
    resource_name TEXT NOT NULL,                  -- the human-readable name given at creation
    status TEXT NOT NULL DEFAULT 'active',        -- active | deleted
    metadata TEXT,                                -- JSON — non-secret provider response fields worth keeping
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT,
    UNIQUE(site_id, resource_type)
);

CREATE INDEX IF NOT EXISTS idx_site_resources_site ON site_resources(site_id);
