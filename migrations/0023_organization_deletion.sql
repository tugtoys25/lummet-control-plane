-- =====================================================
-- ORGANIZATION DEACTIVATION / SCHEDULED DELETION (master
-- prompt section 7; roadmap 1.2)
--
-- Deletion is never immediate: it follows the same
-- restricted -> grace-period -> scheduled-deletion shape the
-- master prompt already specifies for trial expiry (section 13),
-- applied here to a customer's own decision to leave. Staff can
-- see and cancel a pending deletion from /platform/saas at any
-- time before it runs, and the owner can cancel it themselves.
-- =====================================================
ALTER TABLE organizations ADD COLUMN scheduled_deletion_at TEXT;
ALTER TABLE organizations ADD COLUMN deletion_requested_by TEXT;
ALTER TABLE organizations ADD COLUMN deletion_requested_at TEXT;

CREATE INDEX IF NOT EXISTS idx_organizations_scheduled_deletion ON organizations(scheduled_deletion_at);
