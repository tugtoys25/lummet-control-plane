-- =====================================================
-- 0083 — SEO SEED: AFFILIATE NICHES AND COMMISSION MODELS
--
-- Extends 0079 and 0080 (0081 and 0082 are brand-table migrations) with a niche hub and niche pages:
--   software/SaaS, B2B services, finance/insurance/crypto,
--   travel, e-commerce, health/fitness, education, gaming,
--   automotive, lifestyle/fashion/food
-- plus commission-model and disclosure/compliance guides.
--
-- Adds: 13 pages (/p/<slug>), 6 Insights articles, 8 FAQs
-- (group 'affiliate_niches'), 14 feature rows in 2 groups,
-- 3 additive homepage sections (sort 37, 38, 117) and 3
-- footer navigation links.
--
-- Data only: no schema changes, no site_settings changes,
-- nothing existing is modified. All rows use INSERT OR
-- IGNORE, so re-running never overwrites admin edits.
-- Wording: Lummet is the website platform. It does not
-- provide financial, insurance, medical, legal, travel,
-- gambling or real estate services. No statistics,
-- earnings claims, testimonials or competitor rankings.
-- =====================================================

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO lummet_features (feature_key, group_key, icon, title, body, link_label, link_href, status, sort_order) VALUES
  ('niche-software', 'affiliate_niches', 'layers', 'Software and SaaS', 'Reviews, comparisons and alternatives pages for software tools.', 'Software affiliate sites', '/p/software-saas-affiliate-website', 'published', 10),
  ('niche-b2b', 'affiliate_niches', 'sliders', 'B2B services', 'Payroll, accounting, CRM and marketing tool guides.', 'B2B affiliate sites', '/p/b2b-services-affiliate-website', 'published', 20),
  ('niche-finance', 'affiliate_niches', 'trending', 'Finance and insurance', 'Comparison and education sites for regulated financial topics.', 'Finance affiliate sites', '/p/finance-fintech-affiliate-website', 'published', 30),
  ('niche-travel', 'affiliate_niches', 'map-pin', 'Travel', 'Destination guides and hotel reviews that earn on bookings.', 'Travel affiliate sites', '/p/travel-affiliate-website', 'published', 40),
  ('niche-ecommerce', 'affiliate_niches', 'search', 'Product reviews', 'Buying guides, best-of lists and comparisons.', 'Product review sites', '/p/ecommerce-product-review-affiliate-website', 'published', 50),
  ('niche-health', 'affiliate_niches', 'sparkles', 'Health and fitness', 'Gear, app and wellness content with careful claims.', 'Health affiliate sites', '/p/health-fitness-wellness-affiliate-website', 'published', 60),
  ('niche-education', 'affiliate_niches', 'layers', 'Online education', 'Course, language and certification reviews.', 'Education affiliate sites', '/p/online-education-affiliate-website', 'published', 70),
  ('niche-gaming', 'affiliate_niches', 'sparkles', 'Gaming and entertainment', 'Games, hardware, streaming and regulated iGaming.', 'Gaming affiliate sites', '/p/gaming-entertainment-affiliate-website', 'published', 80),
  ('niche-auto', 'affiliate_niches', 'trending', 'Automotive', 'Vehicles, parts and accessories guides.', 'Automotive affiliate sites', '/p/automotive-affiliate-website', 'published', 90),
  ('niche-lifestyle', 'affiliate_niches', 'share', 'Lifestyle and fashion', 'Beauty, fashion, food and outdoor gear.', 'Lifestyle affiliate sites', '/p/lifestyle-fashion-food-affiliate-website', 'published', 100),
  ('model-cpa', 'commission_models', 'trending', 'Pay per sale or action', 'A percentage of a purchase, or a fixed amount when a customer completes a defined step.', NULL, NULL, 'published', 10),
  ('model-revshare', 'commission_models', 'layers', 'Revenue share', 'A percentage of ongoing revenue from the customers you referred.', NULL, NULL, 'published', 20),
  ('model-recurring', 'commission_models', 'sparkles', 'Recurring commission', 'A share of subscription payments while the customer stays subscribed.', NULL, NULL, 'published', 30),
  ('model-lead', 'commission_models', 'search', 'Pay per lead', 'A fixed amount for each qualified enquiry you send.', NULL, NULL, 'published', 40);

INSERT OR IGNORE INTO lummet_homepage_sections (section_key, kind, feature_group, background, title, subtitle, body, cta_label, cta_href, layout, status, sort_order) VALUES
  ('affiliate-niches', 'features', 'affiliate_niches', 'default', 'Affiliate Websites for Every Niche', 'Niches', '<p>From software and travel to finance and gaming, build on the same configured foundation. Compare niches by commission model, competition and regulation.</p>', 'Explore all niches', '/p/affiliate-niches', 'text_only', 'published', 37),
  ('affiliate-commission-models', 'steps', 'commission_models', 'soft', 'Know How You Get Paid', 'Commission models', '<p>Different niches pay in different ways. Understanding the model helps you plan content and set realistic expectations.</p>', 'Compare commission models', '/p/affiliate-commission-models', 'text_only', 'published', 38),
  ('affiliate-niches-faq', 'faq', 'affiliate_niches', 'default', 'Choosing an Affiliate Niche: FAQ', 'FAQ', NULL, NULL, NULL, 'text_only', 'published', 117);

INSERT OR IGNORE INTO lummet_faqs (group_key, question, answer, status, sort_order) VALUES
  ('affiliate_niches', 'Which affiliate niche is best for beginners?', 'There is no single best niche. Software, travel and education are often approachable because the products are easy to review and the rules are lighter. Regulated niches such as finance, gambling and health can pay well but need more care. Choose a topic you can write about consistently.', 'published', 10),
  ('affiliate_niches', 'What are the main affiliate commission models?', 'The most common are pay per sale, cost per acquisition, revenue share, recurring commission and pay per lead. Each program sets its own terms, so read the agreement before you promote.', 'published', 20),
  ('affiliate_niches', 'Which affiliate niches pay recurring commission?', 'Many software and subscription programs pay a recurring share while the customer stays subscribed. Terms differ by program, so confirm before you build content around it.', 'published', 30),
  ('affiliate_niches', 'Are finance and crypto affiliate sites regulated?', 'Often yes. Financial promotions are regulated in many countries, and some restrict who may promote certain products. Include required risk warnings and confirm local rules before launch.', 'published', 40),
  ('affiliate_niches', 'Can a health affiliate site make medical claims?', 'No. Avoid claiming that products treat, cure or prevent conditions, and avoid unsupported health claims. Present general information and send readers to qualified professionals for advice.', 'published', 50),
  ('affiliate_niches', 'Can I run affiliate sites in several niches?', 'Yes. Each site is registered as its own tenant with its own domain, configuration and database, and all of them can be managed from one control plane.', 'published', 60),
  ('affiliate_niches', 'Do I have to disclose affiliate links?', 'Advertising regulators in many countries expect clear disclosure when you earn a commission. Place it near the links in plain language and keep a disclosure page on your site.', 'published', 70),
  ('affiliate_niches', 'Can Lummet AI help me write content in any niche?', 'Lummet AI can draft outlines, reviews, FAQs and SEO titles. Every proposed change is shown as a preview and applied only after you confirm it. You remain responsible for checking facts and claims, especially in regulated niches.', 'published', 80);

INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('footer_company', 'Affiliate Niches', '/p/affiliate-niches', 'page:affiliate-niches', 'published', 6),
  ('footer_platform', 'Commission Models', '/p/affiliate-commission-models', 'page:affiliate-commission-models', 'published', 130),
  ('footer_platform', 'Disclosure and Compliance', '/p/affiliate-disclosure-compliance-guide', 'page:affiliate-disclosure-compliance-guide', 'published', 140);

INSERT OR IGNORE INTO lummet_pages (slug, title, excerpt, content, status, seo_title, seo_description, author_id) VALUES
  ('affiliate-niches', 'Affiliate Niches: Where Affiliate Websites Earn',
   'Compare affiliate niches by commission model, competition and regulation, then build your site on a configured platform.',
   '<h2>Choose an affiliate niche with open eyes</h2>
<p>An affiliate niche is a topic and audience served by businesses that pay a commission for referred customers. The right niche balances three things: how you get paid, how much competition you face, and how heavily the industry is regulated. Lummet provides the same configured website foundation for every niche, so the choice is about your audience, not your technology.</p>
<h2>Niches you can build on Lummet</h2>
<ul>
<li><a href="/p/software-saas-affiliate-website">Software and SaaS</a>: reviews and comparisons of tools, often paid per signup or as recurring commission.</li>
<li><a href="/p/b2b-services-affiliate-website">B2B services</a>: payroll, accounting, CRM and marketing tools for businesses.</li>
<li><a href="/p/finance-fintech-affiliate-website">Finance, insurance and crypto</a>: high-value referrals in regulated markets.</li>
<li><a href="/p/travel-affiliate-website">Travel</a>: hotels, flights, tours and car rental, paid per booking.</li>
<li><a href="/p/ecommerce-product-review-affiliate-website">E-commerce and product reviews</a>: high volume, lower commission per sale.</li>
<li><a href="/p/health-fitness-wellness-affiliate-website">Health, fitness and wellness</a>: gear, apps and supplements with careful claims.</li>
<li><a href="/p/online-education-affiliate-website">Online education</a>: courses, languages and certifications.</li>
<li><a href="/p/gaming-entertainment-affiliate-website">Gaming and entertainment</a>: games, hardware, streaming and iGaming. See also the <a href="/p/casino-affiliate-website-platform">casino affiliate platform</a>.</li>
<li><a href="/p/automotive-affiliate-website">Automotive</a>: vehicles, parts and car-related finance leads.</li>
<li><a href="/p/lifestyle-fashion-food-affiliate-website">Lifestyle, fashion and food</a>: beauty, fashion, subscriptions and outdoor gear.</li>
<li><a href="/p/property-listing-lead-generation-website">Property listings</a> and <a href="/p/casino-hotel-affiliate-website">casino-hotel and travel</a> sites.</li>
</ul>
<h2>How to compare niches</h2>
<ol>
<li><strong>Commission model.</strong> One-time, recurring, revenue share or per lead. See <a href="/p/affiliate-commission-models">commission models</a>.</li>
<li><strong>Regulation.</strong> Finance, insurance, gambling, crypto and health face stricter rules. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</li>
<li><strong>Audience depth.</strong> Enough subtopics for dozens of useful pages.</li>
<li><strong>Your staying power.</strong> Read <a href="/insights/choosing-a-profitable-affiliate-niche">how to choose a niche you can stick with</a>.</li>
</ol>
<p>Run more than one niche by adding sites to the <a href="/p/multi-site-website-platform">multi-site platform</a>, each with its own domain and configuration. New to the model? Start with how to <a href="/p/start-affiliate-business">start an affiliate business</a>, then <a href="/demo">request a demo</a> or compare <a href="/pricing">plans</a>.</p>',
   'published', 'Affiliate Niches: Choose a Niche to Build | Lummet',
   'Compare affiliate niches by commission model and regulation: software, finance, travel, e-commerce, health, education, gaming and more.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('software-saas-affiliate-website', 'Software and SaaS Affiliate Website',
   'Build a software review and comparison website on a configured, SEO-ready platform.',
   '<h2>Software and SaaS Affiliate on a configured platform</h2>
<p>Software buyers research before they sign up, which suits affiliate publishing. Lummet gives you structured review and comparison content, per-page SEO controls and an admin dashboard, so you can focus on testing tools and explaining them clearly.</p>
<h2>What you can publish</h2>
<ul>
<li>In-depth tool reviews written from real use.</li>
<li>Head-to-head comparisons and alternatives pages.</li>
<li>Best-for guides by team size, budget or use case.</li>
<li>How-to tutorials that lead naturally to a recommended tool.</li>
<li>FAQs with structured data for search.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Many software programs pay per signup or a recurring percentage while the customer stays subscribed. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Disclose affiliate links clearly, and describe products accurately, including limits and pricing you have verified. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/b2b-services-affiliate-website">B2B services</a>, <a href="/p/online-education-affiliate-website">online education</a> and <a href="/p/ecommerce-product-review-affiliate-website">product reviews</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Software and SaaS Affiliate Website | Lummet',
   'Build a software and SaaS affiliate website with reviews, comparisons and alternatives pages on a configured SEO-ready platform.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('b2b-services-affiliate-website', 'B2B Services Affiliate Website',
   'Publish reviews and guides on business software and services such as payroll, accounting, CRM and marketing tools.',
   '<h2>B2B Services Affiliate on a configured platform</h2>
<p>Business buyers want clear comparisons and practical guidance. A B2B affiliate site can focus on one function, such as accounting for freelancers or CRM for small teams, and serve a narrow audience well.</p>
<h2>What you can publish</h2>
<ul>
<li>Comparisons of payroll, accounting, CRM and marketing tools.</li>
<li>Guides by company size or industry.</li>
<li>Implementation checklists and setup walkthroughs.</li>
<li>Pricing and feature explainers you keep up to date.</li>
<li>Case-style write-ups based on your own testing.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>B2B programs often pay a larger one-time fee or a recurring share, with longer decision cycles than consumer products. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Keep feature and pricing claims current, and disclose your commission relationship. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/software-saas-affiliate-website">software and SaaS</a>, <a href="/p/finance-fintech-affiliate-website">finance and fintech</a> and <a href="/p/online-education-affiliate-website">online education</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'B2B Services Affiliate Website | Lummet',
   'Build a B2B affiliate website for payroll, accounting, CRM and marketing tools with comparison pages and guides on a configured platform.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('finance-fintech-affiliate-website', 'Finance, Insurance and Crypto Affiliate Website',
   'Build a finance comparison website for banking, investing, insurance and crypto topics, with compliance in mind.',
   '<h2>Finance, Insurance and Crypto Affiliate on a configured platform</h2>
<p>Finance referrals can pay well because the products are valuable, but the industry is regulated. A good finance site is accurate, transparent and clear about what it is not: it informs readers and does not give personal advice.</p>
<h2>What you can publish</h2>
<ul>
<li>Comparisons of banking apps, cards, loans and investing platforms.</li>
<li>Plain-language guides to fees, rates and risks.</li>
<li>Insurance explainers and quote-comparison guides.</li>
<li>Crypto exchange and wallet reviews with risk information.</li>
<li>Country pages, because products and rules differ by market.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Programs commonly pay per approved application, per funded account or per lead, with eligibility rules set by the provider. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Financial promotions are regulated in many countries, and some restrict who may promote certain products, including crypto and trading products. Include required risk warnings, avoid personal recommendations and confirm local requirements before launch. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/automotive-affiliate-website">automotive finance leads</a>, <a href="/p/property-listing-lead-generation-website">property listing sites</a> and <a href="/p/b2b-services-affiliate-website">B2B services</a>. Read the <a href="/insights/regulated-affiliate-niches-checklist">regulated niches checklist</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Finance and Fintech Affiliate Website | Lummet',
   'Build a finance, insurance and crypto affiliate website with comparison pages and guides, and learn which rules to check before you launch.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('travel-affiliate-website', 'Travel Affiliate Website',
   'Build a travel website with destination guides, hotel reviews and comparisons that earn commission on bookings.',
   '<h2>Travel Affiliate on a configured platform</h2>
<p>Travel readers search by destination, season and budget. A travel affiliate site answers those questions with guides and honest reviews, then links to partner booking pages.</p>
<h2>What you can publish</h2>
<ul>
<li>Destination and itinerary guides.</li>
<li>Hotel, tour and car rental reviews.</li>
<li>Seasonal and event guides.</li>
<li>Country and city pages for different audiences.</li>
<li>Travel insurance explainers.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Travel programs usually pay a percentage of the booking value or a fixed amount per completed booking. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>If the reader books and pays on the partner site you are acting as an affiliate. Taking bookings or payments yourself or selling packages can require registration in some countries. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/casino-hotel-affiliate-website">casino-hotel and travel sites</a>, <a href="/p/lifestyle-fashion-food-affiliate-website">lifestyle sites</a> and <a href="/p/ecommerce-product-review-affiliate-website">gear reviews</a>. Read <a href="/insights/how-to-start-a-travel-affiliate-website">how to start a travel affiliate website</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Travel Affiliate Website | Lummet',
   'Build a travel affiliate website with destination guides, hotel and tour reviews and comparison pages on a configured SEO-ready platform.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('ecommerce-product-review-affiliate-website', 'E-commerce and Product Review Affiliate Website',
   'Publish product reviews, buying guides and comparisons for consumer products.',
   '<h2>E-commerce and Product Review Affiliate on a configured platform</h2>
<p>Product review sites win by being useful: clear recommendations, honest trade-offs and up-to-date information. Lummet provides review and comparison structures, categories and SEO controls for catalogue-style content.</p>
<h2>What you can publish</h2>
<ul>
<li>Single-product reviews and hands-on notes.</li>
<li>Best-of lists by category, use case or budget.</li>
<li>Side-by-side comparisons.</li>
<li>Buying guides that explain what to look for.</li>
<li>Category pages organising your whole catalogue.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Retail programs generally pay a percentage of each sale. Rates per sale are often lower than software or finance, so volume matters. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Disclose affiliate links near the links, and keep prices and availability statements accurate or dated. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/lifestyle-fashion-food-affiliate-website">lifestyle</a>, <a href="/p/gaming-entertainment-affiliate-website">gaming hardware</a> and <a href="/p/health-fitness-wellness-affiliate-website">fitness gear</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Product Review Affiliate Website | Lummet',
   'Build a product review affiliate website with buying guides, comparisons and best-of lists on a configured SEO-ready platform.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('health-fitness-wellness-affiliate-website', 'Health, Fitness and Wellness Affiliate Website',
   'Build a fitness and wellness website with gear reviews, app comparisons and responsible content.',
   '<h2>Health, Fitness and Wellness Affiliate on a configured platform</h2>
<p>Wellness audiences look for trustworthy guidance. A strong site separates general information from medical advice, cites reliable sources and reviews products on evidence rather than promises.</p>
<h2>What you can publish</h2>
<ul>
<li>Fitness gear and app reviews.</li>
<li>Training and routine guides.</li>
<li>Nutrition and wellness explainers written with care.</li>
<li>Comparisons of equipment and subscriptions.</li>
<li>Author profiles that show who wrote each page.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Programs pay per sale or per signup, and some pay recurring commission on subscriptions. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Avoid claiming that products treat, cure or prevent conditions, and avoid unsupported health claims. Advertising rules for supplements and health products are strict in many countries. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/lifestyle-fashion-food-affiliate-website">lifestyle and beauty</a>, <a href="/p/ecommerce-product-review-affiliate-website">product reviews</a> and <a href="/p/online-education-affiliate-website">education</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Health and Fitness Affiliate Website | Lummet',
   'Build a health, fitness and wellness affiliate website with reviews, guides and comparisons, and learn how to handle health claims carefully.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('online-education-affiliate-website', 'Online Education Affiliate Website',
   'Publish course, language and certification reviews and learning guides.',
   '<h2>Online Education Affiliate on a configured platform</h2>
<p>Learners compare courses, platforms and credentials before they commit. An education affiliate site can organise this by subject, career goal or skill level.</p>
<h2>What you can publish</h2>
<ul>
<li>Course and platform reviews.</li>
<li>Learning paths by goal or career.</li>
<li>Language-learning app comparisons.</li>
<li>Certification guides and study plans.</li>
<li>FAQs about cost, time and outcomes, stated carefully.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Education programs often pay per enrolment or per sale, and some pay recurring commission on subscriptions. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Do not promise jobs, income or exam results, and describe course content as the provider presents it. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/software-saas-affiliate-website">software</a>, <a href="/p/b2b-services-affiliate-website">business tools</a> and <a href="/p/health-fitness-wellness-affiliate-website">wellness</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Online Education Affiliate Website | Lummet',
   'Build an online education affiliate website with course reviews, learning paths and comparisons on a configured SEO-ready platform.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('gaming-entertainment-affiliate-website', 'Gaming and Entertainment Affiliate Website',
   'Build a website covering games, hardware, streaming and iGaming with reviews and comparisons.',
   '<h2>Gaming and Entertainment Affiliate on a configured platform</h2>
<p>Gaming audiences are enthusiastic and well informed, so accuracy matters. Sites can cover game releases, hardware, subscriptions and streaming services, and, in regulated form, iGaming.</p>
<h2>What you can publish</h2>
<ul>
<li>Game and hardware reviews.</li>
<li>Streaming and subscription comparisons.</li>
<li>Guides, news and release calendars.</li>
<li>Best-for lists by platform or budget.</li>
<li>iGaming pages where permitted, with responsible gambling information.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Programs pay per sale, per signup or, for iGaming, per player or as revenue share. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Gambling advertising and affiliate rules vary widely, and age restrictions apply. For iGaming see the casino affiliate platform page. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/casino-affiliate-website-platform">casino affiliate platform</a>, <a href="/p/ecommerce-product-review-affiliate-website">product reviews</a> and <a href="/p/software-saas-affiliate-website">software</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Gaming and Entertainment Affiliate Website | Lummet',
   'Build a gaming and entertainment affiliate website with game, hardware and streaming reviews, plus options for regulated iGaming content.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('automotive-affiliate-website', 'Automotive Affiliate Website',
   'Build a website on vehicles, parts, accessories and car-related services.',
   '<h2>Automotive Affiliate on a configured platform</h2>
<p>Car buyers and owners search for comparisons, maintenance advice and parts guides. A focused automotive site can serve one segment, such as electric vehicles or used cars.</p>
<h2>What you can publish</h2>
<ul>
<li>Vehicle and accessory reviews.</li>
<li>Maintenance and ownership guides.</li>
<li>Parts and tools buying guides.</li>
<li>Comparisons by type, budget or country.</li>
<li>Guides to car insurance and finance, kept informational.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Parts and accessories programs usually pay per sale. Marketplace and finance programs may pay per lead or per approved application. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Car finance and insurance content falls under financial promotion rules in many countries. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/finance-fintech-affiliate-website">finance and insurance</a>, <a href="/p/ecommerce-product-review-affiliate-website">product reviews</a> and <a href="/p/lifestyle-fashion-food-affiliate-website">lifestyle</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Automotive Affiliate Website | Lummet',
   'Build an automotive affiliate website with vehicle, parts and accessories reviews, guides and comparisons on a configured platform.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('lifestyle-fashion-food-affiliate-website', 'Lifestyle, Fashion and Food Affiliate Website',
   'Publish beauty, fashion, food, subscription and outdoor gear content with reviews and guides.',
   '<h2>Lifestyle, Fashion and Food Affiliate on a configured platform</h2>
<p>Lifestyle sites succeed with a clear point of view and strong visuals. Choose a focus, such as sustainable fashion or home cooking, and publish consistently for that reader.</p>
<h2>What you can publish</h2>
<ul>
<li>Beauty, fashion and accessories reviews.</li>
<li>Meal kit, coffee and subscription comparisons.</li>
<li>Outdoor and sports gear buying guides.</li>
<li>Seasonal gift guides.</li>
<li>Category and country pages.</li>
</ul>
<h2>How this niche usually pays</h2>
<p>Programs generally pay a percentage per sale, and subscription services may pay per new subscriber. Terms differ by program, so read each agreement before you promote. See <a href="/p/affiliate-commission-models">commission models</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Disclose affiliate links and describe product claims accurately. Lummet is a website platform. It does not provide regulated services, and this page is general information, not legal or professional advice. Rules differ by country, so check the requirements for each market you target. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<h2>Keep building</h2>
<p>Related: <a href="/p/ecommerce-product-review-affiliate-website">product reviews</a>, <a href="/p/health-fitness-wellness-affiliate-website">wellness</a> and <a href="/p/travel-affiliate-website">travel</a>. Read how to <a href="/p/start-affiliate-business">start an affiliate business</a>, explore the <a href="/p/affiliate-website-builder">affiliate website builder</a> and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a>, compare <a href="/pricing">plans</a> or <a href="/demo">request a demo</a>. Back to <a href="/p/affiliate-niches">all affiliate niches</a>.</p>',
   'published', 'Lifestyle, Fashion and Food Affiliate Website | Lummet',
   'Build a lifestyle affiliate website for beauty, fashion, food, subscriptions and outdoor gear with reviews, guides and comparisons.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('affiliate-commission-models', 'Affiliate Commission Models Explained',
   'CPA, revenue share, recurring commission and pay per lead, and which niches use each.',
   '<h2>How affiliates get paid</h2>
<p>An affiliate commission is an agreed payment from a business when a visitor you referred takes a defined action. The structure varies by program, and it affects how you plan content and income.</p>
<h2>Common models</h2>
<ul>
<li><strong>Pay per sale.</strong> A percentage of the purchase. Common in retail and travel.</li>
<li><strong>Cost per acquisition (CPA).</strong> A fixed amount when a customer signs up, deposits or completes a defined step. Common in finance and iGaming.</li>
<li><strong>Revenue share.</strong> A percentage of ongoing revenue from the customer you referred. Common in iGaming.</li>
<li><strong>Recurring commission.</strong> A share of subscription payments while the customer stays. Common in software.</li>
<li><strong>Pay per lead.</strong> A fixed amount for a qualified enquiry. Common in property, insurance and B2B.</li>
</ul>
<h2>Matching a model to a niche</h2>
<p>Recurring models reward content that attracts loyal customers, such as <a href="/p/software-saas-affiliate-website">software</a>. Per-sale models reward volume, as in <a href="/p/ecommerce-product-review-affiliate-website">product reviews</a>. Lead and CPA models appear in <a href="/p/finance-fintech-affiliate-website">finance</a> and <a href="/p/property-listing-lead-generation-website">property</a>, where regulation matters most.</p>
<h2>Read the terms</h2>
<p>Programs set their own cookie periods, eligibility rules, payment thresholds and restrictions. Read them before you promote, and disclose the relationship to your readers. See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>.</p>
<p>Compare niches in <a href="/p/affiliate-niches">all affiliate niches</a>, or <a href="/p/start-affiliate-business">start an affiliate business</a>. Read <a href="/insights/affiliate-commission-models-explained">commission models explained</a> for a shorter overview, or <a href="/demo">request a demo</a>.</p>',
   'published', 'Affiliate Commission Models Explained | Lummet',
   'Understand CPA, revenue share, recurring commission and pay per lead, and how each commission model fits different affiliate niches.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('affiliate-disclosure-compliance-guide', 'Affiliate Disclosure and Compliance Guide',
   'What to disclose, how to word it, and which niches need extra care.',
   '<h2>Disclose clearly, every time</h2>
<p>Advertising regulators in many countries expect affiliates to tell readers when they earn a commission. Place the disclosure where readers will see it before they click, use plain words and do not bury it in a footer alone.</p>
<h2>A practical checklist</h2>
<ul>
<li>State the commission relationship near the links, in plain language.</li>
<li>Keep a site-wide disclosure page and link to it from the footer.</li>
<li>Make sure reviews reflect real experience or reliable sources.</li>
<li>Keep prices, features and availability accurate, or date them.</li>
<li>Follow cookie, privacy and consent rules for your readers.</li>
<li>Respect age restrictions and country limits for the products you promote.</li>
</ul>
<h2>Niches that need extra care</h2>
<ul>
<li><a href="/p/finance-fintech-affiliate-website">Finance, insurance and crypto</a>: financial promotion rules, risk warnings and restrictions on who may promote.</li>
<li><a href="/p/casino-affiliate-website-platform">Gambling</a>: licensing or registration for affiliates in some countries, age gates and responsible gambling messages.</li>
<li><a href="/p/health-fitness-wellness-affiliate-website">Health and wellness</a>: strict rules on health claims.</li>
<li><a href="/p/property-listing-lead-generation-website">Property</a>: rules on referral fees and brokerage in some countries.</li>
<li><a href="/p/travel-affiliate-website">Travel</a>: registration and package travel rules if you sell or arrange bookings yourself.</li>
</ul>
<h2>Your responsibility</h2>
<p>Lummet is a website platform. It does not provide legal advice or regulated services, and this guide is general information. Confirm the requirements in each market with a qualified adviser. Read the <a href="/insights/affiliate-disclosure-checklist">disclosure checklist</a> and the <a href="/insights/regulated-affiliate-niches-checklist">regulated niches checklist</a>, compare <a href="/p/affiliate-niches">all affiliate niches</a>, or <a href="/p/start-affiliate-business">start an affiliate business</a>.</p>',
   'published', 'Affiliate Disclosure and Compliance Guide | Lummet',
   'A practical guide to affiliate disclosure, advertising rules and extra care for finance, gambling, health and property niches.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'));

INSERT OR IGNORE INTO lummet_publications (slug, title, excerpt, content, publication_type, author_id, status, published_at) VALUES
  ('affiliate-commission-models-explained', 'Affiliate Commission Models Explained',
   'CPA, revenue share, recurring commission and pay per lead in plain language.',
   '<p>Before you pick a niche, learn how the programs in it pay. The model shapes your content plan.</p>
<h2>The five common models</h2>
<ul>
<li>Pay per sale: a percentage of a purchase.</li>
<li>CPA: a fixed amount for a defined action.</li>
<li>Revenue share: a percentage of ongoing customer revenue.</li>
<li>Recurring: a share of subscription payments.</li>
<li>Pay per lead: a fixed amount per qualified enquiry.</li>
</ul>
<p>Each program sets its own cookie period, eligibility rules and restrictions. See the full guide to <a href="/p/affiliate-commission-models">commission models</a>, compare <a href="/p/affiliate-niches">all affiliate niches</a>, or <a href="/p/start-affiliate-business">start an affiliate business</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-02 08:00:00'),

  ('affiliate-niches-compared', 'Affiliate Niches Compared: Commission, Competition and Regulation',
   'A simple way to compare niches before you commit to one.',
   '<p>Choosing a niche is easier with a checklist.</p>
<h2>Four questions</h2>
<ol>
<li>How do programs in this niche pay?</li>
<li>How many subtopics can I cover with useful pages?</li>
<li>Is the industry regulated, and where?</li>
<li>Can I stay interested for a year?</li>
</ol>
<p>Browse <a href="/p/affiliate-niches">all affiliate niches</a>, read <a href="/insights/choosing-a-profitable-affiliate-niche">how to choose a niche you can stick with</a> and understand <a href="/p/affiliate-commission-models">commission models</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-02 09:00:00'),

  ('how-to-write-honest-software-reviews', 'How to Write Honest Software Reviews',
   'A review structure that readers trust and search engines can understand.',
   '<p>Software readers want to know whether a tool fits their situation.</p>
<h2>Structure</h2>
<ul>
<li>Who the tool is for and who it is not for.</li>
<li>What you tested and for how long.</li>
<li>Strengths and limits, with specifics.</li>
<li>Pricing, checked and dated.</li>
<li>Alternatives worth considering.</li>
</ul>
<p>Disclose your commission relationship clearly. Build your site on the <a href="/p/software-saas-affiliate-website">software affiliate website</a> foundation, or use the <a href="/p/ai-content-for-affiliate-sites">AI content tools</a> to draft outlines you then verify.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-02 10:00:00'),

  ('regulated-affiliate-niches-checklist', 'Regulated Affiliate Niches: What to Check Before You Launch',
   'Finance, gambling, health and property need extra care. Start with this checklist.',
   '<p>Regulated niches can be rewarding, but mistakes are costly.</p>
<h2>Checklist</h2>
<ul>
<li>Do affiliates or promoters need a licence or registration in your target countries?</li>
<li>Are there required risk warnings or age gates?</li>
<li>Which claims are restricted?</li>
<li>Are referral fees limited?</li>
<li>Is your disclosure clear and close to each link?</li>
</ul>
<p>See the <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a>, plus <a href="/p/finance-fintech-affiliate-website">finance</a>, <a href="/p/casino-affiliate-website-platform">gambling</a>, <a href="/p/health-fitness-wellness-affiliate-website">health</a> and <a href="/p/property-listing-lead-generation-website">property</a> pages. This is general information, not legal advice.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-02 11:00:00'),

  ('how-to-start-a-travel-affiliate-website', 'How to Start a Travel Affiliate Website',
   'From choosing a focus to publishing destination guides and hotel reviews.',
   '<p>Travel readers search by place, season and budget.</p>
<h2>Plan</h2>
<ol>
<li>Choose a destination, traveller type or trip style.</li>
<li>Publish destination guides and itineraries.</li>
<li>Add hotel and tour reviews, and comparisons.</li>
<li>Apply to travel programs that fit your content.</li>
</ol>
<p>See the <a href="/p/travel-affiliate-website">travel affiliate website</a> page and the <a href="/p/casino-hotel-affiliate-website">casino-hotel affiliate page</a>, or <a href="/p/start-affiliate-business">start an affiliate business</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-02 12:00:00'),

  ('affiliate-disclosure-checklist', 'Affiliate Disclosure Checklist',
   'Where to disclose, how to word it and what to avoid.',
   '<p>Disclosure builds trust and keeps you within advertising rules.</p>
<ul>
<li>Disclose near the link, before the click.</li>
<li>Use plain words, such as: we may earn a commission if you buy through our links.</li>
<li>Keep a disclosure page and link it in the footer.</li>
<li>Do not let commission change what you say about a product.</li>
</ul>
<p>Read the full <a href="/p/affiliate-disclosure-compliance-guide">disclosure and compliance guide</a> and compare <a href="/p/affiliate-niches">all affiliate niches</a>. Rules vary by country.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-02 13:00:00');
