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

/** Active people who could approve a deletion: owners and admins whose account is not disabled. */
export async function countApprovers(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) AS n FROM organization_users ou JOIN customer_users u ON u.id = ou.user_id
      WHERE ou.organization_id = ? AND ou.role IN ('admin', 'owner') AND u.status = 'active'`
  ).bind(organizationId).first();
  return row?.n || 0;
}

/** Closes pending deletion requests for a site that was deleted another way, so none is left waiting on an approver who does not exist. */
export async function cancelPendingSiteDeletions(env, organizationId, siteId, note) {
  await env.LUMMET_DB.prepare(
    `UPDATE change_requests SET status = 'canceled', reason = COALESCE(?, reason), resolved_at = CURRENT_TIMESTAMP
      WHERE organization_id = ? AND resource_id = ? AND type = 'site_deletion' AND status = 'pending'`
  ).bind(note || null, organizationId, siteId).run();
}
