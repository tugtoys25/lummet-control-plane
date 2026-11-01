-- =====================================================
-- 0078_plan_catalog_management (staff console: manageable plans & pricing)
--
-- Everything here is ADDITIVE. No column, row or table that existed before is changed or dropped, and every new column
-- has a default that reproduces the previous behaviour:
--   * plans.status keeps its meaning. 'active' = published and sellable, 'retired' = archived. This release adds a third
--     value, 'draft' (not published, can be edited freely). Every customer/public query already filters status = 'active',
--     so a draft plan is invisible to them without any other change.
--   * plans.sort_order 0 for every plan = the existing price ordering is unchanged.
--   * plans.is_featured 0 for every plan = the pricing page keeps highlighting the middle plan of a 3-plan family.
--   * plan_features empty for a plan = the pricing page keeps deriving its feature list from plan_entitlements.
--
-- Prices are NOT stored by this migration. Amounts and Stripe price ids stay in plan_prices (migration 0052), still
-- immutable: a price change is a new version row, written by worker/repositories/plan-price-versions.js.
--
-- ROLLBACK: the previous release ignores every object created here. To undo, deploy the previous release; the new
-- columns and tables can stay in place. A plan left in 'draft' is simply hidden by the previous release.
-- =====================================================

-- ---- plan presentation + SEO --------------------------------------------------------------------------------------
ALTER TABLE plans ADD COLUMN description TEXT;                         -- longer marketing copy (plan page, comparison)
ALTER TABLE plans ADD COLUMN tagline TEXT;                             -- one line under the plan name on the pricing card
ALTER TABLE plans ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;    -- lower first inside its product family
ALTER TABLE plans ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0;   -- "recommended" highlight on the pricing page
ALTER TABLE plans ADD COLUMN cta_label TEXT;                           -- optional button text override
ALTER TABLE plans ADD COLUMN seo_title TEXT;
ALTER TABLE plans ADD COLUMN seo_description TEXT;
ALTER TABLE plans ADD COLUMN published_at TEXT;                        -- first time the plan was published
ALTER TABLE plans ADD COLUMN updated_at TEXT;

UPDATE plans SET published_at = COALESCE(created_at, CURRENT_TIMESTAMP) WHERE status = 'active' AND published_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
CREATE INDEX IF NOT EXISTS idx_plans_sort ON plans(product_id, sort_order);

-- ---- labels (reusable chips: "Popular", "Best value", ...) --------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_labels (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,                       -- slug, e.g. "best_value"
    name TEXT NOT NULL,                             -- what the visitor sees
    color TEXT NOT NULL DEFAULT 'neutral',          -- neutral | blue | green | amber | red | purple | teal
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plan_label_links (
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    label_id TEXT NOT NULL REFERENCES plan_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (plan_id, label_id)
);
CREATE INDEX IF NOT EXISTS idx_plan_label_links_label ON plan_label_links(label_id);

INSERT OR IGNORE INTO plan_labels (id, key, name, color) VALUES
    ('label_popular',     'popular',     'Popular',       'purple'),
    ('label_new',         'new',         'New',           'blue'),
    ('label_best_value',  'best_value',  'Best value',    'green'),
    ('label_recommended', 'recommended', 'Recommended',   'teal'),
    ('label_limited',     'limited',     'Limited offer', 'amber'),
    ('label_enterprise',  'enterprise',  'Enterprise',    'neutral');

-- ---- marketing feature list (what the pricing card shows) ---------------------------------------------------------
-- Distinct from plan_entitlements: entitlements are what the product ENFORCES, these lines are what the visitor READS.
CREATE TABLE IF NOT EXISTS plan_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    included INTEGER NOT NULL DEFAULT 1 CHECK (included IN (0, 1)),   -- 0 = shown as "not included"
    highlight INTEGER NOT NULL DEFAULT 0 CHECK (highlight IN (0, 1)),
    sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plan_features_plan ON plan_features(plan_id, sort_order);

-- ---- promotions ---------------------------------------------------------------------------------------------------
-- A promotion is a time-boxed banner on a plan. It NEVER changes what a customer is charged: the discount itself is a
-- Stripe coupon (see /platform/saas/coupons). A promotion may point at one, and then the pricing page tells the visitor
-- which code to enter. Without a coupon it is a plain announcement ("Launch week").
CREATE TABLE IF NOT EXISTS plan_promotions (
    id TEXT PRIMARY KEY,
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    name TEXT NOT NULL,                             -- staff-facing name
    badge_text TEXT NOT NULL,                       -- visitor-facing, e.g. "20% off your first year"
    coupon_id TEXT REFERENCES coupons(id) ON DELETE SET NULL,
    starts_at TEXT,                                 -- 'YYYY-MM-DD HH:MM:SS' UTC, NULL = already started
    ends_at TEXT,                                   -- NULL = no end
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_plan_promotions_plan ON plan_promotions(plan_id, status);
