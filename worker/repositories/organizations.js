/** SQL-only organization queries shared by scheduled services. */
export async function selectOrganizationIdsAfter(env, afterId = '', limit = 100) {
  const page = await env.LUMMET_DB.prepare(
    `SELECT id FROM organizations WHERE id > ? ORDER BY id LIMIT ?`
  ).bind(afterId, Math.min(500, Math.max(1, Number(limit) || 100))).all();
  return page.results || [];
}

export async function findPendingInvitationByEmail(env, organizationId, email, nowIso = new Date().toISOString()) {
  return env.LUMMET_DB.prepare(
    `SELECT id FROM organization_invitations WHERE organization_id = ? AND lower(email) = ? AND status = 'pending' AND expires_at > ? LIMIT 1`
  ).bind(organizationId, String(email || '').trim().toLowerCase(), nowIso).first();
}
