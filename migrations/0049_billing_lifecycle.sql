-- Phase 1, sprint 1.1: billing lifecycle columns and the shadow-mode log.
-- Additive only; existing rows keep working (every new column is nullable or defaulted).
-- Rollback: set BILLING_ENFORCE=off (new code paths become inert); the columns can simply be ignored.
ALTER TABLE subscriptions ADD COLUMN stripe_status TEXT;            -- raw provider status, audit only
ALTER TABLE subscriptions ADD COLUMN trial_started_at TEXT;
ALTER TABLE subscriptions ADD COLUMN current_period_start TEXT;
ALTER TABLE subscriptions ADD COLUMN grace_ends_at TEXT;            -- set on the first failed payment
ALTER TABLE subscriptions ADD COLUMN restricted_at TEXT;
ALTER TABLE subscriptions ADD COLUMN suspended_at TEXT;
ALTER TABLE subscriptions ADD COLUMN pause_resumes_at TEXT;
ALTER TABLE subscriptions ADD COLUMN latest_invoice_id TEXT;
ALTER TABLE plans ADD COLUMN stripe_product_id TEXT;
ALTER TABLE plans ADD COLUMN tax_code TEXT;
ALTER TABLE plans ADD COLUMN catalog_version INTEGER NOT NULL DEFAULT 1;

-- What the access state machine WOULD do, written while BILLING_ENFORCE=shadow (nothing changes for customers).
CREATE TABLE IF NOT EXISTS subscription_access_shadow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    subscription_id TEXT,
    evaluated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    state TEXT NOT NULL,                  -- the state resolveAccess computed
    would_change_from TEXT,               -- the stored subscription status it would change
    reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_shadow_org ON subscription_access_shadow(organization_id, id);

-- Webhook events refused by the livemode guard (a test-mode event sent to production, or the reverse).
CREATE TABLE IF NOT EXISTS billing_webhook_rejections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    event_id TEXT,
    event_type TEXT,
    reason TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_billing_webhook_rejections_created ON billing_webhook_rejections(created_at);
