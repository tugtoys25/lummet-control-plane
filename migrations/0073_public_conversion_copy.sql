-- =====================================================
-- 0073 — PUBLIC SITE: clearer, conversion-focused copy (release 2.6.0.20)
--
-- Safe to re-run, and never overwrites an admin edit:
--   * every UPDATE only touches a row whose value is STILL the exact text seeded by 0034/0035,
--   * every INSERT is INSERT OR IGNORE against its natural key.
-- No numbers, customer names or performance claims are introduced. Statements about trials, prices and plans are
-- rendered from the plans table at request time (see worker/public-site/plans-teaser.js), not written here.
-- =====================================================

-- Hero: buttons first (their destination depends on the label still being the seeded one), then the words.
UPDATE lummet_site_settings SET value = '/pricing' WHERE key = 'hero_cta_primary_href' AND value = '/demo'
  AND (SELECT value FROM lummet_site_settings WHERE key = 'hero_cta_primary_label') = 'Get a Demo';
UPDATE lummet_site_settings SET value = 'Start free trial' WHERE key = 'hero_cta_primary_label' AND value = 'Get a Demo';
UPDATE lummet_site_settings SET value = '/demo' WHERE key = 'hero_cta_secondary_href' AND value = '/brands'
  AND (SELECT value FROM lummet_site_settings WHERE key = 'hero_cta_secondary_label') = 'Explore Our Brands';
UPDATE lummet_site_settings SET value = 'Book a demo' WHERE key = 'hero_cta_secondary_label' AND value = 'Explore Our Brands';
UPDATE lummet_site_settings SET value = 'Multi-brand platform' WHERE key = 'hero_eyebrow' AND value = 'Lummet Platform';
UPDATE lummet_site_settings SET value = 'Run every brand. From one control plane.' WHERE key = 'hero_title' AND value = 'One Platform. Multiple Brands. Centralized Control.';
UPDATE lummet_site_settings SET value = 'Lummet is the technology and AI platform for operating multiple digital brands. Each brand keeps its own site and data; you manage, monitor and scale them all from one place.'
  WHERE key = 'hero_subtitle' AND value = 'Lummet is the centralized technology and AI platform built to operate, manage and scale multiple digital properties from a single control plane.';
UPDATE lummet_site_settings SET value = 'The technology and AI platform for running multiple digital brands from one control plane.'
  WHERE key = 'footer_text' AND value = 'Centralized technology and AI infrastructure for scalable digital brands.';

-- Homepage sections
UPDATE lummet_homepage_sections SET title = 'One control plane. Every brand stays independent.' WHERE section_key = 'platform' AND title = 'The Technology Behind Multiple Digital Brands';
UPDATE lummet_homepage_sections SET title = 'From your first brand to many, in three steps' WHERE section_key = 'how' AND title = 'How Lummet Works';
UPDATE lummet_homepage_sections SET title = 'Brands already running on Lummet' WHERE section_key = 'brands' AND title = 'Brands Powered by Lummet';
UPDATE lummet_homepage_sections SET title = 'Questions, answered' WHERE section_key = 'faq' AND title = 'Common questions';
UPDATE lummet_homepage_sections SET title = 'See Lummet run your brands', cta_label = 'Book a demo',
  body = '<p>Get a private walkthrough of the control plane, or pick a plan and explore it yourself.</p>'
  WHERE section_key = 'demo' AND title = 'See Lummet in Action';
UPDATE lummet_homepage_sections SET cta_label = 'Book a demo' WHERE section_key = 'ai' AND cta_label = 'Ask for a demo';

-- Navigation: a primary "Start free trial" button in the header (last header_cta is the primary one)
INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('header_cta', 'Start free trial', '/app/signup', 'always', 'published', 30);

-- Pricing page intro (used only when an admin has not set their own; the heading stays "Pricing")
INSERT OR IGNORE INTO lummet_site_settings (key, value) VALUES
  ('pricing_intro', 'Choose the plan that fits. Every price is shown up front, and you can compare every plan below.');

-- New interface strings
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('pricing_eyebrow', 'Simple, transparent plans', 'lists'),
  ('pricing_recommended', 'Recommended', 'lists'),
  ('pricing_assure_1', 'Clear monthly pricing', 'lists'),
  ('pricing_assure_2', 'Cancel any time', 'lists'),
  ('pricing_help_title', 'Not sure which plan fits?', 'lists'),
  ('pricing_help_body', 'Tell us about your brands and we will point you to the right plan.', 'lists'),
  ('pricing_help_cta', 'Talk to us', 'lists'),
  ('home_plans_eyebrow', 'Plans', 'layout'),
  ('home_plans_title', 'Pick a plan and get started', 'layout'),
  ('home_plans_intro', 'Choose a plan and create your account. Every plan and product is listed on the pricing page.', 'layout'),
  ('home_plans_all', 'Compare all plans', 'layout'),
  ('hero_from_price', 'Plans from {price} per month', 'layout'),
  ('hero_note_cancel', 'Cancel any time', 'layout'),
  ('cta_see_plans', 'View plans', 'layout'),
  ('footer_cta_title', 'Ready to run your brands from one place?', 'layout'),
  ('footer_cta_body', 'Pick a plan and get started, or talk to us first.', 'layout'),
  ('footer_cta_primary', 'View plans', 'layout'),
  ('footer_cta_secondary', 'Book a demo', 'layout');
