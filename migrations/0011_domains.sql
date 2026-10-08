-- =====================================================
-- DOMAIN MANAGEMENT (Phase 4 — master prompt section 20)
--
-- hostname is UNIQUE globally among non-removed domains (a
-- partial index, not a plain column UNIQUE, so a removed
-- domain frees its hostname back up for reuse) — this is the
-- schema-level guarantee against domain takeover and
-- cross-tenant/duplicate domain assignment the master prompt
-- explicitly calls for: two different sites can never hold
-- the SAME LIVE hostname at the same time, full stop, enforced
-- by the database rather than only by application logic.
--
-- Verification/SSL status is never set to a "confirmed" value
-- by anything other than domains.js actually checking with a
-- DNS resolver / Cloudflare (rule #5) — see domains.js.
-- =====================================================

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS domains (
    id TEXT PRIMARY KEY,                          -- uuid
    site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    hostname TEXT NOT NULL,
    is_primary INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',       -- pending|dns_verified|ssl_pending|active|failed|removed
    verification_method TEXT NOT NULL DEFAULT 'TXT',
    verification_token TEXT NOT NULL,
    dns_verified_at TEXT,
    ssl_status TEXT NOT NULL DEFAULT 'none',      -- none|pending|active|failed
    ssl_resource_id TEXT,                         -- the provider's custom-hostname id, once requested
    ssl_verified_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    removed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_domains_site ON domains(site_id);
CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_domains_hostname_active ON domains(hostname) WHERE status != 'removed';

CREATE TABLE IF NOT EXISTS domain_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain_id TEXT NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    actor_type TEXT NOT NULL DEFAULT 'system',    -- system | customer_user | lummet_admin
    actor_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_domain_events_domain ON domain_events(domain_id);
