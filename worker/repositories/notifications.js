// In-app notifications for an organization (v7F). The rows are the automation_alerts the automation engine already
// writes (create_alert action); this is the read/acknowledge side that had no screen. All SQL for it lives here.

export async function list(env, organizationId, { status = "open", limit = 100 } = {}) {
  const where = status === "all" ? "" : "AND status = ?";
  const binds = status === "all" ? [organizationId, limit] : [organizationId, status, limit];
  return (await env.LUMMET_DB.prepare(
    `SELECT a.id, a.rule_id, a.message, a.status, a.created_at, r.name AS rule_name
       FROM automation_alerts a LEFT JOIN automation_rules r ON r.id = a.rule_id
      WHERE a.organization_id = ? ${where.replace("status", "a.status")}
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
  ).bind(...binds).all()).results;
}

export async function countOpen(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) AS n FROM automation_alerts WHERE organization_id = ? AND status = 'open'`
  ).bind(organizationId).first();
  return row?.n || 0;
}

/** Moves a notification forward: open -> acknowledged -> resolved. Returns true if a row of THIS organization changed. */
export async function setStatus(env, organizationId, id, status) {
  const from = status === "acknowledged" ? "('open')" : "('open','acknowledged')";
  const r = await env.LUMMET_DB.prepare(
    `UPDATE automation_alerts SET status = ? WHERE id = ? AND organization_id = ? AND status IN ${from}`
  ).bind(status, id, organizationId).run();
  return (r?.meta?.changes || 0) > 0;
}
