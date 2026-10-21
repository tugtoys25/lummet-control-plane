-- v7H: remembers when each live site was last checked for events its owner's automations listen to (tracking links going
-- unhealthy), so the periodic sweep rotates fairly through sites instead of always checking the same few.
CREATE TABLE IF NOT EXISTS automation_sweep_state (
  site_id TEXT PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
  last_swept_at TEXT NOT NULL
);
