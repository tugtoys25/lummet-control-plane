-- =====================================================
-- 0007 — SEED: REAL LUMMET CONTENT
--
-- Safe to re-run. Every statement is INSERT OR IGNORE against a
-- natural unique key (slug / section_key / feature_key / question /
-- placement+label / setting key), so:
--   * re-running never duplicates rows, and
--   * re-running never overwrites something an admin has edited.
-- To reset a single row to its seeded text, delete that row first.
--
-- Everything here is factual: brands are the portfolio Lummet
-- already published, and platform / security / update copy is
-- derived from what the control plane's code actually does.
-- No traffic, revenue, customer-count or licensing claims exist
-- anywhere in this file, and no partner is named (partners must be
-- added by an admin once permission to name them is confirmed).
-- =====================================================

-- ---------------------------------------------------------
-- SITE SETTINGS
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_site_settings (key, value) VALUES
  ('site_name', 'Lummet'),
  ('site_title', 'Lummet — Centralized Technology & AI Platform for Digital Brands'),
  ('site_description', 'Lummet is a centralized technology and AI platform for managing, scaling and operating multiple independent digital brands from one control plane.'),
  ('canonical_url', 'https://lummet.com'),
  ('hero_eyebrow', 'Lummet Platform'),
  ('hero_title', 'One Platform. Multiple Brands. Centralized Control.'),
  ('hero_subtitle', 'Lummet is the centralized technology and AI platform built to operate, manage and scale multiple digital properties from a single control plane.'),
  ('hero_cta_primary_label', 'Get a Demo'),
  ('hero_cta_primary_href', '#demo'),
  ('hero_cta_secondary_label', 'Explore Our Brands'),
  ('hero_cta_secondary_href', '/brands'),
  ('footer_text', 'Centralized technology and AI infrastructure for scalable digital brands.'),
  ('brands_title', 'Brands powered by Lummet'),
  ('brands_intro', 'Independent digital properties running on the Lummet technology foundation. Each keeps its own identity, content and configuration.'),
  ('updates_title', 'Platform updates'),
  ('updates_intro', 'What has shipped on the Lummet platform, newest first.'),
  ('insights_title', 'Insights'),
  ('insights_intro', 'Engineering notes and platform write-ups from the Lummet team.'),
  ('partners_title', 'Partners'),
  ('partners_intro', 'Organizations Lummet works with.');

-- ---------------------------------------------------------
-- AUTHOR (an organisational byline, not an invented person)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_authors (name, slug, title, bio) VALUES
  ('Lummet Team', 'lummet-team', 'Editorial team',
   'Product and engineering notes from the team that builds and operates the Lummet platform.');

-- ---------------------------------------------------------
-- BRAND PROFILES (the six properties Lummet already listed)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_brands (name, slug, category, description, logo_url, website_url, status, sort_order) VALUES
  ('Level.casino', 'level-casino', 'iGaming & Casino Intelligence',
   '<p>Premium casino reviews, comparisons, GEO-focused rankings, affiliate content and iGaming publishing.</p>',
   '/static/images/brands/level-casino.png', 'https://level.casino/en', 'published', 10),
  ('NeuroOdds.com', 'neuroodds', 'Sports Betting & Odds Intelligence',
   '<p>Sports betting, odds, analysis and sports-focused editorial content.</p>',
   NULL, 'https://neuroodds.com', 'published', 20),
  ('Cluster.casino', 'cluster-casino', 'iGaming & Casino Platform',
   '<p>Casino-focused digital publishing and comparison infrastructure.</p>',
   NULL, 'https://cluster.casino', 'published', 30),
  ('LegendOdds.com', 'legendodds', 'Sports Betting & Odds',
   '<p>Sports betting and odds-focused digital publishing.</p>',
   NULL, 'https://legendodds.com', 'published', 40),
  ('BrilliantOdds.com', 'brilliantodds', 'Sports & Betting Intelligence',
   '<p>Sports, odds and betting-focused digital content.</p>',
   NULL, 'https://brilliantodds.com', 'published', 50),
  ('Freewin.xyz', 'freewin', 'Digital iGaming Property',
   '<p>iGaming publishing, casino content and affiliate infrastructure.</p>',
   NULL, 'https://freewin.xyz', 'published', 60);

-- ---------------------------------------------------------
-- FEATURES (cards, steps, checklist, AI capabilities)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_features (feature_key, group_key, icon, title, body, status, sort_order) VALUES
  ('platform-independent', 'platform', 'check', 'Each brand operates independently', NULL, 'published', 10),
  ('platform-config', 'platform', 'check', 'Each tenant has its own configuration', NULL, 'published', 20),
  ('platform-database', 'platform', 'check', 'Each tenant can have its own database', NULL, 'published', 30),
  ('platform-central', 'platform', 'check', 'Centralized management through Lummet', NULL, 'published', 40),
  ('platform-secure', 'platform', 'check', 'Secure communication between Lummet and tenants', NULL, 'published', 50),
  ('platform-scalable', 'platform', 'check', 'Scalable architecture for adding new brands', NULL, 'published', 60),
  ('platform-ai', 'platform', 'check', 'AI-powered capabilities', NULL, 'published', 70),
  ('platform-monitoring', 'platform', 'check', 'Centralized monitoring and operational visibility', NULL, 'published', 80),

  ('how-connect', 'how_it_works', 'plug', 'Connect', 'Connect independent digital properties to the Lummet control plane.', 'published', 10),
  ('how-manage', 'how_it_works', 'sliders', 'Manage', 'Manage tenants, content, settings, capabilities, health and platform operations from one central environment.', 'published', 20),
  ('how-scale', 'how_it_works', 'trending', 'Scale', 'Add new brands and properties without rebuilding the underlying platform from scratch.', 'published', 30),

  ('cap-multitenant', 'capabilities', 'layers', 'Multi-Tenant Architecture', 'Run multiple independent properties on a shared technology foundation.', 'published', 10),
  ('cap-central', 'capabilities', 'sliders', 'Centralized Management', 'Manage connected properties from one control plane.', 'published', 20),
  ('cap-ai', 'capabilities', 'sparkles', 'AI-Powered Tools', 'Use Lummet AI capabilities to accelerate content, operations and platform workflows.', 'published', 30),
  ('cap-content', 'capabilities', 'file-text', 'Content Management', 'Manage reviews, news, pages, categories, countries, authors and other publishing resources.', 'published', 40),
  ('cap-seo', 'capabilities', 'search', 'SEO Infrastructure', 'Build and manage SEO-focused digital properties with structured content and metadata.', 'published', 50),
  ('cap-geo', 'capabilities', 'map-pin', 'GEO Targeting', 'Support location-aware content, rankings and digital experiences.', 'published', 60),
  ('cap-affiliate', 'capabilities', 'share', 'Affiliate Infrastructure', 'Support affiliate-focused publishing and commercial integrations.', 'published', 70),
  ('cap-monitoring', 'capabilities', 'activity', 'Monitoring & Health', 'Maintain visibility into connected tenants and their operational status.', 'published', 80),

  ('why-foundation', 'why', 'layers', 'Shared technology foundation', 'One platform, built once, powering every connected brand.', 'published', 10),
  ('why-config', 'why', 'sliders', 'Independent brand configuration', 'Each property runs its own identity, content and settings.', 'published', 20),
  ('why-central', 'why', 'eye', 'Centralized management', 'Operated, monitored and scaled from a single control plane.', 'published', 30),

  ('ai-chat', 'ai', 'message', 'Conversational management', 'Ask for information or changes in plain language. Reads are answered straight away.', 'published', 10),
  ('ai-preview', 'ai', 'check', 'Preview before anything is written', 'Every proposed change is shown as a preview and applied only after an admin confirms it. Previews expire after 15 minutes.', 'published', 20),
  ('ai-permissions', 'ai', 'lock', 'Permission-aware', 'The assistant can only see and change what the signed-in admin could already reach by hand.', 'published', 30),
  ('ai-tools', 'ai', 'file-text', 'Content tools', 'Draft reviews, SEO titles and descriptions, FAQs, schema markup and outlines, and improve existing text.', 'published', 40);

-- ---------------------------------------------------------
-- HOMEPAGE LAYOUT (each row is one section, in order)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_homepage_sections (section_key, kind, feature_group, background, title, subtitle, body, cta_label, cta_href, layout, status, sort_order) VALUES
  ('stats', 'stats', NULL, 'default', 'The platform at a glance', NULL, NULL, NULL, NULL, 'text_only', 'published', 10),
  ('platform', 'checklist', 'platform', 'default', 'The Technology Behind Multiple Digital Brands', 'What is Lummet?',
   '<p>Lummet separates the central management layer from each individual brand it powers. Every property keeps its own identity while being run, monitored and scaled from one place.</p>',
   NULL, NULL, 'text_only', 'published', 20),
  ('how', 'steps', 'how_it_works', 'soft', 'How Lummet Works', 'How it works', NULL, NULL, NULL, 'text_only', 'published', 30),
  ('capabilities', 'features', 'capabilities', 'default', 'Built for Scale. Designed for Control.', 'Capabilities', NULL, NULL, NULL, 'text_only', 'published', 40),
  ('brands', 'brands', NULL, 'soft', 'Brands Powered by Lummet', 'Our brands',
   '<p>Independent digital properties running on the Lummet technology foundation.</p>',
   'View all brands', '/brands', 'text_only', 'published', 50),
  ('why', 'features', 'why', 'default', 'Built Once. Configured for Every Brand.', 'Why Lummet',
   '<p>A shared technology foundation, independent brand configuration, and centralized management, so every brand keeps its own identity while still benefiting from the platform underneath it.</p>',
   NULL, NULL, 'text_only', 'published', 60),
  ('ai', 'panel', 'ai', 'dark', 'Meet Lummet AI', 'Lummet AI',
   '<p>AI-powered capabilities built directly into the platform to help teams create, manage and scale digital properties more efficiently.</p>',
   'Ask for a demo', '#demo', 'text_only', 'published', 70),
  ('updates', 'updates', NULL, 'soft', 'Latest Platform Updates', 'What is new', NULL, 'All updates', '/updates', 'text_only', 'published', 80),
  ('insights', 'insights', NULL, 'default', 'From the Lummet team', 'Insights', NULL, 'All insights', '/insights', 'text_only', 'published', 90),
  ('partners', 'partners', NULL, 'soft', 'Our Partners', 'Partners', NULL, 'All partners', '/partners', 'text_only', 'published', 100),
  ('faq', 'faq', 'general', 'default', 'Common questions', 'FAQ', NULL, NULL, NULL, 'text_only', 'published', 110),
  ('demo', 'cta', NULL, 'default', 'See Lummet in Action', NULL,
   '<p>Want to understand how Lummet can manage multiple digital properties from one centralized platform? Request a private demonstration.</p>',
   'Get a Demo', '#contact', 'text_only', 'published', 120),
  ('contact', 'contact', NULL, 'soft', 'Get in Touch', 'Let us talk',
   '<p>Interested in Lummet, partnership opportunities, technology licensing or a platform demonstration? Get in touch and our team will follow up.</p>',
   NULL, NULL, 'text_only', 'published', 130);

-- ---------------------------------------------------------
-- FAQ (answers derived from how the control plane works)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_faqs (group_key, question, answer, status, sort_order) VALUES
  ('general', 'What is Lummet?',
   'Lummet is a centralized technology and AI platform for managing, scaling and operating multiple independent digital brands from one control plane.', 'published', 10),
  ('general', 'Does Lummet store my brand''s content?',
   'No. The control plane keeps metadata about each connected brand, such as its host, its health status and an encrypted access credential. Content stays in the brand''s own database, and the control plane reaches it only through that brand''s API.', 'published', 20),
  ('general', 'How does Lummet talk to a connected brand?',
   'Over HTTPS using signed requests. Each request carries a timestamp, a one-time value and an HMAC signature that the brand verifies before doing anything.', 'published', 30),
  ('general', 'Can a team member be limited to certain brands?',
   'Yes. Staff accounts start with no access at all. A super admin grants access per brand and per action (create, read, update, delete) on each resource.', 'published', 40),
  ('general', 'Does the AI assistant change content on its own?',
   'No. Any change it proposes is shown as a preview first and nothing is written until an admin confirms it. A preview expires after 15 minutes if it is not confirmed.', 'published', 50),
  ('general', 'Are admin actions recorded?',
   'Yes. Sign-ins (including failed attempts), tenant switches and changes made through the control plane are written to an audit log. Passwords and secrets are never logged, and entries are kept for 180 days.', 'published', 60),
  ('general', 'Can another brand be added later?',
   'Yes. A new brand is registered as a tenant and connected with its own credential. Brands that are already connected are not affected.', 'published', 70);

-- ---------------------------------------------------------
-- NAVIGATION
-- visible_when hides a link until its destination has content:
-- always | has_brands | has_updates | has_publications | has_partners
-- | has_contact | has_faq | page:<slug>
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('header', 'Platform', '/#platform', 'always', 'published', 10),
  ('header', 'Brands', '/brands', 'has_brands', 'published', 20),
  ('header', 'Insights', '/insights', 'has_publications', 'published', 30),
  ('header', 'Updates', '/updates', 'has_updates', 'published', 40),
  ('header', 'Partners', '/partners', 'has_partners', 'published', 50),
  ('header', 'Security', '/security', 'page:security', 'published', 60),
  ('header_cta', 'Sign in', '/login', 'always', 'published', 10),
  ('header_cta', 'Get a Demo', '/#demo', 'always', 'published', 20),
  ('footer_platform', 'Platform', '/#platform', 'always', 'published', 10),
  ('footer_platform', 'Capabilities', '/#capabilities', 'always', 'published', 20),
  ('footer_platform', 'Lummet AI', '/#ai', 'always', 'published', 30),
  ('footer_platform', 'FAQ', '/#faq', 'has_faq', 'published', 40),
  ('footer_company', 'About', '/about', 'page:about', 'published', 10),
  ('footer_company', 'Brands', '/brands', 'has_brands', 'published', 20),
  ('footer_company', 'Insights', '/insights', 'has_publications', 'published', 30),
  ('footer_company', 'Updates', '/updates', 'has_updates', 'published', 40),
  ('footer_company', 'Partners', '/partners', 'has_partners', 'published', 50),
  ('footer_company', 'Contact', '/#contact', 'has_contact', 'published', 60),
  ('footer_legal', 'Security', '/security', 'page:security', 'published', 10),
  ('footer_legal', 'Privacy', '/privacy', 'page:privacy', 'published', 20),
  ('footer_legal', 'Terms', '/terms', 'page:terms', 'published', 30);

-- ---------------------------------------------------------
-- PAGES
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_pages (slug, title, excerpt, content, status, seo_title, seo_description) VALUES
  ('about', 'About Lummet',
   'Lummet separates the central management layer from each brand it powers.',
   '<h2>One control plane, many independent brands</h2>
<p>Lummet is a centralized technology and AI platform for managing, scaling and operating multiple independent digital brands. The management layer lives in one place, while every brand keeps its own identity, content, configuration and database.</p>
<h2>How the pieces fit</h2>
<ul>
<li><strong>The control plane</strong> is a separate application with its own database. It holds the tenant registry, encrypted access credentials, health information and Lummet staff accounts.</li>
<li><strong>Each brand</strong> is a tenant that runs on its own, with its own database. The control plane talks to it only over HTTPS, through a signed API.</li>
<li><strong>Lummet AI</strong> helps staff read and prepare changes across connected brands, with an explicit confirmation step before anything is written.</li>
</ul>
<h2>What Lummet is not</h2>
<p>The control plane does not read a brand''s database directly and does not hold a brand''s content. Removing a brand from the control plane removes only its registry entry. It never deletes anything inside the brand.</p>',
   'published', 'About Lummet',
   'Lummet separates the central management layer from each brand it powers, so every property keeps its own identity while being run from one control plane.'),

  ('security', 'Security',
   'How the Lummet control plane authenticates, isolates and records activity.',
   '<p>This page describes design choices in the Lummet control plane. It is a description of how the software works, not a certification or an audit report.</p>
<h2>Isolation between Lummet and each brand</h2>
<p>The control plane never queries a brand''s database. It reaches a brand only through that brand''s own API, and every brand has its own database. Deleting a brand from the registry removes only the registry entry.</p>
<h2>Signed requests</h2>
<p>Each request from the control plane to a brand carries a timestamp, a random one-time value and an HMAC-SHA-256 signature. The signature covers the HTTP method, the path, the timestamp, the one-time value and a hash of the request body, so a request cannot be altered or replayed as a different one.</p>
<h2>Credentials at rest</h2>
<p>The shared secret for each brand is encrypted with AES-GCM before it is stored. The encryption key is held as a Worker secret and is never written to the database. A secret is shown to an administrator once, at the moment it is issued.</p>
<h2>Staff accounts and sessions</h2>
<ul>
<li>Passwords are hashed with PBKDF2 (SHA-256, 100,000 iterations, per-password salt) and compared in constant time.</li>
<li>Sessions use an HttpOnly, Secure, SameSite=Strict cookie.</li>
<li>Repeated failed sign-ins are rate limited.</li>
<li>A disabled account loses its active sessions immediately.</li>
</ul>
<h2>Least privilege</h2>
<p>A new staff account has no access to any brand and no permission on any resource. A super admin grants access per brand and per action. The server checks these grants on every request, not only when drawing the navigation.</p>
<h2>Audit trail</h2>
<p>Sign-ins, failed sign-ins, tenant switches and changes made through the control plane are recorded in an audit log, including changes proposed by the AI assistant. Passwords and secrets are never written to it. Entries are kept for 180 days.</p>',
   'published', 'Security',
   'How the Lummet control plane isolates brands, signs requests, stores credentials, controls staff access and records activity.'),

  ('privacy', 'Privacy and data handling',
   'What this website and the Lummet control plane do with data.',
   '<p>This page summarises how this website and the Lummet control plane handle data. It describes what the software does today.</p>
<h2>This public website</h2>
<ul>
<li>It does not run advertising or analytics trackers and does not set cookies for visitors.</li>
<li>If you choose a light or dark theme, that choice is saved in your own browser (local storage) and is not sent to a server.</li>
<li>The site is served through Cloudflare, which processes requests, including IP addresses, as part of delivering the site.</li>
</ul>
<h2>If you contact us</h2>
<p>If you email us, we receive the address and the message you send, and we use them to reply to you.</p>
<h2>Lummet staff accounts</h2>
<p>Staff sign in to the control plane with an email address and a password. Passwords are stored only as salted hashes. A session cookie keeps a signed-in staff member signed in. Administrative actions are written to an audit log, and IP addresses in that log and in sign-in rate limiting are stored as one-way hashes.</p>
<h2>Connected brands</h2>
<p>The control plane does not store a brand''s content or its visitors'' data. Each brand runs its own database and publishes its own privacy information.</p>',
   'published', 'Privacy and data handling',
   'What the Lummet website and control plane do with data: no visitor trackers, no visitor cookies, hashed IP addresses in audit and rate-limit records.'),

  ('terms', 'Terms of use',
   'Draft. Replace this text with the approved terms before publishing.',
   '<p>This page is a draft and is not visible to visitors. Replace this text with your approved terms of use, then set the status to published in Lummet Site, Pages.</p>',
   'draft', 'Terms of use', NULL);

-- ---------------------------------------------------------
-- UPDATES (what shipped, from the control plane''s own history)
-- Dates follow the timestamps of the corresponding files and can be
-- edited in Lummet Site, Updates.
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_updates (slug, title, excerpt, content, author_id, status, published_at) VALUES
  ('control-plane-and-tenant-registry', 'Control plane and tenant registry',
   'Brands are registered as tenants and reached through a signed API, with credentials encrypted at rest.',
   '<p>The Lummet control plane launched as a standalone application with its own database, separate from every brand it manages.</p>
<ul>
<li>A tenant registry records each brand''s host, status and cached capabilities.</li>
<li>Each tenant gets its own access credential. The secret is encrypted before storage and shown once.</li>
<li>Connection tests and health checks report whether each brand is reachable, with clear error categories.</li>
<li>Switching the active tenant changes only the admin''s session, never the brand''s own login state.</li>
</ul>',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-11'),

  ('staff-accounts-and-scoped-permissions', 'Staff accounts with scoped permissions',
   'Lummet staff can be given access to specific brands and specific actions, and nothing else.',
   '<p>Staff accounts now exist alongside the super admin, and they start with no access.</p>
<ul>
<li>A super admin chooses which brands a staff member may act on.</li>
<li>Create, read, update and delete are granted per resource.</li>
<li>Temporary passwords are shown once and must be changed at first sign-in.</li>
<li>Disabling an account ends its sessions immediately.</li>
</ul>',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-11'),

  ('lummet-site-cms', 'A CMS for the Lummet site itself',
   'Pages, brand profiles, updates, publications and homepage copy are now managed from the dashboard.',
   '<p>Lummet''s own website content is no longer fixed in code. It is managed from the Lummet Site section of the dashboard: pages, authors, brand profiles, partners, updates, publications, advertisements and homepage settings. Drafts are never publicly reachable.</p>',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-11'),

  ('ai-management-chat', 'AI management chat',
   'Ask for changes in plain language, review a preview, then confirm.',
   '<p>The dashboard now includes an AI assistant for reading and preparing changes across a connected brand.</p>
<ul>
<li>Reads are answered directly.</li>
<li>Writes are shown as a preview and are applied only after an admin confirms. A preview expires after 15 minutes.</li>
<li>Each step is checked against the signed-in admin''s own permissions.</li>
<li>Changes made through the assistant are recorded in the same audit log as everything else.</li>
</ul>',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-26'),

  ('database-driven-public-site', 'The public site now runs from the database',
   'Brands, updates, insights, navigation and page copy on this website are read from the Lummet database.',
   '<p>This website is now rendered from the same database the dashboard edits. Brand pages, platform updates, insights, navigation, the FAQ and the homepage layout are all content, so a change made in the dashboard appears on the site without a code change.</p>',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-30');

-- ---------------------------------------------------------
-- PUBLICATIONS (Insights): technical explainers of the design
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_publications (slug, title, excerpt, content, publication_type, author_id, status, published_at) VALUES
  ('why-the-control-plane-never-reads-a-tenant-database', 'Why the control plane never reads a tenant''s database',
   'Keeping management and content apart is what lets each brand stay independent.',
   '<p>A control plane that could read every brand''s database directly would be convenient, and it would also make every brand depend on it. Lummet takes the opposite approach.</p>
<h2>Two databases, two jobs</h2>
<p>The control plane has its own database. It holds metadata: which brands exist, where they live, whether they are healthy, which staff can act on them. Each brand has a separate database holding its own content and users.</p>
<h2>One narrow doorway</h2>
<p>When the control plane needs something from a brand, it makes a signed HTTPS request to that brand''s own API. The brand decides what that API exposes. If a brand does not support a resource, the dashboard says so instead of guessing.</p>
<h2>What this buys</h2>
<ul>
<li>A brand can be redeployed or migrated without touching the control plane.</li>
<li>Removing a brand from the registry deletes only the registry entry.</li>
<li>A fault in one brand cannot corrupt another, because they share no database.</li>
</ul>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-30'),

  ('how-signed-requests-work', 'How signed requests between Lummet and its brands work',
   'Every call carries a timestamp, a one-time value and an HMAC signature over the request.',
   '<p>Each call from the control plane to a brand proves three things: who sent it, that it was not changed on the way, and that it is not a replay of an earlier call.</p>
<h2>What is signed</h2>
<p>The signature is an HMAC-SHA-256 over five values joined together: the HTTP method, the path, a timestamp, a random one-time value and a SHA-256 hash of the request body. The secret used to sign is unique to each brand.</p>
<h2>What the brand checks</h2>
<p>The brand recomputes the signature from what it received and compares it with the one supplied. A different body, path, method or secret produces a different signature, so the request is rejected.</p>
<h2>Where the secret lives</h2>
<p>On the control plane side, the secret is stored encrypted with AES-GCM, and the key that decrypts it is held as a Worker secret rather than in the database. Someone who obtained a copy of the database alone could not recover a brand''s secret.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-30'),

  ('default-deny-access-for-staff', 'Default-deny access for Lummet staff',
   'New staff accounts start with nothing. Access is granted per brand and per action.',
   '<p>Access control that starts open has to be closed one door at a time. Lummet starts closed.</p>
<h2>The model</h2>
<p>A super admin can do everything. Every other account begins with no brands and no permissions. Access is granted in two layers: which brands the person may act on, and which of create, read, update and delete they hold on each resource.</p>
<h2>Enforced on the server</h2>
<p>Hiding a menu link never stops a direct request, so every route that touches a brand''s content, the Lummet site content or the registry checks the grant itself. The navigation only reflects what the server would allow.</p>
<h2>Guardrails</h2>
<ul>
<li>An admin cannot change their own role or disable or delete themselves.</li>
<li>The last remaining super admin cannot be demoted or deleted.</li>
<li>Disabling an account ends its sessions immediately.</li>
</ul>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-09-30');
