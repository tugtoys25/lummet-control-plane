// worker/customer-overview.js -- read-only extras for the customer Overview: site health, billing summary, "needs your attention", activity.
// Each block loads on its own and never throws; a failing block only disappears. Billing is for owners and admins only.
import * as repo from "./repositories/customer-overview.js";

async function safe(fn, fallback) {
  try { return await fn(); } catch (e) { console.error("customer-overview block failed:", e && e.message); return fallback; }
}

function actionText(action, resource) {
  const a = String(action || "").replace(/_/g, " "), r = String(resource || "").replace(/_/g, " ");
  return r && !a.endsWith(r) ? `${a} ${r}` : a;
}

const ACTIVE_SITE = new Set(["active", "live"]);

export async function loadCustomerOverview(env, { organizationId, sites, subscription, canManage }) {
  const ids = (sites || []).map((s) => s.id);
  const [deploys, health, domains, activityDeploys, audit, invoice, failed30, method] = await Promise.all([
    safe(() => repo.latestDeployments(env, ids), []),
    safe(() => repo.siteHealth(env, ids), []),
    safe(() => repo.domainIssues(env, ids), []),
    safe(() => repo.recentDeployments(env, ids), []),
    safe(() => repo.recentOrgAudit(env, organizationId), []),
    canManage ? safe(() => repo.latestInvoice(env, organizationId), null) : null,
    canManage ? safe(() => repo.failedPaymentsSince(env, organizationId, 30), 0) : 0,
    canManage ? safe(() => repo.defaultPaymentMethod(env, organizationId), null) : null
  ]);
  const dBy = new Map(deploys.map((d) => [d.site_id, d])), hBy = new Map(health.map((h) => [h.site_id, h]));
  const siteById = new Map((sites || []).map((s) => [s.id, s]));
  const siteRows = (sites || []).map((s) => ({ id: s.id, deploy: dBy.get(s.id) || null, health: hBy.get(s.id) ? hBy.get(s.id).health_status : null }));
  const activity = [
    ...activityDeploys.map((d) => ({ at: d.created_at, text: `${d.is_rollback ? "Rollback" : "Deployment"} ${d.version ? d.version + " " : ""}for ${siteById.get(d.site_id) ? siteById.get(d.site_id).name : "a site"}: ${d.status}`, ok: !["failed", "rolled_back"].includes(d.status) })),
    ...audit.map((a) => ({ at: a.created_at, text: `${a.actor_type === "staff" ? "Lummet staff" : "You or your team"}: ${actionText(a.action, a.resource)}`, ok: true }))
  ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 8);
  const billing = canManage && subscription ? { invoice, failed30, method, periodEnd: subscription.current_period_end || null, trialEnds: subscription.trial_ends_at || null, status: subscription.status, graceEnds: subscription.grace_ends_at || null, cancelAtEnd: !!subscription.cancel_at_period_end } : null;
  return { siteRows, domains, activity, billing };
}

/** "Needs your attention", most urgent first: [{level, title, detail, href}]. Pure, so it is easy to test. */
export function customerAttention({ sites, subscription, usage, extra, twoFactorMissing, canManage }) {
  const out = [];
  const st = subscription && subscription.status;
  if (canManage && ["past_due", "restricted", "unpaid", "suspended"].includes(st)) {
    out.push({ level: "danger", title: st === "past_due" ? "Your last payment did not go through" : "Your plan is limited because of an unpaid invoice", detail: st === "past_due" ? "Update your payment method to keep your sites running." : "Pay the open invoice to restore full access.", href: "/app/billing" });
  } else if (canManage && extra && extra.billing && extra.billing.failed30 > 0) {
    out.push({ level: "warn", title: "A recent payment failed", detail: "Check your payment method.", href: "/app/billing" });
  }
  for (const s of sites || []) {
    if (s.status === "failed") out.push({ level: "danger", title: `${s.name} failed to set up`, detail: "Open Sites to retry, or contact support.", href: "/app/sites" });
  }
  for (const r of (extra && extra.siteRows) || []) {
    const s = (sites || []).find((x) => x.id === r.id);
    if (s && ACTIVE_SITE.has(s.status) && r.health && r.health !== "Online") out.push({ level: "danger", title: `${s.name} is not responding`, detail: "We are checking it. Contact support if it lasts.", href: "/app/sites" });
    else if (r.deploy && ["failed", "rolled_back"].includes(r.deploy.status)) out.push({ level: "warn", title: `The latest update of ${s ? s.name : "a site"} did not finish`, detail: "See Deployments for details.", href: "/app/deployments" });
  }
  for (const d of (extra && extra.domains) || []) {
    out.push({ level: d.status === "failed" ? "danger" : "warn", title: d.status === "failed" ? `${d.hostname} could not be connected` : `${d.hostname} is not connected yet`, detail: d.status === "failed" && d.failure_reason ? String(d.failure_reason).slice(0, 120) : "Check the nameserver step on Domains.", href: "/app/domains" });
  }
  if (st === "trialing" && subscription.trial_ends_at) {
    const days = Math.ceil((new Date(subscription.trial_ends_at).getTime() - Date.now()) / 86400000);
    if (days <= 3) out.push({ level: "warn", title: days <= 0 ? "Your trial has ended" : `Your trial ends in ${days} day${days === 1 ? "" : "s"}`, detail: "Choose a plan to keep your sites.", href: "/app/billing" });
  }
  for (const [key, label] of [["sites", "sites"], ["users", "team seats"], ["customDomains", "custom domains"]]) {
    const u = usage && usage[key];
    if (u && u.limit != null && u.limit > 0 && u.used >= u.limit) out.push({ level: "warn", title: `You have used all your ${label}`, detail: `${u.used} of ${u.limit}. Upgrade to add more.`, href: "/app/billing" });
  }
  if (twoFactorMissing) out.push({ level: "warn", title: "Turn on two-factor sign-in", detail: "Protects your account if your password leaks.", href: "/app/security/2fa" });
  const rank = { danger: 0, warn: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
