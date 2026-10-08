PRAGMA foreign_keys = ON;

-- Extra, admin-managed blocks rendered on the public homepage
-- between the built-in sections (hero, capabilities, brands,
-- updates, partners, contact). Ordered by sort_order, ascending.
-- A page's own body (lummet_pages.content) already supports full
-- rich text/HTML for that page's own layout — this table is
-- specifically for the homepage, which otherwise has a fixed set
-- of built-in sections.

CREATE TABLE IF NOT EXISTS lummet_homepage_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    subtitle TEXT,
    body TEXT,                      -- HTML from the rich text editor
    image_url TEXT,
    layout TEXT NOT NULL DEFAULT 'text_only',  -- text_only | image_left | image_right
    cta_label TEXT,
    cta_href TEXT,
    status TEXT NOT NULL DEFAULT 'draft',      -- draft | published
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_homepage_sections_status ON lummet_homepage_sections(status, sort_order);
