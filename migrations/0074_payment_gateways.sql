-- Release 2.6.1.0: multi-gateway billing. Purely additive: three new tables, no existing table or row is altered.
--
-- payment_gateways        one row per gateway, the on/off switch staff flip (and the failover order). Stripe is seeded ON
--                         and NOWPayments OFF, so applying this migration changes nothing for any customer until staff act.
-- payment_gateway_events  append-only record of every switch change (who, when, why).
-- crypto_checkouts        one row per NOWPayments invoice we create. The IPN is matched to the organization and plan from
--                         THIS row (by our own order id), never from anything the webhook body claims.
CREATE TABLE IF NOT EXISTS payment_gateways (
  gateway TEXT PRIMARY KEY,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO payment_gateways (gateway, enabled, priority) VALUES ('stripe', 1, 10);
INSERT OR IGNORE INTO payment_gateways (gateway, enabled, priority) VALUES ('nowpayments', 0, 20);

CREATE TABLE IF NOT EXISTS payment_gateway_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gateway TEXT NOT NULL,
  action TEXT NOT NULL,
  enabled INTEGER,
  reason TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payment_gateway_events_created ON payment_gateway_events(created_at);

CREATE TABLE IF NOT EXISTS crypto_checkouts (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id),
  provider_invoice_id TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirming','partially_paid','paid','expired','failed','refunded')),
  invoice_url TEXT,
  provider_payment_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_crypto_checkouts_org ON crypto_checkouts(organization_id);
CREATE INDEX IF NOT EXISTS idx_crypto_checkouts_invoice ON crypto_checkouts(provider_invoice_id);
