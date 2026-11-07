-- Site address reservation, per platform domain. Additive, idempotent in the sense the runner applies each file once.
--
-- Until now a site's address label WAS its slug (<slug>.<domain>), and the slug is unique across the whole platform
-- because the Worker, D1, KV and R2 names derive from it. That forced a number onto a customer's name ("review-2")
-- the moment anyone, on any domain, had used it.
--
-- host_label  the label the customer sees and chose: <host_label>.<platform domain>. Unique per platform domain among
--             sites that are not deleted. `slug` stays globally unique and internal (resource names only).
--             A name taken on reviews.lummet.app is still free on reviews.sze.app.
-- Existing sites keep their address: host_label starts equal to slug.
ALTER TABLE sites ADD COLUMN host_label TEXT;
UPDATE sites SET host_label = slug WHERE host_label IS NULL AND status != 'deleted';

-- A NULL platform_domain_id means "the default platform domain" (legacy rows); the worker code treats it that way when it
-- checks availability, this index covers every site written with an explicit domain id (all new sites).
-- A 'deleting' site still holds its address: its route may still be live. 'deleted' releases it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_host_label_per_domain
    ON sites(COALESCE(platform_domain_id, ''), host_label)
    WHERE host_label IS NOT NULL AND status != 'deleted';
CREATE INDEX IF NOT EXISTS idx_sites_host_label ON sites(host_label);
