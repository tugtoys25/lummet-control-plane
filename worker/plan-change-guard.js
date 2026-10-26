// Guarded downgrade checks. Counts are real database counts; unknown storage usage is never represented as zero.
const LIMITS = [
  { metric: "sites", key: "sites.max", countSql: "SELECT COUNT(*) n FROM sites WHERE organization_id=? AND status NOT IN ('deleted','deleting')", rowsSql: "SELECT id, name AS label FROM sites WHERE organization_id=? AND status NOT IN ('deleted','deleting') ORDER BY created_at DESC, id DESC" },
  { metric: "users", key: "users.max", countSql: "SELECT (SELECT COUNT(*) FROM organization_users WHERE organization_id=?) + (SELECT COUNT(*) FROM organization_invitations WHERE organization_id=? AND status='pending' AND expires_at>datetime('now')) n", rowsSql: "SELECT ou.id, cu.email AS label, 'member' AS kind FROM organization_users ou JOIN customer_users cu ON cu.id=ou.user_id WHERE ou.organization_id=? UNION ALL SELECT id, email AS label, 'invitation' AS kind FROM organization_invitations WHERE organization_id=? AND status='pending' AND expires_at>datetime('now') ORDER BY label" },
  { metric: "customDomains", key: "domains.custom.max", countSql: "SELECT COUNT(DISTINCT COALESCE(d.zone_id,d.id)) n FROM domains d JOIN sites s ON s.id=d.site_id WHERE s.organization_id=? AND d.status!='removed'", rowsSql: "SELECT COALESCE(d.zone_id,d.id) AS id, MIN(d.hostname) AS label FROM domains d JOIN sites s ON s.id=d.site_id WHERE s.organization_id=? AND d.status!='removed' GROUP BY COALESCE(d.zone_id,d.id) ORDER BY MAX(d.created_at) DESC" }
];
function cast(type, raw) { if (type === "number") return Number(raw); if (type === "boolean") return raw === "true" || raw === "1"; if (type === "json") { try { return JSON.parse(raw); } catch { return null; } } return raw; }
async function planEntitlements(env, planId) {
  const r = await env.LUMMET_DB.prepare("SELECT key,value_type,value FROM plan_entitlements WHERE plan_id=?").bind(planId).all();
  return Object.fromEntries((r.results || []).map(x => [x.key, { type: x.value_type, value: cast(x.value_type, x.value) }]));
}
export async function checkDowngradeGuard(env, organizationId, targetPlanId) {
  const [target, ...counts] = await Promise.all([planEntitlements(env, targetPlanId), ...LIMITS.map(x => env.LUMMET_DB.prepare(x.countSql).bind(...(x.metric === "users" ? [organizationId, organizationId] : [organizationId])).first())]);
  const blockers = [];
  for (let i = 0; i < LIMITS.length; i++) {
    const def = LIMITS[i], used = Number(counts[i]?.n || 0), limit = target[def.key]?.value;
    if (typeof limit === "number" && used > limit) {
      const resourceRows = await env.LUMMET_DB.prepare(def.rowsSql).bind(...(def.metric === "users" ? [organizationId, organizationId] : [organizationId])).all();
      const removalRequired = (resourceRows.results || []).slice(0, used - limit).map((r) => ({ id: r.id, label: r.label || r.id, ...(r.kind ? { kind: r.kind } : {}) }));
      blockers.push({ metric: def.metric, used, limit, excess: used - limit, removalRequired });
    }
  }
  // Add-ons are additive overrides: a downgrade cannot strand an active add-on above the target plan's limit.
  const addonRows = { results: await (await import('./repositories/plan-change-intents.js')).listActiveAddonsForOrganization(env, organizationId) };
  for (const row of addonRows.results || []) {
    const targetLimit = target[row.entitlement_key]?.value;
    const addonValue = Number(row.delta_per_unit) * Number(row.quantity);
    if (typeof targetLimit === 'number' && addonValue > 0 && addonValue > targetLimit) blockers.push({ metric: `addon:${row.entitlement_key}`, used: addonValue, limit: targetLimit, excess: addonValue-targetLimit, removalRequired: 'Reduce or remove the add-on before downgrading' });
  }
  const storageTarget = target["storage.max_mb"]?.value;
  const current = await env.LUMMET_DB.prepare(`SELECT s.plan_id FROM subscriptions s WHERE s.organization_id=? AND s.status NOT IN ('canceled','expired','incomplete_expired') ORDER BY s.created_at DESC LIMIT 1`).bind(organizationId).first();
  if (current && typeof storageTarget === "number") {
    const currentEnt = await planEntitlements(env, current.plan_id), currentStorage = currentEnt["storage.max_mb"]?.value;
    if (typeof currentStorage === "number" && storageTarget < currentStorage) {
    const usageRow = await (await import('./repositories/plan-change-intents.js')).latestStorageUsage(env, organizationId);
    const usedMb = usageRow?.value == null ? null : Number(usageRow.value) / 1048576;
    if (usedMb == null || usedMb > storageTarget) blockers.push({ metric: "storageMb", used: usedMb == null ? null : Math.ceil(usedMb), limit: storageTarget, removalRequired: usedMb == null ? "Storage usage is unknown; obtain a tenant report before this downgrade" : "Reduce storage before downgrading" });
    }
  }
  return { ok: blockers.length === 0, blockers, targetPlanId };
}
