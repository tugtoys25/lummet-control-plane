// Payment gateway switch (migration 0074). All SQL for payment_gateways and payment_gateway_events lives here.

export async function listRows(env) {
  return (await env.LUMMET_DB.prepare("SELECT gateway, enabled, priority, updated_by, updated_at FROM payment_gateways ORDER BY priority ASC, gateway ASC").all()).results || [];
}

export async function upsertSwitch(env, { gateway, enabled, priority, actorId }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO payment_gateways (gateway, enabled, priority, updated_by, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(gateway) DO UPDATE SET enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
  ).bind(gateway, enabled ? 1 : 0, priority, String(actorId)).run();
}

export async function insertEvent(env, { gateway, enabled, reason, actorId }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO payment_gateway_events (gateway, action, enabled, reason, actor_id) VALUES (?, ?, ?, ?, ?)`
  ).bind(gateway, enabled ? "enable" : "disable", enabled ? 1 : 0, String(reason).slice(0, 500), String(actorId)).run();
}

export async function listEvents(env, limit) {
  return (await env.LUMMET_DB.prepare("SELECT gateway, action, enabled, reason, actor_id, created_at FROM payment_gateway_events ORDER BY id DESC LIMIT ?").bind(limit).all()).results || [];
}

/** The provider of an organization's current (non-terminal) subscription, or null. */
export async function currentSubscriptionProvider(env, organizationId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT provider FROM subscriptions WHERE organization_id = ? AND status NOT IN ('canceled','expired','incomplete_expired') ORDER BY created_at DESC LIMIT 1`
  ).bind(organizationId).first();
  return row?.provider || null;
}
