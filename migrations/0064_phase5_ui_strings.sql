-- Phase 5 completion: accessible pricing comparison and public-form Turnstile helper strings.
-- Additive and idempotent; existing administrator edits are preserved by INSERT OR IGNORE.
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
 ('pricing_family_label', 'Product family', 'lists'),
 ('pricing_family_all', 'All product families', 'lists'),
 ('pricing_comparison_title', 'Compare plans', 'lists'),
 ('pricing_comparison_caption', 'Prices and included features for the selected billing interval', 'lists'),
 ('pricing_comparison_aria', 'Plan comparison table', 'lists'),
 ('pricing_comparison_plan', 'Plan', 'lists'),
 ('pricing_comparison_price', 'Price', 'lists'),
 ('pricing_comparison_features', 'Included features', 'lists'),
 ('pricing_comparison_action', 'Action', 'lists'),
 ('form_turnstile_help', 'Complete the security check before submitting this form.', 'forms'),
 ('form_turnstile_unavailable', 'This form is temporarily unavailable because bot protection is not configured. Please contact support directly.', 'forms');
