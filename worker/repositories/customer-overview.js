// Read-only queries behind the customer Overview (worker/customer-overview.js). All SQL for that page lives here.
const marks = (a) => (a.length ? a.map(() => "?").join(",") : "NULL");

/** Newest deployment of each site: [{site_id, version, status, created_at, completed_at}]. */
export async function latestDeployments(env, siteIds) {
  if (!siteIds.length) return [];
  return (await env.LUMMET_DB.prepare(
    `SELECT d.site_id, d.version, d.status, d.created_at, d.completed_at FROM deployments d
      WHERE d.site_id IN (${marks(siteIds)}) AND d.id = (SELECT d2.id FROM deployments d2 WHERE d2.site_id = d.site_id ORDER BY d2.created_at DESC, d2.rowid DESC LIMIT 1)`
  ).bind(...siteIds).all()).results || [];
}

/** Health status of the tenant behind each site: [{site_id, health_status, last_checked_at}]. */
export async function siteHealth(env, siteIds) {
  if (!siteIds.length) return [];
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id AS site_id, h.status AS health_status, h.last_checked_at FROM sites s JOIN tenant_health h ON h.tenant_id = s.tenant_id WHERE s.id IN (${marks(siteIds)})`
  ).bind(...siteIds).all()).results || [];
}

/** Custom domains that are not fully working yet, or failed. */
export async function domainIssues(env, siteIds) {
  if (!siteIds.length) return [];
  return (await env.LUMMET_DB.prepare(
    `SELECT site_id, hostname, status, failure_reason FROM domains WHERE site_id IN (${marks(siteIds)}) AND removed_at IS NULL AND status IN ('pending','dns_verified','ssl_pending','failed') ORDER BY created_at DESC LIMIT 10`
  ).bind(...siteIds).all()).results || [];
}

export async function recentDeployments(env, siteIds, limit = 8) {
  if (!siteIds.length) return [];
  return (await env.LUMMET_DB.prepare(
    `SELECT d.site_id, d.version, d.status, d.is_rollback, d.created_at FROM deployments d WHERE d.site_id IN (${marks(siteIds)}) ORDER BY d.created_at DESC, d.rowid DESC LIMIT ${Number(limit) | 0}`
  ).bind(...siteIds).all()).results || [];
}

/** Customer-safe audit rows of one organization (no ip, no staff ids). */
export async function recentOrgAudit(env, organizationId, limit = 8) {
  return (await env.LUMMET_DB.prepare(
    `SELECT created_at, actor_type, action, resource, success FROM lummet_audit_logs
      WHERE organization_id = ? AND success = 1 AND action IS NOT NULL AND action NOT IN ('read','view','list') ORDER BY id DESC LIMIT ${Number(limit) | 0}`
  ).bind(organizationId).all()).results || [];
}

export async function latestInvoice(env, organizationId) {
  return env.LUMMET_DB.prepare(
    `SELECT status, amount_due_cents, amount_paid_cents, total_cents, currency, due_at, hosted_invoice_url FROM invoices WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).bind(organizationId).first();
}

export async function failedPaymentsSince(env, organizationId, days) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) AS n FROM payments WHERE organization_id = ? AND status = 'failed' AND date(created_at) >= date('now','-${Number(days) - 1} days')`
  ).bind(organizationId).first();
  return r ? r.n : 0;
}

export async function defaultPaymentMethod(env, organizationId) {
  return env.LUMMET_DB.prepare(
    `SELECT type, card_brand, card_last4 FROM billing_payment_methods WHERE organization_id = ? AND status = 'active' ORDER BY is_default DESC, rowid DESC LIMIT 1`
  ).bind(organizationId).first();
}
