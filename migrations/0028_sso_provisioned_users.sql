-- Security review 2.1: an SSO login may only ever sign in accounts that SSO
-- itself created for the SAME organization. Without this, an organization admin
-- who controls an identity provider could assert any email address and be
-- signed in as that existing user.
ALTER TABLE customer_users ADD COLUMN sso_organization_id TEXT;   -- NULL = a normal (self-registered) account
CREATE INDEX IF NOT EXISTS idx_customer_users_sso_org ON customer_users(sso_organization_id);
