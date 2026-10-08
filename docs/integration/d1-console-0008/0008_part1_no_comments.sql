CREATE TABLE IF NOT EXISTS lummet_ui_strings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ui_key TEXT NOT NULL UNIQUE,
    value TEXT NOT NULL,
    group_key TEXT NOT NULL DEFAULT 'general',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lummet_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_key TEXT NOT NULL UNIQUE,
    eyebrow TEXT,
    title TEXT NOT NULL,
    intro TEXT,
    submit_label TEXT NOT NULL,
    success_title TEXT NOT NULL,
    success_message TEXT NOT NULL,
    side_title TEXT,
    side_body TEXT,
    seo_title TEXT,
    seo_description TEXT,
    og_image TEXT,
    status TEXT NOT NULL DEFAULT 'draft',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lummet_form_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_key TEXT NOT NULL,
    field_key TEXT NOT NULL,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text',
    required INTEGER NOT NULL DEFAULT 0,
    placeholder TEXT,
    help_text TEXT,
    options TEXT,
    max_length INTEGER NOT NULL DEFAULT 2000,
    status TEXT NOT NULL DEFAULT 'published',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (form_key, field_key)
);
CREATE INDEX IF NOT EXISTS idx_lummet_form_fields_form ON lummet_form_fields(form_key, status, sort_order);
CREATE TABLE IF NOT EXISTS lummet_inquiries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_key TEXT NOT NULL,
    name TEXT,
    email TEXT,
    summary TEXT,
    details TEXT,
    payload TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    admin_notes TEXT,
    ip_hash TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lummet_inquiries_status ON lummet_inquiries(status, created_at);
CREATE INDEX IF NOT EXISTS idx_lummet_inquiries_ip ON lummet_inquiries(ip_hash, created_at);
