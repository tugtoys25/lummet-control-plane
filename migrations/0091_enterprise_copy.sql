-- =====================================================
-- 0091 — PUBLIC SITE: enterprise-grade copy pass
--
-- Safe to re-run, and never overwrites an admin edit:
--   * every UPDATE only touches a row whose value is STILL the exact text seeded by 0034/0035/0073/0079/0083,
--   * every INSERT is INSERT OR IGNORE against its natural key.
-- No schema change, no site_settings key added, no number, customer name, uptime figure, certification or SLA is claimed.
--
-- Style rules applied: sentence case for headings, one verb pattern for calls to action, benefits before architecture terms,
-- one audience per section (affiliate publishers first, agencies and multi-brand teams in their own section).
--
-- Note: the live hero was edited in the dashboard after 0079, so the hero UPDATEs below match nothing there (by design).
-- Paste the hero text from the copy notes into Lummet Site > Settings instead.
--
-- Claims in the new security section are limited to what the code does today. One is held back as a draft because its
-- platform switch defaults to off (ORG_IP_ALLOWLIST), and one FAQ is a draft because publishing it is an owner decision.
-- =====================================================

-- ---------------------------------------------------------
-- HERO / SEO (no-op where an admin already changed the text)
-- ---------------------------------------------------------
UPDATE lummet_site_settings SET value = 'Affiliate website builder'
 WHERE key = 'hero_eyebrow' AND value = 'Affiliate Website Builder Platform';
UPDATE lummet_site_settings SET value = 'Build and run affiliate websites from one dashboard'
 WHERE key = 'hero_title' AND value = 'Start Your Affiliate Business Today. The Architecture Is Already Built.';
UPDATE lummet_site_settings SET value = 'SEO-ready sites, AI writing tools and custom domains, already set up. Launch in days, not months, and add more sites without rebuilding anything.'
 WHERE key = 'hero_subtitle' AND value = 'Lummet gives you a fully configured foundation for affiliate websites: SEO-ready content management, AI writing tools, custom domains and multi-site control from one dashboard.';
UPDATE lummet_site_settings SET value = 'Lummet | Affiliate website builder and multi-site platform'
 WHERE key = 'site_title' AND value = 'Start an Affiliate Business | Lummet Website Builder';
UPDATE lummet_site_settings SET value = 'Build, launch and manage affiliate websites from one dashboard. SEO-ready templates, AI content tools, custom domains and separate databases for every site.'
 WHERE key = 'site_description' AND value = 'Start your affiliate business today on a fully configured platform: website builder, SEO tools, AI content and multi-site control in one place.';

-- OPTIONAL, owner decision (0090 chose "Start for free" on purpose). Uncomment to make every paid-plan call to action read the same:
-- UPDATE lummet_site_settings SET value = 'Start free trial' WHERE key = 'hero_cta_primary_label' AND value = 'Start for free';
-- UPDATE OR IGNORE lummet_nav_links SET label = 'Start free trial' WHERE placement = 'header_cta' AND label = 'Start for free' AND href = '/pricing';

-- ---------------------------------------------------------
-- HEADINGS: sentence case, plain benefit wording
-- ---------------------------------------------------------
UPDATE lummet_homepage_sections SET title = 'Everything you need to run many sites'
 WHERE section_key = 'capabilities' AND title = 'Built for Scale. Designed for Control.';
UPDATE lummet_homepage_sections SET title = 'One platform. Every brand keeps its own identity.',
                                    subtitle = 'For agencies and multi-brand teams'
 WHERE section_key = 'why' AND title = 'Built Once. Configured for Every Brand.' AND subtitle = 'Why Lummet';
UPDATE lummet_homepage_sections SET title = 'Launch an affiliate website in four steps'
 WHERE section_key = 'affiliate-launch' AND title = 'Launch an Affiliate Website in Four Steps';
UPDATE lummet_homepage_sections SET title = 'The website builder for affiliate publishers'
 WHERE section_key = 'affiliate-features' AND title = 'The Website Builder Built for Affiliate Publishers';
UPDATE lummet_homepage_sections SET title = 'Know how you get paid'
 WHERE section_key = 'affiliate-commission-models' AND title = 'Know How You Get Paid';
UPDATE lummet_homepage_sections SET title = 'One platform for commission-based partner sites'
 WHERE section_key = 'affiliate-verticals' AND title = 'One Platform for Commission-Based Partner Sites';

-- ---------------------------------------------------------
-- SMALL WORDS: "anytime", and a link label that says what it opens
-- ---------------------------------------------------------
UPDATE lummet_ui_strings SET value = 'Cancel anytime' WHERE ui_key IN ('pricing_assure_2', 'hero_note_cancel') AND value = 'Cancel any time';
UPDATE lummet_ui_strings SET value = 'Read the update' WHERE ui_key = 'read_update' AND value = 'Read update';

-- ---------------------------------------------------------
-- NEW SECTION: security and control, built in (sort 46, after the niches band)
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_features (feature_key, group_key, icon, title, body, link_label, link_href, status, sort_order) VALUES
  ('sec-2fa', 'security_builtin', 'key', 'Passkeys and two-step sign-in',
   'Sign in with a passkey or an authenticator app, and require two-step verification for everyone in your organization.', NULL, NULL, 'published', 10),
  ('sec-oidc', 'security_builtin', 'users', 'Single sign-on with OpenID Connect',
   'Let your team sign in with your own identity provider. SAML and SCIM are not available yet.', NULL, NULL, 'published', 20),
  ('sec-roles', 'security_builtin', 'eye', 'Roles per site',
   'Give each team member access to the sites they work on and nothing else.', NULL, NULL, 'published', 30),
  ('sec-audit', 'security_builtin', 'activity', 'Audit log',
   'Sign-ins, role changes and administrative actions are recorded, and your organization can export its log as CSV.', NULL, NULL, 'published', 40),
  ('sec-encryption', 'security_builtin', 'lock', 'Encrypted credentials',
   'Stored secrets are encrypted with AES-GCM using a key kept outside the database, with a documented key-rotation procedure.', NULL, NULL, 'published', 50),
  ('sec-backups', 'security_builtin', 'database', 'Backups and restore runbooks',
   'Scheduled backups, with written procedures for restoring from them and for handling incidents.', NULL, NULL, 'published', 60),
  -- Draft: the platform switch ORG_IP_ALLOWLIST defaults to off. Publish it once the switch is on in production.
  ('sec-ip-allowlist', 'security_builtin', 'shield', 'IP allowlists',
   'Limit access to your organization to the office and VPN addresses you approve.', NULL, NULL, 'draft', 70);

INSERT OR IGNORE INTO lummet_homepage_sections (section_key, kind, feature_group, background, title, subtitle, body, cta_label, cta_href, layout, status, sort_order) VALUES
  ('security-built-in', 'features', 'security_builtin', 'soft', 'Security and control, built in', 'For teams and clients with IT reviews',
   '<p>The controls a security reviewer asks about are part of the platform. This describes how the software works today. It is not a certification or an audit report.</p>',
   'Read about security', '/security', 'text_only', 'published', 46);

-- ---------------------------------------------------------
-- NEW SECTION: agencies and large portfolios (sort 47). No price: enterprise is sold by conversation.
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_features (feature_key, group_key, icon, title, body, link_label, link_href, status, sort_order) VALUES
  ('ent-scale', 'enterprise_tier', 'layers', 'Hundreds of sites, one dashboard',
   'Run large portfolios with a separate database and domain for every site.', NULL, NULL, 'published', 10),
  ('ent-dedicated', 'enterprise_tier', 'cpu', 'Dedicated infrastructure',
   'Isolate your sites on infrastructure that is not shared with other customers.', NULL, NULL, 'published', 20),
  ('ent-governance', 'enterprise_tier', 'check', 'White label and approvals',
   'Present sites under your own brand, and route changes through approval workflows before they go live.', NULL, NULL, 'published', 30),
  ('ent-api', 'enterprise_tier', 'plug', 'API access and automation',
   'Connect Lummet to your own tools, with a large monthly allowance of AI credits for content work.', NULL, NULL, 'published', 40);

INSERT OR IGNORE INTO lummet_homepage_sections (section_key, kind, feature_group, background, title, subtitle, body, cta_label, cta_href, layout, status, sort_order) VALUES
  ('enterprise-teams', 'features', 'enterprise_tier', 'default', 'For agencies and large portfolios', 'Enterprise',
   '<p>Manage many brands with the controls your clients expect. Talk to us about volume, onboarding and support.</p>',
   'Talk to sales', '/demo', 'text_only', 'published', 47);

-- ---------------------------------------------------------
-- FAQ: security (group "security")
-- ---------------------------------------------------------
INSERT OR IGNORE INTO lummet_faqs (group_key, question, answer, status, sort_order) VALUES
  ('security', 'Can we sign in with our own identity provider?',
   'Yes, through OpenID Connect. SAML and SCIM provisioning are not available yet.', 'published', 10),
  ('security', 'Can we require two-step verification for our whole team?',
   'Yes. An organization can require two-step verification, and a passkey or an authenticator app both count.', 'published', 20),
  ('security', 'Can team members be limited to certain sites?',
   'Yes. Access is granted per site, and administrative actions are written to an audit log that your organization can export.', 'published', 30),
  -- Draft: publishing this answer is an owner decision. The SOC 2 policy set is unapproved and no audit has taken place.
  ('security', 'Is Lummet SOC 2 certified?',
   'Not yet. Our security policies are written but have not been audited, so we do not claim a certification. Ask us for the current security documentation.', 'draft', 40);
