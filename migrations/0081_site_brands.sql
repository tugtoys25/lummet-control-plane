-- Every site that goes live gets a brand profile as an UNPUBLISHED draft; an admin publishes it to show it on lummet.com/brands, the homepage
-- strip and "Powered by Lummet" (worker/site-brands.js keeps the row in step with the site's status). These columns tie a brand row to its site: `source` tells automatic rows from hand-made profiles, `auto_hidden`
-- marks a row the system took offline (site suspended or deleted) so reactivating the site can put it back without overriding a
-- staff member who unpublished a brand on purpose. Purely additive; hand-made brand profiles are untouched.
ALTER TABLE lummet_brands ADD COLUMN site_id TEXT;
ALTER TABLE lummet_brands ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE lummet_brands ADD COLUMN auto_hidden INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS idx_lummet_brands_site ON lummet_brands(site_id) WHERE site_id IS NOT NULL;

-- Backfill: sites that are already live (as drafts, never auto-published) (white-label customers who hide Lummet branding are never listed).
INSERT OR IGNORE INTO lummet_brands (tenant_id, name, slug, tagline, category, website_url, status, sort_order, source, site_id)
SELECT s.tenant_id, s.name, s.slug, 'Powered by Lummet', 'Powered by Lummet',
       CASE WHEN s.primary_domain IS NOT NULL AND s.primary_domain <> '' THEN 'https://' || s.primary_domain END,
       'draft', 100, 'site', s.id
FROM sites s
WHERE s.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM lummet_brands b WHERE b.slug = s.slug)
  AND NOT EXISTS (SELECT 1 FROM organization_branding ob WHERE ob.organization_id = s.organization_id AND ob.hide_lummet_branding = 1);

-- Slug already taken by another brand: list the site under a suffixed slug instead of skipping it.
INSERT OR IGNORE INTO lummet_brands (tenant_id, name, slug, tagline, category, website_url, status, sort_order, source, site_id)
SELECT s.tenant_id, s.name, s.slug || '-' || substr(s.id, 1, 6), 'Powered by Lummet', 'Powered by Lummet',
       CASE WHEN s.primary_domain IS NOT NULL AND s.primary_domain <> '' THEN 'https://' || s.primary_domain END,
       'draft', 100, 'site', s.id
FROM sites s
WHERE s.status = 'active'
  AND NOT EXISTS (SELECT 1 FROM lummet_brands b WHERE b.site_id = s.id)
  AND NOT EXISTS (SELECT 1 FROM organization_branding ob WHERE ob.organization_id = s.organization_id AND ob.hide_lummet_branding = 1);
