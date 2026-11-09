// Portal branding values (migration 0096). All SQL for platform_branding lives here.

export async function listAll(env) {
  return (await env.LUMMET_DB.prepare("SELECT key, value, updated_by, updated_at FROM platform_branding ORDER BY key ASC").all()).results || [];
}

export async function upsert(env, { key, value, actorId }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO platform_branding (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
  ).bind(key, value, String(actorId)).run();
}

export async function remove(env, key) {
  await env.LUMMET_DB.prepare("DELETE FROM platform_branding WHERE key = ?").bind(key).run();
}

/** Applies many changes at once (all or none): `sets` is [{key, value}], `removes` is [key]. */
export async function applyChanges(env, { sets = [], removes = [], actorId }) {
  const db = env.LUMMET_DB;
  const statements = [
    ...sets.map((s) => db.prepare(
      `INSERT INTO platform_branding (key, value, updated_by, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).bind(s.key, s.value, String(actorId))),
    ...removes.map((key) => db.prepare("DELETE FROM platform_branding WHERE key = ?").bind(key))
  ];
  if (statements.length) await db.batch(statements);
}
