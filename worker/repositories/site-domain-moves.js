// Site domain moves (migration 0086). All SQL for moves and the temporary old-host redirects lives here;
// worker/site-domain-moves.js holds the rules.

const parse = (row) => {
  if (!row) return null;
  let steps = {};
  try { steps = JSON.parse(row.steps_json || "{}"); } catch (_) { steps = {}; }
  return { ...row, update_primary: !!row.update_primary, steps };
};

export async function getMove(env, id) {
  return parse(await env.LUMMET_DB.prepare(`SELECT * FROM site_domain_moves WHERE id = ?`).bind(id).first());
}

export async function listMovesForSite(env, siteId, limit = 20) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM site_domain_moves WHERE site_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).bind(siteId, limit).all();
  return r.results.map(parse);
}

/** The unfinished move for a site ('running' or 'failed'), if any. */
export async function findOpenMove(env, siteId) {
  return parse(await env.LUMMET_DB.prepare(`SELECT * FROM site_domain_moves WHERE site_id = ? AND state IN ('running', 'failed')`).bind(siteId).first());
}

/** Inserts a move in 'running'. The unique index refuses a second unfinished move for the site: returns null then. */
export async function insertMove(env, m) {
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO site_domain_moves (id, site_id, from_domain_id, to_domain_id, old_host, new_host, old_route_id, old_zone_id, new_zone_id, worker_name, update_primary, redirect_days, requested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(m.id, m.siteId, m.fromDomainId || null, m.toDomainId, m.oldHost, m.newHost, m.oldRouteId || null, m.oldZoneId || null, m.newZoneId || null, m.workerName || null, m.updatePrimary ? 1 : 0, m.redirectDays, m.requestedBy || null).run();
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) return null;
    throw err;
  }
  return getMove(env, m.id);
}

/** Marks a step done (and stores anything it learned), optionally changing state. Never loses earlier steps. */
export async function recordStep(env, id, step, patch = {}) {
  const move = await getMove(env, id);
  const steps = { ...move.steps, [step]: { at: new Date().toISOString(), ...(patch.detail ? { detail: patch.detail } : {}) } };
  await env.LUMMET_DB.prepare(
    `UPDATE site_domain_moves SET steps_json = ?, new_route_id = COALESCE(?, new_route_id), updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(JSON.stringify(steps), patch.newRouteId || null, id).run();
}

export async function unrecordStep(env, id, step) {
  const move = await getMove(env, id);
  const steps = { ...move.steps }; delete steps[step];
  await env.LUMMET_DB.prepare(`UPDATE site_domain_moves SET steps_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(JSON.stringify(steps), id).run();
}

export async function setState(env, id, state, { error = null, redirectUntil = null } = {}) {
  const finished = ["completed", "rolled_back"].includes(state);
  await env.LUMMET_DB.prepare(
    `UPDATE site_domain_moves SET state = ?, last_error = ?, redirect_until = COALESCE(?, redirect_until), finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).bind(state, error ? String(error).slice(0, 300) : null, redirectUntil, finished ? 1 : 0, id).run();
}

/**
 * The switch itself, in one batch so the registry, the site row and the route row can never disagree:
 * tenants.host/api_base_url, sites.platform_domain_id (+ primary_domain when it was the platform host), and the site's route row.
 */
export async function applySwitch(env, { siteId, tenantId, host, domainId, setPrimary, route }) {
  const db = env.LUMMET_DB;
  const stmts = [
    db.prepare(`UPDATE tenants SET host = ?, api_base_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(host, `https://${host}`, tenantId),
    db.prepare(`UPDATE sites SET platform_domain_id = ?, ${setPrimary ? "primary_domain = ?, " : ""}updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...[domainId, ...(setPrimary ? [host] : []), siteId]),
    db.prepare(
      `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name, metadata)
       VALUES (?, ?, 'route', ?, ?, ?)
       ON CONFLICT(site_id, resource_type) DO UPDATE SET resource_id = excluded.resource_id, resource_name = excluded.resource_name, metadata = excluded.metadata, status = 'active', deleted_at = NULL`
    ).bind(siteId, route.provider, route.routeId, `${host}/*`, route.zoneId ? JSON.stringify({ zoneId: route.zoneId }) : null)
  ];
  await db.batch(stmts);
}

export async function saveRedirect(env, r) {
  await env.LUMMET_DB.prepare(
    `INSERT INTO site_host_redirects (old_host, new_host, site_id, move_id, route_id, zone_id, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(old_host) DO UPDATE SET new_host = excluded.new_host, site_id = excluded.site_id, move_id = excluded.move_id, route_id = excluded.route_id, zone_id = excluded.zone_id, expires_at = excluded.expires_at`
  ).bind(r.oldHost, r.newHost, r.siteId, r.moveId, r.routeId || null, r.zoneId || null, r.expiresAt).run();
}

export async function deleteRedirect(env, oldHost) {
  await env.LUMMET_DB.prepare(`DELETE FROM site_host_redirects WHERE old_host = ?`).bind(oldHost).run();
}

/** Live redirect for an exact hostname, or null (expired rows are ignored even before the sweep removes them). */
export async function findRedirect(env, host) {
  return env.LUMMET_DB.prepare(`SELECT old_host, new_host, expires_at FROM site_host_redirects WHERE old_host = ? AND expires_at > ?`).bind(host, new Date().toISOString()).first();
}

export async function listExpiredRedirects(env, limit = 50) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM site_host_redirects WHERE expires_at <= ? ORDER BY expires_at LIMIT ?`).bind(new Date().toISOString(), limit).all();
  return r.results;
}

export async function listRedirectsForSite(env, siteId) {
  const r = await env.LUMMET_DB.prepare(`SELECT * FROM site_host_redirects WHERE site_id = ?`).bind(siteId).all();
  return r.results;
}

/** Sites for the move preview. */
export async function getSiteWithTenant(env, siteId) {
  return env.LUMMET_DB.prepare(`SELECT id, name, slug, status, tenant_id, primary_domain, platform_domain_id FROM sites WHERE id = ?`).bind(siteId).first();
}

export async function revertSwitch(env, { siteId, tenantId, host, domainId, setPrimary, route }) {
  // Same shape as applySwitch: the "old" values go back.
  return applySwitch(env, { siteId, tenantId, host, domainId, setPrimary, route });
}
