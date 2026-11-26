-- Advertisement sliders: an advertisement (placement homepage_banner) can carry several slides, slider settings and
-- per-slide views / clicks. Additive and idempotent. An advertisement without slides keeps working: it shows its own
-- image_url / link_url / alt_text as a single slide, exactly as before.
CREATE TABLE IF NOT EXISTS lummet_ad_settings (
  ad_id INTEGER PRIMARY KEY,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lummet_ad_slides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ad_id INTEGER NOT NULL,
  slide_key TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL DEFAULT '{}',
  start_at TEXT,
  end_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (ad_id, slide_key)
);
CREATE INDEX IF NOT EXISTS idx_lummet_ad_slides_ad ON lummet_ad_slides(ad_id, position);

-- One row per advertisement, slide and day (slide_key '' = the advertisement as a whole). Never one row per view.
CREATE TABLE IF NOT EXISTS lummet_ad_stats (
  ad_id INTEGER NOT NULL,
  slide_key TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ad_id, slide_key, day)
);
