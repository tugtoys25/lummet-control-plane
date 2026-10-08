// =====================================================
// ORGANIZATION AUDIT LOG (master prompt section 33,
// "advanced audit" — Phase 7)
//
// Pure read layer over lummet_audit_logs (migration 0001,
// extended in migration 0007 with organization_id/actor_type).
// No new writes happen here — every audit event this surfaces
// was already being recorded by logAudit() calls throughout
// index.js since Phase 1; this just gives the organization
// that owns those events a scoped way to see them.
// =====================================================

export async function listOrganizationAuditLog(env, organizationId, { limit = 100 } = {}) {
  const result = await env.LUMMET_DB.prepare(
    `SELECT endpoint, method, resource, resource_id, action, success, status_code, error_message, actor_type, customer_user_id, created_at
     FROM lummet_audit_logs WHERE organization_id = ? ORDER BY id DESC LIMIT ?`
  )
    .bind(organizationId, Math.min(limit, 500))
    .all();
  return result.results || [];
}
