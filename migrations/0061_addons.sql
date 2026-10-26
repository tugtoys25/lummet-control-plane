-- Phase 5.5: catalog-backed add-ons and idempotent one-time credit grants.
CREATE TABLE IF NOT EXISTS addons (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  entitlement_key TEXT NOT NULL,
  delta_per_unit INTEGER NOT NULL CHECK (delta_per_unit >= 0),
  stripe_price_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS subscription_addons (
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  addon_id TEXT NOT NULL REFERENCES addons(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (subscription_id, addon_id)
);
CREATE TABLE IF NOT EXISTS credit_packs (
  id TEXT PRIMARY KEY,
  credits INTEGER NOT NULL CHECK (credits > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'usd',
  stripe_price_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS credit_pack_grants (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  credit_pack_id TEXT NOT NULL REFERENCES credit_packs(id),
  provider_payment_id TEXT NOT NULL UNIQUE,
  credits INTEGER NOT NULL CHECK (credits > 0),
  granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_credit_pack_grants_org ON credit_pack_grants(organization_id, granted_at DESC);

