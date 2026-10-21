// Change requests (approval workflow rows) (v7I). All SQL for change_requests.

export async function findPendingSiteDeletion(env, organizationId, siteId) {
  return env.LUMMET_DB.prepare(
    `SELECT id FROM change_requests WHERE organization_id = ? AND resource_id = ? AND type = 'site_deletion' AND status = 'pending'`
  ).bind(organizationId, siteId).first();
}

export async function insertSiteDeletion(env, { id, organizationId, siteId, requestedBy, reason }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO change_requests (id, organization_id, type, resource_id, requested_by, reason) VALUES (?, ?, 'site_deletion', ?, ?, ?)`
  ).bind(id, organizationId, siteId, requestedBy || null, reason || null).run();
}

export async function list(env, organizationId, status) {
  const result = status
    ? await env.LUMMET_DB.prepare(`SELECT * FROM change_requests WHERE organization_id = ? AND status = ? ORDER BY created_at DESC`).bind(organizationId, status).all()
    : await env.LUMMET_DB.prepare(`SELECT * FROM change_requests WHERE organization_id = ? ORDER BY created_at DESC`).bind(organizationId).all();
  return result.results || [];
}

export async function findPending(env, organizationId, changeRequestId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM change_requests WHERE id = ? AND organization_id = ? AND status = 'pending'`).bind(changeRequestId, organizationId).first();
}

export async function markApproved(env, changeRequestId, approverUserId) {
  await env.LUMMET_DB.prepare(
    `UPDATE change_requests SET status = 'approved', approved_by = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(approverUserId || null, changeRequestId).run();
}

export async function markRejected(env, changeRequestId, approverUserId, reason) {
  await env.LUMMET_DB.prepare(
    `UPDATE change_requests SET status = 'rejected', approved_by = ?, reason = COALESCE(?, reason), resolved_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(approverUserId || null, reason || null, changeRequestId).run();
}
