-- =====================================================
-- STAFF API TOKENS + TENANT RELEASE ROLLOUTS (v1.2)
--
-- Purely additive: two new feature areas, three new tables, no change to any existing table.
--
-- staff_api_tokens  long-lived machine credentials for CI (a GitHub Actions run cannot sign in with a
--                   browser session). Only a SHA-256 hash is stored; the token is shown once. Each token has
--                   scopes, so a leaked CI token can publish releases / run rollouts and NOTHING else.
-- tenant_rollouts   one row per "deploy the active release to every site" run. At most ONE can be running at a
--                   time (partial unique index), so two people clicking Roll out cannot start two.
-- tenant_rollout_items  one row per site in a rollout, in the order they are deployed (one at a time).
-- =====================================================
CREATE TABLE IF NOT EXISTS staff_api_tokens (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_prefix TEXT NOT NULL,                   -- 8 hex chars, safe to display
    token_hash TEXT NOT NULL UNIQUE,              -- sha256 of the full token
    scopes TEXT NOT NULL,                         -- JSON array: release:publish, rollout:run
    status TEXT NOT NULL DEFAULT 'active',        -- active | revoked
    created_by TEXT,                              -- lummet_admins.id
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT,
    last_used_at TEXT,
    revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_staff_api_tokens_status ON staff_api_tokens(status);

CREATE TABLE IF NOT EXISTS tenant_rollouts (
    id TEXT PRIMARY KEY,
    release_version TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',       -- running | completed | failed | cancelled
    total_sites INTEGER NOT NULL DEFAULT 0,       -- sites that needed the release when it started
    started_by TEXT,                              -- admin:<id> | token:<prefix> | system
    notes TEXT,
    error_message TEXT,
    lock_until INTEGER NOT NULL DEFAULT 0,        -- epoch ms; one advancer at a time
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tenant_rollouts_created ON tenant_rollouts(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_rollouts_running ON tenant_rollouts(status) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS tenant_rollout_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rollout_id TEXT NOT NULL REFERENCES tenant_rollouts(id) ON DELETE CASCADE,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending | running | succeeded | skipped | failed
    detail TEXT,                                  -- why it was skipped / what failed
    deployment_id TEXT,
    job_id TEXT,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE (rollout_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_rollout_items_progress ON tenant_rollout_items(rollout_id, status, position);
CREATE INDEX IF NOT EXISTS idx_tenant_rollout_items_site ON tenant_rollout_items(site_id);
