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
  ["billing_notifications", "organization_id = ?"],
  ["cancellation_feedback", "organization_id = ?"],
  ["usage_snapshots", "organization_id = ?"],
  ["staff_billing_notes", "organization_id = ?"],
  ["dunning_actions", "organization_id = ?"],
  ["quotes", "organization_id = ?"],
  ["organization_branding", "organization_id = ?"],
  ["organization_invitations", "organization_id = ?"],
  ["organization_sso_domains", "organization_id = ?"],
  ["organization_sso_settings", "organization_id = ?"],
  ["organization_security_policies", "organization_id = ?"],   // org security policy (2FA requirement; no personal data); removed with the organization
  ["organization_users", "organization_id = ?"],
  ["sso_login_states", "organization_id = ?"],
  ["usage_events", "organization_id = ?"],
  ["usage_counters", "organization_id = ?"],
  ["webhooks", "organization_id = ?"],            // delivery history cascades with it
  ["site_backups", "organization_id = ?"],
  ["jobs", "organization_id = ?"],                // steps, runs, attempts and logs cascade with it
  ["subscription_access_shadow", "organization_id = ?"],   // billing lifecycle shadow-mode log (no personal data)
  ["billing_cancel_pending", "organization_id = ?"],       // queued Stripe cancellation; irrelevant once the organization is erased
  ["trial_fingerprints", "organization_id = ?"],           // hashed anti-abuse record; removed with the organization (privacy over abuse memory)
  ["plan_sync_issues", "organization_id = ?"],             // plan sync findings (price ids and plan ids only, no personal data)
  ["reconciliation_findings", "organization_id = ?"],     // source-of-truth discrepancies removed with the organization
  ["billing_payment_methods", "organization_id = ?"],    // card metadata/fingerprint is not needed after account erasure
  ["addon_change_intents", "organization_id = ?"],        // add-on change requests (ids and quantities only); provider state stays in Stripe
  ["billing_save_offers", "organization_id = ?"]           // cancellation save-flow offers shown to the customer; no financial effect on their own
];

/** Rows removed for each of the organization's sites. */
export const SITE_DELETE = [
  ["deployments", "site_id = ?"],
  ["domains", "site_id = ?"],                      // domain events cascade
  ["domain_zones", "site_id = ?"],                 // delegated domains; zone events cascade (provider zones are deleted first, see erasure.js)
  ["site_migrations_applied", "site_id = ?"],
  ["site_status_events", "site_id = ?"],
  ["site_resources", "site_id = ?"],
  ["tenant_rollout_items", "site_id = ?"],         // the site's line in a release rollout (the rollout itself is platform data)
  ["automation_sweep_state", "site_id = ?"],
  ["site_access_push_jobs", "site_id = ?"],
  ["site_storage_limit_sync", "site_id = ?"],
  ["site_storage_usage", "site_id = ?"]
];

/** Kept for FINANCIAL_RETENTION_YEARS after erasure, then removed by the retention sweep. */
export const FINANCIAL_RETAINED = ["subscriptions", "subscription_status_events", "subscription_movements", "subscription_revenue_state", "plan_change_intents", "invoices", "payments", "refunds", "disputes", "credit_notes", "organization_billing_profiles", "billing_customers", "usage_monthly", "ai_credit_ledger", "credit_pack_grants", "credit_pack_reversals", "staff_approval_requests", "immediate_cancel_decisions", "founder_license_grants", "quote_entitlement_grants"];

/** Retained tables that have no organization_id of their own: removed through their subscription when the retention period ends. */
// v2.6.0.1: revenue movements and state are financial records kept with the subscription, then removed with it.
export const SUBSCRIPTION_SCOPED = ["subscription_status_events", "plan_change_intents", "subscription_movements", "subscription_revenue_state"];

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
  quote_lines: "cascades with quotes; quote rows tied to an organization are removed by ORG_DELETE; unlinked sales leads require staff privacy-request review",
  lummet_admin_permissions: "staff data", lummet_admin_tenant_access: "staff data", lummet_admin_totp: "staff data",
  lummet_admins: "staff data", lummet_ai_conversations: "staff data", lummet_ai_pending_operations: "staff data",
  lummet_auth_attempts: "hashed IP only, pruned by age", lummet_brands: "tenant registry", lummet_mfa_challenges: "staff data",
  lummet_sessions: "staff data", tenant_api_credentials: "removed with the tenant registry row", tenant_capabilities: "removed with the tenant registry row",
  tenant_health: "removed with the tenant registry row", tenant_template_releases: "platform releases", staff_api_tokens: "staff data: CI credentials, stored hashed", tenant_rollouts: "platform releases: which release went to which sites, no personal data", tenant_rollout_items: "erased per site (see SITE_DELETE) and cascades with tenant_rollouts", domain_events: "cascades with domains", domain_zone_events: "cascades with domain_zones",
  webhook_deliveries: "cascades with webhooks", job_steps: "cascades with jobs", tenants: "removed per site, see eraseOrganization"
};
