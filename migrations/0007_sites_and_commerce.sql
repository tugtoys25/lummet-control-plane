-- =====================================================
-- SITES, PRODUCTS, PLANS, ENTITLEMENTS, SUBSCRIPTIONS
-- (Phase 1 continued)
--
-- `sites` here is the SaaS-lifecycle record an organization
-- sees and manages — pending/provisioning/active/etc. It is
-- deliberately separate from `tenants` (migration 0001),
-- which is the control plane's registry of an ALREADY-
-- deployed Cloudflare Worker it can call over the Super
-- API. A site starts with tenant_id = NULL and is only
-- linked to a `tenants` row once Phase 3 (automated
-- provisioning) actually stands up the Worker/D1/KV/R2 for
-- it. Until then the site row is real (its plan, owner, and
-- status are true) even though nothing is deployed yet —
-- see master prompt section 9.
-- =====================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------
-- PRODUCTS / PLANS / ENTITLEMENTS
-- Commercial catalog as data, never as string literals in
-- business logic (master prompt rule #3 / section 12).
-- Seeded minimally below with one trial-capable plan so the
-- entitlement service and trial flow have something real to
-- resolve end to end. This is illustrative catalog data, NOT
-- final pricing (see section 11) — a real catalog-management
-- screen is staff-console work (section 45), not yet built.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,                          -- uuid / stable key
    key TEXT NOT NULL UNIQUE,                     -- stable machine key, e.g. "casino_news"
    name TEXT NOT NULL,                           -- customer-facing name
    category TEXT NOT NULL,                       -- news | affiliate | business | license
    status TEXT NOT NULL DEFAULT 'active',        -- active | retired
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,                          -- uuid / stable key
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    key TEXT NOT NULL UNIQUE,                     -- stable machine key, e.g. "casino_news_starter"
    name TEXT NOT NULL,                           -- customer-facing name, e.g. "Starter"
    billing_period TEXT NOT NULL DEFAULT 'monthly', -- monthly | annual | custom
    price_cents INTEGER,                          -- NULL = custom/contract pricing
    currency TEXT NOT NULL DEFAULT 'USD',
    trial_days INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',        -- active | retired
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plans_product ON plans(product_id);

CREATE TABLE IF NOT EXISTS plan_entitlements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    key TEXT NOT NULL,                            -- e.g. "sites.max", "affiliate.enabled"
    value_type TEXT NOT NULL,                     -- boolean | number | text | json
    value TEXT NOT NULL,                          -- stored as text, cast by entitlements.js per value_type
    UNIQUE(plan_id, key)
);

CREATE INDEX IF NOT EXISTS idx_plan_entitlements_plan ON plan_entitlements(plan_id);

-- -----------------------------------------------------
-- SUBSCRIPTIONS
-- One (non-canceled) subscription per organization drives
-- its entitlements. No payment provider is wired yet
-- (Phase 2 of the master prompt) — status starts and stays
-- "trialing" until real billing exists. Nothing in this
-- migration or in Phase 1 code ever fabricates an "active"
-- paid subscription (rule #5).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plan_id TEXT NOT NULL REFERENCES plans(id),
    status TEXT NOT NULL DEFAULT 'trialing',      -- trialing|active|past_due|paused|canceled|expired|incomplete|incomplete_expired|suspended
    trial_ends_at TEXT,
    current_period_end TEXT,
    canceled_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(organization_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);

CREATE TABLE IF NOT EXISTS subscription_entitlement_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value_type TEXT NOT NULL,
    value TEXT NOT NULL,
    reason TEXT,                                  -- why this override exists, for staff/audit visibility
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(subscription_id, key)
);

-- -----------------------------------------------------
-- SITES
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS sites (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL, -- linked once provisioned (Phase 3)
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    product_id TEXT NOT NULL REFERENCES products(id),
    status TEXT NOT NULL DEFAULT 'pending',       -- pending|provisioning|provisioned|configuring|deploying|active|suspended|maintenance|failed|deleting|deleted
    primary_domain TEXT,
    suspension_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sites_org ON sites(organization_id);
CREATE INDEX IF NOT EXISTS idx_sites_status ON sites(status);
CREATE INDEX IF NOT EXISTS idx_sites_tenant ON sites(tenant_id);

CREATE TABLE IF NOT EXISTS site_status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    actor_type TEXT NOT NULL DEFAULT 'system',    -- system | customer_user | lummet_admin
    actor_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_site_status_events_site ON site_status_events(site_id);

-- -----------------------------------------------------
-- USAGE COUNTERS
-- Phase 1 skeleton — just enough for entitlement checks
-- like "sites.max" to compare against a real count. The
-- full metering service (master prompt section 15: storage,
-- API requests, AI credits, etc.) is later work and is not
-- implemented by this migration.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS usage_counters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
    metric_key TEXT NOT NULL,                     -- e.g. "sites.count", "users.count"
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, site_id, metric_key, period_start)
);

CREATE INDEX IF NOT EXISTS idx_usage_counters_org ON usage_counters(organization_id);

-- -----------------------------------------------------
-- SEED: one example product + a trial-capable plan so the
-- entitlement service and trial flow resolve against real
-- rows end to end. Illustrative catalog data only — NOT
-- final pricing (master prompt section 11 explicitly warns
-- against treating these numbers as commercial truth).
-- -----------------------------------------------------

INSERT OR IGNORE INTO products (id, key, name, category) VALUES
    ('prod_casino_news', 'casino_news', 'Casino News', 'news');

INSERT OR IGNORE INTO plans (id, product_id, key, name, billing_period, price_cents, trial_days) VALUES
    ('plan_casino_news_starter', 'prod_casino_news', 'casino_news_starter', 'Starter', 'monthly', 500, 7);

INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value) VALUES
    ('plan_casino_news_starter', 'sites.max', 'number', '1'),
    ('plan_casino_news_starter', 'domains.custom.max', 'number', '1'),
    ('plan_casino_news_starter', 'users.max', 'number', '2'),
    ('plan_casino_news_starter', 'storage.max_mb', 'number', '500'),
    ('plan_casino_news_starter', 'ai.enabled', 'boolean', 'false'),
    ('plan_casino_news_starter', 'affiliate.enabled', 'boolean', 'false'),
    ('plan_casino_news_starter', 'analytics.level', 'text', 'basic'),
    ('plan_casino_news_starter', 'white_label.enabled', 'boolean', 'false'),
    ('plan_casino_news_starter', 'api.enabled', 'boolean', 'false');
