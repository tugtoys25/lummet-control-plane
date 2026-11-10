-- 0099: per-section style controls for homepage sections (heading font, body font, alignment, content width, spacing, grid columns).
-- Every column is "default" = keep today's look, so no existing section changes. Values are checked against a fixed list at render time
-- (worker/public-site/section-style.js), so an edit can never put an arbitrary class name or CSS onto the page.
ALTER TABLE lummet_homepage_sections ADD COLUMN heading_font TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lummet_homepage_sections ADD COLUMN body_font TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lummet_homepage_sections ADD COLUMN text_align TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lummet_homepage_sections ADD COLUMN content_width TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lummet_homepage_sections ADD COLUMN spacing TEXT NOT NULL DEFAULT 'default';
ALTER TABLE lummet_homepage_sections ADD COLUMN grid_columns TEXT NOT NULL DEFAULT 'default';
