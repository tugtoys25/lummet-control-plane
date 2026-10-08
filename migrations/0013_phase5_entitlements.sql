-- =====================================================
-- Phase 5 adds two new entitlement keys (reports.enabled,
-- alerts.enabled — see entitlements.js) that gate the new
-- tenant-portal analytics/reports/campaigns/alerts proxy.
-- Any plan without an explicit row for these keys already
-- resolves them to `false` via entitlements.js's
-- ZERO_ACCESS_ENTITLEMENTS floor merge, so this migration is
-- not strictly required for correctness — it exists so the
-- one seeded example plan (migration 0006) stays a complete,
-- explicit record of its own feature set rather than
-- silently relying on the floor for two of its keys.
-- =====================================================

INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value) VALUES
    ('plan_casino_news_starter', 'reports.enabled', 'boolean', 'false'),
    ('plan_casino_news_starter', 'alerts.enabled', 'boolean', 'false');
