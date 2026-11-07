// SQL for deleting one site (worker/site-teardown.js holds the orchestration). Plain data in, plain data out.

export const openJob = (env, siteId, type) =>
  env.LUMMET_DB.prepare(`SELECT id, status FROM jobs WHERE site_id = ? AND type = ? AND status IN ('queued','running','failed') ORDER BY created_at DESC LIMIT 1`).bind(siteId, type).first();

export async function activeResources(env, siteId, type) {
  return (await env.LUMMET_DB.prepare(`SELECT id, resource_type, resource_id, resource_name, metadata FROM site_resources WHERE site_id = ? AND resource_type = ? AND status = 'active'`).bind(siteId, type).all()).results || [];
}
export async function activeResourceTypes(env, siteId) {
  return ((await env.LUMMET_DB.prepare(`SELECT resource_type FROM site_resources WHERE site_id = ? AND status = 'active'`).bind(siteId).all()).results || []).map((r) => r.resource_type);
}
export const markResourceDeleted = (env, id) =>
  env.LUMMET_DB.prepare(`UPDATE site_resources SET status = 'deleted', deleted_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();

export async function redirectsForSite(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT old_host, route_id, zone_id FROM site_host_redirects WHERE site_id = ?`).bind(siteId).all()).results || [];
}
export const deleteRedirect = (env, oldHost) => env.LUMMET_DB.prepare(`DELETE FROM site_host_redirects WHERE old_host = ?`).bind(oldHost).run();

export async function customHostnames(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, ssl_resource_id FROM domains WHERE site_id = ? AND ssl_resource_id IS NOT NULL AND status != 'removed'`).bind(siteId).all()).results || [];
}
export const markHostnameRemoved = (env, id) =>
  env.LUMMET_DB.prepare(`UPDATE domains SET status = 'removed', ssl_resource_id = NULL, removed_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();

export async function storedBackups(env, siteId) {
  return (await env.LUMMET_DB.prepare(`SELECT id, storage_key FROM site_backups WHERE site_id = ? AND storage_key IS NOT NULL`).bind(siteId).all()).results || [];
}
export const clearBackupKey = (env, id) => env.LUMMET_DB.prepare(`UPDATE site_backups SET storage_key = NULL WHERE id = ?`).bind(id).run();
export async function deleteBackupRows(env, siteId) {
  return (await env.LUMMET_DB.prepare(`DELETE FROM site_backups WHERE site_id = ?`).bind(siteId).run()).meta.changes || 0;
}

/** `table` and `condition` come from retention-policy.js constants (never from a request). */
export async function deleteSiteRows(env, table, condition, siteId) {
  return (await env.LUMMET_DB.prepare(`DELETE FROM ${table} WHERE ${condition}`).bind(siteId).run()).meta.changes || 0;
}

export const tenantSharedWithOtherSite = (env, tenantId, siteId) =>
  env.LUMMET_DB.prepare(`SELECT 1 AS x FROM sites WHERE tenant_id = ? AND id != ?`).bind(tenantId, siteId).first();
export const deleteTenant = (env, tenantId) => env.LUMMET_DB.prepare(`DELETE FROM tenants WHERE id = ?`).bind(tenantId).run();
export const detachTenantFromSite = (env, siteId) =>
  env.LUMMET_DB.prepare(`UPDATE sites SET tenant_id = NULL, primary_domain = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(siteId).run();

/** Cancels every other job of the site that could still run or be retried (setup, deploy, backups...), so none can recreate what is being removed. */
export async function cancelOtherJobs(env, siteId, keepType) {
  return (await env.LUMMET_DB.prepare(
    `UPDATE jobs SET status = 'cancelled', canceled_at = CURRENT_TIMESTAMP WHERE site_id = ? AND type != ? AND status IN ('queued','running','waiting','retrying','failed')`
  ).bind(siteId, keepType).run()).meta.changes || 0;
}

export async function sitesDeletingWithoutJob(env, type, limit) {
  return (await env.LUMMET_DB.prepare(
    `SELECT s.id FROM sites s WHERE s.status = 'deleting' AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.site_id = s.id AND j.type = ?) LIMIT ?`
  ).bind(type, limit).all()).results || [];
}
