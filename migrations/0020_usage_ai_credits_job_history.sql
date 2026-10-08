-- =====================================================
-- USAGE METERING, AI CREDIT LEDGER, JOB HISTORY
-- (master prompt sections 15, 16, 38)
-- =====================================================

-- Raw, idempotent usage events. idempotency_key makes duplicate
-- delivery of the same event a no-op.
CREATE TABLE IF NOT EXISTS usage_events (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    site_id TEXT,
    user_id TEXT,
    metric TEXT NOT NULL,            -- api_requests | emails | webhook_deliveries | deployments | ai_credits | storage_mb ...
    quantity INTEGER NOT NULL,
    period TEXT NOT NULL,            -- 'YYYY-MM' (UTC)
    idempotency_key TEXT,
    metadata TEXT,
    occurred_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_events_idem ON usage_events(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_events_org_period ON usage_events(organization_id, period, metric);

-- Aggregate, kept in step with usage_events by usage.js (same code path).
CREATE TABLE IF NOT EXISTS usage_monthly (
    organization_id TEXT NOT NULL,
    period TEXT NOT NULL,
    metric TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (organization_id, period, metric)
);

-- Append-only credit ledger. Balance = SUM(amount). Positive = grant/purchase/
-- refund/settle-back, negative = reservation/usage. Never updated in place.
CREATE TABLE IF NOT EXISTS ai_credit_ledger (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    site_id TEXT,
    user_id TEXT,
    kind TEXT NOT NULL,              -- grant_monthly | purchase | reserve | settle | refund | adjust
    amount INTEGER NOT NULL,
    reservation_id TEXT,             -- ties reserve/settle/refund together
    idempotency_key TEXT,
    provider TEXT,
    model TEXT,
    task TEXT,
    provider_tokens_in INTEGER,
    provider_tokens_out INTEGER,
    provider_cost_micros INTEGER,    -- provider cost in millionths of USD, if known
    note TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_ledger_idem ON ai_credit_ledger(organization_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_ledger_org ON ai_credit_ledger(organization_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_ledger_res ON ai_credit_ledger(reservation_id);

-- Unified job history (jobs + job_steps already exist, migration 0010).
CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    run_number INTEGER NOT NULL,
    trigger TEXT NOT NULL DEFAULT 'initial',   -- initial | retry | manual
    status TEXT NOT NULL DEFAULT 'running',    -- running | success | failed
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT,
    error_message TEXT,
    UNIQUE(job_id, run_number)
);
CREATE TABLE IF NOT EXISTS job_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    run_number INTEGER NOT NULL,
    step_key TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL,                      -- running | success | failed | skipped
    error_message TEXT,
    started_at TEXT DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_attempts_job ON job_attempts(job_id);
CREATE TABLE IF NOT EXISTS job_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',        -- info | warn | error
    message TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_job_logs_job ON job_logs(job_id, id);

-- Monthly AI credit allocation per plan tier (editable configuration).
INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT id, 'ai.credits_monthly', 'number',
  CASE WHEN key LIKE '%_starter' THEN '0'
       WHEN key LIKE '%_growth'  THEN '500'
       WHEN key LIKE '%_pro'     THEN '2500'
       WHEN key IN ('agency_30') THEN '10000'
       WHEN key IN ('agency_100') THEN '40000'
       ELSE '150000' END
FROM plans;
