-- =====================================================
-- 0093 — PUBLIC SITE: remove the last internal jargon, tidy the footer (after 0092)
--
-- Safe to re-run, and never overwrites an admin edit: every UPDATE only touches a row whose value is STILL the exact text
-- seeded by 0034/0073/0079/0083. No INSERT, no schema change.
--
-- Wording rule: customers manage a "dashboard" and "sites". "Control plane", "tenant", "architecture" and
-- "infrastructure" stay in engineering docs, the Security page and the Insights articles written for that audience.
-- =====================================================

-- Affiliate section: intro and the multi-site card
UPDATE lummet_homepage_sections SET body = '<p>Everything an affiliate website needs, already set up: content types, SEO, AI, domains and monitoring.</p>'
 WHERE section_key = 'affiliate-features'
   AND body = '<p>Everything an affiliate website needs, in one configured architecture: content types, SEO, AI, domains and monitoring.</p>';
UPDATE lummet_features SET body = 'Run several independent sites, each with its own database, from one dashboard.'
 WHERE feature_key = 'aff-multisite' AND body = 'Run several independent sites, each with its own database, from one control plane.';

-- Agencies and multi-brand section ("why")
UPDATE lummet_homepage_sections SET body = '<p>One shared platform with separate settings for every brand, so each keeps its own identity while you manage them all in one place.</p>'
 WHERE section_key = 'why'
   AND body = '<p>A shared technology foundation, independent brand configuration, and centralized management, so every brand keeps its own identity while still benefiting from the platform underneath it.</p>';
UPDATE lummet_features SET title = 'One platform, built once', body = 'Every connected brand runs on the same platform.'
 WHERE feature_key = 'why-foundation' AND title = 'Shared technology foundation' AND body = 'One platform, built once, powering every connected brand.';
UPDATE lummet_features SET title = 'Separate settings per brand'
 WHERE feature_key = 'why-config' AND title = 'Independent brand configuration';
UPDATE lummet_features SET title = 'One dashboard', body = 'Operate, monitor and grow every brand from a single place.'
 WHERE feature_key = 'why-central' AND title = 'Centralized management' AND body = 'Operated, monitored and scaled from a single control plane.';

-- AI band and demo band
UPDATE lummet_homepage_sections SET body = '<p>AI tools built into the platform help your team create, manage and grow your sites faster, with a preview before any change is saved.</p>'
 WHERE section_key = 'ai'
   AND body = '<p>AI-powered capabilities built directly into the platform to help teams create, manage and scale digital properties more efficiently.</p>';
UPDATE lummet_homepage_sections SET body = '<p>Get a private walkthrough of the dashboard, or pick a plan and explore it yourself.</p>'
 WHERE section_key = 'demo' AND body = '<p>Get a private walkthrough of the control plane, or pick a plan and explore it yourself.</p>';

-- Footer text and the two FAQ answers that said "tenant" and "control plane"
UPDATE lummet_site_settings SET value = 'The technology and AI platform for running multiple digital brands from one dashboard.'
 WHERE key = 'footer_text' AND value = 'The technology and AI platform for running multiple digital brands from one control plane.';
UPDATE lummet_faqs SET answer = 'Yes. Each site has its own configuration and database, and you can manage all of them from one dashboard.'
 WHERE question = 'Can I run more than one affiliate website?'
   AND answer = 'Yes. Each site is registered as its own tenant with its own configuration and database, and all of them can be managed from one control plane.';
UPDATE lummet_faqs SET answer = 'Yes. Each site has its own domain, configuration and database, and you can manage all of them from one dashboard.'
 WHERE question = 'Can I run affiliate sites in several niches?'
   AND answer = 'Yes. Each site is registered as its own tenant with its own domain, configuration and database, and all of them can be managed from one control plane.';

-- Footer links: sentence case, and the first link no longer repeats its column heading ("Platform")
UPDATE OR IGNORE lummet_nav_links SET label = 'Overview'                          WHERE placement = 'footer_platform' AND label = 'Platform' AND href = '/#platform';
UPDATE OR IGNORE lummet_nav_links SET label = 'Affiliate website builder'         WHERE placement = 'footer_platform' AND label = 'Affiliate Website Builder';
UPDATE OR IGNORE lummet_nav_links SET label = 'Best website builder for affiliates' WHERE placement = 'footer_platform' AND label = 'Best Website Builder for Affiliates';
UPDATE OR IGNORE lummet_nav_links SET label = 'Multi-site platform'               WHERE placement = 'footer_platform' AND label = 'Multi-Site Platform';
UPDATE OR IGNORE lummet_nav_links SET label = 'White-label platform'              WHERE placement = 'footer_platform' AND label = 'White-Label Platform';
UPDATE OR IGNORE lummet_nav_links SET label = 'AI content for affiliate sites'    WHERE placement = 'footer_platform' AND label = 'AI Content for Affiliate Sites';
UPDATE OR IGNORE lummet_nav_links SET label = 'Casino affiliate websites'         WHERE placement = 'footer_platform' AND label = 'Casino Affiliate Websites';
UPDATE OR IGNORE lummet_nav_links SET label = 'Hotel and travel affiliates'       WHERE placement = 'footer_platform' AND label = 'Hotel and Travel Affiliates';
UPDATE OR IGNORE lummet_nav_links SET label = 'Property listing websites'         WHERE placement = 'footer_platform' AND label = 'Property Listing Websites';
UPDATE OR IGNORE lummet_nav_links SET label = 'Commission models'                 WHERE placement = 'footer_platform' AND label = 'Commission Models';
UPDATE OR IGNORE lummet_nav_links SET label = 'Disclosure and compliance'        WHERE placement = 'footer_platform' AND label = 'Disclosure and Compliance';
UPDATE OR IGNORE lummet_nav_links SET label = 'Start an affiliate business'       WHERE placement = 'footer_company'  AND label = 'Start an Affiliate Business';
UPDATE OR IGNORE lummet_nav_links SET label = 'Affiliate niches'                  WHERE placement = 'footer_company'  AND label = 'Affiliate Niches';

-- OPTIONAL, owner decision: shorten the homepage by hiding the two extra FAQ blocks (the general "Questions, answered" block
-- stays). Their questions still exist and can be shown on their own pages; hiding them removes that text from the homepage,
-- which may cost some long-tail search traffic. Uncomment to hide, or switch them to draft in Lummet Site > Homepage sections.
-- UPDATE lummet_homepage_sections SET status = 'draft' WHERE section_key IN ('affiliate-faq', 'affiliate-niches-faq') AND status = 'published';
