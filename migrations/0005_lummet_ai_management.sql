-- =====================================================
-- LUMMET AI MANAGEMENT LAYER
-- Additive only. Adds conversation/message history and a
-- short-lived pending-operations table for the AI chat's
-- write-preview/confirmation workflow (see worker/ai/*).
--
-- No existing table is altered except lummet_audit_logs,
-- which gains two nullable columns so AI-originated writes
-- are identifiable in the SAME audit trail the dashboard
-- already writes to -- not a second, disconnected log.
-- =====================================================


-- -----------------------------------------------------
-- CONVERSATIONS
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_ai_conversations (
    id TEXT PRIMARY KEY,                      -- uuid
    admin_id INTEGER NOT NULL REFERENCES lummet_admins(id) ON DELETE CASCADE,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL, -- active tenant when created
    title TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_conversations_admin ON lummet_ai_conversations(admin_id);

-- -----------------------------------------------------
-- MESSAGES
-- One row per turn. `action_id` links a message to the
-- pending operation it proposed or confirmed, if any.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_ai_messages (
    id TEXT PRIMARY KEY,                      -- uuid
    conversation_id TEXT NOT NULL REFERENCES lummet_ai_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,                       -- 'user' | 'assistant' | 'system'
    content TEXT NOT NULL,
    action_id TEXT,                           -- lummet_ai_pending_operations.id, nullable
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation ON lummet_ai_messages(conversation_id, created_at);

-- -----------------------------------------------------
-- PENDING OPERATIONS
-- A prepared-but-not-yet-executed write. Created at
-- preview time, consumed (or rejected) at confirm time.
-- Short-lived by design (see expires_at) -- this table is
-- NOT a general write queue, just the gap between a
-- preview being shown and the admin pressing confirm.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_ai_pending_operations (
    id TEXT PRIMARY KEY,                      -- uuid
    admin_id INTEGER NOT NULL REFERENCES lummet_admins(id) ON DELETE CASCADE,
    conversation_id TEXT REFERENCES lummet_ai_conversations(id) ON DELETE SET NULL,
    tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    resource TEXT NOT NULL,                   -- a key from resources.js RESOURCES
    operation TEXT NOT NULL,                  -- create | update | delete
    record_id TEXT,                           -- null for create
    current_values TEXT,                      -- JSON snapshot at preview time (null for create)
    proposed_values TEXT NOT NULL,            -- JSON: only the fields being changed
    payload_hash TEXT NOT NULL,               -- sha256 of {resource,operation,recordId,proposedValues}
    status TEXT NOT NULL DEFAULT 'pending',   -- pending | executed | expired | superseded | rejected
    result TEXT,                              -- JSON: outcome once executed
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    executed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_pending_ops_admin ON lummet_ai_pending_operations(admin_id, status);
CREATE INDEX IF NOT EXISTS idx_ai_pending_ops_expiry ON lummet_ai_pending_operations(status, expires_at);

-- -----------------------------------------------------
-- AUDIT: identify AI-originated rows in the EXISTING log
-- -----------------------------------------------------

ALTER TABLE lummet_audit_logs ADD COLUMN initiated_by TEXT NOT NULL DEFAULT 'dashboard';
ALTER TABLE lummet_audit_logs ADD COLUMN ai_conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_lummet_audit_initiated_by ON lummet_audit_logs(initiated_by);
