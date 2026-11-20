-- 0107: files on support tickets, and announcements from the platform team.
--
-- private_files: files that are NOT public. They live in the existing PLATFORM_MEDIA bucket under the key prefix "private/", which the public
--   /brand-media route can never serve (its keys must look like folder/number-hex.ext). Support files are only readable by members of the
--   organization (and staff); announcement files are reached through a signed link so an email can show a photo or offer a document.
-- announcements: a message from staff to everyone, one person, an organization, a site or the billing contacts, shown in the customer dashboard
--   and/or sent by email. The dashboard list is computed from the audience rule, so nothing is copied per user; only emails are fanned out, in small
--   batches, through announcement_recipients.
-- announcement_reads: which person has opened which announcement (drives the unread badge).

CREATE TABLE IF NOT EXISTS private_files (
    id TEXT PRIMARY KEY,
    organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,                        -- support | announcement
    message_id TEXT,                              -- support_messages.id once the file is attached to a message
    announcement_id TEXT,                         -- announcements.id once attached
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    uploaded_by_kind TEXT NOT NULL,               -- customer | staff
    uploaded_by TEXT,                             -- customer user id or staff id
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_private_files_message ON private_files(message_id);
CREATE INDEX IF NOT EXISTS idx_private_files_announcement ON private_files(announcement_id);
CREATE INDEX IF NOT EXISTS idx_private_files_org ON private_files(organization_id);

CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    subject TEXT NOT NULL,
    body_html TEXT NOT NULL,                      -- already sanitised
    format TEXT NOT NULL DEFAULT 'html',          -- html | text (how the author wrote it)
    audience_kind TEXT NOT NULL,                  -- all | user | organization | site | billing
    audience_ref TEXT,                            -- user id, organization id, site id, or an organization id for billing (empty = every organization)
    audience_label TEXT NOT NULL,
    channels TEXT NOT NULL,                       -- JSON array: dashboard, email
    recipient_count INTEGER NOT NULL DEFAULT 0,
    email_total INTEGER NOT NULL DEFAULT 0,
    created_by_staff TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at);

CREATE TABLE IF NOT EXISTS announcement_recipients (
    announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    email_status TEXT NOT NULL DEFAULT 'pending', -- pending | queued | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (announcement_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_announcement_recipients_pending ON announcement_recipients(email_status, announcement_id);

CREATE TABLE IF NOT EXISTS announcement_reads (
    announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES customer_users(id) ON DELETE CASCADE,
    read_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (announcement_id, user_id)
);
