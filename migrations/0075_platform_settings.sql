-- Release 2.7.0: platform settings managed from the staff console. Purely additive: two new tables, nothing existing is altered.
--
-- platform_settings        one row per setting a staff member has set. A key with NO row falls back to the wrangler.jsonc var, then to the
--                          built-in default. Only keys in worker/platform-settings.js (SETTINGS) are ever applied; a row for any other
--                          key is ignored, so this table can never override a secret or a binding.
-- platform_setting_events  append-only record of every change (who, when, why, old and new value). Values here are non-secret by construction.
CREATE TABLE IF NOT EXISTS platform_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS platform_setting_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_setting_events_created ON platform_setting_events(created_at);
