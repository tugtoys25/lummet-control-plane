-- Moving a site to another platform domain (platform-domains step f). Additive and idempotent.
--
-- site_domain_moves: one row per move. `steps_json` records each finished step so a failed move can be resumed or rolled
--   back; the old route and zone are stored here because the site's own route row is repointed to the new host.
-- site_host_redirects: while a move's redirect is live, requests for the OLD host reach the control plane Worker (the old
--   route is repointed to it) and are answered with a redirect to the NEW host. Looked up by exact hostname only; the
--   target always comes from this table, never from the request.
CREATE TABLE IF NOT EXISTS site_domain_moves (
    id TEXT PRIMARY KEY,
    site_id TEXT NOT NULL,
    from_domain_id TEXT,
    to_domain_id TEXT NOT NULL,
    old_host TEXT NOT NULL,
    new_host TEXT NOT NULL,
    old_route_id TEXT,
    old_zone_id TEXT,
    new_route_id TEXT,
    new_zone_id TEXT,
    worker_name TEXT,
    update_primary INTEGER NOT NULL DEFAULT 1 CHECK (update_primary IN (0, 1)),
    redirect_days INTEGER NOT NULL DEFAULT 30,
    state TEXT NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'failed', 'redirecting', 'completed', 'rolled_back')),
    steps_json TEXT NOT NULL DEFAULT '{}',
    last_error TEXT,
    requested_by TEXT,
    redirect_until TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    finished_at TEXT
);

-- At most one unfinished move per site.
CREATE UNIQUE INDEX IF NOT EXISTS idx_site_domain_moves_one_open ON site_domain_moves(site_id) WHERE state IN ('running', 'failed');
CREATE INDEX IF NOT EXISTS idx_site_domain_moves_site ON site_domain_moves(site_id, created_at);

CREATE TABLE IF NOT EXISTS site_host_redirects (
    old_host TEXT PRIMARY KEY,
    new_host TEXT NOT NULL,
    site_id TEXT NOT NULL,
    move_id TEXT NOT NULL,
    route_id TEXT,
    zone_id TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_site_host_redirects_expires ON site_host_redirects(expires_at);
