-- Brand partners band: editable accent colour + per-brand "show in strip" switch, and a one-listing-per-tenant guard.
--   accent_color   optional #RRGGBB (validated when rendered); empty = a colour derived from the slug
--   show_in_strip  1 = shown to customers in the dashboard brand strip, 0 = only on /brands
-- Additive and after 0081. ALTER TABLE ... ADD COLUMN is run once per database by the migration runner.
ALTER TABLE lummet_brands ADD COLUMN accent_color TEXT;
ALTER TABLE lummet_brands ADD COLUMN show_in_strip INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_lummet_brands_strip ON lummet_brands(status, show_in_strip, sort_order);

-- At most one automatic listing per tenant. Any earlier duplicates are unlinked from the tenant (rows and site_id kept)
-- so the index can always be created.
UPDATE lummet_brands SET tenant_id = NULL
WHERE source = 'site' AND tenant_id IS NOT NULL
  AND id NOT IN (SELECT MIN(id) FROM lummet_brands WHERE source = 'site' AND tenant_id IS NOT NULL GROUP BY tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lummet_brands_site_tenant ON lummet_brands(tenant_id) WHERE source = 'site' AND tenant_id IS NOT NULL;

-- Interface text for the homepage brand strip (editable under the CMS interface strings; the Worker has fallbacks if absent).
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('brand_strip_label', 'Powered by Lummet', 'cards'),
  ('brand_strip_aria', 'Brands powered by Lummet', 'cards'),
  ('brand_strip_all', 'All brands', 'cards'),
  ('brand_strip_pause', 'Pause scrolling brands', 'cards');
