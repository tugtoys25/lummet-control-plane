-- =====================================================
-- 0089_plan_families (generic, editable plan families and site types)
--
-- Until now one record, `products`, did two jobs: it grouped plans on the pricing page ("Casino Affiliate: Starter, Growth,
-- Pro") AND it was the type of site a customer created. This migration lets staff separate the two without changing either:
--
--   show_on_pricing        1 = this product is a plan family on the public pricing page (default 1: nothing changes)
--   show_in_site_creation  1 = customers can pick it as the type of a new site (default 1: nothing changes)
--   public_name            customer-facing name; the internal `name` stays as the staff label (NULL = use `name`)
--   slug                   editable public address of the family (a stable id stays in `id`); backfilled from `key`
--   description / sort_order / updated_at   presentation
--
-- Old slugs are kept in product_slug_history so an old link (/pricing?family=old-slug) still resolves after a rename, and
-- so a slug can never be reused for a different product.
--
-- Purely additive. Every column has a default that reproduces the previous behaviour. Prices, Stripe objects, entitlements,
-- subscriptions and sites are NOT touched. ROLLBACK: deploy the previous release; it ignores every object created here.
-- =====================================================
ALTER TABLE products ADD COLUMN public_name TEXT;
ALTER TABLE products ADD COLUMN slug TEXT;
ALTER TABLE products ADD COLUMN description TEXT;
ALTER TABLE products ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN show_on_pricing INTEGER NOT NULL DEFAULT 1 CHECK (show_on_pricing IN (0, 1));
ALTER TABLE products ADD COLUMN show_in_site_creation INTEGER NOT NULL DEFAULT 1 CHECK (show_in_site_creation IN (0, 1));
ALTER TABLE products ADD COLUMN updated_at TEXT;

UPDATE products SET slug = REPLACE(key, '_', '-') WHERE slug IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_products_slug ON products(slug);

CREATE TABLE IF NOT EXISTS product_slug_history (
    slug TEXT PRIMARY KEY,
    product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_product_slug_history_product ON product_slug_history(product_id);
