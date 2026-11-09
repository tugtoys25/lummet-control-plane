-- Release 2.8.0: portal branding and a dedicated media library for the control plane. Purely additive: two new tables.
--
-- platform_media     one row per file in the control plane's OWN media library (R2 binding PLATFORM_MEDIA). Logos, favicons and app icons are picked
--                    from here. This library is separate from every tenant's media library: nothing here is read from or written to a tenant.
--                    r2_key is the object key and the public path (/brand-media/<r2_key>); width/height/mime_type come from the file's bytes.
-- platform_branding  one row per branding value a staff member has set (brand name, logo, favicons, app icons, theme colours). A key with no
--                    row means "not set": the portal keeps its built-in look. Only keys listed in worker/portal-branding.js (FIELDS) are read.
CREATE TABLE IF NOT EXISTS platform_media (
  id TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  alt_text TEXT NOT NULL DEFAULT '',
  folder TEXT NOT NULL DEFAULT 'branding',
  sha256 TEXT,
  uploaded_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_platform_media_created ON platform_media(created_at);
CREATE INDEX IF NOT EXISTS idx_platform_media_folder ON platform_media(folder, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_media_sha ON platform_media(sha256);

CREATE TABLE IF NOT EXISTS platform_branding (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
