// Organization audit log read for export (table lummet_audit_logs, migrations 0001, 0007, 0008): one bounded keyset page (Round 6.4B).
// Only columns that are safe for a customer to see are selected: no ip_hash, no staff admin_id, no tenant_id.

/** Rows of ONE organization with id below beforeId (or the newest rows when beforeId is null), newest first. */
export async function page(env, { organizationId, limit, beforeId }) {
  const paged = beforeId != null;
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, created_at, actor_type, customer_user_id, action, resource, resource_id, endpoint, method, success, status_code, error_message, reason, request_id
       FROM lummet_audit_logs
      WHERE organization_id = ?${paged ? " AND id < ?" : ""}
      ORDER BY id DESC LIMIT ?`
  ).bind(...[organizationId, ...(paged ? [beforeId] : []), limit]).all();
  return r.results || [];
}
