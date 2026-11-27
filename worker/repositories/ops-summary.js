// Read-only queries behind the staff Overview (worker/ops-summary.js). All SQL for that page lives here.
const inList = (ids) => (ids && ids.length ? ids.map(() => "?").join(",") : "NULL");

export async function tenantsWithHealth(env) {
  return (await env.LUMMET_DB.prepare(
    `SELECT t.id, t.name, t.status, h.status AS health_status, h.last_checked_at, h.last_error, h.api_version
     FROM tenants t LEFT JOIN tenant_health h ON h.tenant_id = t.id ORDER BY t.name`
  ).all()).results || [];
}

/** Latest audit rows; `ids` (array) limits them to those tenants, null means all. */
export async function recentAudit(env, ids, limit = 10) {
  const scoped = Array.isArray(ids);
  return (await env.LUMMET_DB.prepare(
    `SELECT a.*, t.name AS tenant_name FROM lummet_audit_logs a LEFT JOIN tenants t ON t.id = a.tenant_id
     ${scoped ? `WHERE a.tenant_id IN (${inList(ids)})` : ""} ORDER BY a.created_at DESC LIMIT ${Number(limit) | 0}`
  ).bind(...(scoped ? ids : [])).all()).results || [];
}

export async function failedAuditByDay(env, days, ids) {
  const scoped = Array.isArray(ids);
  return (await env.LUMMET_DB.prepare(
    `SELECT date(created_at) AS d, COUNT(*) AS n FROM lummet_audit_logs WHERE success = 0 AND date(created_at) >= date('now','-${Number(days) - 1} days')
     ${scoped ? `AND tenant_id IN (${inList(ids)})` : ""} GROUP BY d`
  ).bind(...(scoped ? ids : [])).all()).results || [];
}

export async function rolloutItemCounts(env, rolloutId) {
  return (await env.LUMMET_DB.prepare(`SELECT status, COUNT(*) AS n FROM tenant_rollout_items WHERE rollout_id = ? GROUP BY status`).bind(rolloutId).all()).results || [];
}

export async function subscriptionCounts(env) {
  return (await env.LUMMET_DB.prepare(`SELECT status, COUNT(*) AS n FROM subscriptions GROUP BY status`).all()).results || [];
}

export async function failedPaymentsSince(env, days) {
  const r = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM payments WHERE status = 'failed' AND date(created_at) >= date('now','-${Number(days) - 1} days')`).first();
  return r ? r.n : 0;
}

export async function overdueInvoices(env) {
  return (await env.LUMMET_DB.prepare(
    `SELECT currency, COUNT(*) AS n, SUM(amount_due_cents - COALESCE(amount_paid_cents,0)) AS cents FROM invoices
     WHERE status = 'open' AND due_at IS NOT NULL AND due_at < datetime('now') GROUP BY currency`
  ).all()).results || [];
}

export async function subscriptionsAtRisk(env, limit = 5) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id, s.status, s.grace_ends_at, o.name AS org FROM subscriptions s JOIN organizations o ON o.id = s.organization_id
     WHERE s.status IN ('past_due','restricted','unpaid','suspended') ORDER BY s.updated_at DESC LIMIT ${Number(limit) | 0}`
  ).all()).results || [];
}

export async function deploymentsByDay(env, days, badOnly = false) {
  return (await env.LUMMET_DB.prepare(
    `SELECT date(created_at) AS d, COUNT(*) AS n FROM deployments WHERE ${badOnly ? "status IN ('failed','rolled_back') AND " : ""}date(created_at) >= date('now','-${Number(days) - 1} days') GROUP BY d`
  ).all()).results || [];
}
