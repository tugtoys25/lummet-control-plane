-- Cookie consent banner: every word and link is editable text (staff console > Interface text, group "cookies"). Purely additive.
-- The banner shows only while COOKIE_BANNER is on (Platform settings, default on) AND cookie_banner_text is not empty, so clearing the
-- text, or switching the setting off, removes it everywhere (public site, sign-in pages, dashboard). A link with an empty label or
-- address is simply not shown (link 2 is seeded empty: fill both its label and address to add a second link, e.g. a cookie policy page).
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('cookie_banner_title', 'Cookies on this site', 'cookies'),
  ('cookie_banner_text', 'We use essential cookies to keep you signed in and the site secure. With your permission we also use cookies to understand how the site is used and to improve it.', 'cookies'),
  ('cookie_accept_label', 'Accept', 'cookies'),
  ('cookie_decline_label', 'Decline non-essential', 'cookies'),
  ('cookie_settings_label', 'Cookie settings', 'cookies'),
  ('cookie_link_1_label', 'Privacy policy', 'cookies'),
  ('cookie_link_1_href', '/privacy', 'cookies'),
  ('cookie_link_2_label', '', 'cookies'),
  ('cookie_link_2_href', '', 'cookies');
