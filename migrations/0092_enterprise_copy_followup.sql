-- =====================================================
-- 0092 — PUBLIC SITE: enterprise copy follow-up (after 0091)
--
-- Safe to re-run, and never overwrites an admin edit:
--   * every UPDATE only touches a row whose value is STILL the exact text seeded by 0034/0073/0079/0083/0091,
--   * no INSERT, no schema change, no new key.
--
-- What it does:
--   1. Capability cards and the "What is Lummet?" checklist drop the words tenant, architecture and infrastructure
--      in favour of what the customer gets.
--   2. Remaining Title Case section headings move to sentence case.
--   3. Section order: agencies (why) -> enterprise -> security, grouped together ahead of the brands band.
--   4. Hides the enterprise "Dedicated infrastructure" card: dedicated_infrastructure.enabled is only a plan flag today
--      (worker/entitlements.js, worker/plan-catalog.js); nothing in the Worker provisions or enforces it.
--      Re-publish it from Lummet Site > Features once that is real.
-- =====================================================

-- ---------------------------------------------------------
-- 0. Correct a 0091 claim that the code does not back yet
-- ---------------------------------------------------------
UPDATE lummet_features SET status = 'draft'
 WHERE feature_key = 'ent-dedicated' AND status = 'published'
   AND title = 'Dedicated infrastructure';

-- ---------------------------------------------------------
-- 1. Capability cards (group "capabilities")
-- ---------------------------------------------------------
UPDATE lummet_features SET title = 'Separate sites, one platform',
  body = 'Run independent sites side by side, each with its own configuration.'
 WHERE feature_key = 'cap-multitenant' AND title = 'Multi-Tenant Architecture';
UPDATE lummet_features SET title = 'One dashboard for every site',
  body = 'Manage content, settings and site health for all your sites from one place.'
 WHERE feature_key = 'cap-central' AND title = 'Centralized Management';
UPDATE lummet_features SET title = 'AI that previews before it writes',
  body = 'Draft and improve content with Lummet AI. Every change is shown as a preview and applied only after you confirm it.'
 WHERE feature_key = 'cap-ai' AND title = 'AI-Powered Tools';
UPDATE lummet_features SET title = 'Content management'
 WHERE feature_key = 'cap-content' AND title = 'Content Management';
UPDATE lummet_features SET title = 'SEO built in',
  body = 'Titles, descriptions, structured data and clean URLs on every page type.'
 WHERE feature_key = 'cap-seo' AND title = 'SEO Infrastructure';
UPDATE lummet_features SET title = 'Country targeting',
  body = 'Show location-aware content and rankings to audiences in different countries.'
 WHERE feature_key = 'cap-geo' AND title = 'GEO Targeting';
UPDATE lummet_features SET title = 'Affiliate tools',
  body = 'Publish reviews, comparisons and partner links, with commercial terms and conversions tracked.'
 WHERE feature_key = 'cap-affiliate' AND title = 'Affiliate Infrastructure';
UPDATE lummet_features SET title = 'Monitoring and health',
  body = 'See the status of every connected site at a glance.'
 WHERE feature_key = 'cap-monitoring' AND title = 'Monitoring & Health';

-- ---------------------------------------------------------
-- 1b. "What is Lummet?" block, its checklist, and the three "how it works" steps
-- ---------------------------------------------------------
UPDATE lummet_homepage_sections SET title = 'One dashboard. Every site stays independent.',
  body = '<p>Lummet keeps management in one place and every site separate. Each site keeps its own identity, content and settings while you run, monitor and grow them all from one dashboard.</p>'
 WHERE section_key = 'platform'
   AND title = 'One control plane. Every brand stays independent.'
   AND body = '<p>Lummet separates the central management layer from each individual brand it powers. Every property keeps its own identity while being run, monitored and scaled from one place.</p>';

UPDATE lummet_features SET title = 'Every site runs independently'            WHERE feature_key = 'platform-independent' AND title = 'Each brand operates independently';
UPDATE lummet_features SET title = 'Every site has its own configuration'     WHERE feature_key = 'platform-config'      AND title = 'Each tenant has its own configuration';
UPDATE lummet_features SET title = 'Every site can have its own database'     WHERE feature_key = 'platform-database'    AND title = 'Each tenant can have its own database';
UPDATE lummet_features SET title = 'Manage everything from one dashboard'     WHERE feature_key = 'platform-central'     AND title = 'Centralized management through Lummet';
UPDATE lummet_features SET title = 'Signed requests between Lummet and your sites' WHERE feature_key = 'platform-secure' AND title = 'Secure communication between Lummet and tenants';
UPDATE lummet_features SET title = 'Add new sites without rebuilding anything' WHERE feature_key = 'platform-scalable'   AND title = 'Scalable architecture for adding new brands';
UPDATE lummet_features SET title = 'AI tools with a confirmation step'        WHERE feature_key = 'platform-ai'          AND title = 'AI-powered capabilities';
UPDATE lummet_features SET title = 'Health monitoring across all your sites'  WHERE feature_key = 'platform-monitoring'  AND title = 'Centralized monitoring and operational visibility';

UPDATE lummet_features SET body = 'Connect each site to your Lummet dashboard.'
 WHERE feature_key = 'how-connect' AND body = 'Connect independent digital properties to the Lummet control plane.';
UPDATE lummet_features SET body = 'Manage sites, content, settings, health and day-to-day operations from one place.'
 WHERE feature_key = 'how-manage' AND body = 'Manage tenants, content, settings, capabilities, health and platform operations from one central environment.';
UPDATE lummet_features SET body = 'Add new sites without rebuilding the platform underneath them.'
 WHERE feature_key = 'how-scale' AND body = 'Add new brands and properties without rebuilding the underlying platform from scratch.';
UPDATE lummet_features SET body = 'Your site, its database and its domain are set up for you on a template that is already configured.'
 WHERE feature_key = 'launch-deploy' AND body = 'Your site, its database and its domain are set up through the Lummet control plane on a template that is already configured.';

-- ---------------------------------------------------------
-- 2. Remaining Title Case headings
-- ---------------------------------------------------------
UPDATE lummet_homepage_sections SET title = 'Affiliate websites for every niche'
 WHERE section_key = 'affiliate-niches' AND title = 'Affiliate Websites for Every Niche';
UPDATE lummet_homepage_sections SET title = 'Latest platform updates'
 WHERE section_key = 'updates' AND title = 'Latest Platform Updates';
UPDATE lummet_homepage_sections SET title = 'Get in touch'
 WHERE section_key = 'contact' AND title = 'Get in Touch';
UPDATE lummet_homepage_sections SET title = 'Affiliate business and website builder FAQ'
 WHERE section_key = 'affiliate-faq' AND title = 'Affiliate Business and Website Builder FAQ';
UPDATE lummet_homepage_sections SET title = 'Choosing an affiliate niche: FAQ'
 WHERE section_key = 'affiliate-niches-faq' AND title = 'Choosing an Affiliate Niche: FAQ';

-- ---------------------------------------------------------
-- 3. Section order: agencies -> enterprise -> security, then the brands band
--    (0034 put "why" at 60, 0091 put security at 46 and enterprise at 47)
-- ---------------------------------------------------------
UPDATE lummet_homepage_sections SET sort_order = 48 WHERE section_key = 'security-built-in' AND sort_order = 46;
UPDATE lummet_homepage_sections SET sort_order = 46 WHERE section_key = 'why' AND sort_order = 60;

-- OPTIONAL, owner decision: hide the "platform at a glance" counters (brands, updates and insights are about Lummet's own
-- content, not customer results). Uncomment to hide them until real outcomes can replace them.
-- UPDATE lummet_homepage_sections SET status = 'draft' WHERE section_key = 'stats' AND title = 'The platform at a glance' AND status = 'published';
