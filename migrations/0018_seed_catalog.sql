-- =====================================================
-- FULL COMMERCIAL CATALOG (master prompt sections 10, 11,
-- 44)
--
-- Migration 0007 seeded exactly ONE example plan
-- (Casino News Starter, $5/mo) as a proof that the
-- products/plans/plan_entitlements schema works end to
-- end -- its own comments say so explicitly. Every other
-- product and every Growth/Pro/business/license tier the
-- master prompt asks for was never seeded, which means
-- until this migration runs, a real signup flow has
-- nothing to sell beyond that one plan.
--
-- Uses INSERT OR IGNORE throughout and the SAME id/key
-- naming convention as the existing seed (underscored,
-- e.g. prod_casino_news / plan_casino_news_starter) so
-- this is safe to run after 0007/0013/0015 without
-- touching the row they already created -- re-running this
-- migration a second time, or running it on a database
-- that already has some of these rows for any reason, is a
-- no-op for whatever already exists rather than an error.
--
-- This is EDITABLE CONFIGURATION, not application logic
-- (rule #3): add, retire, or reprice a plan with
--   UPDATE plans SET price_cents = ... WHERE key = '...';
-- or an `INSERT OR IGNORE` following this file's pattern --
-- never by changing plans.js/entitlements.js/index.js.
-- Prices are the master prompt's SUGGESTED starting point
-- (section 11: "Do not treat these prices as final legal or
-- commercial truth").
--
-- Entitlement keys used below are exactly the set read by
-- worker/entitlements.js's ZERO_ACCESS_ENTITLEMENTS floor --
-- every value seeded here is enforced somewhere in the
-- running code today, not decorative.
--
-- No staff UI exists yet to create/edit these records
-- (plans.js is read-only from the customer side by design;
-- catalog management is master-prompt section 45 staff-
-- console work, not built) -- see docs/SAAS_MERGE_NOTES.md.
-- =====================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------
-- PRODUCTS
-- ---------------------------------------------

INSERT OR IGNORE INTO products (id, key, name, category, status) VALUES
    ('prod_casino_news',        'casino_news',        'Casino News',            'news',      'active'),
    ('prod_sports_news',        'sports_news',        'Sports News',            'news',      'active'),
    ('prod_igaming_news',       'igaming_news',       'Full iGaming News',      'news',      'active'),
    ('prod_casino_affiliate',   'casino_affiliate',   'Casino Affiliate',       'affiliate', 'active'),
    ('prod_sports_affiliate',   'sports_affiliate',   'Sports Affiliate',       'affiliate', 'active'),
    ('prod_other_affiliate',    'other_affiliate',    'Other iGaming Affiliate','affiliate', 'active'),
    ('prod_combined_affiliate', 'combined_affiliate', 'Combined Affiliate',     'affiliate', 'active'),
    ('prod_agency',             'agency',             'Agency',                 'business',  'active'),
    ('prod_enterprise',         'enterprise',         'Enterprise',             'business',  'active'),
    ('prod_founder_license',    'founder_license',    'Founder License',       'license',   'active');

-- ---------------------------------------------
-- PLANS
-- Publisher/affiliate products get the same three-tier
-- shape (Starter/Growth/Pro), 7-day trial, monthly billing.
-- casino_news_starter already exists (migration 0007) and
-- is skipped by OR IGNORE; every other row here is new.
-- Annual pricing is deliberately NOT seeded (section 11
-- warns against "economically impossible discounts") --
-- add it separately once real commercial terms are set.
-- ---------------------------------------------

INSERT OR IGNORE INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status) VALUES
    -- Casino News: $5 / $8 / $20 (starter pre-existing)
    ('plan_casino_news_starter', 'prod_casino_news', 'casino_news_starter', 'Starter', 'monthly', 500,  'USD', 7, 'active'),
    ('plan_casino_news_growth',  'prod_casino_news', 'casino_news_growth',  'Growth',  'monthly', 800,  'USD', 7, 'active'),
    ('plan_casino_news_pro',     'prod_casino_news', 'casino_news_pro',     'Pro',     'monthly', 2000, 'USD', 7, 'active'),

    -- Sports News: $5 / $8 / $20
    ('plan_sports_news_starter', 'prod_sports_news', 'sports_news_starter', 'Starter', 'monthly', 500,  'USD', 7, 'active'),
    ('plan_sports_news_growth',  'prod_sports_news', 'sports_news_growth',  'Growth',  'monthly', 800,  'USD', 7, 'active'),
    ('plan_sports_news_pro',     'prod_sports_news', 'sports_news_pro',     'Pro',     'monthly', 2000, 'USD', 7, 'active'),

    -- Full iGaming News: $9 / $15 / $25
    ('plan_igaming_news_starter', 'prod_igaming_news', 'igaming_news_starter', 'Starter', 'monthly', 900,  'USD', 7, 'active'),
    ('plan_igaming_news_growth',  'prod_igaming_news', 'igaming_news_growth',  'Growth',  'monthly', 1500, 'USD', 7, 'active'),
    ('plan_igaming_news_pro',     'prod_igaming_news', 'igaming_news_pro',     'Pro',     'monthly', 2500, 'USD', 7, 'active'),

    -- Casino Affiliate: $9 / $15 / $25
    ('plan_casino_affiliate_starter', 'prod_casino_affiliate', 'casino_affiliate_starter', 'Starter', 'monthly', 900,  'USD', 7, 'active'),
    ('plan_casino_affiliate_growth',  'prod_casino_affiliate', 'casino_affiliate_growth',  'Growth',  'monthly', 1500, 'USD', 7, 'active'),
    ('plan_casino_affiliate_pro',     'prod_casino_affiliate', 'casino_affiliate_pro',     'Pro',     'monthly', 2500, 'USD', 7, 'active'),

    -- Sports Affiliate: $9 / $15 / $25
    ('plan_sports_affiliate_starter', 'prod_sports_affiliate', 'sports_affiliate_starter', 'Starter', 'monthly', 900,  'USD', 7, 'active'),
    ('plan_sports_affiliate_growth',  'prod_sports_affiliate', 'sports_affiliate_growth',  'Growth',  'monthly', 1500, 'USD', 7, 'active'),
    ('plan_sports_affiliate_pro',     'prod_sports_affiliate', 'sports_affiliate_pro',     'Pro',     'monthly', 2500, 'USD', 7, 'active'),

    -- Other iGaming Affiliate: $9 / $15 / $25
    ('plan_other_affiliate_starter', 'prod_other_affiliate', 'other_affiliate_starter', 'Starter', 'monthly', 900,  'USD', 7, 'active'),
    ('plan_other_affiliate_growth',  'prod_other_affiliate', 'other_affiliate_growth',  'Growth',  'monthly', 1500, 'USD', 7, 'active'),
    ('plan_other_affiliate_pro',     'prod_other_affiliate', 'other_affiliate_pro',     'Pro',     'monthly', 2500, 'USD', 7, 'active'),

    -- Combined Affiliate: $25 / $33 / $50
    ('plan_combined_affiliate_starter', 'prod_combined_affiliate', 'combined_affiliate_starter', 'Starter', 'monthly', 2500, 'USD', 7, 'active'),
    ('plan_combined_affiliate_growth',  'prod_combined_affiliate', 'combined_affiliate_growth',  'Growth',  'monthly', 3300, 'USD', 7, 'active'),
    ('plan_combined_affiliate_pro',     'prod_combined_affiliate', 'combined_affiliate_pro',     'Pro',     'monthly', 5000, 'USD', 7, 'active'),

    -- Business / white-label -- sales-assisted, no self-serve trial.
    ('plan_agency_30',     'prod_agency',     'agency_30',     'Agency 30',      'monthly', 19900,  'USD', 0, 'active'),
    ('plan_agency_100',    'prod_agency',     'agency_100',    'Agency 100',     'monthly', 49900,  'USD', 0, 'active'),
    ('plan_enterprise_300','prod_enterprise', 'enterprise_300','Enterprise 300', 'monthly', 149900, 'USD', 0, 'active'),
    -- Master: price_cents NULL = custom/contract pricing (section
    -- 11). billing.js's startCheckout already refuses to start a
    -- Stripe Checkout session for a NULL-price plan rather than
    -- charging $0 -- selling this plan means a manual/contract flow.
    ('plan_master', 'prod_enterprise', 'master', 'Master', 'custom', NULL, 'USD', 0, 'active'),

    -- Founder License: one-time, not recurring. billing_period
    -- 'custom' makes billing.js treat this as outside normal
    -- subscription checkout (see startCheckout's early-return for
    -- billing_period = 'custom') -- selling it today means an
    -- off-platform invoice/contract, not a working Checkout button.
    ('plan_founder_license', 'prod_founder_license', 'founder_license', 'Founder License', 'custom', 5000000, 'USD', 0, 'active');

-- ---------------------------------------------
-- PLAN ENTITLEMENTS — STARTER tier
-- (plan_casino_news_starter already has its own explicit
-- rows from 0007/0013/0015; OR IGNORE skips it here so
-- those original values are left untouched rather than
-- silently overwritten by this migration's defaults.)
-- ---------------------------------------------

INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT p.id, e.key, e.value_type, e.value
FROM plans p
CROSS JOIN (
    SELECT 'sites.max' AS key, 'number' AS value_type, '1' AS value
    UNION ALL SELECT 'domains.custom.max', 'number', '1'
    UNION ALL SELECT 'users.max', 'number', '2'
    UNION ALL SELECT 'storage.max_mb', 'number', '500'
    UNION ALL SELECT 'analytics.level', 'text', 'basic'
    UNION ALL SELECT 'ai.enabled', 'boolean', 'false'
    UNION ALL SELECT 'api.enabled', 'boolean', 'false'
    UNION ALL SELECT 'reports.enabled', 'boolean', 'false'
    UNION ALL SELECT 'alerts.enabled', 'boolean', 'false'
    UNION ALL SELECT 'white_label.enabled', 'boolean', 'false'
    UNION ALL SELECT 'approval_workflows.enabled', 'boolean', 'false'
    UNION ALL SELECT 'dedicated_infrastructure.enabled', 'boolean', 'false'
) e
WHERE p.key LIKE '%_starter';

-- GROWTH tier
INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT p.id, e.key, e.value_type, e.value
FROM plans p
CROSS JOIN (
    SELECT 'sites.max' AS key, 'number' AS value_type, '1' AS value
    UNION ALL SELECT 'domains.custom.max', 'number', '2'
    UNION ALL SELECT 'users.max', 'number', '5'
    UNION ALL SELECT 'storage.max_mb', 'number', '2000'
    UNION ALL SELECT 'analytics.level', 'text', 'standard'
    UNION ALL SELECT 'ai.enabled', 'boolean', 'true'
    UNION ALL SELECT 'api.enabled', 'boolean', 'true'
    UNION ALL SELECT 'reports.enabled', 'boolean', 'true'
    UNION ALL SELECT 'alerts.enabled', 'boolean', 'true'
    UNION ALL SELECT 'white_label.enabled', 'boolean', 'false'
    UNION ALL SELECT 'approval_workflows.enabled', 'boolean', 'false'
    UNION ALL SELECT 'dedicated_infrastructure.enabled', 'boolean', 'false'
) e
WHERE p.key LIKE '%_growth';

-- PRO tier
INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT p.id, e.key, e.value_type, e.value
FROM plans p
CROSS JOIN (
    SELECT 'sites.max' AS key, 'number' AS value_type, '3' AS value
    UNION ALL SELECT 'domains.custom.max', 'number', '5'
    UNION ALL SELECT 'users.max', 'number', '10'
    UNION ALL SELECT 'storage.max_mb', 'number', '10000'
    UNION ALL SELECT 'analytics.level', 'text', 'advanced'
    UNION ALL SELECT 'ai.enabled', 'boolean', 'true'
    UNION ALL SELECT 'api.enabled', 'boolean', 'true'
    UNION ALL SELECT 'reports.enabled', 'boolean', 'true'
    UNION ALL SELECT 'alerts.enabled', 'boolean', 'true'
    UNION ALL SELECT 'white_label.enabled', 'boolean', 'false'
    UNION ALL SELECT 'approval_workflows.enabled', 'boolean', 'true'
    UNION ALL SELECT 'dedicated_infrastructure.enabled', 'boolean', 'false'
) e
WHERE p.key LIKE '%_pro';

-- affiliate.enabled: true only for affiliate-category products
-- (combined product included); news-only products never get
-- affiliate features regardless of tier (section 44's product
-- packaging). casino_news_starter's pre-existing row (already
-- 'false') is left alone by OR IGNORE.
INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT p.id, 'affiliate.enabled', 'boolean', 'true'
FROM plans p
JOIN products pr ON pr.id = p.product_id
WHERE pr.category = 'affiliate';

INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT p.id, 'affiliate.enabled', 'boolean', 'false'
FROM plans p
JOIN products pr ON pr.id = p.product_id
WHERE pr.category = 'news';

-- Business / white-label / license tiers: specified individually
-- since caps scale with the plan's own commercial size rather
-- than a shared tier shape.
INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value) VALUES
    ('plan_agency_30', 'sites.max', 'number', '30'),
    ('plan_agency_30', 'domains.custom.max', 'number', '30'),
    ('plan_agency_30', 'users.max', 'number', '25'),
    ('plan_agency_30', 'storage.max_mb', 'number', '50000'),
    ('plan_agency_30', 'analytics.level', 'text', 'advanced'),
    ('plan_agency_30', 'ai.enabled', 'boolean', 'true'),
    ('plan_agency_30', 'api.enabled', 'boolean', 'true'),
    ('plan_agency_30', 'reports.enabled', 'boolean', 'true'),
    ('plan_agency_30', 'alerts.enabled', 'boolean', 'true'),
    ('plan_agency_30', 'affiliate.enabled', 'boolean', 'true'),
    ('plan_agency_30', 'white_label.enabled', 'boolean', 'true'),
    ('plan_agency_30', 'approval_workflows.enabled', 'boolean', 'true'),
    ('plan_agency_30', 'dedicated_infrastructure.enabled', 'boolean', 'false'),

    ('plan_agency_100', 'sites.max', 'number', '100'),
    ('plan_agency_100', 'domains.custom.max', 'number', '100'),
    ('plan_agency_100', 'users.max', 'number', '50'),
    ('plan_agency_100', 'storage.max_mb', 'number', '200000'),
    ('plan_agency_100', 'analytics.level', 'text', 'advanced'),
    ('plan_agency_100', 'ai.enabled', 'boolean', 'true'),
    ('plan_agency_100', 'api.enabled', 'boolean', 'true'),
    ('plan_agency_100', 'reports.enabled', 'boolean', 'true'),
    ('plan_agency_100', 'alerts.enabled', 'boolean', 'true'),
    ('plan_agency_100', 'affiliate.enabled', 'boolean', 'true'),
    ('plan_agency_100', 'white_label.enabled', 'boolean', 'true'),
    ('plan_agency_100', 'approval_workflows.enabled', 'boolean', 'true'),
    ('plan_agency_100', 'dedicated_infrastructure.enabled', 'boolean', 'false'),

    ('plan_enterprise_300', 'sites.max', 'number', '300'),
    ('plan_enterprise_300', 'domains.custom.max', 'number', '300'),
    ('plan_enterprise_300', 'users.max', 'number', '200'),
    ('plan_enterprise_300', 'storage.max_mb', 'number', '1000000'),
    ('plan_enterprise_300', 'analytics.level', 'text', 'advanced'),
    ('plan_enterprise_300', 'ai.enabled', 'boolean', 'true'),
    ('plan_enterprise_300', 'api.enabled', 'boolean', 'true'),
    ('plan_enterprise_300', 'reports.enabled', 'boolean', 'true'),
    ('plan_enterprise_300', 'alerts.enabled', 'boolean', 'true'),
    ('plan_enterprise_300', 'affiliate.enabled', 'boolean', 'true'),
    ('plan_enterprise_300', 'white_label.enabled', 'boolean', 'true'),
    ('plan_enterprise_300', 'approval_workflows.enabled', 'boolean', 'true'),
    ('plan_enterprise_300', 'dedicated_infrastructure.enabled', 'boolean', 'true'),

    -- Master: nominal large caps standing in for "custom/negotiated,
    -- not actually unlimited" -- entitlements.js has no dedicated
    -- "unlimited" sentinel, and inventing one now (e.g. -1 meaning
    -- infinite) would change every numeric entitlement check's
    -- contract for a plan nobody can self-serve buy yet. Revisit
    -- when a real Master customer is being onboarded.
    ('plan_master', 'sites.max', 'number', '999999'),
    ('plan_master', 'domains.custom.max', 'number', '999999'),
    ('plan_master', 'users.max', 'number', '999999'),
    ('plan_master', 'storage.max_mb', 'number', '999999999'),
    ('plan_master', 'analytics.level', 'text', 'advanced'),
    ('plan_master', 'ai.enabled', 'boolean', 'true'),
    ('plan_master', 'api.enabled', 'boolean', 'true'),
    ('plan_master', 'reports.enabled', 'boolean', 'true'),
    ('plan_master', 'alerts.enabled', 'boolean', 'true'),
    ('plan_master', 'affiliate.enabled', 'boolean', 'true'),
    ('plan_master', 'white_label.enabled', 'boolean', 'true'),
    ('plan_master', 'approval_workflows.enabled', 'boolean', 'true'),
    ('plan_master', 'dedicated_infrastructure.enabled', 'boolean', 'true'),

    -- Founder License: not a subscription-driven access tier in any
    -- normal sense (section 11: "subject to contract and
    -- infrastructure terms"). Seeded only so a subscription row
    -- referencing this plan doesn't collapse to the zero-access
    -- floor by accident -- the real terms belong in the contract.
    ('plan_founder_license', 'sites.max', 'number', '999999'),
    ('plan_founder_license', 'domains.custom.max', 'number', '999999'),
    ('plan_founder_license', 'users.max', 'number', '999999'),
    ('plan_founder_license', 'storage.max_mb', 'number', '999999999'),
    ('plan_founder_license', 'analytics.level', 'text', 'advanced'),
    ('plan_founder_license', 'ai.enabled', 'boolean', 'true'),
    ('plan_founder_license', 'api.enabled', 'boolean', 'true'),
    ('plan_founder_license', 'reports.enabled', 'boolean', 'true'),
    ('plan_founder_license', 'alerts.enabled', 'boolean', 'true'),
    ('plan_founder_license', 'affiliate.enabled', 'boolean', 'true'),
    ('plan_founder_license', 'white_label.enabled', 'boolean', 'true'),
    ('plan_founder_license', 'approval_workflows.enabled', 'boolean', 'true'),
    ('plan_founder_license', 'dedicated_infrastructure.enabled', 'boolean', 'true');
