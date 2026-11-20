-- 0106: Integrations and Support (the two "Coming soon" entries of the customer dashboard).
--
-- integrations: an organization's connections to chat tools (Slack, Discord, Microsoft Teams, Telegram). The destination (a webhook address,
--   or a Telegram bot token and chat id) is a secret, so it is stored encrypted like webhook signing secrets and never shown again;
--   target_hint keeps a harmless label (the host) for the list. Events are the same ones webhooks and automations already use.
-- support_tickets / support_messages: a customer's conversations with the platform team, one thread per ticket.

CREATE TABLE IF NOT EXISTS integrations (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,                       -- slack | discord | teams | telegram
    name TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    target_hint TEXT NOT NULL,
    event_types TEXT NOT NULL,                    -- JSON array
    status TEXT NOT NULL DEFAULT 'active',        -- active | disabled
    last_status TEXT,                             -- ok | failed
    last_error TEXT,
    last_sent_at TEXT,
    sent_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_by TEXT REFERENCES customer_users(id) ON DELETE SET NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_integrations_org ON integrations(organization_id);

CREATE TABLE IF NOT EXISTS support_tickets (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    customer_user_id TEXT REFERENCES customer_users(id) ON DELETE SET NULL,
    site_id TEXT REFERENCES sites(id) ON DELETE SET NULL,
    subject TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'question',    -- question | problem | billing | feature
    priority TEXT NOT NULL DEFAULT 'normal',      -- low | normal | high
    status TEXT NOT NULL DEFAULT 'open',          -- open (waiting for us) | answered (waiting for the customer) | closed
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_org ON support_tickets(organization_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets(status, updated_at);

CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY,
    ticket_id TEXT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    author_type TEXT NOT NULL,                    -- customer | staff
    author_label TEXT NOT NULL,                   -- name or email shown in the thread
    body TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_support_messages_ticket ON support_messages(ticket_id, created_at);
