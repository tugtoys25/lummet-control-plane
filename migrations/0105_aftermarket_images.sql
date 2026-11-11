-- 0105: website link and images for aftermarket listings
--
--  * lummet_listings.website_url   the business's own website (https only). Shown under the location and clickable on the public page.
--  * lummet_listing_images         images attached to a domain (one cover image) or a business listing (up to ten: logo, screenshots, photos).
--                                  The file itself lives in the platform media library (R2 binding PLATFORM_MEDIA, table platform_media), so it is
--                                  checked by its bytes and served from /brand-media/<key> like every other platform image. This table only says
--                                  which image belongs to which listing, in which order, and whether staff hid it.
--                                  media_id is shared when two sellers upload the identical file; a file is deleted only when no listing uses it.

ALTER TABLE lummet_listings ADD COLUMN website_url TEXT;

CREATE TABLE IF NOT EXISTS lummet_listing_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_kind TEXT NOT NULL,                          -- domain | listing
    subject_id INTEGER NOT NULL,                         -- lummet_aftermarket_domains.id or lummet_listings.id
    media_id TEXT NOT NULL,                              -- platform_media.id
    caption TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,               -- lowest first; the first image is the cover
    status TEXT NOT NULL DEFAULT 'published',            -- published | hidden (staff can hide an image without deleting it)
    organization_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_lummet_listing_images_subject ON lummet_listing_images(subject_kind, subject_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_lummet_listing_images_media ON lummet_listing_images(media_id);
CREATE INDEX IF NOT EXISTS idx_lummet_listing_images_org ON lummet_listing_images(organization_id);

INSERT OR IGNORE INTO lummet_ui_strings (ui_key, value, group_key) VALUES
  ('listing_fact_website', 'Website', 'listings'),
  ('listing_gallery_label', 'Images', 'listings');
