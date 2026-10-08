-- =====================================================
-- LUMMET ADMIN RBAC (Phase 10)
--
-- Extends the single flat `master_admin` role from
-- migration 0001 into real role-based access for Lummet
-- staff: who can log in at all, which tenants they may
-- switch to/manage, and which Content/System resources
-- (per tenant) and which lummet.com CMS resources they may
-- read/create/update/delete.
--
-- `super_admin` (and the legacy `master_admin` value from
-- before this migration) bypasses every check below,
-- exactly like the tenant's own `admin` role bypasses its
-- permissions table — see rbac.js. Everyone else starts
-- with zero access until a super admin explicitly grants it.
-- =====================================================

PRAGMA foreign_keys = ON;

ALTER TABLE lummet_admins ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- active | disabled
ALTER TABLE lummet_admins ADD COLUMN created_by INTEGER REFERENCES lummet_admins(id) ON DELETE SET NULL;
ALTER TABLE lummet_admins ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;

-- -----------------------------------------------------
-- Which tenants a non-super-admin may see/switch to/act
-- on at all. A super admin needs no rows here.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_admin_tenant_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES lummet_admins(id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(admin_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_admin_tenant_access_admin ON lummet_admin_tenant_access(admin_id);

-- -----------------------------------------------------
-- Fine-grained role/resource/action grants, scoped by
-- `area`:
--   'tenant'   — Content/System resources on whichever
--                tenant is currently active (casinos,
--                reviews, news, pages, users, settings…),
--                same resource keys as resources.js.
--   'cms'      — lummet.com's own CMS resources (pages,
--                authors, brands, partners, updates,
--                publications, advertisements, site_settings).
--   'platform' — control-plane-only screens (admins,
--                credentials, audit-logs, capabilities,
--                tenants — registering/deleting a tenant
--                itself, not its content).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_admin_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER NOT NULL REFERENCES lummet_admins(id) ON DELETE CASCADE,
    area TEXT NOT NULL,
    resource TEXT NOT NULL,
    action TEXT NOT NULL,          -- create | read | update | delete
    allowed INTEGER NOT NULL DEFAULT 0,
    UNIQUE(admin_id, area, resource, action)
);

CREATE INDEX IF NOT EXISTS idx_admin_permissions_admin ON lummet_admin_permissions(admin_id);
