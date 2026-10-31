// Platform settings (migration 0075). All SQL for platform_settings and platform_setting_events lives here.

export async function listAll(env) {
  return (await env.LUMMET_DB.prepare("SELECT key, value, updated_by, updated_at FROM platform_settings ORDER BY key ASC").all()).results || [];
}

export async function getOne(env, key) {
  return env.LUMMET_DB.prepare("SELECT key, value, updated_by, updated_at FROM platform_settings WHERE key = ?").bind(key).first();
}

export async function upsert(env, { key, value, actorId }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
  ).bind(key, value, String(actorId)).run();
}

export async function remove(env, key) {
  await env.LUMMET_DB.prepare("DELETE FROM platform_settings WHERE key = ?").bind(key).run();
}

export async function insertEvent(env, { key, action, oldValue, newValue, reason, actorId }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO platform_setting_events (key, action, old_value, new_value, reason, actor_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(key, action, oldValue ?? null, newValue ?? null, String(reason).slice(0, 500), String(actorId)).run();
}

export async function listEvents(env, limit) {
  return (await env.LUMMET_DB.prepare(
    "SELECT key, action, old_value, new_value, reason, actor_id, created_at FROM platform_setting_events ORDER BY id DESC LIMIT ?"
  ).bind(limit).all()).results || [];
}
