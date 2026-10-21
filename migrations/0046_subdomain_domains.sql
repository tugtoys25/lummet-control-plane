-- =====================================================
-- SINGLE SUBDOMAINS (v1.1)
--
-- v1 connected whole root domains by nameserver delegation. v1.1 also connects ONE subdomain (shop.example.com):
--
--   * if the parent domain is already delegated to Lummet for the same site (a domain_zones row), the subdomain
--     simply becomes another hostname of that zone (method 'nameservers', nothing new here);
--   * otherwise the customer keeps their DNS where it is (including their own Cloudflare account) and adds two
--     records: a CNAME to the platform's CNAME target and a TXT ownership record. Lummet then registers a
--     Cloudflare for SaaS custom hostname, routes it to the site's Worker and checks that HTTPS really works.
--     Those rows have method = 'cname'.
--
-- Lifecycle for method 'cname' reuses the existing statuses:
--   pending (waiting for the records) -> dns_verified (TXT seen) -> ssl_pending (certificate issuing)
--   -> active | failed | removed
--
-- Additive only.
-- =====================================================

ALTER TABLE domains ADD COLUMN route_id TEXT;              -- Worker route id for a 'cname' hostname (platform zone)
ALTER TABLE domains ADD COLUMN dns_instructions TEXT;      -- JSON: the records the customer must add (shown as-is)
ALTER TABLE domains ADD COLUMN cname_seen_at TEXT;         -- first time public DNS showed the CNAME (progress only)
ALTER TABLE domains ADD COLUMN next_check_at TEXT;         -- the maintenance sweep skips the row until then
ALTER TABLE domains ADD COLUMN last_checked_at TEXT;
ALTER TABLE domains ADD COLUMN check_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE domains ADD COLUMN expires_at TEXT;            -- still 'pending' at this time -> the claim is released
ALTER TABLE domains ADD COLUMN reminder_sent_at TEXT;

CREATE INDEX IF NOT EXISTS idx_domains_sweep ON domains(method, status, next_check_at);
