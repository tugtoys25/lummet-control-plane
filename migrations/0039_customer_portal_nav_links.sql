-- v7C: public header/footer links to the customer portal. Idempotent, never overwrites an edit
-- (UNIQUE(placement,label) + INSERT OR IGNORE). Staff can reorder or hide them under /cms/nav_links.
INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('header_cta', 'Customer sign in', '/app/login', 'always', 'published', 15),
  ('footer_platform', 'Customer sign in', '/app/login', 'always', 'published', 90);
