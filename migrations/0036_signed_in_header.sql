-- Header link shown in place of "Sign in" once a staff member is signed in.
-- Idempotent: safe to run more than once, and it never overwrites an edit.
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('signed_in_label', 'Dashboard', 'layout'),
  ('signed_in_href', '/dashboard', 'layout');
