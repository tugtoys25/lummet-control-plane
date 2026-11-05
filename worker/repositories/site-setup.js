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

export async function bumpAttempts(env, id) {
  await env.LUMMET_DB.prepare(`UPDATE site_setup_requests SET attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(id).run();
}

export async function setOutcome(env, id, status, lastError) {
  await env.LUMMET_DB.prepare(
    `UPDATE site_setup_requests SET status = ?, last_error = ?, applied_at = CASE WHEN ? = 'applied' THEN CURRENT_TIMESTAMP ELSE applied_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(status, lastError || null, status, id).run();
}
