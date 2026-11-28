-- Optional customer-owned Cloudflare hosting (docs/CUSTOM_CLOUDFLARE_HOSTING.md).
--
-- A site can run in the customer's OWN Cloudflare account instead of Lummet's. Everything here is ADDITIVE: no existing
-- table or column changes, and a site with no row in site_custom_hosting is a Lummet-hosted site exactly as before.
-- The feature is dark until staff switch it on (platform setting CUSTOM_HOSTING) and an organization is allowed or entitled.
--
--   customer_cloudflare_accounts  the Cloudflare accounts an organization saved (non-secret facts only)
--   custom_hosting_secrets        every secret value (API token, R2 secret key, email key, a site's Turnstile secret, custom
--                                 site variables), one encrypted value per row (CREDENTIAL_KEK, AAD-bound to the row id)
--   site_custom_hosting           which saved account a site runs on, where it lands (workers.dev or a custom hostname)
--   custom_hosting_org_access     staff allow / deny per organization (on top of the plan entitlement)
--   site_hosting_transfers        moving an existing Lummet-hosted site into the customer's account (resumable job state)
CREATE TABLE IF NOT EXISTS customer_cloudflare_accounts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  label TEXT NOT NULL,
  cf_account_id TEXT NOT NULL,
  cf_account_name TEXT,
  token_hint TEXT,                         -- last four characters of the token, for recognition only
  r2_access_key_id TEXT,                   -- optional S3-compatible key id (its secret lives in custom_hosting_secrets)
  r2_jurisdiction TEXT NOT NULL DEFAULT 'default' CHECK (r2_jurisdiction IN ('default', 'eu', 'fedramp')),
  email_from TEXT,                         -- optional sender for the site's own email (needs the email key secret)
  workers_subdomain TEXT,                  -- <subdomain>.workers.dev of this account, read from Cloudflare
  status TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified', 'invalid', 'disabled')),
  permissions TEXT,                        -- JSON: the last permission check, one entry per capability
  last_verified_at TEXT,
  last_error TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cf_accounts_org_account ON customer_cloudflare_accounts(organization_id, cf_account_id);
CREATE INDEX IF NOT EXISTS idx_cf_accounts_org ON customer_cloudflare_accounts(organization_id, created_at);

CREATE TABLE IF NOT EXISTS custom_hosting_secrets (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('account', 'site')),
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,                      -- api_token | r2_secret_access_key | email_api_key | turnstile_secret | var:<NAME>
  is_secret INTEGER NOT NULL DEFAULT 1,
  encrypted_secret TEXT NOT NULL,
  secret_iv TEXT NOT NULL,
  hint TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_custom_hosting_secret ON custom_hosting_secrets(owner_type, owner_id, name);
CREATE INDEX IF NOT EXISTS idx_custom_hosting_secret_org ON custom_hosting_secrets(organization_id);

CREATE TABLE IF NOT EXISTS site_custom_hosting (
  site_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,               -- customer_cloudflare_accounts.id (an account in use cannot be removed)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'transferring', 'active')),
  landing TEXT NOT NULL DEFAULT 'workers_dev' CHECK (landing IN ('workers_dev', 'custom_domain')),
  hostname TEXT,                           -- the custom hostname (apex or subdomain) when landing = custom_domain
  zone_id TEXT,
  zone_name TEXT,
  domain_status TEXT NOT NULL DEFAULT 'none' CHECK (domain_status IN ('none', 'pending', 'active', 'failed')),
  domain_error TEXT,
  turnstile_sitekey TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_site_custom_hosting_org ON site_custom_hosting(organization_id);
CREATE INDEX IF NOT EXISTS idx_site_custom_hosting_account ON site_custom_hosting(account_ref);
-- One site per custom hostname (another site may still use another subdomain of the same zone).
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_custom_hosting_hostname ON site_custom_hosting(hostname) WHERE hostname IS NOT NULL;

CREATE TABLE IF NOT EXISTS custom_hosting_org_access (
  organization_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL CHECK (mode IN ('allow', 'deny')),
  note TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS site_hosting_transfers (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  account_ref TEXT NOT NULL,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  landing TEXT NOT NULL DEFAULT 'workers_dev' CHECK (landing IN ('workers_dev', 'custom_domain')),
  hostname TEXT,
  zone_id TEXT,
  zone_name TEXT,
  source_host TEXT,                        -- the Lummet address the site had before the move
  target_resources TEXT,                   -- JSON: D1 / KV / R2 created in the customer's account
  source_resources TEXT,                   -- JSON: the Lummet resources, kept until the customer removes the old copy
  progress TEXT,                           -- JSON: copy cursors and counters (resumable)
  lease_until INTEGER,                     -- ms epoch: one runner at a time
  old_copy_status TEXT NOT NULL DEFAULT 'none' CHECK (old_copy_status IN ('none', 'kept', 'removing', 'removed', 'failed')),
  error_message TEXT,
  requested_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_site_hosting_transfers_site ON site_hosting_transfers(site_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_hosting_transfers_org ON site_hosting_transfers(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_hosting_transfer_open ON site_hosting_transfers(site_id) WHERE status IN ('queued', 'running');
