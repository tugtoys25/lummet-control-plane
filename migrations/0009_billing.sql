-- =====================================================
-- BILLING (Phase 2 — master prompt sections 14-15)
--
-- Introduces a payment-provider-neutral billing layer on
-- top of the subscriptions table from migration 0006.
-- Provider-specific IDs live in billing_customers and on
-- subscriptions itself; internal status values (already
-- established in 0006: trialing|active|past_due|paused|
-- canceled|expired|incomplete|incomplete_expired|suspended)
-- are the ONLY status vocabulary application code should
-- ever branch on — see worker/billing-stripe.js's
-- normalizeSubscriptionStatus(), the one function allowed
-- to read a provider-specific status string.
--
-- No payment provider is wired to real money by THIS
-- migration — it only adds schema. worker/billing.js and
-- worker/billing-stripe.js are what actually talk to
-- Stripe, and only do so once STRIPE_SECRET_KEY /
-- STRIPE_WEBHOOK_SECRET are configured as Worker secrets
-- (see the deployment notes in the completion report).
-- =====================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------
-- BILLING CUSTOMERS
-- Maps one organization to (at most) one customer record
-- per provider. Kept separate from `organizations` so an
-- organization's billing identity can be recreated/migrated
-- to a different provider later without touching the
-- organization row itself.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                       -- 'stripe' today; interface supports others later (section 19)
    provider_customer_id TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(organization_id, provider),
    UNIQUE(provider, provider_customer_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_customers_org ON billing_customers(organization_id);

-- -----------------------------------------------------
-- COUPONS
-- Provider-neutral coupon metadata mirrored locally so
-- checkout can validate a code without a live provider round
-- trip; the discount itself is still applied provider-side
-- at checkout (see billing-stripe.js's createCheckoutSession).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS coupons (
    id TEXT PRIMARY KEY,                          -- uuid
    code TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL,
    provider_coupon_id TEXT NOT NULL,
    percent_off REAL,                             -- e.g. 20 = 20% off
    amount_off_cents INTEGER,                     -- flat discount, alternative to percent_off
    duration TEXT NOT NULL DEFAULT 'once',        -- once | repeating | forever
    status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
    expires_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------
-- PLANS: provider price linkage (extends migration 0006)
-- A plan with stripe_price_id = NULL cannot be checked out
-- against — billing.js's startCheckout refuses rather than
-- faking a checkout session for an unconfigured plan
-- (rule #5). Staff wire this up once the matching Stripe
-- Price object exists (catalog management UI is section 45,
-- not yet built — set via direct DB access or a future
-- staff-console screen).
-- -----------------------------------------------------

ALTER TABLE plans ADD COLUMN stripe_price_id TEXT;

-- -----------------------------------------------------
-- SUBSCRIPTIONS: provider linkage (extends migration 0006)
-- provider = NULL means "trial only, no payment provider
-- involved yet" — the exact state every Phase 1 trial
-- subscription is already in, so this is backward compatible
-- with no data migration needed. Checkout completing
-- converts such a row in place rather than creating a
-- second one (see billing.js's dispatchEvent).
-- -----------------------------------------------------

ALTER TABLE subscriptions ADD COLUMN provider TEXT;
ALTER TABLE subscriptions ADD COLUMN provider_subscription_id TEXT;
ALTER TABLE subscriptions ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN coupon_id TEXT REFERENCES coupons(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_subscriptions_provider_sub ON subscriptions(provider_subscription_id);

-- -----------------------------------------------------
-- SUBSCRIPTION STATUS EVENTS
-- Same pattern as site_status_events (migration 0006) —
-- every status change is recorded with who/what caused it,
-- so "why is this organization suspended" always has an
-- answer. actor_type = 'billing_webhook' covers
-- provider-driven changes (payment failed, renewed, etc.) —
-- this doubles as the "billing event audit log" master
-- prompt section 14 asks for.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS subscription_status_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    actor_type TEXT NOT NULL DEFAULT 'system',    -- system | customer_user | lummet_admin | billing_webhook
    actor_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_subscription_status_events_sub ON subscription_status_events(subscription_id);

-- -----------------------------------------------------
-- INVOICES
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    provider_invoice_id TEXT NOT NULL,
    status TEXT NOT NULL,                         -- draft | open | paid | uncollectible | void
    amount_due_cents INTEGER NOT NULL DEFAULT 0,
    amount_paid_cents INTEGER NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    hosted_invoice_url TEXT,
    period_start TEXT,
    period_end TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    paid_at TEXT,
    UNIQUE(provider, provider_invoice_id)
);

CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(organization_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);

-- -----------------------------------------------------
-- PAYMENTS
-- One row per payment attempt against an invoice — separate
-- from invoices because a single invoice can have more than
-- one attempt (a failed charge followed by a successful
-- retry).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY,                          -- uuid
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    invoice_id TEXT REFERENCES invoices(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    provider_payment_id TEXT NOT NULL,
    status TEXT NOT NULL,                         -- succeeded | failed | pending | refunded
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    failure_reason TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(provider, provider_payment_id)
);

CREATE INDEX IF NOT EXISTS idx_payments_org ON payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id);

-- -----------------------------------------------------
-- WEBHOOK IDEMPOTENCY / EVENT LOG
-- Every verified webhook event is recorded here, keyed on
-- the PROVIDER's own event ID, before being processed — a
-- redelivered webhook (Stripe retries on anything but a 2xx)
-- is a guaranteed no-op the second time. Required by master
-- prompt section 14 ("idempotency") and section 40 ("replay
-- attacks"). A row stuck in 'failed' needs manual staff
-- investigation in this phase — there is no automatic retry
-- job yet (that's the job system, section 38).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS billing_webhook_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'received',      -- received | processed | failed
    error_message TEXT,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP,
    processed_at TEXT,
    UNIQUE(provider, provider_event_id)
);

CREATE INDEX IF NOT EXISTS idx_billing_webhook_events_type ON billing_webhook_events(event_type);
