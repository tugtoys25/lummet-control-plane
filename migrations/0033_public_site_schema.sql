-- =====================================================
-- 0006 — PUBLIC SITE SCHEMA
--
-- Makes lummet.com's public site fully database-driven.
-- Adds the columns and tables that were previously
-- hardcoded in worker/views/pages/home.js and
-- worker/public-brands.js.
--
-- NOTE: the ALTER TABLE ... ADD COLUMN statements are not
-- re-runnable in SQLite/D1 (a second run fails with
-- "duplicate column name"). Run this file ONCE per
-- database. The seed in 0007 IS safe to re-run.
-- =====================================================

PRAGMA foreign_keys = ON;

-- ---- Brand profiles: category + per-page SEO ----------
ALTER TABLE lummet_brands ADD COLUMN category TEXT;
ALTER TABLE lummet_brands ADD COLUMN seo_title TEXT;
ALTER TABLE lummet_brands ADD COLUMN seo_description TEXT;
ALTER TABLE lummet_brands ADD COLUMN og_image TEXT;

-- ---- Pages: social image ------------------------------
ALTER TABLE lummet_pages ADD COLUMN og_image TEXT;

-- ---- Updates: per-page SEO ----------------------------
ALTER TABLE lummet_updates ADD COLUMN seo_title TEXT;
ALTER TABLE lummet_updates ADD COLUMN seo_description TEXT;
ALTER TABLE lummet_updates ADD COLUMN og_image TEXT;

-- ---- Publications (Insights): per-page SEO ------------
ALTER TABLE lummet_publications ADD COLUMN seo_title TEXT;
ALTER TABLE lummet_publications ADD COLUMN seo_description TEXT;
ALTER TABLE lummet_publications ADD COLUMN og_image TEXT;

-- ---- Homepage sections become the homepage layout -----
-- `kind` decides which component renders the row:
--   text | features | steps | checklist | brands | stats |
--   updates | insights | partners | faq | panel | cta | contact
-- Existing rows keep working as kind = 'text'.
ALTER TABLE lummet_homepage_sections ADD COLUMN section_key TEXT;
ALTER TABLE lummet_homepage_sections ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE lummet_homepage_sections ADD COLUMN feature_group TEXT;
ALTER TABLE lummet_homepage_sections ADD COLUMN background TEXT NOT NULL DEFAULT 'default';

-- ---- Features: cards, steps and checklist items -------
-- Rendered by homepage sections of kind features / steps /
-- checklist, selected through lummet_homepage_sections.feature_group.
CREATE TABLE IF NOT EXISTS lummet_features (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feature_key TEXT NOT NULL UNIQUE,
    group_key TEXT NOT NULL,
    icon TEXT,                       -- name from the built-in inline icon set
    title TEXT NOT NULL,
    body TEXT,
    link_label TEXT,
    link_href TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_features_group ON lummet_features(group_key, status, sort_order);

-- ---- Navigation links (header + footer columns) -------
-- visible_when hides a link until the thing it points at
-- actually has published content:
--   always | has_brands | has_updates | has_publications | has_partners
CREATE TABLE IF NOT EXISTS lummet_nav_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    placement TEXT NOT NULL,         -- header | header_cta | footer_platform | footer_company | footer_legal
    label TEXT NOT NULL,
    href TEXT NOT NULL,
    visible_when TEXT NOT NULL DEFAULT 'always',
    status TEXT NOT NULL DEFAULT 'published',   -- draft | published
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (placement, label)
);

CREATE INDEX IF NOT EXISTS idx_lummet_nav_links_placement ON lummet_nav_links(placement, status, sort_order);

-- ---- FAQs ---------------------------------------------
CREATE TABLE IF NOT EXISTS lummet_faqs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_key TEXT NOT NULL DEFAULT 'general',
    question TEXT NOT NULL UNIQUE,
    answer TEXT NOT NULL,            -- plain text or simple HTML
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_faqs_group ON lummet_faqs(group_key, status, sort_order);

-- Homepage sections are addressed by a stable key (also used as the
-- section's anchor id on the page, e.g. /#brands). NULL keys stay
-- distinct, so rows created before this migration are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lummet_homepage_sections_key ON lummet_homepage_sections(section_key);
