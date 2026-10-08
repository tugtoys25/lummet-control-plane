-- Security review 2.1 follow-up: SSO may only assert email addresses in domains the
-- organization has proven it owns (a DNS TXT record), and one verified domain can belong
-- to only one organization. Closes address "squatting" through a self-hosted IdP.
CREATE TABLE IF NOT EXISTS organization_sso_domains (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    verification_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | verified
    verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, domain)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sso_domains_verified ON organization_sso_domains(domain) WHERE status = 'verified';
