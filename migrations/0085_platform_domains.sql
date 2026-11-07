-- Platform domains: several default domains a new site can run on (<slug>.<domain>), managed by staff.
-- Additive, idempotent and forward-only. No existing row is rewritten: existing sites keep their stored primary_domain and routes.
--   platform_domains.status  pending | verifying | active | disabled | failed   (removed rows are deleted, never kept)
--   is_default               at most one row (enforced by a partial unique index); only an active row may be the default
--   cname_target             set only on the domain that serves customers' custom hostnames
--   sites.platform_domain_id NULL means "the default platform domain" (the one the site was created under before this feature)
-- The first row is created lazily by worker code from PLATFORM_DOMAIN_SUFFIX and CF_ZONE_ID (a migration cannot read env).
CREATE TABLE IF NOT EXISTS platform_domains (
    id TEXT PRIMARY KEY,
    hostname TEXT NOT NULL,
    label TEXT NOT NULL,
    cf_zone_id TEXT,
    cname_target TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verifying', 'active', 'disabled', 'failed')),
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
    allow_customer_choice INTEGER NOT NULL DEFAULT 1 CHECK (allow_customer_choice IN (0, 1)),
    entitlement_key TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    last_check_at TEXT,
    last_check_json TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_domains_hostname ON platform_domains(hostname);
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_domains_one_default ON platform_domains(is_default) WHERE is_default = 1;
CREATE INDEX IF NOT EXISTS idx_platform_domains_status ON platform_domains(status, sort_order);

-- SQLite has no ADD COLUMN IF NOT EXISTS; the migration runner applies each file once, and the test shim tolerates a repeat.
ALTER TABLE sites ADD COLUMN platform_domain_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sites_platform_domain ON sites(platform_domain_id);
