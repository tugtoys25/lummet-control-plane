-- Round 6.1A (release 2.6.0.1): revenue schema. Tables only; nothing here computes MRR or reads a metric (6.1B and 6.1C do).
-- Every key below exists so a later job or a redelivered webhook can run any number of times and leave one answer.
--
-- revenue_snapshots: one row per (day, currency), written by the 6.1B daily job with an upsert. Money columns are integer cents.
-- churned_mrr is stored as a positive magnitude; new/expansion/contraction/churned are the sums of that day's movements.
CREATE TABLE IF NOT EXISTS revenue_snapshots (
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  currency TEXT NOT NULL,
  mrr_cents INTEGER NOT NULL DEFAULT 0,
  arr_cents INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 0,
  trialing INTEGER NOT NULL DEFAULT 0,
  past_due INTEGER NOT NULL DEFAULT 0,
  new_mrr INTEGER NOT NULL DEFAULT 0,
  expansion_mrr INTEGER NOT NULL DEFAULT 0,
  contraction_mrr INTEGER NOT NULL DEFAULT 0,
  churned_mrr INTEGER NOT NULL DEFAULT 0,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (day, currency)
);

-- subscription_movements: an append-only ledger of changes in a subscription's MRR contribution. id is '<subscription_id>:<seq>'.
-- seq counts from 1 per subscription; UNIQUE (subscription_id, seq) is what makes two writers (a redelivery, a replay, the backfill)
-- unable to record the same step twice. The sum of mrr_delta_cents for a subscription always equals its mrr_cents in
-- subscription_revenue_state. A zero change is never written. source says where the step came from: 'webhook' (a provider-confirmed
-- event), 'lifecycle' (the billing sweep) or 'backfill' (history reconstructed from existing rows). Never a UI action.
CREATE TABLE IF NOT EXISTS subscription_movements (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  kind TEXT NOT NULL CHECK (kind IN ('new','expansion','contraction','churn')),
  mrr_delta_cents INTEGER NOT NULL CHECK (mrr_delta_cents <> 0),
  mrr_after_cents INTEGER NOT NULL CHECK (mrr_after_cents >= 0),
  currency TEXT NOT NULL,
  plan_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  source TEXT NOT NULL CHECK (source IN ('webhook','lifecycle','backfill')),
  provider_event_created INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subscription_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_subscription_movements_day ON subscription_movements(day, kind);
CREATE INDEX IF NOT EXISTS idx_subscription_movements_org ON subscription_movements(organization_id, day);
-- The backfill can write at most one 'new' and one 'churn' per subscription, even if it is started twice at once.
CREATE UNIQUE INDEX IF NOT EXISTS ux_subscription_movements_backfill ON subscription_movements(subscription_id, kind) WHERE source = 'backfill';

-- subscription_revenue_state: the last MRR the ledger recorded for each subscription, plus the newest provider event time already
-- considered (the watermark that makes an older, late event a no-op even when the newer one changed nothing). One row per subscription.
CREATE TABLE IF NOT EXISTS subscription_revenue_state (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0 CHECK (seq >= 0),
  mrr_cents INTEGER NOT NULL DEFAULT 0 CHECK (mrr_cents >= 0),
  currency TEXT NOT NULL DEFAULT 'USD',
  plan_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  last_event_created INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
