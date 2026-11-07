-- =====================================================
-- TENANT TEMPLATE LINES (release 2.7.1)
--
-- Until now every site ran ONE application (lummet-tenant). A "template line" is a family of releases for one
-- application, so a second application can be released to R2 and provisioned on its own track:
--
--   casino      lummet-tenant (the existing application; every existing product and release stays on it)
--   brokerage   luminousagents (casino and hospitality brokerage sites)
--
-- Purely additive and backwards compatible: every existing row is 'casino', and every code path that does not name
-- a line keeps meaning 'casino'.
--
--   products.template_line                 which application a product's sites run
--   tenant_template_releases.template_line which application a published release belongs to
--   tenant_rollouts.template_line          which application a rollout deploys
--
-- A release's R2 key and version stay unique across lines (versions are globally unique), exactly one release per
-- line is 'active' (enforced in worker/repositories/tenant-releases.js), and at most ONE rollout per line runs at a time.
-- =====================================================
ALTER TABLE products ADD COLUMN template_line TEXT NOT NULL DEFAULT 'casino';
ALTER TABLE tenant_template_releases ADD COLUMN template_line TEXT NOT NULL DEFAULT 'casino';
ALTER TABLE tenant_rollouts ADD COLUMN template_line TEXT NOT NULL DEFAULT 'casino';

CREATE INDEX IF NOT EXISTS idx_template_releases_line ON tenant_template_releases(template_line, status, created_at);

DROP INDEX IF EXISTS uniq_tenant_rollouts_running;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tenant_rollouts_running_line ON tenant_rollouts(template_line) WHERE status = 'running';

-- The brokerage product. No plan is seeded: price and trial are an owner decision, set in the staff Plan and pricing manager
-- (the product appears there). Any customer whose plan allows sites can already create a site of this product.
INSERT OR IGNORE INTO products (id, key, name, category, status, template_line)
VALUES ('prod_brokerage_site', 'brokerage_site', 'Brokerage Site', 'business', 'active', 'brokerage');
