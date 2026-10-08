// =====================================================
// SITE HEALTH REPORT (master prompt Phase 7's "SLA/health
// reporting")
//
// Every number here is derived from data this codebase
// already records — site_status_events (migration 0006) and
// the health_check job step recorded by every deployment
// (deployments.js, Phase 4). Nothing is sampled, estimated,
// or invented. There is no active/periodic health polling
// outside of a deployment's own health_check step, so
// "current status" reflects the last time something actually
// touched the site (a deployment, a status change) — not a
// live probe. A real SLA product would add scheduled polling;
// not built here.
// =====================================================

/**
 * Approximates uptime as the fraction of the site's recorded
 * lifetime it has spent in "active" status, computed from the exact
 * timestamps in site_status_events — not a sample-based estimate.
 * Returns null (not a fake number) if the site has no history yet.
 */
function computeActiveTimeRatio(events, now) {
  // A single event (just the site's creation) has no observed
  // transition yet — there's nothing to measure a duration between,
  // so this is "not enough history" (null), not "0% uptime".
  if (events.length < 2) return null;

  // Events are stored newest-first; walk oldest-to-newest to
  // accumulate time spent in each status.
  const chronological = [...events].reverse();
  let activeMs = 0;
  let totalMs = 0;

  for (let i = 0; i < chronological.length; i++) {
    const start = new Date(chronological[i].created_at).getTime();
    const end = i + 1 < chronological.length ? new Date(chronological[i + 1].created_at).getTime() : now;
    const duration = Math.max(0, end - start);
    totalMs += duration;
    if (chronological[i].to_status === "active") activeMs += duration;
  }

  if (totalMs === 0) return null;
  return activeMs / totalMs;
}

export async function getSiteHealthReport(env, siteId) {
  const site = await env.LUMMET_DB.prepare(`SELECT * FROM sites WHERE id = ?`).bind(siteId).first();
  if (!site) return null;

  const eventsResult = await env.LUMMET_DB.prepare(
    `SELECT from_status, to_status, reason, created_at FROM site_status_events WHERE site_id = ? ORDER BY created_at DESC`
  )
    .bind(siteId)
    .all();
  const events = eventsResult.results || [];

  const activeRatio = computeActiveTimeRatio(events, Date.now());

  const lastFailure = events.find((e) => e.to_status === "failed") || null;
  const lastHealthCheckStep = await env.LUMMET_DB.prepare(
    `SELECT js.status, js.output, js.completed_at FROM job_steps js
     JOIN jobs j ON j.id = js.job_id
     WHERE j.site_id = ? AND js.step_key = 'health_check' AND js.status IN ('success', 'failed')
     ORDER BY js.completed_at DESC LIMIT 1`
  )
    .bind(siteId)
    .first();

  return {
    siteId: site.id,
    currentStatus: site.status,
    // null (not 0%) when there's no history to compute from yet —
    // see computeActiveTimeRatio's own comment.
    approximateUptimeRatio: activeRatio,
    lastFailure: lastFailure ? { reason: lastFailure.reason, at: lastFailure.created_at } : null,
    lastHealthCheck: lastHealthCheckStep
      ? {
          status: lastHealthCheckStep.status,
          at: lastHealthCheckStep.completed_at,
          detail: lastHealthCheckStep.output ? JSON.parse(lastHealthCheckStep.output) : null
        }
      : null,
    statusHistory: events.slice(0, 20)
  };
}
