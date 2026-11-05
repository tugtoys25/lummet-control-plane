// First-configuration requests for new sites (Phase 9) and the default preset per plan or product.
// (Repository: all SQL for worker/site-setup.js. Tables: site_setup_requests, site_preset_defaults; see migrations/0084_site_setup.sql.)

export async function listDefaults(env) {
  const r = await env.LUMMET_DB.prepare(`SELECT scope_kind, scope_id, preset_id, updated_by, updated_at FROM site_preset_defaults ORDER BY scope_kind, scope_id`).all();
  return r.results || [];
}

/** True when the plan (kind "plan") or product (kind "product") exists. */
export async function scopeExists(env, kind, id) {
  const sql = kind === "plan" ? `SELECT 1 AS x FROM plans WHERE id = ?` : `SELECT 1 AS x FROM products WHERE id = ?`;
  return !!(await env.LUMMET_DB.prepare(sql).bind(id).first());
}

export async function deleteDefault(env, kind, id) {
  await env.LUMMET_DB.prepare(`DELETE FROM site_preset_defaults WHERE scope_kind = ? AND scope_id = ?`).bind(kind, id).run();
}

export async function upsertDefault(env, { scopeKind, scopeId, presetId, updatedBy }) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_preset_defaults (scope_kind, scope_id, preset_id, updated_by, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(scope_kind, scope_id) DO UPDATE SET preset_id = excluded.preset_id, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
  ).bind(scopeKind, scopeId, presetId, updatedBy).run();
}

export async function findDefaultPreset(env, kind, id) {
  const row = await env.LUMMET_DB.prepare(`SELECT preset_id FROM site_preset_defaults WHERE scope_kind = ? AND scope_id = ?`).bind(kind, id).first();
  return row ? row.preset_id : null;
}

/** The plan of the organization's current subscription (active, trialing or past_due), newest first; null when it has none. */
export async function currentPlanId(env, organizationId) {
  const sub = await env.LUMMET_DB.prepare(
    `SELECT plan_id FROM subscriptions WHERE organization_id = ? AND status IN ('active', 'trialing', 'past_due') ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).bind(organizationId).first();
  return sub ? sub.plan_id : null;
}

export const findSite = (env, id) =>
  env.LUMMET_DB.prepare(`SELECT id, organization_id, tenant_id, status FROM sites WHERE id = ?`).bind(id).first();

export const findSiteByTenant = (env, tenantId) =>
  env.LUMMET_DB.prepare(`SELECT id, status FROM sites WHERE tenant_id = ? LIMIT 1`).bind(tenantId).first();

export const findTenant = (env, id) =>
  env.LUMMET_DB.prepare(`SELECT id, status FROM tenants WHERE id = ?`).bind(id).first();

/** Marks the still-open requests of one target (kind "site" or "tenant") as skipped; they are kept, never deleted. */
export async function supersedeOpen(env, targetKind, targetId) {
  const sql = targetKind === "site"
    ? `UPDATE site_setup_requests SET status = 'skipped', last_error = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE site_id = ? AND status IN ('pending', 'failed')`
    : `UPDATE site_setup_requests SET status = 'skipped', last_error = 'superseded', updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ? AND status IN ('pending', 'failed')`;
  await env.LUMMET_DB.prepare(sql).bind(targetId).run();
}

export async function insertRequest(env, r) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_setup_requests (id, site_id, tenant_id, kind, preset_id, source_tenant_id, sections, status, requested_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).bind(r.id, r.siteId, r.tenantId, r.kind, r.presetId, r.sourceTenantId, r.sections, r.requestedBy).run();
}

export const getRequest = (env, id) => env.LUMMET_DB.prepare(`SELECT * FROM site_setup_requests WHERE id = ?`).bind(id).first();

export const latestRequestForSite = (env, siteId) =>
  env.LUMMET_DB.prepare(`SELECT * FROM site_setup_requests WHERE site_id = ? ORDER BY requested_at DESC, rowid DESC LIMIT 1`).bind(siteId).first();

/**
 * Counts one attempt. With `expectedUpdatedAt` it is a compare-and-swap: the row is changed only if its updated_at is still the value
 * the caller read, so two drivers (the tick and alert-check) that picked the same request count ONE attempt between them.
 * Returns true when this call counted the attempt, false when another driver got there first. Without it, always counts (deploy, manual retry).
 */
export async function bumpAttempts(env, id, expectedUpdatedAt = null) {
  const r = expectedUpdatedAt
    ? await env.LUMMET_DB.prepare(`UPDATE site_setup_requests SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND updated_at = ? AND status IN ('pending', 'failed')`).bind(id, expectedUpdatedAt).run()
    : await env.LUMMET_DB.prepare(`UPDATE site_setup_requests SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
  return Number(r?.meta?.changes ?? 0) > 0;
}

export async function setOutcome(env, id, status, lastError) {
  await env.LUMMET_DB.prepare(
    `UPDATE site_setup_requests SET status = ?, last_error = ?, applied_at = CASE WHEN ? = 'applied' THEN CURRENT_TIMESTAMP ELSE applied_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(status, lastError || null, status, id).run();
}

/** Active sites of one organization that could be copied from (they have a tenant). Names only; nothing from the tenant. */
export async function listCloneSources(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT s.id, s.name, p.name AS product_name FROM sites s LEFT JOIN products p ON p.id = s.product_id
     WHERE s.organization_id = ? AND s.status = 'active' AND s.tenant_id IS NOT NULL ORDER BY s.created_at`
  ).bind(organizationId).all();
  return r.results || [];
}

/** The newest setup request of every site of one organization, in one query (no per-site lookups). */
export async function latestRequestsForOrganization(env, organizationId) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT q.* FROM site_setup_requests q JOIN sites s ON s.id = q.site_id
     WHERE s.organization_id = ? AND s.status != 'deleted'
       AND q.rowid = (SELECT q2.rowid FROM site_setup_requests q2 WHERE q2.site_id = q.site_id ORDER BY q2.requested_at DESC, q2.rowid DESC LIMIT 1)`
  ).bind(organizationId).all();
  return r.results || [];
}

/**
 * Requests the retry sweep may look at: the NEWEST request of a site (older ones are superseded), still pending or failed, below the
 * attempt cap, whose site is live and has a tenant. Oldest update first, capped. Whether one is due (backoff) is decided by the caller.
 */
export async function listRetryCandidates(env, { maxAttempts, limit }) {
  const r = await env.LUMMET_DB.prepare(
    `SELECT q.id, q.site_id, q.status, q.attempts, q.requested_at, q.updated_at FROM site_setup_requests q JOIN sites s ON s.id = q.site_id
     WHERE q.status IN ('pending', 'failed') AND q.attempts < ? AND s.status IN ('active', 'maintenance') AND s.tenant_id IS NOT NULL
       AND q.rowid = (SELECT q2.rowid FROM site_setup_requests q2 WHERE q2.site_id = q.site_id ORDER BY q2.requested_at DESC, q2.rowid DESC LIMIT 1)
     ORDER BY q.updated_at ASC LIMIT ?`
  ).bind(maxAttempts, limit).all();
  return r.results || [];
}

/** Counts for the staff screen: how many requests are in each status, and how many failed ones have used every automatic attempt. */
export async function countByStatus(env, maxAttempts) {
  const r = await env.LUMMET_DB.prepare(`SELECT status, COUNT(*) AS n FROM site_setup_requests GROUP BY status`).all();
  const gave = await env.LUMMET_DB.prepare(`SELECT COUNT(*) AS n FROM site_setup_requests WHERE status = 'failed' AND attempts >= ?`).bind(maxAttempts).first();
  return { byStatus: Object.fromEntries((r.results || []).map((x) => [x.status, Number(x.n)])), gaveUp: Number(gave?.n || 0) };
}

/** Staff list of recent requests with the site name, newest first. */
export async function listRecentRequests(env, { status = null, limit = 50 } = {}) {
  const where = status ? `WHERE q.status = ?` : ``;
  const stmt = env.LUMMET_DB.prepare(
    `SELECT q.id, q.site_id, q.tenant_id, q.kind, q.preset_id, q.status, q.attempts, q.last_error, q.requested_at, q.applied_at, q.updated_at, s.name AS site_name
     FROM site_setup_requests q LEFT JOIN sites s ON s.id = q.site_id ${where} ORDER BY q.requested_at DESC, q.rowid DESC LIMIT ?`
  );
  return ((status ? await stmt.bind(status, limit).all() : await stmt.bind(limit).all()).results) || [];
}
