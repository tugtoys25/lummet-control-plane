-- Closes the last-use race on limited coupons. Starting a checkout with a
-- coupon that has max_redemptions takes a short HOLD (one row per
-- coupon + organization). Holds count against the limit for everyone
-- else until they expire or the checkout completes (the redemption row
-- then replaces the hold). Redemptions still happen only on completion,
-- so the hold, not the counter, is what is taken at checkout start.
CREATE TABLE IF NOT EXISTS coupon_reservations (
    coupon_id TEXT NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    organization_id TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (coupon_id, organization_id)
);
CREATE INDEX IF NOT EXISTS idx_coupon_reservations_expiry ON coupon_reservations(coupon_id, expires_at);
