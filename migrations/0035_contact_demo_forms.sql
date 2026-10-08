-- =====================================================
-- 0008 — CONTACT + DEMO FORMS, INQUIRIES, UI TEXT
--
-- Adds the tables behind /contact and /demo (form copy, form fields,
-- stored submissions) and lummet_ui_strings, which holds the small
-- pieces of interface text (button labels, aria labels, empty-state
-- messages, form errors) that used to be written into templates.
--
-- Safe to re-run: tables use IF NOT EXISTS, every seed row is
-- INSERT OR IGNORE on a unique key, and the UPDATE statements only
-- change a row while it still holds the old seeded value, so an
-- admin edit is never overwritten.
-- =====================================================

CREATE TABLE IF NOT EXISTS lummet_ui_strings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ui_key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    group_key TEXT NOT NULL DEFAULT 'general',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lummet_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_key TEXT NOT NULL UNIQUE,
    eyebrow TEXT,
    title TEXT NOT NULL,
    intro TEXT,
    submit_label TEXT NOT NULL,
    success_title TEXT NOT NULL,
    success_message TEXT NOT NULL,
    side_title TEXT,
    side_body TEXT,
    seo_title TEXT,
    seo_description TEXT,
    og_image TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lummet_form_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_key TEXT NOT NULL,
    field_key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    required INTEGER NOT NULL DEFAULT 0,
    placeholder TEXT,
    help_text TEXT,
    options TEXT,
    max_length INTEGER NOT NULL DEFAULT 2000,
    status TEXT NOT NULL DEFAULT 'published',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (form_key, field_key)
);
CREATE INDEX IF NOT EXISTS idx_lummet_form_fields_form ON lummet_form_fields(form_key, status, sort_order);
CREATE TABLE IF NOT EXISTS lummet_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_key TEXT NOT NULL,
    name TEXT,
    email TEXT,
    summary TEXT,
    details TEXT,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    admin_notes TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lummet_inquiries_status ON lummet_inquiries(status, created_at);
CREATE INDEX IF NOT EXISTS idx_lummet_inquiries_ip ON lummet_inquiries(ip_hash, created_at);

INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('skip_to_content', 'Skip to content', 'layout'),
  ('nav_primary_label', 'Primary', 'layout'),
  ('nav_mobile_label', 'Mobile', 'layout'),
  ('menu_open', 'Open menu', 'layout'),
  ('menu_close', 'Close menu', 'layout'),
  ('theme_toggle', 'Switch color theme', 'layout'),
  ('rights', 'All rights reserved.', 'layout'),
  ('footer_platform_title', 'Platform', 'layout'),
  ('footer_company_title', 'Company', 'layout'),
  ('footer_legal_title', 'Legal', 'layout'),
  ('breadcrumb_label', 'Breadcrumb', 'layout'),
  ('crumb_home', 'Home', 'layout'),
  ('pagination_label', 'Pagination', 'layout'),
  ('prev', 'Previous', 'layout'),
  ('next', 'Next', 'layout'),
  ('page_word', 'page', 'layout'),
  ('title_brands', 'Brands', 'lists'),
  ('title_updates', 'Updates', 'lists'),
  ('title_insights', 'Insights', 'lists'),
  ('title_partners', 'Partners', 'lists'),
  ('filter_brands_label', 'Filter brands by category', 'lists'),
  ('filter_insights_label', 'Filter insights by type', 'lists'),
  ('filter_all', 'All', 'lists'),
  ('empty_brands', 'No brands are published yet.', 'lists'),
  ('empty_updates', 'No updates have been published yet.', 'lists'),
  ('empty_insights', 'Nothing has been published here yet.', 'lists'),
  ('empty_partners', 'No partners are listed yet.', 'lists'),
  ('partner_cta', 'Talk to us about partnering', 'lists'),
  ('view_profile', 'View profile', 'cards'),
  ('read_update', 'Read update', 'cards'),
  ('read_insight', 'Read', 'cards'),
  ('visit_site', 'Visit', 'cards'),
  ('min_read', 'min read', 'cards'),
  ('by', 'By', 'cards'),
  ('source_label', 'Source', 'cards'),
  ('type_blog', 'Article', 'cards'),
  ('type_press', 'In the press', 'cards'),
  ('type_report', 'Report', 'cards'),
  ('copy_link', 'Copy link', 'articles'),
  ('link_copied', 'Link copied', 'articles'),
  ('all_updates', 'All updates', 'articles'),
  ('all_insights', 'All insights', 'articles'),
  ('more_brands', 'More brands', 'articles'),
  ('more_updates', 'More updates', 'articles'),
  ('keep_reading', 'Keep reading', 'articles'),
  ('author_insights', 'Insights', 'articles'),
  ('author_updates', 'Updates', 'articles'),
  ('last_updated', 'Last updated', 'articles'),
  ('not_found_title', 'Page not found', 'errors'),
  ('not_found_text', 'That page does not exist or is no longer published.', 'errors'),
  ('back_home', 'Back to home', 'errors'),
  ('stat_brand_one', 'Brand on the platform', 'home'),
  ('stat_brand_many', 'Brands on the platform', 'home'),
  ('stat_update_one', 'Platform update published', 'home'),
  ('stat_update_many', 'Platform updates published', 'home'),
  ('stat_insight_one', 'Insight published', 'home'),
  ('stat_insight_many', 'Insights published', 'home'),
  ('stat_latest', 'Latest platform update', 'home'),
  ('graph_label_one', '{center} control plane connected to {count} brand: {names}', 'home'),
  ('graph_label_many', '{center} control plane connected to {count} brands: {names}', 'home'),
  ('form_required_note', 'Fields marked * are required.', 'forms'),
  ('form_required_mark', '*', 'forms'),
  ('form_errors_summary', 'Please correct the highlighted fields.', 'forms'),
  ('form_choose', 'Choose an option', 'forms'),
  ('err_required', 'This field is required.', 'forms'),
  ('err_email', 'Enter a valid email address.', 'forms'),
  ('err_url', 'Enter a valid web address starting with http:// or https://.', 'forms'),
  ('err_too_long', 'This is too long.', 'forms'),
  ('err_option', 'Choose one of the listed options.', 'forms'),
  ('err_rate', 'Too many submissions from your connection. Please try again later.', 'forms'),
  ('err_generic', 'Something went wrong and your message was not sent. Please try again.', 'forms'),
  ('err_too_large', 'That submission is too large.', 'forms'),
  ('form_unavailable', 'This form is not accepting submissions right now.', 'forms'),
  ('form_side_email', 'Or write to us directly:', 'forms'),
  ('form_sending', 'Sending...', 'forms');

INSERT OR IGNORE INTO lummet_forms (form_key, eyebrow, title, intro, submit_label, success_title, success_message, side_title, side_body, seo_title, seo_description, status) VALUES
  ('contact', 'Contact', 'Get in touch', '<p>Interested in Lummet, partnership opportunities, technology licensing or a platform demonstration? Send us a message and our team will follow up.</p>', 'Send message', 'Message sent', '<p>Thank you. Your message has been received and our team will follow up.</p>', NULL, NULL, 'Contact Lummet', 'Contact the Lummet team about the platform, partnerships or technology licensing.', 'published'),
  ('demo', 'Demo', 'Request a demo', '<p>Want to understand how Lummet can manage multiple digital properties from one centralized platform? Request a private demonstration.</p>', 'Request a demo', 'Request received', '<p>Thank you. Your request has been received and our team will follow up to arrange your demonstration.</p>', 'What a demonstration covers', '<ul><li>Connecting a brand to the control plane as a tenant.</li><li>Managing content and settings across connected brands from one place.</li><li>Staff accounts with per-brand, per-action permissions.</li><li>The AI assistant and its preview-before-write flow.</li></ul>', 'Request a Lummet demo', 'Request a private demonstration of the Lummet control plane for managing multiple digital brands.', 'published');

INSERT OR IGNORE INTO lummet_form_fields (form_key, field_key, label, type, required, placeholder, help_text, options, max_length, status, sort_order) VALUES
  ('contact', 'name', 'Your name', 'text', 1, NULL, NULL, NULL, 120, 'published', 10),
  ('contact', 'email', 'Email address', 'email', 1, NULL, NULL, NULL, 254, 'published', 20),
  ('contact', 'company', 'Company or brand', 'text', 0, NULL, NULL, NULL, 160, 'published', 30),
  ('contact', 'topic', 'What is this about?', 'select', 0, NULL, NULL, 'Platform question
Partnership opportunity
Technology licensing
Other', 80, 'published', 40),
  ('contact', 'message', 'Message', 'textarea', 1, NULL, NULL, NULL, 5000, 'published', 50),
  ('demo', 'name', 'Your name', 'text', 1, NULL, NULL, NULL, 120, 'published', 10),
  ('demo', 'email', 'Work email', 'email', 1, NULL, NULL, NULL, 254, 'published', 20),
  ('demo', 'company', 'Company or brand', 'text', 1, NULL, NULL, NULL, 160, 'published', 30),
  ('demo', 'role', 'Your role', 'text', 0, NULL, NULL, NULL, 120, 'published', 40),
  ('demo', 'properties', 'Number of digital properties you operate', 'select', 0, NULL, NULL, '1
2 to 5
6 to 10
More than 10', 40, 'published', 50),
  ('demo', 'message', 'What would you like to see?', 'textarea', 0, NULL, NULL, NULL, 3000, 'published', 60);

INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('header', 'Contact', '/contact', 'form:contact', 'published', 70),
  ('footer_company', 'Request a demo', '/demo', 'form:demo', 'published', 55);
UPDATE lummet_nav_links SET href = '/demo', visible_when = 'form:demo' WHERE placement = 'header_cta' AND label = 'Get a Demo' AND href = '/#demo';
UPDATE lummet_nav_links SET href = '/contact', visible_when = 'form:contact' WHERE placement = 'footer_company' AND label = 'Contact' AND href = '/#contact';
UPDATE lummet_site_settings SET value = '/demo' WHERE key = 'hero_cta_primary_href' AND value = '#demo';
UPDATE lummet_homepage_sections SET cta_href = '/demo' WHERE section_key = 'demo' AND cta_href = '#contact';
UPDATE lummet_homepage_sections SET cta_href = '/demo' WHERE section_key = 'ai' AND cta_href = '#demo';
UPDATE lummet_homepage_sections SET cta_label = 'Contact us', cta_href = '/contact' WHERE section_key = 'contact' AND cta_label IS NULL;
