-- =====================================================
-- Extends the existing lummet_audit_logs table (migration
-- 0001) so customer/organization actions (Phase 1) go
-- through the SAME audit log as staff actions, rather than
-- a duplicate table — master prompt section 33 asks for
-- organization ID and actor type on every audit record.
--
-- Existing rows default to actor_type = 'lummet_admin',
-- which is correct for every row written before this
-- migration (only staff actions existed until now).
-- =====================================================

PRAGMA foreign_keys = ON;

ALTER TABLE lummet_audit_logs ADD COLUMN actor_type TEXT NOT NULL DEFAULT 'lummet_admin'; -- lummet_admin | customer_user | system
ALTER TABLE lummet_audit_logs ADD COLUMN customer_user_id TEXT;
ALTER TABLE lummet_audit_logs ADD COLUMN organization_id TEXT;

CREATE INDEX IF NOT EXISTS idx_lummet_audit_customer_user ON lummet_audit_logs(customer_user_id);
CREATE INDEX IF NOT EXISTS idx_lummet_audit_organization ON lummet_audit_logs(organization_id);
