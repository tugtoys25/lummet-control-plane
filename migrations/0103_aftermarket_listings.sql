-- 0103: businesses for sale, by category (the marketplace beyond domains)
--
--  * lummet_listing_categories  the categories (Websites, E-commerce, ...). Admin edits them in Site Forms -> Listing categories.
--  * lummet_listings            one row per business for sale. Admin adds rows, or a seller creates one in the portal (Aftermarket tab);
--                               a seller's listing starts as 'pending' and goes public when an admin sets it to 'listed'.
--  * listing-enquiry form       the SAME enquiry mechanism as domains (forms.js): same protection, same tracking. The enquiry is stored with
--                               subject_ref = 'listing:<slug>' so the inbox and the seller's dashboard show who asked about which listing.
--  * interface text             every label the new pages use.

CREATE TABLE IF NOT EXISTS lummet_listing_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'published',            -- published | draft
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS lummet_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE COLLATE NOCASE,
    kind TEXT NOT NULL DEFAULT 'business',               -- business (domains stay in lummet_aftermarket_domains)
    category_slug TEXT,
    title TEXT NOT NULL,
    summary TEXT,                                        -- one or two sentences, shown in lists
    description TEXT,
    location TEXT,
    asking_price TEXT,                                   -- free text: "120000 USD", "Make an offer"
    revenue TEXT,                                        -- free text: "40000 USD / year"
    profit TEXT,
    status TEXT NOT NULL DEFAULT 'draft',                -- draft | pending | listed | unlisted | sold  (only "listed" is public)
    source TEXT NOT NULL DEFAULT 'admin',                -- admin | seller
    organization_id TEXT,                                -- seller only
    owner_user_id TEXT,
    owner_email TEXT,                                    -- seller only; never shown publicly
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lummet_listings_status ON lummet_listings(status, category_slug, sort_order);
CREATE INDEX IF NOT EXISTS idx_lummet_listings_org ON lummet_listings(organization_id, status);

INSERT OR IGNORE INTO lummet_listing_categories (slug, name, description, sort_order) VALUES
  ('websites', 'Websites', 'Content sites, blogs and niche sites with traffic.', 10),
  ('ecommerce', 'E-commerce', 'Online shops and stores that already sell.', 20),
  ('saas-apps', 'SaaS and apps', 'Software products and mobile or web apps.', 30),
  ('local-business', 'Local businesses', 'Shops, studios and service businesses with a physical presence.', 40),
  ('other', 'Other', 'Anything else that is for sale.', 90);

-- ------------------------------------------------------------------ enquiry form
INSERT OR IGNORE INTO lummet_forms
  (form_key, eyebrow, title, intro, submit_label, success_title, success_message, seo_title, seo_description, status)
VALUES
  ('listing-enquiry', 'Marketplace', 'Enquire about a listing',
   '<p>Tell us your interest and we will reply by email.</p>',
   'Send enquiry', 'Enquiry received', '<p>Thank you. We have received your enquiry and will reply by email.</p>',
   'Enquire about a listing | Lummet', 'Send an enquiry about a business for sale.', 'published');

INSERT OR IGNORE INTO lummet_form_fields
  (form_key, field_key, label, type, required, placeholder, help_text, options, max_length, status, sort_order)
VALUES
  ('listing-enquiry', 'name', 'Your name', 'text', 1, NULL, NULL, NULL, 120, 'published', 10),
  ('listing-enquiry', 'email', 'Email address', 'email', 1, NULL, NULL, NULL, 254, 'published', 20),
  ('listing-enquiry', 'offer', 'Your offer (USD)', 'text', 0, 'e.g. 50000', 'Optional.', NULL, 40, 'published', 50),
  ('listing-enquiry', 'message', 'Anything else we should know?', 'textarea', 1, NULL, 'Who you are and what you want to know about this business.', NULL, 3000, 'published', 60);

-- ----------------------------------------------------------------- footer links
INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('footer_company', 'Businesses for sale', '/aftermarket/businesses', 'always', 'published', 64);

-- -------------------------------------------------------------- interface text
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('listings_hub_title', 'Marketplace', 'listings'),
  ('listings_hub_intro', 'Domains and businesses for sale. Send an enquiry and we will reply by email.', 'listings'),
  ('listings_hub_domains', 'Domain names', 'listings'),
  ('listings_hub_domains_blurb', 'Browse the domain names for sale.', 'listings'),
  ('listings_hub_count', '{count} listed', 'listings'),
  ('listings_crumb', 'Businesses for sale', 'listings'),
  ('listings_title', 'Businesses for sale', 'listings'),
  ('listings_intro', 'Websites, shops, apps and local businesses for sale. Open a listing to send an enquiry.', 'listings'),
  ('listings_category_title', '{category} for sale', 'listings'),
  ('listings_all_categories', 'All categories', 'listings'),
  ('listings_empty', 'Nothing is listed here right now.', 'listings'),
  ('listings_col_listing', 'Listing', 'listings'),
  ('listings_col_category', 'Category', 'listings'),
  ('listings_col_location', 'Location', 'listings'),
  ('listings_col_revenue', 'Revenue', 'listings'),
  ('listings_col_price', 'Asking price', 'listings'),
  ('listings_col_actions', 'Actions', 'listings'),
  ('listings_view', 'View and enquire', 'listings'),
  ('listings_sell_cta', 'List your business', 'listings'),
  ('listing_all', 'All businesses for sale', 'listings'),
  ('listing_fact_category', 'Category', 'listings'),
  ('listing_fact_location', 'Location', 'listings'),
  ('listing_fact_revenue', 'Revenue', 'listings'),
  ('listing_fact_profit', 'Profit', 'listings');
