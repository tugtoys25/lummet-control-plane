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
