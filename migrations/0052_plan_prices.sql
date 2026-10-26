-- =====================================================
-- 0052_plan_prices (Phase 3, sprint 3.1: catalog as code and plan prices)
--
-- One row per REAL Stripe price a plan can be sold at. Before this migration a plan carried a single free-text
-- plans.stripe_price_id that staff could overwrite from the console; that column stays (see ROLLBACK) but is no
-- longer read by checkout, plan changes or webhook plan mapping.
--
-- Prices are IMMUTABLE. A price change is a NEW row (version + 1, new lookup_key); the old row is kept with
-- active = 0 so subscribers who are still on it keep mapping to their plan. Nothing in worker/ updates the
-- amount, currency, interval, plan, lookup key or version of an existing row (test/plan-prices.test.js enforces it).
--
-- The rows are written by scripts/stripe-sync.mjs from catalog/plans.v1.json after it has found or created the
-- price in Stripe by its lookup_key. It never writes a price Stripe does not hold.
--
-- ROLLBACK: deploy v2.2.2 (it ignores this table). The sync script mirrors the active price id back into
-- plans.stripe_price_id and plans.price_cents, so the older code keeps selling what the catalog says. Flag-off is not
-- needed: there is no flag; checkout reads this table as soon as the code is deployed.
--
-- PREFLIGHT (run before applying; each query should return no rows, or rows you accept losing):
--   -- plans whose legacy price id is shared with another plan: only the lowest plan id is carried over
--   SELECT stripe_price_id, COUNT(*) FROM plans WHERE stripe_price_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) > 1;
--   -- plans with a legacy price id that are not monthly or annual (not carried over; checkout would refuse them anyway)
--   SELECT id, billing_period FROM plans WHERE stripe_price_id IS NOT NULL AND billing_period NOT IN ('monthly','annual');
--   -- plans with a legacy price id and no price in the plan row
--   SELECT id FROM plans WHERE stripe_price_id IS NOT NULL AND price_cents IS NULL;
-- =====================================================

CREATE TABLE IF NOT EXISTS plan_prices (
    id TEXT PRIMARY KEY,                                   -- 'pp_<plan id>_v<version>' for backfilled rows, a uuid for synced ones
    plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
    currency TEXT NOT NULL,                                -- ISO 4217, lower case (Stripe's spelling)
    interval TEXT NOT NULL CHECK (interval IN ('month', 'year')),
    unit_amount_cents INTEGER NOT NULL CHECK (unit_amount_cents >= 0),
    tax_behavior TEXT NOT NULL DEFAULT 'unspecified' CHECK (tax_behavior IN ('inclusive', 'exclusive', 'unspecified')),
    stripe_price_id TEXT NOT NULL UNIQUE,
    lookup_key TEXT NOT NULL UNIQUE,                       -- <plan key>_<interval>_<currency>_v<version>
    -- 'unknown' only on rows carried over from plans.stripe_price_id (a Stripe price id does not say which mode it
    -- belongs to). stripe-sync stamps the real mode the first time it sees the price. Checkout refuses a row whose
    -- mode is known and differs from the mode of STRIPE_SECRET_KEY.
    stripe_mode TEXT NOT NULL DEFAULT 'unknown' CHECK (stripe_mode IN ('test', 'live', 'unknown')),
    version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plan_prices_plan ON plan_prices(plan_id);

-- At most one price is the one NEW customers get, per plan, currency and interval.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_prices_one_active ON plan_prices(plan_id, currency, interval) WHERE active = 1;

-- Backfill: one row per existing plans.stripe_price_id (version 1, active, mode unknown). Never fails the migration:
-- a row that would break a constraint is skipped and shows up in the preflight queries above.
INSERT OR IGNORE INTO plan_prices (id, plan_id, currency, interval, unit_amount_cents, tax_behavior, stripe_price_id, lookup_key, stripe_mode, version, active)
SELECT 'pp_' || p.id || '_v1',
       p.id,
       lower(p.currency),
       CASE p.billing_period WHEN 'annual' THEN 'year' ELSE 'month' END,
       p.price_cents,
       'unspecified',
       trim(p.stripe_price_id),
       p.key || '_' || (CASE p.billing_period WHEN 'annual' THEN 'year' ELSE 'month' END) || '_' || lower(p.currency) || '_v1',
       'unknown',
       1,
       1
  FROM plans p
 WHERE p.stripe_price_id IS NOT NULL
   AND trim(p.stripe_price_id) != ''
   AND p.price_cents IS NOT NULL
   AND p.billing_period IN ('monthly', 'annual')
   AND p.id = (SELECT MIN(q.id) FROM plans q WHERE q.stripe_price_id = p.stripe_price_id);
