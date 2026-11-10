-- 0100: domain aftermarket (domains for sale, enquiry tracking, seller self-listing)
--
--  * lummet_aftermarket_domains  the domains for sale. Admin adds rows (Site Forms -> Domains for sale) or a seller proves
--                                control at /aftermarket/sell-your-domain (nameservers or TXT record) and the row goes live.
--  * lummet_inquiries            two new columns: subject_ref (the domain the visitor asked about) and source
--                                (redirect | host | landing | list) so the inbox shows who wants which domain, and from where.
--  * forms                       domain-acquisition (buy enquiry) and sell-domain (seller claim). INSERT OR IGNORE, so a
--                                domain-acquisition form you already created by hand is kept as it is; only the missing
--                                "domain_other" field is added to it.
--  * interface text             every label the new pages use (nothing is written into the templates).

ALTER TABLE lummet_inquiries ADD COLUMN subject_ref TEXT;
ALTER TABLE lummet_inquiries ADD COLUMN source TEXT;
CREATE INDEX IF NOT EXISTS idx_lummet_inquiries_subject ON lummet_inquiries(subject_ref, created_at);

CREATE TABLE IF NOT EXISTS lummet_aftermarket_domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL UNIQUE COLLATE NOCASE,          -- bare host name, no scheme, no www
    status TEXT NOT NULL DEFAULT 'draft',                -- draft | pending | listed | unlisted | sold  (only "listed" is public)
    headline TEXT,
    description TEXT,
    asking_price TEXT,                                   -- free text: "2500 USD", "Make an offer"
    buy_url TEXT,                                        -- marketplace page (Afternic, Dan, Sedo...) for the Buy now button
    hosted INTEGER NOT NULL DEFAULT 0,                   -- 1 = the domain's own address (https://domain/) shows its for-sale page
    source TEXT NOT NULL DEFAULT 'admin',                -- admin | seller
    owner_email TEXT,                                    -- seller only; never shown publicly
    verify_token TEXT,                                   -- seller only: value for the _lummet-verify TXT record
    verified_method TEXT,                                -- ns | txt
    verified_at TEXT,
    last_check_at TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lummet_aftermarket_status ON lummet_aftermarket_domains(status, sort_order);

-- ------------------------------------------------------------------ buy form
INSERT OR IGNORE INTO lummet_forms
  (form_key, eyebrow, title, intro, submit_label, success_title, success_message, seo_title, seo_description, status)
VALUES
  ('domain-acquisition', 'Domains', 'Buy a domain name',
   '<p>Interested in acquiring a domain? Tell us which one and your offer. We will reply with availability and next steps.</p>',
   'Send enquiry', 'Enquiry received', '<p>Thank you. We have received your enquiry and will reply by email.</p>',
   'Buy a domain name | Lummet', 'Make an offer to acquire a domain name.', 'published');

INSERT OR IGNORE INTO lummet_form_fields
  (form_key, field_key, label, type, required, placeholder, help_text, options, max_length, status, sort_order)
VALUES
  ('domain-acquisition', 'name', 'Your name', 'text', 1, NULL, NULL, NULL, 120, 'published', 10),
  ('domain-acquisition', 'email', 'Email address', 'email', 1, NULL, NULL, NULL, 254, 'published', 20),
  ('domain-acquisition', 'domain', 'Chosen domain', 'select', 1, NULL, 'The list is built from the domains for sale. Pick Other to name a different domain.', NULL, 253, 'published', 30),
  ('domain-acquisition', 'domain_other', 'Other domain', 'text', 0, 'example.com', 'Only needed when you picked Other above.', NULL, 253, 'published', 35),
  ('domain-acquisition', 'offer', 'Your offer (USD)', 'text', 1, 'e.g. 500', NULL, NULL, 40, 'published', 50),
  ('domain-acquisition', 'message', 'Anything else we should know?', 'textarea', 0, NULL, NULL, NULL, 3000, 'published', 60);

-- A domain-acquisition form that already existed keeps its own fields; make sure it has the field that goes with "Other".
INSERT OR IGNORE INTO lummet_form_fields
  (form_key, field_key, label, type, required, placeholder, help_text, options, max_length, status, sort_order)
VALUES
  ('domain-acquisition', 'domain_other', 'Other domain', 'text', 0, 'example.com', 'Only needed when you picked Other above.', NULL, 253, 'published', 35);

-- --------------------------------------------------------------- seller form
INSERT OR IGNORE INTO lummet_forms
  (form_key, eyebrow, title, intro, submit_label, success_title, success_message, seo_title, seo_description, status)
VALUES
  ('sell-domain', 'Domains', 'Sell your domain',
   '<p>List a domain you own. Enter it below, then prove you control it with a nameserver change or a TXT record. Once it is verified, its for-sale page is created automatically and buyer enquiries come to us.</p>',
   'Continue to verification', 'Submission received', '<p>Thank you. We have received your submission.</p>',
   'Sell your domain | Lummet', 'List your domain for sale and verify ownership.', 'published');

INSERT OR IGNORE INTO lummet_form_fields
  (form_key, field_key, label, type, required, placeholder, help_text, options, max_length, status, sort_order)
VALUES
  ('sell-domain', 'name', 'Your name', 'text', 1, NULL, NULL, NULL, 120, 'published', 10),
  ('sell-domain', 'email', 'Email address', 'email', 1, NULL, 'Kept private. We use it to contact you about offers.', NULL, 254, 'published', 20),
  ('sell-domain', 'domain', 'Domain you own', 'text', 1, 'example.com', NULL, NULL, 253, 'published', 30),
  ('sell-domain', 'asking_price', 'Asking price (USD)', 'text', 1, 'e.g. 2500', 'Enter "Make an offer" if you have no fixed price.', NULL, 60, 'published', 40),
  ('sell-domain', 'message', 'About the domain', 'textarea', 0, NULL, 'Optional. Shown on the for-sale page.', NULL, 1500, 'published', 50);

-- ----------------------------------------------------------------- footer links
INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('footer_company', 'Domains for sale', '/aftermarket/list-of-domains', 'always', 'published', 62),
  ('footer_company', 'Sell your domain', '/aftermarket/sell-your-domain', 'form:sell-domain', 'published', 63);

-- -------------------------------------------------------------- interface text
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('aftermarket_crumb', 'Domains for sale', 'aftermarket'),
  ('aftermarket_for_sale_title', '{domain} is for sale', 'aftermarket'),
  ('aftermarket_for_sale_intro', 'Interested in {domain}? Send your enquiry below and we will reply by email with availability and next steps.', 'aftermarket'),
  ('aftermarket_other_option', 'Other (write it below)', 'aftermarket'),
  ('aftermarket_price_label', 'Asking price', 'aftermarket'),
  ('aftermarket_price_on_request', 'Make an offer', 'aftermarket'),
  ('aftermarket_buy_now', 'Buy now', 'aftermarket'),
  ('aftermarket_buy_note', 'Buy it straight from the marketplace, or send an enquiry below.', 'aftermarket'),
  ('aftermarket_all_domains', 'All domains for sale', 'aftermarket'),
  ('aftermarket_list_title', 'Domains for sale', 'aftermarket'),
  ('aftermarket_list_intro', 'Buy a listed domain from the marketplace, or send us an enquiry and we will reply by email.', 'aftermarket'),
  ('aftermarket_list_empty', 'No domains are listed for sale right now.', 'aftermarket'),
  ('aftermarket_list_domain', 'Domain', 'aftermarket'),
  ('aftermarket_list_price', 'Price', 'aftermarket'),
  ('aftermarket_list_actions', 'Actions', 'aftermarket'),
  ('aftermarket_view', 'View and enquire', 'aftermarket'),
  ('aftermarket_sell_cta', 'Sell your domain', 'aftermarket'),
  ('aftermarket_sell_crumb', 'Sell your domain', 'aftermarket'),
  ('aftermarket_verify_title', 'Verify {domain}', 'aftermarket'),
  ('aftermarket_verify_intro', 'Prove you control {domain} with either option below. As soon as one passes, the for-sale page is created and the domain is listed.', 'aftermarket'),
  ('aftermarket_ns_title', 'Option 1: change the nameservers', 'aftermarket'),
  ('aftermarket_ns_body', 'At your registrar, set the nameservers of {domain} to the ones below. The for-sale page is then also shown at the domain itself.', 'aftermarket'),
  ('aftermarket_ns_unavailable', 'Nameserver verification is not available right now. Use the TXT record option.', 'aftermarket'),
  ('aftermarket_ns_button', 'Verify nameservers', 'aftermarket'),
  ('aftermarket_txt_title', 'Option 2: add a TXT record', 'aftermarket'),
  ('aftermarket_txt_body', 'Add this record at your DNS provider. Your nameservers stay as they are, and the domain is listed on this site.', 'aftermarket'),
  ('aftermarket_txt_button', 'Verify TXT record', 'aftermarket'),
  ('aftermarket_record_type', 'Type', 'aftermarket'),
  ('aftermarket_record_name', 'Name', 'aftermarket'),
  ('aftermarket_record_value', 'Value', 'aftermarket'),
  ('aftermarket_not_verified_ns', 'We could not see the nameservers on {domain} yet. DNS changes can take a while: try again in a few minutes.', 'aftermarket'),
  ('aftermarket_not_verified_txt', 'We could not find the TXT record for {domain} yet. DNS changes can take a while: try again in a few minutes.', 'aftermarket'),
  ('aftermarket_throttled', 'Please wait a few seconds before checking again.', 'aftermarket'),
  ('aftermarket_listed_notice', '{domain} is verified and listed.', 'aftermarket'),
  ('aftermarket_view_listing', 'View the for-sale page', 'aftermarket'),
  ('aftermarket_err_domain', 'Enter a valid domain name such as example.com.', 'aftermarket'),
  ('aftermarket_err_taken', 'This domain is already listed or reserved. Contact us if it is yours.', 'aftermarket'),
  ('aftermarket_err_other', 'Write the domain you want.', 'aftermarket');
