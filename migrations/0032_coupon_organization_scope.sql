-- v6A: organization-scoped coupons (ported from v4A's coupons.organization_id).
-- NULL = usable by any organization (all existing coupons keep working unchanged).
-- When set, only that organization can use the code; anyone else gets the same
-- "invalid_coupon" answer as for a code that does not exist, so a scoped code
-- cannot be discovered by guessing.
ALTER TABLE coupons ADD COLUMN organization_id TEXT;
CREATE INDEX IF NOT EXISTS idx_coupons_organization ON coupons(organization_id);
