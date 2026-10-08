// =====================================================
// DATA RETENTION POLICY  (roadmap 1.3)
//
// ONE place that says what happens to each kind of data when an organization or
// a person is erased. THE DEFAULTS BELOW ARE A DRAFT: they are conservative
// engineering choices, NOT legal advice. A lawyer must confirm the financial
// retention period and the audit-log treatment for your jurisdictions before you
// rely on them. Changing a value here changes behavior everywhere.
//
// A test (test/erasure.test.js) fails if a table that references an organization,
// site or user is missing from this file, so new tables cannot silently escape
// the erasure process.
// =====================================================

/** Years to keep billing records of an erased organization (tax/accounting law varies; 7 is a common upper bound). */
export const FINANCIAL_RETENTION_YEARS = 7;

/** Rows removed outright when an organization is erased. [table, SQL condition on that table, parameter kind] */
export const ORG_DELETE = [
  ["automation_alerts", "organization_id = ?"],
  ["automation_runs", "organization_id = ?"],
  ["automation_rules", "organization_id = ?"],
  ["backup_restores", "organization_id = ?"],
  ["change_requests", "organization_id = ?"],
  ["customer_api_keys", "organization_id = ?"],
  ["coupon_redemptions", "organization_id = ?"],
  ["coupon_reservations", "organization_id = ?"],
  ["coupons", "organization_id = ?"],             // only coupons reserved for this organization; shared coupons have no organization_id
  ["email_outbox", "organization_id = ?"],
  ["organization_branding", "organization_id = ?"],
  ["organization_invitations", "organization_id = ?"],
  ["organization_sso_domains", "organization_id = ?"],
  ["organization_sso_settings", "organization_id = ?"],
  ["organization_users", "organization_id = ?"],
  ["sso_login_states", "organization_id = ?"],
  ["usage_events", "organization_id = ?"],
  ["usage_counters", "organization_id = ?"],
  ["webhooks", "organization_id = ?"],            // delivery history cascades with it
  ["site_backups", "organization_id = ?"],
  ["jobs", "organization_id = ?"]                 // steps, runs, attempts and logs cascade with it
];

/** Rows removed for each of the organization's sites. */
export const SITE_DELETE = [
  ["deployments", "site_id = ?"],
  ["domains", "site_id = ?"],                      // domain events cascade
  ["site_migrations_applied", "site_id = ?"],
  ["site_status_events", "site_id = ?"],
  ["site_resources", "site_id = ?"]
];

/** Kept for FINANCIAL_RETENTION_YEARS after erasure, then removed by the retention sweep. */
export const FINANCIAL_RETAINED = ["subscriptions", "subscription_status_events", "invoices", "payments", "billing_customers", "usage_monthly", "ai_credit_ledger"];

/** Kept as anonymous tombstones: personal fields are overwritten, the row stays so references remain valid. */
export const TOMBSTONED = ["organizations", "sites", "customer_users"];

/** Audit rows are kept (security and accountability) but lose personal content. */
export const AUDIT_TABLE = "lummet_audit_logs";

/** Rows removed outright when a PERSON is erased. */
export const USER_DELETE = [
  ["customer_sessions", "user_id = ?"],
  ["customer_password_resets", "user_id = ?"],
  ["customer_email_verifications", "user_id = ?"],
  ["customer_mfa_challenges", "user_id = ?"],
  ["webauthn_challenges", "user_id = ?"],
  ["customer_totp", "user_id = ?"],
  ["customer_webauthn_credentials", "user_id = ?"],
  ["organization_users", "user_id = ?"]
];

/**
 * Tables that mention organizations, sites, users or emails but are NOT customer data
 * (platform staff, tenant registry, system tables) or that are covered by cascade/other
 * rules. Each needs a reason, so an omission is a decision, not an accident.
 */
export const OUT_OF_SCOPE = {
  lummet_inquiries: "visitor contact/demo submissions are not tied to an account, so erasing a person (or an organization with a billing email) deletes the submissions made with that email address; anything else is deleted by staff in Site Forms > Inquiries",
  lummet_admin_permissions: "staff data", lummet_admin_tenant_access: "staff data", lummet_admin_totp: "staff data",
  lummet_admins: "staff data", lummet_ai_conversations: "staff data", lummet_ai_pending_operations: "staff data",
  lummet_auth_attempts: "hashed IP only, pruned by age", lummet_brands: "tenant registry", lummet_mfa_challenges: "staff data",
  lummet_sessions: "staff data", tenant_api_credentials: "removed with the tenant registry row", tenant_capabilities: "removed with the tenant registry row",
  tenant_health: "removed with the tenant registry row", tenant_template_releases: "platform releases", domain_events: "cascades with domains",
  webhook_deliveries: "cascades with webhooks", job_steps: "cascades with jobs", tenants: "removed per site, see eraseOrganization"
};
