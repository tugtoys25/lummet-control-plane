-- =====================================================
-- LUMMET CMS SCHEMA (Phase 9)
--
-- Everything below is content OWNED BY LUMMET ITSELF —
-- lummet.com's own public site (pages, authors, brand
-- profiles, partners, updates, publications, adverts,
-- and the homepage's editable copy). This is deliberately
-- separate from the tenant registry tables above and from
-- any tenant's own content, which still lives only in that
-- tenant's own D1, reachable solely over the Super API.
-- =====================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------
-- AUTHORS — bylines for lummet.com's own pages, updates,
-- and publications (separate from any tenant's authors
-- table, which lives on that tenant's own D1).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    title TEXT,                    -- e.g. "Editor", "Head of Partnerships"
    bio TEXT,
    avatar_url TEXT,
    social_links TEXT,             -- raw JSON string, e.g. {"twitter":"..."}
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------
-- PAGES — arbitrary standalone pages (About, Careers,
-- Press Kit, etc.), served at /p/:slug when published.
-- The homepage itself is NOT a row here — its editable
-- copy lives in lummet_site_settings below, since it has
-- a fixed, richer layout rather than free-form content.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_pages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT,                  -- HTML from the rich text editor
    excerpt TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    author_id INTEGER REFERENCES lummet_authors(id) ON DELETE SET NULL,
    seo_title TEXT,
    seo_description TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_pages_status ON lummet_pages(status);

-- -----------------------------------------------------
-- BRAND PROFILES — editorial profiles for brands in the
-- Lummet portfolio, shown on lummet.com. Optionally linked
-- to a registered tenant (`tenant_id`), but a profile can
-- also exist on its own (e.g. a brand not yet/never run
-- through this control plane).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    tagline TEXT,
    description TEXT,              -- HTML
    logo_url TEXT,
    website_url TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_brands_status ON lummet_brands(status);

-- -----------------------------------------------------
-- PARTNERS — shown on lummet.com's Partners page.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    partner_type TEXT,             -- e.g. technology | payments | affiliate | media
    logo_url TEXT,
    website_url TEXT,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_partners_status ON lummet_partners(status);

-- -----------------------------------------------------
-- UPDATES — Lummet-level platform/product updates
-- (distinct from a tenant's own "Updates" content type,
-- which stays on that tenant's own D1).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT,                  -- HTML
    excerpt TEXT,
    author_id INTEGER REFERENCES lummet_authors(id) ON DELETE SET NULL,
    featured_image TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    published_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_updates_status ON lummet_updates(status, published_at);

-- -----------------------------------------------------
-- PUBLICATIONS — Lummet's own blog posts / press
-- mentions / reports.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_publications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT,                  -- HTML
    excerpt TEXT,
    publication_type TEXT NOT NULL DEFAULT 'blog',  -- blog | press | report
    source_name TEXT,              -- e.g. an external outlet's name, if type = press
    source_url TEXT,
    author_id INTEGER REFERENCES lummet_authors(id) ON DELETE SET NULL,
    featured_image TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
    published_at TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_publications_status ON lummet_publications(status, published_at);

-- -----------------------------------------------------
-- ADVERTISEMENTS — placements rendered on lummet.com
-- itself (not a tenant's ad system, which is unrelated
-- and lives on that tenant's own D1/settings).
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_advertisements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    placement TEXT NOT NULL,       -- e.g. homepage_banner | homepage_sidebar
    image_url TEXT,
    link_url TEXT,
    alt_text TEXT,
    status TEXT NOT NULL DEFAULT 'draft',   -- draft | active | paused
    start_date TEXT,
    end_date TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_lummet_ads_placement ON lummet_advertisements(placement, status);

-- -----------------------------------------------------
-- SITE SETTINGS — key/value store for the homepage's
-- editable copy (hero title, subtitle, CTA labels, contact
-- email, etc.) so it's no longer hardcoded in home.js.
-- Same shape as the tenant's own `settings` table.
-- -----------------------------------------------------

CREATE TABLE IF NOT EXISTS lummet_site_settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
