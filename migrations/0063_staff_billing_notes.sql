-- Phase 5.7: private staff-only notes. Never exposed to customer organization APIs.
CREATE TABLE IF NOT EXISTS staff_billing_notes (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  author_staff_id TEXT NOT NULL,
  note TEXT NOT NULL CHECK (length(note) BETWEEN 1 AND 5000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_staff_billing_notes_org_created ON staff_billing_notes(organization_id, created_at DESC);

-- Pricing trust/FAQ copy remains editable through Site settings > UI strings.
INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
 ('pricing_trust_aria', 'Billing information', 'lists'),
 ('pricing_trust_title', 'Clear billing.', 'lists'),
 ('pricing_trust_body', 'Review plan terms before checkout. Taxes, where applicable, are shown by the payment provider. You can manage eligible subscriptions from your billing area.', 'lists'),
 ('pricing_faq_title', 'Pricing questions', 'lists'),
 ('pricing_faq_charge_q', 'When am I charged?', 'lists'),
 ('pricing_faq_charge_a', 'Checkout displays the amount and billing interval before you confirm. Any trial and its end date are shown before signup completes.', 'lists'),
 ('pricing_faq_cancel_q', 'Can I change or cancel a plan?', 'lists'),
 ('pricing_faq_cancel_a', 'Eligible subscriptions can be changed or scheduled for cancellation from the billing area. Timing and effect depend on the subscription terms shown at checkout.', 'lists'),
 ('pricing_faq_tax_q', 'Are taxes included?', 'lists'),
 ('pricing_faq_tax_a', 'Tax treatment depends on your location and the configured billing settings. Review the checkout total and invoice before payment.', 'lists'),
 ('pricing_faq_business_q', 'Can I request a business plan?', 'lists'),
 ('pricing_faq_business_a', 'Contact the team for a quote. A quote is not a subscription and does not grant access until the required billing steps are complete.', 'lists');
