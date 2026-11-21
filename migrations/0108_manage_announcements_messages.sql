-- 0108: staff can edit, hide and delete announcements and support messages.
--   hidden_at: set = not shown to customers (still visible to staff, who can show it again). edited_at: shown to customers as "edited".
ALTER TABLE announcements ADD COLUMN hidden_at TEXT;
ALTER TABLE announcements ADD COLUMN edited_at TEXT;
ALTER TABLE support_messages ADD COLUMN hidden_at TEXT;
ALTER TABLE support_messages ADD COLUMN edited_at TEXT;
