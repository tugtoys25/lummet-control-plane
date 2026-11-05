// =====================================================
// DEFAULT SETTINGS SEEDED INTO EVERY NEWLY GENERATED TENANT
//
// A new site's database is built from the active tenant release's migrations. On the site's FIRST deploy (the one that
// takes it from "provisioned" to live) deployments.js appends the migrations returned here, after the release's own, so
// the rows land in a database whose `settings` table already exists.
//
// Why a migration and not a release file: it is recorded in site_migrations_applied under a fixed name, so it runs
// exactly once per site. A later redeploy, a rollout or a rollback never re-applies it, and the customer's own edits to
// the announcement bar (Header & Hero admin page) are never overwritten. Sites that were already live are not touched.
//
// The keys are the ones the tenant's Header & Hero page manages (lummet-tenant en/worker/header-hero/schema.js).
// =====================================================

export const DEFAULT_SITE_ANNOUNCEMENT = Object.freeze([
  ["site_announce_enabled", "true"],
  ["site_announce_text", "Launch your own affiliate business with Lummet.com, ready in 5 minutes."],
  ["site_announce_link_text", "Start with Lummet"],
  ["site_announce_url", "https://lummet.com"],
  ["site_announce_tone", "promo"],
  ["site_announce_dismissible", "true"]
]);

export const DEFAULT_ANNOUNCEMENT_MIGRATION = "provision_0001_default_site_announcement";

const q = (v) => "'" + String(v).replace(/'/g, "''") + "'";

/** The seed as one INSERT OR REPLACE statement (a brand-new database has nothing worth keeping under these keys). */
export function defaultAnnouncementSql() {
  const rows = DEFAULT_SITE_ANNOUNCEMENT.map(([k, v]) => `(${q(k)},${q(v)})`).join(",\n");
  return `INSERT OR REPLACE INTO settings (key, value) VALUES\n${rows};`;
}

// Phase 9: a new tenant starts in the setup wizard. The tenant's own migration 0013 marks the setup of a database as complete (that is
// right for sites that were already in use), so this seed, which runs AFTER the release's migrations on the first deploy only, puts the
// two keys back to "pending / new". It is what makes the wizard appear even when applying the preset (site-setup.js) fails.
export const SETUP_PENDING_MIGRATION = "provision_0002_site_setup_pending";

export function setupPendingSql() {
  return `INSERT OR REPLACE INTO settings (key, value) VALUES\n('site_setup_state','pending'),\n('site_setup_source','new');`;
}

/** Migrations applied only on a site's first deploy, after the release's own migrations. */
export function newTenantSeedMigrations() {
  return [
    { name: DEFAULT_ANNOUNCEMENT_MIGRATION, sql: defaultAnnouncementSql() },
    { name: SETUP_PENDING_MIGRATION, sql: setupPendingSql() }
  ];
}
