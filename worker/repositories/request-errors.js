// Server error records (v7I). All SQL for request_errors lives here.

const PER_MINUTE_CAP = 100;

/** Records one failure. Skips silently when more than PER_MINUTE_CAP were already recorded in the last minute (a flood is one problem, not thousands of rows). */
export async function record(env, { requestId, method, route, status, errorName = null, message = null }) {
  const recent = await env.LUMMET_DB.prepare(`SELECT COUNT(*) n FROM request_errors WHERE created_at >= datetime('now','-1 minute')`).first();
  if ((recent?.n || 0) >= PER_MINUTE_CAP) return false;
  await env.LUMMET_DB.prepare(
    `INSERT INTO request_errors (request_id, method, route, status, error_name, message) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(requestId, method, route, status, errorName, message).run();
  return true;
}

export async function listRecent(env, limit = 100) {
  return (await env.LUMMET_DB.prepare(
    `SELECT id, request_id, method, route, status, error_name, message, created_at FROM request_errors ORDER BY id DESC LIMIT ?`
  ).bind(Math.min(Math.max(limit, 1), 500)).all()).results;
}

export async function summaryLastHours(env, hours = 24) {
  return (await env.LUMMET_DB.prepare(
    `SELECT route, status, COUNT(*) AS n, MAX(created_at) AS last_seen
       FROM request_errors WHERE created_at >= datetime('now', ?) GROUP BY route, status ORDER BY n DESC LIMIT 20`
  ).bind(`-${Math.max(1, Math.floor(hours))} hours`).all()).results;
}

export async function purgeOlderThanDays(env, days = 14) {
  const r = await env.LUMMET_DB.prepare(`DELETE FROM request_errors WHERE created_at < datetime('now', ?)`).bind(`-${days} days`).run();
  return r?.meta?.changes || 0;
}
