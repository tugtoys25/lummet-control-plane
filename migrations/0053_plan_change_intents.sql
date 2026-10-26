-- =====================================================
-- 0053_plan_change_intents (Phase 3, sprint 3.2, first half: plan sync and plan-change intents)
--
-- Additive only. Nothing here changes how a customer is billed or what a plan allows until BILLING_ENFORCE is
-- `shadow` (record only) or `enforce` (apply). With BILLING_ENFORCE=off every new code path is inert.
--
-- plan_change_intents   a customer's request to change plan, written BEFORE Stripe is called. The row carries the
--                       idempotency key sent to Stripe, so an interrupted change can be retried without charging twice.
--                       The subscription's plan_id changes only when Stripe's own webhook confirms the new price (N2).
-- plan_sync_issues      what the webhook plan sync found that needs a human: a Stripe price Lummet does not know
--                       (alert `unknown_price_id`), and, in shadow mode, plan changes it WOULD have applied.
-- subscriptions.plan_synced_event_at
--                       unix time of the newest Stripe event the plan sync has acted on; an older event arriving later
--                       (Stripe does not guarantee order) can never move the plan backwards.
--
-- ROLLBACK: set BILLING_ENFORCE=off (new paths inert) or deploy v2.3.0. Both tables and the column can simply be
-- ignored; v2.3.0 never reads them. An intent left in `pending` or `submitted` at rollback has already been sent to
-- Stripe (or never will be); Stripe remains the truth for what the customer is charged.
--
-- PREFLIGHT: none needed (no existing rows are read or rewritten).
-- =====================================================

ALTER TABLE subscriptions ADD COLUMN plan_synced_event_at INTEGER;

CREATE TABLE IF NOT EXISTS plan_change_intents (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    from_plan_id TEXT,
    to_plan_id TEXT NOT NULL,
    -- pending     written, Stripe not yet known to have accepted it (retried by the sweep with the SAME key)
    -- submitted   Stripe accepted it; waiting for the webhook that confirms the new price
    -- confirmed   the webhook arrived and plan_id now matches
    -- failed      Stripe refused it (a 4xx) or retries ran out
    -- superseded  a newer request replaced it after it sat unconfirmed for over an hour
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'superseded')),
    idempotency_key TEXT NOT NULL UNIQUE,
    direction TEXT CHECK (direction IN ('upgrade', 'downgrade', 'lateral')),   -- by monthly-equivalent price; used by the downgrade guard (second half of 3.2)
    to_price_id TEXT,                                      -- the Stripe price the request was sent with
    requested_by TEXT,                                     -- customer user id, or 'staff:<admin id>'
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    confirmed_at TEXT
);

-- One change in flight per subscription: two simultaneous requests cannot both reach Stripe.
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_change_one_open ON plan_change_intents(subscription_id) WHERE status IN ('pending', 'submitted');
CREATE INDEX IF NOT EXISTS idx_plan_change_intents_open ON plan_change_intents(status, updated_at);

CREATE TABLE IF NOT EXISTS plan_sync_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('unknown_price_id', 'shadow_plan_change')),
    stripe_price_id TEXT NOT NULL DEFAULT '',
    provider_subscription_id TEXT NOT NULL DEFAULT '',
    subscription_id TEXT,
    organization_id TEXT,
    from_plan_id TEXT,
    to_plan_id TEXT,
    event_id TEXT,                                         -- the newest event that raised it
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
    resolved_at TEXT,
    resolved_by TEXT                                       -- 'auto: price mapped', 'auto: plan matches', or 'staff:<admin id>'
);

-- A repeat of the same problem bumps occurrences instead of adding rows (webhooks are at-least-once).
CREATE UNIQUE INDEX IF NOT EXISTS uq_plan_sync_issue_open ON plan_sync_issues(kind, provider_subscription_id, stripe_price_id) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_plan_sync_issues_open ON plan_sync_issues(kind, resolved_at);
