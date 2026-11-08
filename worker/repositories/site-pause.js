// SQL for customer pause/resume (worker/site-pause.js holds the rules).

/** Who put the site in `suspended` most recently: 'customer_user' (a pause), 'lummet_admin' (staff), 'system', or null. */
export async function lastSuspensionActor(env, siteId) {
  const row = await env.LUMMET_DB.prepare(
    `SELECT actor_type FROM site_status_events WHERE site_id = ? AND to_status = 'suspended' ORDER BY created_at DESC, id DESC LIMIT 1`
  ).bind(siteId).first();
  return row?.actor_type || null;
}
