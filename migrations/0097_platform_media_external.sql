-- Release 2.8.1: a library entry can be an image kept at its own https address (added by link, like the tenant's "Add image from external URL").
-- external_url is NULL for a stored file (r2_key is its object key). For an entry added by link, external_url is the address and r2_key is
-- the placeholder 'ext:<id>' (unique, and never a valid object key, so nothing is ever read from or deleted in R2 for it).
ALTER TABLE platform_media ADD COLUMN external_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_platform_media_external ON platform_media(external_url) WHERE external_url IS NOT NULL;
