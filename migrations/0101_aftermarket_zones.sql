-- 0101: nameserver verification for seller domains with a Cloudflare zone per domain
--
-- Replaces the shared "AFTERMARKET_NAMESERVERS" check. When a seller picks the nameserver option, a zone for their domain is
-- created in the platform Cloudflare account (the same mechanism as custom domains at site creation). Cloudflare assigns that
-- domain its OWN two nameservers and only marks the zone active when the registrar really delegates to them, so activation is the
-- ownership proof. The domain is then attached to this Worker and its for-sale page is served at the domain itself.
-- Unfinished claims expire and the zone is deleted.

ALTER TABLE lummet_aftermarket_domains ADD COLUMN cf_zone_id TEXT;
ALTER TABLE lummet_aftermarket_domains ADD COLUMN ns_assigned TEXT;          -- the two nameservers Cloudflare assigned, comma separated
ALTER TABLE lummet_aftermarket_domains ADD COLUMN ns_detected_at TEXT;       -- public DNS lists them (progress only)
ALTER TABLE lummet_aftermarket_domains ADD COLUMN activation_asked_at TEXT;
ALTER TABLE lummet_aftermarket_domains ADD COLUMN zone_expires_at TEXT;
ALTER TABLE lummet_aftermarket_domains ADD COLUMN next_check_at TEXT;
CREATE INDEX IF NOT EXISTS idx_lummet_aftermarket_zone ON lummet_aftermarket_domains(cf_zone_id, next_check_at);

UPDATE lummet_ui_strings SET value = 'Get two nameservers made for {domain}, set them at your registrar, then check. Once Cloudflare confirms them, the for-sale page is also shown at the domain itself. Existing DNS records are copied across, so check that email and other services keep working.'
  WHERE ui_key = 'aftermarket_ns_body' AND value = 'At your registrar, set the nameservers of {domain} to the ones below. The for-sale page is then also shown at the domain itself.';
UPDATE lummet_ui_strings SET value = 'Nameserver verification is not available right now. Use the TXT record option.'
  WHERE ui_key = 'aftermarket_ns_unavailable';

INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('aftermarket_ns_start_button', 'Get my nameservers', 'aftermarket'),
  ('aftermarket_ns_set_these', 'Set these two nameservers at your registrar, then press the button below.', 'aftermarket'),
  ('aftermarket_ns_seen', 'We can see the new nameservers on {domain}. Cloudflare is confirming them, which usually takes a few minutes.', 'aftermarket'),
  ('aftermarket_ns_error', 'We could not set up nameservers for {domain} right now. Try again later, or use the TXT record option.', 'aftermarket'),
  ('aftermarket_ns_busy', 'Nameserver setup is busy right now. Try again later, or use the TXT record option.', 'aftermarket'),
  ('aftermarket_ns_taken', 'This domain is already connected to an account here, so nameservers cannot be set up for it. Use the TXT record option.', 'aftermarket');
