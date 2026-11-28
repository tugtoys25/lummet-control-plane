-- Hardening for customer-owned Cloudflare hosting (docs/CUSTOM_CLOUDFLARE_HOSTING.md). ADDITIVE only: columns with defaults.
--
--   customer_cloudflare_accounts.health_*      scheduled token re-verification: when it last ran and what the customer was last told
--   site_custom_hosting.enforced_state          what Lummet has done at the edge of the customer's account for a suspended site
--                                               (NULL / 'serving' = the Worker is reachable, 'blocked' = workers.dev and custom domain detached)
--   site_hosting_transfers.confirm_skipped      the customer accepted that media files above the automatic-copy size are NOT carried over
--   site_hosting_transfers.frozen_at            when the site was put into maintenance for the final copy (NULL = serving normally)
ALTER TABLE customer_cloudflare_accounts ADD COLUMN health_checked_at TEXT;
ALTER TABLE customer_cloudflare_accounts ADD COLUMN health_alert_state TEXT;
ALTER TABLE customer_cloudflare_accounts ADD COLUMN health_alerted_at TEXT;
ALTER TABLE site_custom_hosting ADD COLUMN enforced_state TEXT;
ALTER TABLE site_custom_hosting ADD COLUMN enforced_at TEXT;
ALTER TABLE site_custom_hosting ADD COLUMN enforce_error TEXT;
ALTER TABLE site_hosting_transfers ADD COLUMN confirm_skipped INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_hosting_transfers ADD COLUMN frozen_at TEXT;
