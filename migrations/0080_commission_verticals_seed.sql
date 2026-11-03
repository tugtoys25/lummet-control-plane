-- =====================================================
-- 0080 — SEO SEED: COMMISSION-BASED PARTNER VERTICALS
--
-- Extends 0079 with three verticals:
--   * casino and iGaming affiliate sites
--   * casino-hotel and travel affiliate / referral sites
--   * property listing and lead-generation sites
--
-- Adds: 3 landing pages (/p/<slug>), 3 Insights articles,
-- 6 FAQs (group 'affiliate'), 1 feature group + 1 homepage
-- section, and footer navigation links.
--
-- Data only: no schema changes, no site_settings changes.
-- All rows use INSERT OR IGNORE, so re-running never
-- overwrites rows an admin has since edited.
-- Wording: Lummet is the website platform. It does not
-- provide brokerage, agent, travel, gambling or real estate
-- services. Customers are responsible for the licences and
-- local rules that apply to their own activity.
-- =====================================================

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO lummet_features (feature_key, group_key, icon, title, body, link_label, link_href, status, sort_order) VALUES
  ('vert-casino', 'affiliate_verticals', 'layers', 'Casino and iGaming affiliates', 'Review, comparison and country pages for casino and betting affiliate sites, with disclosure and responsible gambling pages built in.', 'Casino affiliate sites', '/p/casino-affiliate-website-platform', 'published', 10),
  ('vert-travel', 'affiliate_verticals', 'map-pin', 'Casino-hotel and travel affiliates', 'Destination, hotel and package pages for sites that earn commission when readers book through partner links.', 'Hotel and travel sites', '/p/casino-hotel-affiliate-website', 'published', 20),
  ('vert-property', 'affiliate_verticals', 'search', 'Property listing sites', 'Listing, location and guide pages for sites that send enquiries to owners, developers and licensed agents.', 'Property listing sites', '/p/property-listing-lead-generation-website', 'published', 30);

INSERT OR IGNORE INTO lummet_homepage_sections (section_key, kind, feature_group, background, title, subtitle, body, cta_label, cta_href, layout, status, sort_order) VALUES
  ('affiliate-verticals', 'features', 'affiliate_verticals', 'soft', 'One Platform for Commission-Based Partner Sites', 'Verticals',
   '<p>Affiliates, referral partners and listing sites all earn an agreed commission when a visitor buys from a partner. Lummet provides the website platform for each of them.</p>',
   NULL, NULL, 'text_only', 'published', 36);

INSERT OR IGNORE INTO lummet_faqs (group_key, question, answer, status, sort_order) VALUES
  ('affiliate', 'Can Lummet be used for casino affiliate websites?',
   'Yes. Casino and iGaming affiliate sites are a core use of the platform: reviews, comparisons, country pages and FAQs, with each site on its own domain. You remain responsible for the gambling advertising and affiliate rules that apply in the countries you target.', 'published', 130),
  ('affiliate', 'Can I build a casino-hotel or travel affiliate website?',
   'Yes. You can publish destination, hotel and package guides and link to partner booking pages. If the customer books and pays on the partner site, you are acting as an affiliate. Taking bookings or payments yourself can require travel agent registration in some countries.', 'published', 140),
  ('affiliate', 'Can I build a property listing website with Lummet?',
   'Yes. Listing, location and guide pages work well for sites that send enquiries to owners, developers or licensed agents. Some countries regulate fees paid for property referrals, so check the rules where you operate.', 'published', 150),
  ('affiliate', 'Does Lummet make me a licensed broker or agent?',
   'No. Lummet is a website platform. It does not grant licences or provide brokerage, agent, travel, gambling or real estate services. Customers are responsible for the licences and registrations their own activity requires.', 'published', 160),
  ('affiliate', 'What is the difference between an affiliate and a broker or agent?',
   'An affiliate publishes content and links to a partner, and the customer buys from the partner, who pays an agreed commission. A broker or agent usually negotiates, takes bookings or payments, or advises on a specific deal, and that activity is often regulated.', 'published', 170),
  ('affiliate', 'Do I need a licence to run an affiliate website?',
   'Often not, but it depends on your industry and the countries you target. Gambling, financial and property promotion rules vary widely, so confirm the requirements locally before you launch.', 'published', 180);

INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('footer_platform', 'Casino Affiliate Websites', '/p/casino-affiliate-website-platform', 'page:casino-affiliate-website-platform', 'published', 100),
  ('footer_platform', 'Hotel and Travel Affiliates', '/p/casino-hotel-affiliate-website', 'page:casino-hotel-affiliate-website', 'published', 110),
  ('footer_platform', 'Property Listing Websites', '/p/property-listing-lead-generation-website', 'page:property-listing-lead-generation-website', 'published', 120);

INSERT OR IGNORE INTO lummet_pages (slug, title, excerpt, content, status, seo_title, seo_description, author_id) VALUES
  ('casino-affiliate-website-platform', 'Casino Affiliate Website Platform',
   'A configured website platform for casino and iGaming affiliates: reviews, comparisons, country pages and disclosure.',
   '<h2>A casino affiliate website platform, already configured</h2>
<p>A casino affiliate site needs more than a blog. It needs structured reviews, comparison tables, country-specific pages, author profiles and clear disclosure. Lummet provides these on a configured foundation, so you can start with your market and your content.</p>
<h2>What you can publish</h2>
<ul>
<li>Operator reviews and side-by-side comparisons.</li>
<li>Country and region pages for different audiences.</li>
<li>Guides, news and FAQs with structured data for search.</li>
<li>Responsible gambling and affiliate disclosure pages.</li>
</ul>
<h2>Built on the same platform</h2>
<p>Every site gets <a href="/p/affiliate-website-builder">the affiliate website builder</a>, its own domain, and <a href="/p/ai-content-for-affiliate-sites">AI content tools</a> with a preview before anything is saved. Run more than one brand from a <a href="/p/multi-site-website-platform">multi-site platform</a>.</p>
<h2>Rules you remain responsible for</h2>
<p>Gambling advertising and affiliate rules differ by country, and some countries require affiliates to register. Lummet is the website platform and does not provide gambling services or legal advice. Check the requirements for each market you target.</p>
<p>New to this? Start with <a href="/p/start-affiliate-business">how to start an affiliate business</a>, or <a href="/demo">request a demo</a>.</p>',
   'published', 'Casino Affiliate Website Platform | Lummet',
   'Build a casino or iGaming affiliate website on a configured platform: reviews, comparisons, country pages, SEO and AI content tools.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('casino-hotel-affiliate-website', 'Casino-Hotel and Travel Affiliate Website',
   'Build a hotel, resort and travel affiliate website that earns commission when readers book through partner links.',
   '<h2>A casino-hotel and travel affiliate website</h2>
<p>Travel affiliates earn an agreed commission when a reader books with a partner. Lummet gives you the website for that: destination pages, hotel and resort reviews, package guides and comparison pages, all with SEO controls.</p>
<h2>What you can publish</h2>
<ul>
<li>Destination and resort guides, including casino-hotel stays.</li>
<li>Hotel reviews and price-range comparisons.</li>
<li>Seasonal and event guides.</li>
<li>Clear links to partner booking pages, with affiliate disclosure.</li>
</ul>
<h2>Affiliate or agent?</h2>
<p>If the reader books and pays on the partner site, you are acting as an affiliate. If you take bookings or payments yourself, or sell packages, travel agent registration or package travel rules may apply in your country. Lummet is the website platform and does not provide travel or agent services.</p>
<p>See the <a href="/p/start-affiliate-business">start an affiliate business</a> guide, the <a href="/p/casino-affiliate-website-platform">casino affiliate platform</a>, or <a href="/demo">request a demo</a>.</p>',
   'published', 'Casino-Hotel and Travel Affiliate Website | Lummet',
   'Build a hotel, resort and travel affiliate website with destination pages, reviews and comparisons on a configured SEO-ready platform.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team')),

  ('property-listing-lead-generation-website', 'Property Listing and Lead Generation Website',
   'A website platform for property listing and referral sites that send enquiries to owners, developers and licensed agents.',
   '<h2>A property listing website, already configured</h2>
<p>Property sites rank by being useful: clear listings, location guides and honest comparisons. Lummet provides the structure for listing pages, area guides, categories and enquiry links, with SEO controls on every page.</p>
<h2>What you can publish</h2>
<ul>
<li>Listing pages for hotels, apartments, villas and commercial property.</li>
<li>Location and neighbourhood guides.</li>
<li>Buying guides and comparison pages.</li>
<li>Enquiry links that send visitors to the owner, developer or licensed agent.</li>
</ul>
<h2>Lead generation or brokerage?</h2>
<p>A site that publishes listings and refers enquiries is usually lead generation. Negotiating between buyer and seller, advising on offers, or handling deposits is brokerage and generally needs a licence. Some countries also restrict fees paid for property referrals. Lummet is the website platform and does not provide real estate services.</p>
<p>Read how to <a href="/p/start-affiliate-business">start a commission-based business</a>, see the <a href="/p/multi-site-website-platform">multi-site platform</a>, or <a href="/demo">request a demo</a>.</p>',
   'published', 'Property Listing and Lead Generation Website | Lummet',
   'Build a property listing or referral website on a configured platform with listing pages, location guides and SEO controls.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'));

INSERT OR IGNORE INTO lummet_publications (slug, title, excerpt, content, publication_type, author_id, status, published_at) VALUES
  ('affiliate-vs-broker-vs-agent', 'Affiliate, Broker or Agent: What Is the Difference?',
   'Three ways to earn commission online, and where licensing questions usually start.',
   '<p>All three earn an agreed commission when a customer buys. What differs is what you do before the sale.</p>
<h2>Affiliate</h2>
<p>You publish content and link to a partner. The customer buys from the partner, who pays you. This is the simplest model.</p>
<h2>Referral partner or lead generator</h2>
<p>You send enquiries to a business, often for a fixed fee. Some industries restrict referral fees, so check locally.</p>
<h2>Broker or agent</h2>
<p>You negotiate, take bookings or payments, or advise on a specific deal. This is often regulated and may need a licence.</p>
<p>A quick test: do you only send traffic, or do you handle the transaction? See the <a href="/p/start-affiliate-business">affiliate business guide</a>. Lummet is a website platform and does not provide licensed services.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-03 09:00:00'),

  ('how-to-start-a-casino-affiliate-website', 'How to Start a Casino Affiliate Website',
   'A practical order of work for launching a casino or iGaming affiliate site.',
   '<p>A casino affiliate site earns when readers trust your reviews. This is the order of work.</p>
<h2>1. Choose your market</h2>
<p>Pick the countries and audience you will serve, and check the advertising and affiliate rules there before you publish.</p>
<h2>2. Plan your content</h2>
<p>Start with reviews, comparisons and guides that answer real questions, plus responsible gambling and disclosure pages.</p>
<h2>3. Apply to programs</h2>
<p>Apply to programs that fit the content you have published.</p>
<p>See the <a href="/p/casino-affiliate-website-platform">casino affiliate website platform</a> or <a href="/demo">request a demo</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-03 10:00:00'),

  ('how-to-start-a-property-listing-website', 'How to Start a Property Listing Website',
   'From choosing a location to publishing listings and sending enquiries to the right people.',
   '<p>A property listing site works when visitors find clear, useful information and an easy way to enquire.</p>
<h2>1. Pick a focus</h2>
<p>Choose a location, property type or buyer group, such as holiday villas or hotel investments.</p>
<h2>2. Publish listings and guides</h2>
<p>Combine listing pages with area guides and comparisons that help buyers decide.</p>
<h2>3. Route enquiries correctly</h2>
<p>Send enquiries to the owner, developer or licensed agent, and check whether referral fees are allowed in your country.</p>
<p>See the <a href="/p/property-listing-lead-generation-website">property listing website platform</a> or <a href="/demo">request a demo</a>.</p>',
   'blog', (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'), 'published', '2026-11-03 11:00:00');
