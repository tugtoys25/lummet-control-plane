// =====================================================
// USAGE SNAPSHOT (master prompt section 8's "Usage" nav item;
// section 15's usage_counters table exists but a full metering
// service — storage, API requests, AI credits — is NOT built
// yet, see migration 0006's header comment).
//
// This deliberately only reports usage this codebase can
// already count for real: sites, team members, and custom
// domains — each a direct COUNT() against data Phases 1-4
// already maintain. Nothing here is estimated, sampled, or
// invented; a metric this platform can't yet measure (storage,
// AI credits, API request volume) is reported as `null`, not a
// fake zero, so the UI can visibly distinguish "using none of
// this" from "we don't track this yet".
// =====================================================

import * as entitlementsService from "./entitlements.js";

export async function getUsageSnapshot(env, organizationId) {
  const entitlements = await entitlementsService.resolveForOrganization(env, organizationId);

  const sitesRow = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM sites WHERE organization_id = ? AND status NOT IN ('deleted', 'deleting')`
  )
    .bind(organizationId)
    .first();

  const membersRow = await env.LUMMET_DB.prepare(
    `SELECT COUNT(*) c FROM organization_users WHERE organization_id = ?`
  )
    .bind(organizationId)
    .first();

  const domainsRow = await env.LUMMET_DB.prepare(
    `SELECT COUNT(DISTINCT COALESCE(d.zone_id, d.id)) c FROM domains d
     JOIN sites s ON s.id = d.site_id
     WHERE s.organization_id = ? AND d.status != 'removed'`
  )
    .bind(organizationId)
    .first();

  return {
    sites: { used: sitesRow?.c || 0, limit: entitlements["sites.max"]?.value ?? null },
    users: { used: membersRow?.c || 0, limit: entitlements["users.max"]?.value ?? null },
    customDomains: { used: domainsRow?.c || 0, limit: entitlements["domains.custom.max"]?.value ?? null },
    // Not yet metered anywhere in this codebase — see header comment.
    storageMb: { used: null, limit: entitlements["storage.max_mb"]?.value ?? null },
    features: {
      aiEnabled: entitlements["ai.enabled"]?.value ?? false,
      affiliateEnabled: entitlements["affiliate.enabled"]?.value ?? false,
      analyticsLevel: entitlements["analytics.level"]?.value ?? "none",
      reportsEnabled: entitlements["reports.enabled"]?.value ?? false,
      alertsEnabled: entitlements["alerts.enabled"]?.value ?? false,
      whiteLabelEnabled: entitlements["white_label.enabled"]?.value ?? false,
      apiEnabled: entitlements["api.enabled"]?.value ?? false
    }
  };
}

// =====================================================
// USAGE METERING SERVICE (master prompt section 15)
//
// The single entry point for counting anything. Every metric goes
// through recordUsage(); do not add ad-hoc counters elsewhere.
// Events are idempotent (same idempotencyKey => counted once) and
// the monthly aggregate is updated in the same code path.
// =====================================================

export function currentPeriod(now = new Date()) {
  return now.toISOString().slice(0, 7);
}

export async function recordUsage(env, { organizationId, siteId = null, userId = null, metric, quantity = 1, idempotencyKey = null, metadata = null, now = new Date() }) {
  if (!organizationId || !metric || !Number.isInteger(quantity) || quantity <= 0) return { ok: false, error: "invalid_usage_event" };
  const period = currentPeriod(now);
  try {
    await env.LUMMET_DB.prepare(
      `INSERT INTO usage_events (id, organization_id, site_id, user_id, metric, quantity, period, idempotency_key, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(crypto.randomUUID(), organizationId, siteId, userId, metric, quantity, period, idempotencyKey, metadata ? JSON.stringify(metadata) : null).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) return { ok: true, duplicate: true };
    throw e;
  }
  await env.LUMMET_DB.prepare(
    `INSERT INTO usage_monthly (organization_id, period, metric, quantity) VALUES (?, ?, ?, ?)
     ON CONFLICT(organization_id, period, metric) DO UPDATE SET quantity = quantity + excluded.quantity`
  ).bind(organizationId, period, metric, quantity).run();
  return { ok: true, duplicate: false };
}

export async function getMonthlyUsage(env, organizationId, period = currentPeriod()) {
  const r = await env.LUMMET_DB.prepare(`SELECT metric, quantity FROM usage_monthly WHERE organization_id = ? AND period = ?`)
    .bind(organizationId, period).all();
  return Object.fromEntries(r.results.map((x) => [x.metric, x.quantity]));
}

// metric -> entitlement key that caps it (data, not per-plan code).
export const METRIC_LIMITS = { ai_credits: "ai.credits_monthly", api_requests: "api.requests_monthly", emails: "emails.monthly" };

/** { limit, used, remaining, exceeded, percent } — limit is null when the plan sets none. */
export async function checkUsageLimit(env, organizationId, metric) {
  const key = METRIC_LIMITS[metric];
  const [limit, monthly] = await Promise.all([
    key ? entitlementsService.checkEntitlement(env, organizationId, key) : undefined,
    getMonthlyUsage(env, organizationId)
  ]);
  const used = monthly[metric] || 0;
  if (typeof limit !== "number") return { limit: null, used, remaining: null, exceeded: false, percent: null };
  return { limit, used, remaining: Math.max(0, limit - used), exceeded: used >= limit, percent: limit ? Math.round((used / limit) * 100) : 100 };
}
