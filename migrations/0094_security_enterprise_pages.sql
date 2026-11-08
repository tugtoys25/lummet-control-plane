-- =====================================================
-- 0094 — PUBLIC SITE: Security overview page, Enterprise page, and two corrections to 0091 (after 0093)
--
-- Safe to re-run, and never overwrites an admin edit:
--   * the Security page and the two card corrections only change a row whose value is STILL the exact text from 0034/0091,
--   * the Enterprise page and its footer link are INSERT OR IGNORE against their natural keys.
--
-- Corrections, because the code does not support the wording published by 0091:
--   * "route changes through approval workflows before they go live": worker/change-requests.js applies approvals to deleting a
--     site only, not to content changes.
--   * "Scheduled backups": the platform database is exported about once a day (docs/CONTROL_PLANE_BACKUP.md); scheduled site
--     backups are not confirmed.
--
-- Deliberately NOT claimed anywhere below: SOC 2 or any certification, uptime or SLA figures, SAML/SCIM, dedicated infrastructure,
-- an enforced Content Security Policy (CSP_MODE defaults to report-only), Cloudflare Access (off), HSTS preload (off), log shipping.
-- =====================================================

UPDATE lummet_features SET body = 'Present sites under your own brand, and require approval before a site is deleted.'
 WHERE feature_key = 'ent-governance' AND body = 'Present sites under your own brand, and route changes through approval workflows before they go live.';
UPDATE lummet_features SET title = 'Backups and restore runbooks',
  body = 'The platform database is exported daily and encrypted, plans with backups can back up site content, and written procedures cover restores and incidents.'
 WHERE feature_key = 'sec-backups' AND body = 'Scheduled backups, with written procedures for restoring from them and for handling incidents.';

-- Security page (/security): customer-readable overview; staff-level detail kept in its own section.
UPDATE lummet_pages SET
  content = '<p>Lummet keeps every site separate, limits each person to the access they need, and protects stored secrets. This page describes how the software works today. It is not a certification or an audit report.</p>
<h2>Separate sites, separate data</h2>
<p>Every site has its own database. Lummet never reads a site''s database: it reaches a site only through that site''s own API. Each request carries a timestamp, a one-time value and an HMAC-SHA-256 signature that covers the method, the path and a hash of the body, so a request cannot be altered or replayed as a different one. Removing a site from Lummet removes only its entry in the registry.</p>
<h2>Sign-in and access for your team</h2>
<ul>
<li>Sign in with a passkey or an authenticator app for two-step verification.</li>
<li>Organizations can require two-step verification for their members.</li>
<li>Team members can sign in through your identity provider with OpenID Connect. SAML and SCIM provisioning are not available yet.</li>
<li>Give each team member access to specific sites and roles.</li>
<li>Repeated failed sign-ins are rate limited.</li>
</ul>
<h2>Protecting stored data</h2>
<ul>
<li>Credentials that Lummet stores, such as the secret used to reach each of your sites, are encrypted with AES-GCM. The key is held outside the database, and a rotation procedure is documented.</li>
<li>API keys are stored only as hashes. A key is shown once, when it is created.</li>
<li>Passwords are stored only as salted hashes (PBKDF2 with SHA-256) and compared in constant time.</li>
<li>Every response tells browsers to keep using HTTPS (HSTS, one year, including subdomains).</li>
</ul>
<h2>Lummet staff access</h2>
<ul>
<li>A new staff account has no access to any site and no permission on any resource. A super admin grants access per site and per action, and the server checks the grants on every request, not only when the menu is drawn.</li>
<li>Staff sessions use an HttpOnly, Secure, SameSite=Strict cookie.</li>
<li>A disabled account loses its active sessions immediately.</li>
</ul>
<h2>Audit trail</h2>
<p>Sign-ins, failed sign-ins, site switches and changes made through Lummet are recorded in an audit log, including changes proposed by the AI assistant. Organizations can export their audit log as CSV. Passwords and secrets are never written to the log. Entries are kept for 180 days.</p>
<h2>Backups and recovery</h2>
<p>Lummet''s own database is exported about once a day, and the export is encrypted before it is stored. Plans that include backups can back up site content. Written runbooks cover restoring from a backup and handling incidents with the database, Cloudflare, Stripe and email delivery.</p>
<h2>Not available yet</h2>
<p>Lummet does not hold an independent security certification, and SAML single sign-on and SCIM provisioning are not available. If your security review needs more detail than this page gives, ask us and we will answer from how the software works.</p>
<p><a href="/demo">Contact us about a security review</a></p>
',
  excerpt = 'How Lummet keeps sites separate, controls access, protects stored secrets and records changes. A description of the software, not a certification.',
  seo_title = 'Security overview | Lummet',
  seo_description = 'How Lummet separates sites, controls access, encrypts stored credentials, records an audit trail and handles backups. What is available today and what is not.'
 WHERE slug = 'security' AND content = '<p>This page describes design choices in the Lummet control plane. It is a description of how the software works, not a certification or an audit report.</p>
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
<p>Sign-ins, failed sign-ins, tenant switches and changes made through the control plane are recorded in an audit log, including changes proposed by the AI assistant. Passwords and secrets are never written to it. Entries are kept for 180 days.</p>';

-- Enterprise page (/p/enterprise)
INSERT OR IGNORE INTO lummet_pages (slug, title, excerpt, content, status, seo_title, seo_description, author_id) VALUES
  ('enterprise', 'Lummet for agencies and large portfolios',
   'Run many affiliate sites from one dashboard, with a separate database, domain and brand for every site.',
   '<p>Lummet lets an agency or a large publisher run many affiliate sites from one dashboard, with a separate database, domain and brand for every site.</p>
<h2>What you get</h2>
<ul>
<li><strong>One dashboard for every site.</strong> Manage content, settings, team access and site health in one place, and add sites without rebuilding anything.</li>
<li><strong>Separate sites.</strong> Each site has its own configuration, database and custom domain, so one client''s site never shares data with another''s.</li>
<li><strong>White label.</strong> Present sites under your own brand and hide Lummet branding.</li>
<li><strong>Team roles.</strong> Give each team member access to the sites they work on and nothing else.</li>
<li><strong>API access and automation.</strong> Connect Lummet to your own tools, with a large monthly allowance of AI credits for content work.</li>
<li><strong>Safeguards.</strong> Deleting a site can require approval, and administrative actions are recorded in an audit log that your organization can export.</li>
<li><strong>AI that asks first.</strong> Lummet AI shows a preview of every proposed change and applies it only after an admin confirms.</li>
</ul>
<h2>Security</h2>
<p>Passkeys, authenticator-app two-step verification, OpenID Connect single sign-on, encrypted credentials and signed requests between Lummet and your sites are part of the platform. Read the <a href="/security">security overview</a> for what is and is not available today.</p>
<h2>Plans</h2>
<p>Enterprise plans scale to hundreds of sites and team members. Pricing depends on volume, so we talk it through with you first.</p>
<h2>Talk to us</h2>
<p><a href="/demo">Book a demo</a> and tell us about your portfolio: how many sites, which niches and how large your team is. We will follow up about the right plan, onboarding and support.</p>
',
   'published', 'Lummet for agencies and large portfolios | Lummet',
   'Run many affiliate sites from one dashboard with separate databases, custom domains, white label, team roles, API access and an audit log. Talk to us about volume.',
   (SELECT id FROM lummet_authors WHERE slug = 'lummet-team'));

INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('footer_platform', 'Enterprise', '/p/enterprise', 'page:enterprise', 'published', 55);
