-- Phase 5 completion (merged v2.5.2.7; renumbered from 0067): add-on intents, save/cancel decisions, Founder License, tax evidence,
-- quote entitlement grants, credit-pack reconciliation and signup intent. Dunning comp and webhook replay live in 0068/0069.
CREATE TABLE IF NOT EXISTS addon_change_intents (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  addon_id TEXT NOT NULL REFERENCES addons(id),
  from_quantity INTEGER NOT NULL DEFAULT 0 CHECK (from_quantity >= 0),
  to_quantity INTEGER NOT NULL CHECK (to_quantity > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','confirmed','failed','cancelled')),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider_subscription_item_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_addon_intents_org ON addon_change_intents(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_save_offers (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  offer_key TEXT NOT NULL CHECK (offer_key IN ('pause','downgrade','coupon','export')),
  status TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','accepted','declined','completed','expired')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_save_offer ON billing_save_offers(subscription_id) WHERE status IN ('shown','accepted');

CREATE TABLE IF NOT EXISTS immediate_cancel_decisions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  staff_id TEXT NOT NULL,
  refund_decision TEXT NOT NULL CHECK (refund_decision IN ('none','full','partial')),
  refund_amount_cents INTEGER NOT NULL DEFAULT 0 CHECK (refund_amount_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_immediate_cancel_org ON immediate_cancel_decisions(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS founder_license_grants (
  organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
  provider_invoice_id TEXT NOT NULL UNIQUE,
  entitlement_json TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tax_registration_checklist (
  id TEXT PRIMARY KEY,
  jurisdiction TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','pending','verified','not_applicable')),
  evidence_url TEXT,
  notes TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS quote_entitlement_grants (
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id) ON DELETE CASCADE,
  entitlement_json TEXT NOT NULL,
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, quote_id)
);
CREATE TABLE IF NOT EXISTS credit_pack_reconciliation_findings (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE REFERENCES credit_pack_grants(id) ON DELETE CASCADE,
  provider_payment_id TEXT NOT NULL,
  expected_amount_cents INTEGER NOT NULL,
  provider_amount_cents INTEGER,
  currency TEXT,
  status TEXT NOT NULL CHECK (status IN ('match','mismatch','unavailable')),
  detail TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE customer_users ADD COLUMN signup_plan_id TEXT;
ALTER TABLE customer_users ADD COLUMN signup_billing_period TEXT;
