// What the job sweep reads and changes in `jobs`. (Repository: all SQL for the sweep lives here.)
//
// Every state change is a compare-and-swap on the status AND the retry counter the caller observed, so two
// sweeps running at the same moment (two pingers, a pinger plus a cron tick) can never both take the same job.

/** Jobs that were created but never started (the request that should have started them ended first). */
export async function listStuckQueued(env, minutes, limit) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, type, site_id, organization_id, status, auto_retries FROM jobs
      WHERE status = 'queued' AND dead_lettered_at IS NULL
        AND created_at <= datetime('now', '-' || ? || ' minutes')
      ORDER BY created_at LIMIT ?`
  ).bind(minutes, limit).all();
  return r.results || [];
}

/** Running jobs with no sign of life (no log line, no start) for `minutes`: the Worker that ran them is gone. */
export async function listStaleRunning(env, minutes, limit) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT j.id, j.type, j.site_id, j.organization_id, j.status, j.auto_retries FROM jobs j
      WHERE j.status = 'running' AND j.dead_lettered_at IS NULL
        AND COALESCE((SELECT MAX(l.created_at) FROM job_logs l WHERE l.job_id = j.id), j.started_at, j.created_at)
            <= datetime('now', '-' || ? || ' minutes')
      ORDER BY j.created_at LIMIT ?`
  ).bind(minutes, limit).all();
  return r.results || [];
}

/** Failed, not yet given up on, of a type that may be retried automatically. */
export async function listFailedRetryable(env, types, limit) {
  if (!types.length) return [];
  const marks = types.map(() => "?").join(",");
  const r = await env.LUMMET_DB.prepare(
    `SELECT id, type, site_id, organization_id, status, auto_retries, completed_at, created_at FROM jobs
      WHERE status = 'failed' AND dead_lettered_at IS NULL AND type IN (${marks})
      ORDER BY COALESCE(completed_at, created_at) LIMIT ?`
  ).bind(...types, limit).all();
  return r.results || [];
}

/** Takes the job for one more automatic attempt. True only for the single caller that wins. */
export async function claim(env, jobId, fromStatus, observedAutoRetries) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE jobs SET auto_retries = auto_retries + 1
      WHERE id = ? AND status = ? AND auto_retries = ? AND dead_lettered_at IS NULL`
  ).bind(jobId, fromStatus, observedAutoRetries).run();
  return (r?.meta?.changes || 0) > 0;
}

export async function deadLetter(env, jobId, reason) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE jobs SET dead_lettered_at = CURRENT_TIMESTAMP, dead_reason = ? WHERE id = ? AND dead_lettered_at IS NULL`
  ).bind(String(reason).slice(0, 300), jobId).run();
  return (r?.meta?.changes || 0) > 0;
}

/** Staff action: give a dead-lettered job a fresh set of automatic retries. */
export async function clearDeadLetter(env, jobId) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE jobs SET dead_lettered_at = NULL, dead_reason = NULL, auto_retries = 0 WHERE id = ? AND dead_lettered_at IS NOT NULL`
  ).bind(jobId).run();
  return (r?.meta?.changes || 0) > 0;
}
