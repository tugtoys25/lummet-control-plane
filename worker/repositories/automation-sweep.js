// Which live sites the automation sweep should look at next (v7H). All SQL for it lives here.

/**
 * Live sites whose organization has an ACTIVE rule for this trigger, least recently swept first.
 * (Entitlement is checked again by runAutomations; a rule that exists but is not entitled costs one cheap skip.)
 */
export async function listSitesDue(env, eventType, limit) {
  return (await env.LUMMET_DB.prepare(
    `SELECT DISTINCT s.id, s.organization_id, s.name, s.tenant_id
       FROM sites s
       JOIN automation_rules r ON r.organization_id = s.organization_id AND r.trigger_event = ? AND r.status = 'active'
       LEFT JOIN automation_sweep_state w ON w.site_id = s.id
      WHERE s.status = 'active' AND s.tenant_id IS NOT NULL
      ORDER BY COALESCE(w.last_swept_at, '') ASC, s.id ASC
      LIMIT ?`
  ).bind(eventType, limit).all()).results;
}

export async function markSwept(env, siteId) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO automation_sweep_state (site_id, last_swept_at) VALUES (?, CURRENT_TIMESTAMP)
     ON CONFLICT(site_id) DO UPDATE SET last_swept_at = CURRENT_TIMESTAMP`
  ).bind(siteId).run();
}
