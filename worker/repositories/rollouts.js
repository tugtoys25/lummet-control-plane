// Tenant release rollouts. (Repository: all SQL for tenant_rollouts / tenant_rollout_items lives here.)
//
// A rollout deploys one release to every live site, one at a time. These functions only read and change rows;
// the rules (one at a time, stop on failure, skip what is current) live in worker/rollouts.js.

const isUniqueViolation = (error) => /UNIQUE|constraint/i.test(String(error && error.message));

export async function getById(env, id) {
  return env.LUMMET_DB.prepare(`SELECT * FROM tenant_rollouts WHERE id = ?`).bind(id).first();
}

export async function getRunning(env) {
  return env.LUMMET_DB.prepare(`SELECT * FROM tenant_rollouts WHERE status = 'running' LIMIT 1`).first();
}

export async function listRecent(env, limit = 10) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT * FROM tenant_rollouts ORDER BY created_at DESC, rowid DESC LIMIT ?`
  ).bind(limit).all();
  return r.results || [];
}

/** false when another rollout is already running (the partial unique index refused the insert). */
export async function insertRollout(env, { id, version, startedBy, notes }) {
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO tenant_rollouts (id, release_version, status, started_by, notes) VALUES (?, ?, 'running', ?, ?)`
    ).bind(id, version, startedBy || null, notes || null).run();
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

/**
 * Lists the sites in ONE statement (the platform may have hundreds; a statement per site would exceed the
 * database calls one request may make). Live sites only: a site still being provisioned gets the release from
 * its own first deployment, and a suspended or deleting site must not be touched. Sites already on the version
 * are recorded as skipped, so the rollout page shows the whole fleet.
 */
export async function seedItems(env, { rolloutId, version, siteIds = null }) {
  const filter = siteIds && siteIds.length ? `AND s.id IN (SELECT value FROM json_each(?))` : "";
  const binds = [rolloutId, version, version];
  if (filter) binds.push(JSON.stringify(siteIds));
  await env.LUMMET_DB.prepare(
    `INSERT INTO tenant_rollout_items (rollout_id, site_id, position, status, detail)
     SELECT ?, s.id, ROW_NUMBER() OVER (ORDER BY s.created_at, s.id),
            CASE WHEN s.app_version = ? THEN 'skipped' ELSE 'pending' END,
            CASE WHEN s.app_version = ? THEN 'already_on_version' ELSE NULL END
       FROM sites s
      WHERE s.status = 'active' AND s.tenant_id IS NOT NULL ${filter}`
  ).bind(...binds).run();
}

export async function itemCounts(env, rolloutId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT status, COUNT(*) AS n FROM tenant_rollout_items WHERE rollout_id = ? GROUP BY status`
  ).bind(rolloutId).all();
  const counts = { pending: 0, running: 0, succeeded: 0, skipped: 0, failed: 0 };
  for (const row of r.results || []) counts[row.status] = row.n;
  return counts;
}

export async function setTotal(env, id, total) {
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollouts SET total_sites = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(total, id).run();
}

/** Compare-and-swap lock so two advancers (pinger, page, CI) never work on one rollout at once. */
export async function acquireLock(env, id, nowMs, untilMs) {
  const r = await env.LUMMET_DB.prepare(
    `UPDATE tenant_rollouts SET lock_until = ? WHERE id = ? AND status = 'running' AND lock_until < ?`
  ).bind(untilMs, id, nowMs).run();
  return (r.meta?.changes ?? 0) > 0;
}

export async function releaseLock(env, id) {
  await env.LUMMET_DB.prepare(`UPDATE tenant_rollouts SET lock_until = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
}

export async function getRunningItem(env, rolloutId) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM tenant_rollout_items WHERE rollout_id = ? AND status = 'running' ORDER BY position LIMIT 1`
  ).bind(rolloutId).first();
}

export async function nextPending(env, rolloutId) {
  return env.LUMMET_DB.prepare(
    `SELECT * FROM tenant_rollout_items WHERE rollout_id = ? AND status = 'pending' ORDER BY position LIMIT 1`
  ).bind(rolloutId).first();
}

/** What the deployment and its job are doing right now. */
export async function readProgress(env, deploymentId, jobId) {
  return env.LUMMET_DB.prepare(
    `SELECT d.status AS deployment_status, d.error_message AS deployment_error,
            j.status AS job_status, j.dead_lettered_at AS dead_lettered_at, j.dead_reason AS dead_reason
       FROM deployments d LEFT JOIN jobs j ON j.id = ?
      WHERE d.id = ?`
  ).bind(jobId || null, deploymentId).first();
}

/** A deployment already under way for this site (a customer pressed Update, or an earlier tick was cut short). */
export async function inflightDeployment(env, siteId) {
  return env.LUMMET_DB.prepare(
    `SELECT d.id AS deployment_id, d.version AS version,
            (SELECT j.id FROM jobs j WHERE j.site_id = d.site_id AND j.type = 'site_deployment'
                AND json_extract(j.payload, '$.deploymentId') = d.id ORDER BY j.created_at DESC LIMIT 1) AS job_id
       FROM deployments d
      WHERE d.site_id = ? AND d.status IN ('queued','building','migrating','deploying','checking')
      ORDER BY d.created_at DESC LIMIT 1`
  ).bind(siteId).first();
}

export async function markItemRunning(env, itemId, { deploymentId, jobId }) {
  await env.LUMMET_DB.prepare(
    `UPDATE tenant_rollout_items SET status = 'running', deployment_id = ?, job_id = ?, started_at = CURRENT_TIMESTAMP, detail = NULL WHERE id = ?`
  ).bind(deploymentId, jobId || null, itemId).run();
}

export async function markItemDone(env, itemId, status, detail = null) {
  await env.LUMMET_DB.prepare(
    `UPDATE tenant_rollout_items SET status = ?, detail = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(status, detail ? String(detail).slice(0, 300) : null, itemId).run();
}

/** Cancelled: nothing still waiting will be deployed. */
export async function skipPending(env, rolloutId, detail) {
  await env.LUMMET_DB.prepare(
    `UPDATE tenant_rollout_items SET status = 'skipped', detail = ?, completed_at = CURRENT_TIMESTAMP WHERE rollout_id = ? AND status = 'pending'`
  ).bind(detail, rolloutId).run();
}

export async function finishRollout(env, id, status, errorMessage = null) {
  await env.LUMMET_DB.prepare(
    `UPDATE tenant_rollouts SET status = ?, error_message = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP, lock_until = 0
      WHERE id = ? AND status IN ('running', 'failed')`
  ).bind(status, errorMessage ? String(errorMessage).slice(0, 300) : null, id).run();
}

/** Failed -> running again, with the failed sites queued for another try. false if another rollout is running. */
export async function reopen(env, id) {
  try {
    const r = await env.LUMMET_DB.prepare(
      `UPDATE tenant_rollouts SET status = 'running', error_message = NULL, completed_at = NULL, lock_until = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'failed'`
    ).bind(id).run();
    return (r.meta?.changes ?? 0) > 0;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

export async function requeueFailedItems(env, rolloutId) {
  await env.LUMMET_DB.prepare(
    `UPDATE tenant_rollout_items SET status = 'pending', detail = NULL, deployment_id = NULL, job_id = NULL, started_at = NULL, completed_at = NULL
      WHERE rollout_id = ? AND status = 'failed'`
  ).bind(rolloutId).run();
}

export async function listItems(env, rolloutId, limit = 100) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT i.id, i.site_id, i.position, i.status, i.detail, i.deployment_id, i.started_at, i.completed_at,
            s.name AS site_name, s.slug AS site_slug
       FROM tenant_rollout_items i LEFT JOIN sites s ON s.id = i.site_id
      WHERE i.rollout_id = ?
      ORDER BY CASE i.status WHEN 'failed' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, i.position
      LIMIT ?`
  ).bind(rolloutId, limit).all();
  return r.results || [];
}

/** Live sites grouped by the version they run: the fleet at a glance. */
export async function fleetVersions(env) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT app_version AS version, COUNT(*) AS n FROM sites
      WHERE status = 'active' AND tenant_id IS NOT NULL GROUP BY app_version ORDER BY n DESC`
  ).all();
  return r.results || [];
}

export async function activeRelease(env) {
  return env.LUMMET_DB.prepare(
    `SELECT version, created_at, notes FROM tenant_template_releases WHERE status = 'active' ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).first();
}
