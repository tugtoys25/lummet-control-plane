// Phase 5.4 storage-limit sync and tenant usage reports (repository: SQL only).
export async function listSitesForStorageCheck(env, limit) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id site_id, s.organization_id, s.tenant_id FROM sites s
     LEFT JOIN site_storage_limit_sync y ON y.site_id = s.id
     WHERE s.tenant_id IS NOT NULL AND s.status NOT IN ('deleted','deleting','pending','failed')
     ORDER BY COALESCE(y.checked_at,'') ASC, s.id LIMIT ?`).bind(limit).all()).results || [];
}
export async function selectSync(env, siteId) {
  return env.LUMMET_DB.prepare("SELECT * FROM site_storage_limit_sync WHERE site_id=?").bind(siteId).first();
}
export async function insertSync(env, { siteId, desiredMb }) {
  return env.LUMMET_DB.prepare("INSERT OR IGNORE INTO site_storage_limit_sync (site_id, desired_mb, generation, status, checked_at) VALUES (?,?,1,'pending',CURRENT_TIMESTAMP)").bind(siteId, desiredMb).run();
}
// Changing the desired cap bumps the generation in one statement and re-queues the push.
export async function changeDesired(env, { siteId, desiredMb }) {
  return env.LUMMET_DB.prepare(
    `UPDATE site_storage_limit_sync SET desired_mb=?, generation=generation+1, status='pending', attempts=0, next_attempt_at=CURRENT_TIMESTAMP, last_error=NULL, checked_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE site_id=? AND desired_mb<>?`).bind(desiredMb, siteId, desiredMb).run();
}
export async function touchChecked(env, siteId) {
  return env.LUMMET_DB.prepare("UPDATE site_storage_limit_sync SET checked_at=CURRENT_TIMESTAMP WHERE site_id=?").bind(siteId).run();
}
export async function listDuePushes(env, { now, limit }) {
  return (await env.LUMMET_DB.prepare(
    `SELECT * FROM site_storage_limit_sync WHERE (status='pending' OR (status='running' AND updated_at < datetime('now','-10 minutes'))) AND next_attempt_at<=? ORDER BY next_attempt_at LIMIT ?`).bind(now, limit).all()).results || [];
}
// Claim pins the generation so a push for a superseded desired value is never started.
export async function claimPush(env, { siteId, generation }) {
  return env.LUMMET_DB.prepare(
    `UPDATE site_storage_limit_sync SET status='running', attempts=attempts+1, updated_at=CURRENT_TIMESTAMP
     WHERE site_id=? AND generation=? AND (status='pending' OR (status='running' AND updated_at < datetime('now','-10 minutes')))`).bind(siteId, generation).run();
}
export async function markPushed(env, { siteId, generation, httpStatus }) {
  return env.LUMMET_DB.prepare(
    `UPDATE site_storage_limit_sync SET pushed_generation=MAX(pushed_generation,?), pushed_at=CURRENT_TIMESTAMP, last_http_status=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP,
       status=CASE WHEN generation=? THEN 'succeeded' ELSE status END
     WHERE site_id=?`).bind(generation, httpStatus, generation, siteId).run();
}
export async function markPushRetry(env, { siteId, generation, terminal, error, delaySeconds }) {
  return env.LUMMET_DB.prepare(
    `UPDATE site_storage_limit_sync SET status=?, last_error=?, next_attempt_at=datetime('now',?), updated_at=CURRENT_TIMESTAMP WHERE site_id=? AND generation=?`)
    .bind(terminal ? "failed" : "pending", String(error).slice(0, 1000), `+${delaySeconds} seconds`, siteId, generation).run();
}
export async function listPushFailures(env, limit = 100) {
  return (await env.LUMMET_DB.prepare(
    `SELECT y.site_id, s.name site_name, o.name organization_name, y.desired_mb, y.generation, y.attempts, y.last_error
     FROM site_storage_limit_sync y JOIN sites s ON s.id=y.site_id JOIN organizations o ON o.id=s.organization_id WHERE y.status='failed' ORDER BY y.updated_at DESC LIMIT ?`).bind(limit).all()).results || [];
}
export async function upsertUsage(env, { siteId, usedBytes, reservedBytes, limitBytes, limitGeneration }) {
  return env.LUMMET_DB.prepare(
    `INSERT INTO site_storage_usage (site_id, used_bytes, reserved_bytes, limit_bytes, limit_generation, reported_at) VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(site_id) DO UPDATE SET used_bytes=excluded.used_bytes, reserved_bytes=excluded.reserved_bytes, limit_bytes=excluded.limit_bytes, limit_generation=excluded.limit_generation, reported_at=CURRENT_TIMESTAMP`)
    .bind(siteId, usedBytes, reservedBytes, limitBytes, limitGeneration).run();
}
// Organization storage = sum of fresh per-site reports. `total` lets callers tell partial coverage from full.
export async function organizationStorage(env, organizationId, { freshAfter }) {
  return env.LUMMET_DB.prepare(
    `SELECT COUNT(u.site_id) reporting, COALESCE(SUM(u.used_bytes),0) used_bytes,
       (SELECT COUNT(*) FROM sites WHERE organization_id=? AND tenant_id IS NOT NULL AND status NOT IN ('deleted','deleting')) total
     FROM sites s JOIN site_storage_usage u ON u.site_id=s.id
     WHERE s.organization_id=? AND s.status NOT IN ('deleted','deleting') AND u.reported_at >= ?`).bind(organizationId, organizationId, freshAfter).first();
}
