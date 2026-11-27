// worker/ops-summary.js -- read-only data for the staff Overview ("what needs me right now?").
// Every block is loaded independently and never throws: a failing query only hides its own block (the page still renders).
// Platform-wide blocks (releases, billing, incidents) are for super admins only; a scoped admin sees their own tenants.
import { isSuperAdmin, getAdminTenantIds } from "./rbac.js";
import { listAlertState, alertCatalog } from "./alerts.js";
import * as rollouts from "./rollouts.js";
import * as repo from "./repositories/ops-summary.js";

const DAYS = 14;

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.error("ops-summary block failed:", e && e.message); return fallback; }
}

/** Fill a 14-day series (oldest first) from rows of {d:'YYYY-MM-DD', n}. */
function series(rows, now = new Date()) {
  const by = new Map((rows || []).map((r) => [r.d, Number(r.n) || 0]));
  const out = [];
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    out.push(by.get(d) || 0);
  }
  return out;
}

export async function loadOpsSummary(env, admin) {
  const sup = isSuperAdmin(admin);
  const ids = sup ? null : await safe(() => getAdminTenantIds(env, admin.id), []);
  const scope = ids ? new Set(ids) : null;

  const tenantsP = safe(async () => {
    const r = await repo.tenantsWithHealth(env);
    return scope ? r.filter((t) => scope.has(t.id)) : r;
  }, []);
  const auditP = safe(() => repo.recentAudit(env, ids), []);
  const auditTrendP = safe(async () => series(await repo.failedAuditByDay(env, DAYS, ids)), series([]));

  let releases = null, billing = null, incidents = null, deployTrend = null;
  if (sup) {
    [releases, billing, incidents, deployTrend] = await Promise.all([
      safe(async () => {
        const dash = await rollouts.dashboard(env);
        const running = dash.running ? {
          id: dash.running.id, version: dash.running.release_version || (dash.shown && dash.shown.version) || null,
          counts: Object.fromEntries((await repo.rolloutItemCounts(env, dash.running.id)).map((r) => [r.status, r.n]))
        } : null;
        return {
          line: dash.line, activeVersion: dash.active ? dash.active.version : null, activeSince: dash.active ? dash.active.created_at : null,
          totalLive: dash.totalLive, onActive: dash.onActive, outdated: dash.outdated, running,
          recent: (dash.recent || []).slice(0, 4)
        };
      }, null),
      safe(async () => {
        const [subRows, failed7, overdue, atRisk] = await Promise.all([repo.subscriptionCounts(env), repo.failedPaymentsSince(env, 7), repo.overdueInvoices(env), repo.subscriptionsAtRisk(env)]);
        return { subs: Object.fromEntries(subRows.map((r) => [r.status, r.n])), failed7, overdue, atRisk };
      }, null),
      safe(async () => {
        const state = await listAlertState(env);
        const cat = new Map(alertCatalog().map((c) => [c.key, c]));
        return state.filter((s) => s.firing === 1 || s.firing === true).map((s) => ({
          key: s.key, count: s.last_count, since: s.first_seen_at, title: (cat.get(s.key) || {}).title || s.key, path: (cat.get(s.key) || {}).path || "/platform/saas/alerts"
        }));
      }, null),
      safe(async () => ({ all: series(await repo.deploymentsByDay(env, DAYS)), failed: series(await repo.deploymentsByDay(env, DAYS, true)) }), null)
    ]);
  }
  const [tenants, audit, failedActions] = await Promise.all([tenantsP, auditP, auditTrendP]);
  return { sup, tenants, audit, failedActions, releases, billing, incidents, deployTrend };
}

/**
 * The "needs attention" list, most urgent first: [{level:'danger'|'warn', title, detail, href}].
 * Pure function of the loaded data, so it is easy to test.
 */
export function attentionItems(s) {
  const items = [];
  for (const t of s.tenants || []) {
    if (t.status === "active" && t.health_status && t.health_status !== "Online") {
      items.push({ level: ["Unauthorized", "Unavailable"].includes(t.health_status) ? "danger" : "warn", title: `${t.name} is ${String(t.health_status).toLowerCase()}`, detail: t.last_error ? String(t.last_error).slice(0, 120) : "Failing its health check", href: `/tenants/${encodeURIComponent(t.id)}` });
    }
  }
  for (const a of s.incidents || []) items.push({ level: "danger", title: a.title, detail: a.count ? `${a.count} affected` : "Alert firing", href: a.path || "/platform/saas/alerts" });
  const r = s.releases;
  if (r && r.recent && r.recent[0] && r.recent[0].status === "failed" && !r.running) items.push({ level: "danger", title: `Rollout ${r.recent[0].version} failed`, detail: r.recent[0].error ? String(r.recent[0].error).slice(0, 120) : "Review and resume or cancel it", href: "/tenants/deployments" });
  const b = s.billing;
  if (b) {
    const pd = (b.subs.past_due || 0), rs = (b.subs.restricted || 0) + (b.subs.unpaid || 0) + (b.subs.suspended || 0);
    if (rs) items.push({ level: "danger", title: `${rs} subscription${rs === 1 ? "" : "s"} restricted or suspended`, detail: "Sites may be limited until payment is fixed", href: "/platform/saas/subscriptions" });
    if (pd) items.push({ level: "warn", title: `${pd} subscription${pd === 1 ? "" : "s"} past due`, detail: "In the grace period", href: "/platform/saas/subscriptions?status=past_due" });
    if (b.failed7) items.push({ level: "warn", title: `${b.failed7} failed payment${b.failed7 === 1 ? "" : "s"} in the last 7 days`, detail: "Customers may need a nudge", href: "/platform/saas/subscriptions" });
  }
  if (r && r.outdated > 0 && !r.running) items.push({ level: "warn", title: `${r.outdated} site${r.outdated === 1 ? "" : "s"} behind release ${r.activeVersion}`, detail: "Start or resume a rollout", href: "/tenants/deployments" });
  const rank = { danger: 0, warn: 1 };
  return items.sort((x, y) => rank[x.level] - rank[y.level]);
}
