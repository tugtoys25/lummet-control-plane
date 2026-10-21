-- v7I: server-side failures, so they can be seen and alerted on. One row per 5xx response or unhandled exception.
-- No request bodies, headers, query strings or user data: route is the path with ids/tokens replaced by placeholders and
-- message is the error's own text, trimmed. Purged after 14 days by the maintenance tick.
CREATE TABLE IF NOT EXISTS request_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  error_name TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_request_errors_created ON request_errors(created_at);
