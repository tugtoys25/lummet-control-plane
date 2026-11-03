-- =====================================================
-- 0079 — SEO SEED: START AN AFFILIATE BUSINESS
--
-- Seeds lummet.com with search-focused content around
-- launching an affiliate website business on a fully
-- configured multi-site platform:
--   * site settings (title, description, hero) rewritten
--   * 6 landing pages        (/p/<slug>)
--   * 8 Insights articles    (/insights/<slug>)
--   * 12 FAQs in group 'affiliate'
--   * 2 feature groups + 3 homepage sections
--   * navigation links (shown only when the page exists)
--
-- Data only: no schema changes. Content rows use
-- INSERT OR IGNORE, so re-running never overwrites rows an
-- admin has since edited. The site settings block below is
-- an upsert and DOES overwrite those keys; the migration
-- runner applies this file once.
-- Claims here describe what the platform does today. No
-- statistics, testimonials or competitor rankings.
-- =====================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------
-- SITE SETTINGS (homepage title, description, hero copy).
-- Hero buttons are left as set by 0073 (pricing / demo).
-- ---------------------------------------------------------
INSERT INTO lummet_site_settings (key, value) VALUES
  ('site_title', 'Start an Affiliate Business | Lummet Website Builder'),
  ('site_description', 'Start your affiliate business today on a fully configured platform: website builder, SEO tools, AI content and multi-site control in one place.'),
  ('hero_eyebrow', 'Affiliate Website Builder Platform'),
  ('hero_title', 'Start Your Affiliate Business Today. The Architecture Is Already Built.'),
  ('hero_subtitle', 'Lummet gives you a fully configured foundation for affiliate websites: SEO-ready content management, AI writing tools, custom domains and multi-site control from one dashboard.')
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP;

-- ---------------------------------------------------------
-- FEATURES (steps + capability cards for the new sections)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_features (feature_key, group_key, icon, title, body, link_label, link_href, status, sort_order) VALUES
  ('launch-niche', 'affiliate_launch', 'search', 'Choose your niche', 'Pick a topic and audience, then plan the categories, countries and content types your site will cover.', NULL, NULL, 'published', 10),
  ('launch-deploy', 'affiliate_launch', 'layers', 'Deploy your site', 'Your site, its database and its domain are set up through the Lummet control plane on a template that is already configured.', NULL, NULL, 'published', 20),
  ('launch-content', 'affiliate_launch', 'sparkles', 'Build content with AI', 'Draft reviews, comparisons, FAQs and SEO titles with Lummet AI. Every change is previewed before it is saved.', NULL, NULL, 'published', 30),
  ('launch-grow', 'affiliate_launch', 'trending', 'Grow and add sites', 'Track site health from one dashboard and add further sites without rebuilding anything.', NULL, NULL, 'published', 40),

  ('aff-builder', 'affiliate_features', 'layers', 'Affiliate website builder', 'A configured site template for reviews, comparisons, news, categories and landing pages.', 'Explore the builder', '/p/affiliate-website-builder', 'published', 10),
  ('aff-seo', 'affiliate_features', 'search', 'SEO-ready by default', 'Per-page titles, descriptions, social images, structured data and clean URLs on every page type.', 'Best website builder for SEO', '/p/best-website-builder-for-affiliate-marketing', 'published', 20),
  ('aff-multisite', 'affiliate_features', 'sliders', 'Multi-site control', 'Run several independent sites, each with its own database, from one control plane.', 'Multi-site platform', '/p/multi-site-website-platform', 'published', 30),
  ('aff-ai', 'affiliate_features', 'sparkles', 'AI content tools', 'Outlines, drafts, FAQs and schema suggestions with a confirmation step before anything is written.', 'AI for affiliate sites', '/p/ai-content-for-affiliate-sites', 'published', 40),
  ('aff-geo', 'affiliate_features', 'map-pin', 'GEO-targeted content', 'Location-aware pages and rankings for audiences in different countries.', NULL, NULL, 'published', 50),
  ('aff-white', 'affiliate_features', 'share', 'White-label ready', 'Each site keeps its own brand, domain and configuration.', 'White-label platform', '/p/white-label-website-platform', 'published', 60);

-- ---------------------------------------------------------
-- HOMEPAGE SECTIONS (inserted between existing rows)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_homepage_sections (section_key, kind, feature_group, background, title, subtitle, body, cta_label, cta_href, layout, status, sort_order) VALUES
  ('affiliate-launch', 'steps', 'affiliate_launch', 'soft', 'Launch an Affiliate Website in Four Steps', 'Start an affiliate business',
   '<p>Skip the months of setup. The hosting, content management, SEO structure and AI tooling are already configured, so you can spend your time on your niche and your audience.</p>',
   'Read the full guide', '/p/start-affiliate-business', 'text_only', 'published', 25),
  ('affiliate-features', 'features', 'affiliate_features', 'default', 'The Website Builder Built for Affiliate Publishers', 'Why Lummet',
   '<p>Everything an affiliate website needs, in one configured architecture: content types, SEO, AI, domains and monitoring.</p>',
   NULL, NULL, 'text_only', 'published', 35),
  ('affiliate-faq', 'faq', 'affiliate', 'soft', 'Affiliate Business and Website Builder FAQ', 'FAQ',
   NULL, NULL, NULL, 'text_only', 'published', 115);

-- ---------------------------------------------------------
-- FAQ (group: affiliate) — also feeds FAQPage structured data
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_faqs (group_key, question, answer, status, sort_order) VALUES
  ('affiliate', 'How do I start an affiliate business?',
   'Choose a niche and an audience, build a website that publishes useful content for that audience, and join affiliate programs relevant to it. Lummet provides the configured website foundation, so the technical setup is already done and you can focus on content and partnerships.', 'published', 10),
  ('affiliate', 'What is an affiliate website builder?',
   'An affiliate website builder is a platform for creating websites that publish reviews, comparisons and guides and link to products through affiliate programs. Lummet adds SEO tools, AI content assistance and multi-site management on top of the basic builder.', 'published', 20),
  ('affiliate', 'What makes a good website builder for affiliate marketing?',
   'Look for structured content types such as reviews and comparisons, per-page SEO controls, fast hosting, custom domains, the ability to manage more than one site, and tools that speed up content production without lowering quality.', 'published', 30),
  ('affiliate', 'Do I need technical skills to use Lummet?',
   'No coding is needed for day-to-day publishing. Content, pages, categories and settings are managed through an admin dashboard with a rich text editor.', 'published', 40),
  ('affiliate', 'Can I run more than one affiliate website?',
   'Yes. Each site is registered as its own tenant with its own configuration and database, and all of them can be managed from one control plane.', 'published', 50),
  ('affiliate', 'Is the platform SEO friendly?',
   'Pages support custom SEO titles, descriptions and social images, and the public site outputs structured data. You still need good content and a sound content plan, as no platform can rank a site by itself.', 'published', 60),
  ('affiliate', 'How does the AI content assistant work?',
   'You ask for outlines, drafts, FAQs or SEO text in plain language. Any change is shown as a preview first and nothing is written until you confirm it.', 'published', 70),
  ('affiliate', 'Can I use my own domain name?',
   'Yes. Sites can be connected to a custom domain, or to a subdomain.', 'published', 80),
  ('affiliate', 'Can I target different countries?',
   'Yes. The platform supports location-aware content so you can publish pages and rankings for audiences in specific countries.', 'published', 90),
  ('affiliate', 'Is Lummet a white-label platform?',
   'Each site keeps its own brand identity, content and configuration, and Lummet runs underneath. You decide how the site is presented to your audience.', 'published', 100),
  ('affiliate', 'How long does it take to launch a site?',
   'The technical foundation is already configured, so the main time investment is your own content and positioning. The platform removes the setup work, not the editorial work.', 'published', 110),
  ('affiliate', 'Are affiliate links allowed, and do I need to disclose them?',
   'Affiliate publishing is supported. You are responsible for following the rules of each affiliate program and the advertising disclosure rules in the countries you publish in. Clear disclosure also builds reader trust.', 'published', 120);

-- ---------------------------------------------------------
-- NAVIGATION (each link appears only once its page exists)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('header', 'Start an Affiliate Business', '/p/start-affiliate-business', 'page:start-affiliate-business', 'published', 15),
  ('footer_platform', 'Affiliate Website Builder', '/p/affiliate-website-builder', 'page:affiliate-website-builder', 'published', 50),
  ('footer_platform', 'Best Website Builder for Affiliates', '/p/best-website-builder-for-affiliate-marketing', 'page:best-website-builder-for-affiliate-marketing', 'published', 60),
  ('footer_platform', 'Multi-Site Platform', '/p/multi-site-website-platform', 'page:multi-site-website-platform', 'published', 70),
  ('footer_platform', 'White-Label Platform', '/p/white-label-website-platform', 'page:white-label-website-platform', 'published', 80),
  ('footer_platform', 'AI Content for Affiliate Sites', '/p/ai-content-for-affiliate-sites', 'page:ai-content-for-affiliate-sites', 'published', 90),
  ('footer_company', 'Start an Affiliate Business', '/p/start-affiliate-business', 'page:start-affiliate-business', 'published', 5);

-- ---------------------------------------------------------
-- PAGES
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_pages (slug, title, excerpt, content, status, seo_title, seo_description, author_id) VALUES
  ('start-affiliate-business', 'Start an Affiliate Business Today',
   'Launch an affiliate website business on an architecture that is already built, configured and ready for content.',
   '<h2>Start an affiliate business without the technical setup</h2>
<p>Most affiliate projects stall before the first article is published, because the website, hosting, content structure and SEO setup take longer than expected. Lummet removes that stage. The architecture is already configured, so you can start with your niche and your audience.</p>
<h2>What an affiliate business needs</h2>
<ul>
<li><strong>A focused niche.</strong> A clear topic and a specific audience.</li>
<li><strong>A website that search engines can read.</strong> Clean URLs, titles, descriptions and structured data.</li>
<li><strong>Useful content.</strong> Reviews, comparisons, guides and news that answer real questions.</li>
<li><strong>Affiliate partnerships.</strong> Programs that fit your audience, with clear disclosure.</li>
<li><strong>A way to grow.</strong> More content, more countries, and eventually more sites.</li>
</ul>
<h2>What Lummet already provides</h2>
<ul>
<li>A configured <a href="/p/affiliate-website-builder">affiliate website builder</a> with content types for reviews, news, pages, categories, countries and authors.</li>
<li>SEO fields on every page type, as covered in our guide to the <a href="/p/best-website-builder-for-affiliate-marketing">best website builder for affiliate marketing</a>.</li>
<li><a href="/p/ai-content-for-affiliate-sites">AI content tools</a> with a preview step before any change is saved.</li>
<li>A <a href="/p/multi-site-website-platform">multi-site platform</a> so your second and third site cost you no extra setup.</li>
<li>Custom domains and per-site configuration, described on our <a href="/p/white-label-website-platform">white-label platform</a> page.</li>
</ul>
<h2>Your first 30 days</h2>
<ol>
<li>Choose a niche and list the 20 questions your audience asks most.</li>
<li>Set up your site, brand name, domain and author profile.</li>
<li>Publish your core pages: about, contact, disclosure and privacy.</li>
<li>Publish a first batch of guides and comparisons.</li>
<li>Apply to affiliate programs that fit the content you have published.</li>
<li>Review what is read, then expand into the topics that perform.</li>
</ol>
<p>Read the full step-by-step guide in <a href="/insights/how-to-start-an-affiliate-business-in-2026">How to start an affiliate business in 2026</a>, or <a href="/demo">request a demo</a> to see the platform. Ready to compare options? See the <a href="/pricing">plans</a>.</p>',
   'published', 'Start an Affiliate Business Today | Lummet',
   'Start an affiliate business on a fully configured platform. SEO-ready website builder, AI content tools and multi-site control, no technical setup.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('affiliate-website-builder', 'Affiliate Website Builder',
   'A website builder configured for affiliate publishing: reviews, comparisons, news, categories and landing pages.',
   '<h2>An affiliate website builder, already configured</h2>
<p>A general-purpose website builder gives you a blank page. An affiliate website needs more: structured review content, comparison layouts, categories, country pages, author profiles and strong SEO controls. Lummet ships with these already in place.</p>
<h2>Content types included</h2>
<ul>
<li><strong>Reviews</strong> with sections you can show or hide.</li>
<li><strong>News and guides</strong> for fresh, topical content.</li>
<li><strong>Pages and landing pages</strong> with a rich text editor.</li>
<li><strong>Categories and countries</strong> to organize content and target locations.</li>
<li><strong>Authors</strong> so readers see who wrote each piece.</li>
</ul>
<h2>Built for search</h2>
<p>Every page type has its own SEO title, description and social image, and the public site outputs structured data. See how this compares to what to look for in a <a href="/p/best-website-builder-for-affiliate-marketing">website builder for affiliate marketing</a>.</p>
<h2>Built to grow</h2>
<p>When one site works, add another. Each site runs with its own configuration and database through the <a href="/p/multi-site-website-platform">multi-site platform</a>.</p>
<p>New to the model? Start with our guide to <a href="/p/start-affiliate-business">starting an affiliate business</a>, or <a href="/demo">get a demo</a>.</p>',
   'published', 'Affiliate Website Builder: Reviews, SEO & Content | Lummet',
   'An affiliate website builder with review and comparison content types, SEO controls, AI tools and custom domains, already configured for you.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('best-website-builder-for-affiliate-marketing', 'How to Choose the Best Website Builder for Affiliate Marketing',
   'A practical checklist for judging any website builder before you commit your affiliate business to it.',
   '<h2>There is no single best website builder, only the best fit</h2>
<p>The right builder depends on your niche, your skills and how many sites you plan to run. Use the criteria below to judge any platform, including ours.</p>
<h2>The criteria that matter</h2>
<ol>
<li><strong>Content structure.</strong> Does it support reviews, comparisons, categories and author pages, or only generic pages?</li>
<li><strong>SEO controls.</strong> Can you set titles, descriptions, social images and structured data on every page type?</li>
<li><strong>Speed.</strong> Slow pages lose readers and rankings. Ask where and how the site is hosted.</li>
<li><strong>Domains.</strong> Can you use your own domain and move it later?</li>
<li><strong>Multi-site.</strong> Can you run a second site without starting again?</li>
<li><strong>Content workflow.</strong> Are there tools that make writing faster and keep quality high?</li>
<li><strong>Ownership.</strong> Is your content stored in a way you control?</li>
<li><strong>Cost over time.</strong> Count plugins, hosting and extra sites, not only the entry price.</li>
</ol>
<h2>How Lummet approaches each one</h2>
<p>Lummet is an <a href="/p/affiliate-website-builder">affiliate website builder</a> with structured content types and SEO fields on every page type. It adds <a href="/p/ai-content-for-affiliate-sites">AI content tools</a> and a <a href="/p/multi-site-website-platform">multi-site control plane</a>. Each site has its own database.</p>
<p>Compare us against your own checklist, then <a href="/demo">ask for a demo</a>. A builder is only the right choice if it fits how you plan to work.</p>',
   'published', 'Best Website Builder for Affiliate Marketing | Lummet',
   'How to pick the best website builder for affiliate marketing: eight criteria covering SEO, speed, domains, multi-site and content tools.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('multi-site-website-platform', 'Multi-Site Website Platform',
   'Run multiple independent websites from one control plane, each with its own database and configuration.',
   '<h2>Manage multiple websites from one dashboard</h2>
<p>Running several sites usually means several logins, several setups and several sets of maintenance. Lummet is built differently: a central control plane manages every site, while each site stays independent.</p>
<h2>How it works</h2>
<ul>
<li><strong>Independent sites.</strong> Each site is a tenant with its own configuration, content and database.</li>
<li><strong>Central control.</strong> The control plane holds the registry, health status and staff access. It does not store your content.</li>
<li><strong>Secure connection.</strong> The control plane talks to each site over HTTPS using signed requests.</li>
<li><strong>Access control.</strong> Team members only see the sites and actions they have been granted.</li>
</ul>
<h2>Why this matters for affiliate publishers</h2>
<p>Publishers often split a portfolio by niche, language or country. A multi-tenant architecture lets you add a site without rebuilding the platform, and an issue on one site does not affect the others.</p>
<p>See how it supports a new site in <a href="/p/start-affiliate-business">starting an affiliate business</a>, or read about the <a href="/p/white-label-website-platform">white-label platform</a>.</p>',
   'published', 'Multi-Site Website Platform: Manage Many Sites | Lummet',
   'A multi-site website platform with one control plane and independent site databases. Add sites without rebuilding and manage access per team member.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('white-label-website-platform', 'White-Label Website Platform',
   'Every site keeps its own brand, domain and configuration, while Lummet runs underneath.',
   '<h2>Your brand in front, our platform underneath</h2>
<p>A white-label platform lets you present a website as your own. With Lummet, each site has its own identity, content, domain and settings. Visitors see your brand.</p>
<h2>What you control per site</h2>
<ul>
<li>Brand name, logo and design settings</li>
<li>Domain or subdomain</li>
<li>Pages, navigation and content</li>
<li>SEO titles, descriptions and social images</li>
<li>Authors and publishing workflow</li>
</ul>
<h2>Who it suits</h2>
<p>Affiliate publishers building a portfolio of sites, agencies running sites for others, and teams that want one technology foundation with separate brands on top.</p>
<p>Learn how multiple brands are run in the <a href="/p/multi-site-website-platform">multi-site platform</a> overview, or begin with <a href="/p/start-affiliate-business">starting an affiliate business</a>. To discuss licensing, <a href="/#contact">get in touch</a>.</p>',
   'published', 'White-Label Website Platform for Publishers | Lummet',
   'A white-label website platform: each site keeps its own brand, domain and settings, with one control plane running underneath.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('ai-content-for-affiliate-sites', 'AI Content Tools for Affiliate Websites',
   'Draft outlines, FAQs, SEO text and reviews faster, with a preview step before anything is saved.',
   '<h2>AI that speeds up publishing, not replaces judgment</h2>
<p>Lummet AI is built into the platform. You ask in plain language and it helps you prepare content for your site.</p>
<h2>What it can help with</h2>
<ul>
<li>Article and review outlines</li>
<li>Draft text you then edit and verify</li>
<li>SEO titles and meta descriptions</li>
<li>FAQ sections and schema suggestions</li>
<li>Improving existing text for clarity</li>
</ul>
<h2>Safe by design</h2>
<p>Every proposed change is shown as a preview and applied only after you confirm it. The assistant can only see and change what your account already has access to.</p>
<h2>Keep quality high</h2>
<p>AI drafts still need a human check for facts, tone and usefulness. Readers and search engines reward original, accurate content. Pair these tools with the planning steps in <a href="/insights/how-to-start-an-affiliate-business-in-2026">our starting guide</a>, and see the full toolset on the <a href="/p/affiliate-website-builder">affiliate website builder</a> page.</p>',
   'published', 'AI Content Tools for Affiliate Websites | Lummet',
   'AI content tools for affiliate websites: outlines, drafts, FAQs and SEO text with a confirmation step before any change is saved.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'));

-- ---------------------------------------------------------
-- INSIGHTS ARTICLES
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_publications (slug, title, excerpt, content, publication_type, author_id, status, published_at) VALUES
  ('how-to-start-an-affiliate-business-in-2026', 'How to Start an Affiliate Business in 2026',
   'A step-by-step plan from choosing a niche to publishing your first pages and applying to affiliate programs.',
   '<p>Starting an affiliate business is mostly a publishing business: you earn when readers trust your recommendations. This plan covers the order of work.</p>
<h2>1. Choose a niche you can sustain</h2>
<p>Pick a topic with a clear audience, enough subtopics for 50 or more articles, and affiliate programs that serve it. Interest helps, because consistency matters more than speed.</p>
<h2>2. Map the questions</h2>
<p>List what your audience searches for: how-to questions, comparisons, and "best for" decisions. These become your first articles.</p>
<h2>3. Set up your website</h2>
<p>You need a fast site, clean URLs, SEO fields and trust pages. A configured <a href="/p/affiliate-website-builder">affiliate website builder</a> saves weeks here.</p>
<h2>4. Publish helpful content first</h2>
<p>Publish guides and comparisons before you chase partnerships. Programs approve sites that already look credible.</p>
<h2>5. Join affiliate programs and disclose clearly</h2>
<p>Apply to programs that fit your content, read their rules, and add a clear disclosure on every page that carries affiliate links.</p>
<h2>6. Measure and expand</h2>
<p>Keep what works and expand into related topics. When the model is proven, add a second site on a <a href="/p/multi-site-website-platform">multi-site platform</a>.</p>
<p>Ready to begin? Visit <a href="/p/start-affiliate-business">start an affiliate business</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-03 08:00:00'),

  ('affiliate-website-builder-checklist', 'Affiliate Website Builder Checklist: 12 Things to Check',
   'Twelve checks to run before you commit an affiliate project to any website builder.',
   '<p>Before you build, confirm that the platform can do the following.</p>
<h2>Content</h2>
<ul>
<li>Review and comparison layouts</li>
<li>Categories and tags</li>
<li>Author profiles</li>
<li>A rich text editor that outputs clean HTML</li>
</ul>
<h2>SEO</h2>
<ul>
<li>Custom title and description on every page type</li>
<li>Social sharing images</li>
<li>Structured data such as FAQ markup</li>
<li>Clean, readable URLs</li>
</ul>
<h2>Operations</h2>
<ul>
<li>Custom domain support</li>
<li>Speed and reliable hosting</li>
<li>Team access controls</li>
<li>A path to adding more sites</li>
</ul>
<p>See how our <a href="/p/affiliate-website-builder">affiliate website builder</a> answers each point, and read the broader guide to the <a href="/p/best-website-builder-for-affiliate-marketing">best website builder for affiliate marketing</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-10-31 08:00:00'),

  ('choosing-a-profitable-affiliate-niche', 'How to Choose an Affiliate Niche You Can Stick With',
   'A simple framework: audience, depth, programs and your own staying power.',
   '<p>The niche decision shapes everything after it. Use four filters.</p>
<h2>Audience</h2>
<p>Can you describe the reader in one sentence? A specific audience is easier to serve than a broad one.</p>
<h2>Depth</h2>
<p>Can you list at least 50 article ideas? If you run out at 10, the niche is too narrow.</p>
<h2>Programs</h2>
<p>Are there reputable affiliate programs relevant to the topic? Check their terms and payment rules before you invest.</p>
<h2>Staying power</h2>
<p>Will you still care in a year? Publishing consistently beats picking the theoretically perfect topic.</p>
<p>Once chosen, follow the plan in <a href="/insights/how-to-start-an-affiliate-business-in-2026">how to start an affiliate business</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-10-30 08:00:00'),

  ('seo-structure-for-affiliate-websites', 'SEO Structure for Affiliate Websites',
   'How to organize pillar pages, supporting articles and internal links so search engines understand your site.',
   '<p>Good structure helps readers and search engines find the right page quickly.</p>
<h2>Use a hub-and-spoke model</h2>
<p>Create one pillar page per core topic. Publish supporting articles that answer narrower questions and link each one back to the pillar.</p>
<h2>Write one clear title and one H1 per page</h2>
<p>Keep titles under about 60 characters and descriptions under about 155 so they are not cut off in results.</p>
<h2>Link with purpose</h2>
<p>Use descriptive anchor text, and link related guides to each other.</p>
<h2>Add structured data where it fits</h2>
<p>FAQ sections can be marked up so the questions are machine readable.</p>
<p>These fields are available on every page type in our <a href="/p/affiliate-website-builder">affiliate website builder</a>. For more on choosing a platform, see the <a href="/p/best-website-builder-for-affiliate-marketing">builder checklist</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-10-29 08:00:00'),

  ('multi-tenant-architecture-explained', 'Multi-Tenant Architecture Explained for Website Owners',
   'What multi-tenant means, why it matters for running several sites, and what stays separate.',
   '<p>Multi-tenant means one platform serves several independent customers or sites, called tenants.</p>
<h2>What is shared</h2>
<p>The technology foundation, the management layer and the release process.</p>
<h2>What stays separate</h2>
<p>Each tenant keeps its own configuration, content and database. A problem on one tenant does not reach the others.</p>
<h2>Why publishers care</h2>
<p>Adding a new site does not mean starting from scratch, and updates to the platform can reach every site without separate rebuilds.</p>
<p>Learn how Lummet applies this on the <a href="/p/multi-site-website-platform">multi-site website platform</a> page.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-10-28 08:00:00'),

  ('using-ai-to-write-affiliate-content-responsibly', 'Using AI to Write Affiliate Content Responsibly',
   'Where AI helps, where a human must step in, and how to keep content original and accurate.',
   '<p>AI can shorten the path from idea to draft. It cannot replace first-hand knowledge or fact checking.</p>
<h2>Good uses</h2>
<ul>
<li>Outlines and heading structures</li>
<li>First drafts you rewrite in your own voice</li>
<li>FAQ ideas and SEO title options</li>
<li>Editing for clarity</li>
</ul>
<h2>Human responsibilities</h2>
<ul>
<li>Verify every fact and figure</li>
<li>Add your own experience and examples</li>
<li>Check tone and usefulness</li>
<li>Disclose affiliate relationships</li>
</ul>
<p>Lummet AI shows a preview before saving anything. Read more on <a href="/p/ai-content-for-affiliate-sites">AI content tools for affiliate websites</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-10-27 08:00:00'),

  ('geo-targeting-for-content-websites', 'GEO Targeting for Content Websites',
   'How to serve different countries with location-aware pages without duplicating your whole site.',
   '<p>Readers in different countries have different needs, rules and options. GEO targeting aligns your content with them.</p>
<h2>Start with a shared core</h2>
<p>Keep the guides that apply everywhere in one place.</p>
<h2>Add country pages where it matters</h2>
<p>Create pages for countries where details differ, such as availability, pricing or regulations.</p>
<h2>Keep each page useful</h2>
<p>Avoid near-duplicate pages. Each country page should contain facts specific to that audience.</p>
<p>Lummet supports location-aware content through countries and category-country pages. Start from <a href="/p/start-affiliate-business">starting an affiliate business</a> for the full setup path.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-10-26 08:00:00'),

  ('launch-your-first-affiliate-site-checklist', 'Launch Checklist for Your First Affiliate Website',
   'A one-page checklist of what to have in place before you announce a new affiliate site.',
   '<p>Use this list before launch.</p>
<h2>Foundation</h2>
<ul>
<li>Domain connected and secure</li>
<li>Brand name, logo and author profile set</li>
<li>About, contact, privacy and affiliate disclosure pages published</li>
</ul>
<h2>Content</h2>
<ul>
<li>At least 10 helpful articles or comparisons live</li>
<li>Pillar page and internal links in place</li>
<li>SEO title and description on every page</li>
</ul>
<h2>Growth</h2>
<ul>
<li>Affiliate programs applied for</li>
<li>A publishing calendar for the next 90 days</li>
<li>A way to review results monthly</li>
</ul>
<p>Need the foundation done for you? See the <a href="/p/affiliate-website-builder">affiliate website builder</a> or <a href="/demo">request a demo</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-10-25 08:00:00');
