-- Roadmap 1.5: redemption limits and tracking for coupons.
-- Redemptions are recorded when checkout COMPLETES (not when it starts),
-- so abandoned checkouts never use up a limited coupon.
ALTER TABLE coupons ADD COLUMN max_redemptions INTEGER;           -- NULL = unlimited
ALTER TABLE coupons ADD COLUMN redemption_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE coupons ADD COLUMN note TEXT;

CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id TEXT PRIMARY KEY,
    coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    subscription_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(coupon_id, organization_id)                              -- one redemption per organization
);
CREATE INDEX IF NOT EXISTS idx_coupon_redemptions_coupon ON coupon_redemptions(coupon_id);
