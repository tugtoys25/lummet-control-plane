-- v7G: annual twins of the monthly plans, seeded RETIRED so nothing changes until staff publish them.
--
-- Why retired: an annual price is a commercial decision (the catalog migration says so on purpose) and needs its own Stripe
-- price. Each twin is a normal plan row: key "<key>_annual", billing_period 'annual', price = 10 x monthly (two months free,
-- a 16.7% discount; it can never undercut the monthly price), no second trial, same entitlements as its monthly plan. To
-- publish one: Staff > Plans, set the Stripe price id (and the price, if different), then Activate. Entitlements are copied
-- once; change both rows if a limit changes later.
INSERT OR IGNORE INTO plans (id, product_id, key, name, billing_period, price_cents, currency, trial_days, status)
SELECT id || '_annual', product_id, key || '_annual', name || ' (annual)', 'annual', price_cents * 10, currency, 0, 'retired'
  FROM plans
 WHERE billing_period = 'monthly' AND price_cents IS NOT NULL AND price_cents > 0 AND id NOT LIKE '%\_annual' ESCAPE '\';

INSERT OR IGNORE INTO plan_entitlements (plan_id, key, value_type, value)
SELECT m.id || '_annual', e.key, e.value_type, e.value
  FROM plan_entitlements e JOIN plans m ON m.id = e.plan_id
 WHERE m.billing_period = 'monthly' AND m.price_cents IS NOT NULL AND m.price_cents > 0
   AND EXISTS (SELECT 1 FROM plans a WHERE a.id = m.id || '_annual');

INSERT OR IGNORE INTO lummet_nav_links (placement, label, href, visible_when, status, sort_order) VALUES
  ('header', 'Pricing', '/pricing', 'always', 'published', 25),
  ('footer_platform', 'Pricing', '/pricing', 'always', 'published', 35);

-- Words on the public pricing page: editable like every other public string (Site settings > UI strings).
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('title_pricing', 'Pricing', 'lists'),
  ('pricing_billing_label', 'Billing period', 'lists'),
  ('pricing_monthly', 'Monthly', 'lists'),
  ('pricing_annual', 'Annual', 'lists'),
  ('pricing_per_month', 'per month', 'lists'),
  ('pricing_per_year', 'per year', 'lists'),
  ('pricing_trial', '{n}-day free trial', 'lists'),
  ('pricing_saving', 'Save {pct}% compared with paying monthly', 'lists'),
  ('pricing_cta', 'Get started', 'lists'),
  ('pricing_note', 'Prices exclude any taxes that apply where you are. You can cancel at any time; see your plan''s terms for refunds.', 'lists'),
  ('pricing_empty', 'Pricing is not published yet.', 'lists'),
  ('pricing_contact', 'Contact us and we will help you choose a plan.', 'lists');
