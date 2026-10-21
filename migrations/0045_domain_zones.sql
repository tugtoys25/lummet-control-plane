-- =====================================================
-- CUSTOM DOMAINS BY NAMESERVER DELEGATION (v1)
--
-- The customer adds their root domain (example.com) in the Lummet dashboard. Lummet creates a Cloudflare zone
-- for it in the PLATFORM Cloudflare account and shows the two nameservers Cloudflare assigned. The customer
-- sets those at their registrar / DNS manager. When Cloudflare reports the zone ACTIVE (which it only does once
-- the registrar really delegates the domain, so this is also the proof of ownership), Lummet attaches the
-- hostnames (example.com and www.example.com) to the site's Worker, Cloudflare issues the certificates, and the
-- domain goes live.
--
-- domain_zones   one row per delegated root domain (the thing the customer has to act on, and that we track)
-- domains        gains method / zone_id / custom_domain_id so every hostname served through a zone is a normal
--                domains row (same limits, listing, primary domain, webhooks, export as before)
--
-- New domains.status value used by this flow: 'awaiting_nameservers' (the hostnames exist but the zone is not
-- active yet). The rest of the lifecycle reuses dns_verified -> ssl_pending -> active | failed | removed.
--
-- Additive only. Existing domains keep method = 'txt' (the earlier TXT + custom hostname flow).
-- =====================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS domain_zones (
    id TEXT PRIMARY KEY,                           -- uuid
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    zone_name TEXT NOT NULL,                       -- the root domain, lower case, e.g. example.com
    provider_zone_id TEXT,                         -- Cloudflare zone id
    status TEXT NOT NULL DEFAULT 'pending',        -- pending | active | failed | expired | removed
    name_servers TEXT NOT NULL DEFAULT '[]',       -- JSON array: the nameservers the customer must set
    detected_name_servers TEXT,                    -- JSON array: what public DNS answered at the last look
    nameservers_detected_at TEXT,                  -- first time public DNS showed (all of) our nameservers
    last_checked_at TEXT,
    next_check_at TEXT,                            -- the maintenance sweep skips zones until this time
    check_count INTEGER NOT NULL DEFAULT 0,
    last_activation_check_at TEXT,                 -- last time we asked Cloudflare to re-check (rate limited)
    activated_at TEXT,
    failure_reason TEXT,
    expires_at TEXT,                               -- a zone still pending at this time is released
    reminder_sent_at TEXT,
    created_by TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    removed_at TEXT
);

-- One live claim per root domain across the whole platform (same takeover guarantee as domains.hostname). An
-- 'expired' claim (nameservers never changed in time) is released so nobody can squat on a domain they do not own.
CREATE UNIQUE INDEX IF NOT EXISTS idx_domain_zones_name_live ON domain_zones(zone_name) WHERE status NOT IN ('removed', 'expired');
CREATE INDEX IF NOT EXISTS idx_domain_zones_site ON domain_zones(site_id);
CREATE INDEX IF NOT EXISTS idx_domain_zones_sweep ON domain_zones(status, next_check_at);

ALTER TABLE domains ADD COLUMN method TEXT NOT NULL DEFAULT 'txt';          -- txt | nameservers
ALTER TABLE domains ADD COLUMN zone_id TEXT REFERENCES domain_zones(id);
ALTER TABLE domains ADD COLUMN custom_domain_id TEXT;                       -- Cloudflare Workers custom domain id
ALTER TABLE domains ADD COLUMN failure_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_domains_zone ON domains(zone_id);

-- Progress history the dashboard shows ("nameservers detected", "Cloudflare confirmed", ...).
CREATE TABLE IF NOT EXISTS domain_zone_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    zone_id TEXT NOT NULL REFERENCES domain_zones(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,                            -- created | nameservers_detected | nameservers_changed_away | activated | attached | live | failed | expired | removed | reminder | record_added | record_removed
    detail TEXT,
    actor_type TEXT NOT NULL DEFAULT 'system',
    actor_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_domain_zone_events_zone ON domain_zone_events(zone_id);
