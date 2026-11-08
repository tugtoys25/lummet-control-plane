-- Public call-to-action copy. Only rows still holding the shipped defaults are touched; anything an admin edited is left alone.
--   Top of the site (hero + header button): "Start for free", and the header button opens the pricing page (edge-cached, so it opens fast)
--   instead of the uncached sign-up page. Pricing cards for plans that really have a trial say "Start free trial".

UPDATE lummet_site_settings SET value = 'Start for free' WHERE key = 'hero_cta_primary_label' AND value = 'Start free trial';

-- OR IGNORE + the DELETE keep this safe to re-run: (placement, label) is unique, and an older migration's INSERT OR IGNORE can put the
-- shipped default row back, which must not collide with the renamed one.
UPDATE OR IGNORE lummet_nav_links SET label = 'Start for free', href = '/pricing'
 WHERE placement = 'header_cta' AND label = 'Start free trial' AND href = '/app/signup';
DELETE FROM lummet_nav_links
 WHERE placement = 'header_cta' AND label = 'Start free trial' AND href = '/app/signup'
   AND EXISTS (SELECT 1 FROM lummet_nav_links n WHERE n.placement = 'header_cta' AND n.label = 'Start for free');

INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('pricing_cta_trial', 'Start free trial', 'lists');
