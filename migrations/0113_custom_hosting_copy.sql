-- "Copy this site to my Cloudflare account" (docs/CUSTOM_CLOUDFLARE_HOSTING.md): the same resumable job table is used, a copy row
-- being a transfer whose source site stays on Lummet and whose result is a NEW site. ADDITIVE only: columns with defaults.
--   kind             'move' (existing behaviour) or 'copy'
--   target_site_id   for a copy: the new site created in the customer's account
--   cleanup_report   JSON: what the last cancel / clean-up removed from the customer's account and what it could not
ALTER TABLE site_hosting_transfers ADD COLUMN kind TEXT NOT NULL DEFAULT 'move';
ALTER TABLE site_hosting_transfers ADD COLUMN target_site_id TEXT;
ALTER TABLE site_hosting_transfers ADD COLUMN cleanup_report TEXT;
