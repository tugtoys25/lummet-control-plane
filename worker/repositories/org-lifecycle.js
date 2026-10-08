// Organization deletion lifecycle state. (Repository: SQL for staff stop-deletion.)

export async function findDeletionState(env, organizationId) {
  return env.LUMMET_DB.prepare(`SELECT id, scheduled_deletion_at, erased_at FROM organizations WHERE id = ?`).bind(organizationId).first();
}

/** Clears a scheduled erasure and reopens the organization. */
export async function clearScheduledDeletion(env, organizationId) {
  await env.LUMMET_DB.prepare(
    `UPDATE organizations SET status = 'active', scheduled_deletion_at = NULL, deletion_requested_by = NULL, deletion_requested_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(organizationId).run();
}
