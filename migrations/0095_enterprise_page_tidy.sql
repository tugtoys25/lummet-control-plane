-- =====================================================
-- 0095 — PUBLIC SITE: Enterprise page tidy (after 0094)
--
-- Safe to re-run, and never overwrites an admin edit: the update only applies while the page still holds the exact 0094 text.
--   * removes the opening paragraph, which repeated the excerpt the page template already prints under the title,
--   * replaces "never shares data" with a claim the provisioning code supports (each provisioned site gets its own D1 database,
--     worker/provisioning.js create_database) without an absolute.
-- =====================================================
UPDATE lummet_pages SET content = '<h2>What you get</h2>
<ul>
<li><strong>One dashboard for every site.</strong> Manage content, settings, team access and site health in one place, and add sites without rebuilding anything.</li>
<li><strong>Separate sites.</strong> Each site has its own configuration, database and custom domain, so each client''s data stays in its own database.</li>
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
'
 WHERE slug = 'enterprise' AND content = '<p>Lummet lets an agency or a large publisher run many affiliate sites from one dashboard, with a separate database, domain and brand for every site.</p>
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
';
