-- =====================================================
-- BACKUPS (master prompt sections 23-24) and AUTOMATIONS (29)
-- =====================================================
CREATE TABLE IF NOT EXISTS site_backups (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    site_id TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'manual',      -- manual | scheduled
    scope TEXT NOT NULL DEFAULT 'content',    -- content (tenant resources via Super API)
    status TEXT NOT NULL DEFAULT 'running',   -- running | complete | partial | failed | expired
    storage_key TEXT,                         -- key inside the BACKUPS object store
    size_bytes INTEGER,
    sha256 TEXT,
    resource_summary TEXT,                    -- JSON {resource: {ok, count, error?}}
    encrypted INTEGER NOT NULL DEFAULT 0,
    verified_at TEXT,
    verification_status TEXT,                 -- ok | mismatch | missing
    retention_until TEXT,
    created_by TEXT,
    error_message TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_backups_site ON site_backups(site_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_backups_org ON site_backups(organization_id, created_at);

CREATE TABLE IF NOT EXISTS backup_restores (
    id TEXT PRIMARY KEY,
    backup_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    source_site_id TEXT NOT NULL,
    target_site_id TEXT NOT NULL,             -- always a DIFFERENT site: restore never overwrites the source
    status TEXT NOT NULL DEFAULT 'running',   -- running | complete | partial | failed
    result_summary TEXT,
    requested_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);

CREATE TABLE IF NOT EXISTS automation_rules (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    name TEXT NOT NULL,
    trigger_event TEXT NOT NULL,              -- a webhook event type, e.g. payment.failed
    conditions TEXT NOT NULL DEFAULT '[]',    -- JSON [{field, op, value}] all must match
    actions TEXT NOT NULL,                    -- JSON [{type, params}] from the fixed action registry
    status TEXT NOT NULL DEFAULT 'active',    -- active | paused
    max_runs_per_hour INTEGER NOT NULL DEFAULT 10,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_automation_rules_org ON automation_rules(organization_id, trigger_event, status);

CREATE TABLE IF NOT EXISTS automation_runs (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    status TEXT NOT NULL,                     -- success | partial | failed | skipped_rate_limited
    action_results TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(rule_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_rule ON automation_runs(rule_id, created_at);

CREATE TABLE IF NOT EXISTS automation_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    rule_id TEXT,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',      -- open | acknowledged | resolved
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT id, 'backups.enabled', 'boolean', CASE WHEN key LIKE '%_starter' THEN 'false' ELSE 'true' END FROM plans;
INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT id, 'automations.enabled', 'boolean', CASE WHEN key LIKE '%_starter' OR key LIKE '%_growth' THEN 'false' ELSE 'true' END FROM plans;
