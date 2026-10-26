// Phase 5.4: plan storage cap -> tenant, and tenant storage usage -> control plane.
// Cap semantics: each provisioned site receives the organization's `storage.max_mb` entitlement (add-ons included) as its own cap.
// A non-positive entitlement (no usable subscription resolves to zero) is NEVER pushed as a cap: access loss is the site-access
// gate's job, and a billing blip must not turn into "every upload refused" on a live site. The previous cap stays in force.
import * as repo from "./repositories/storage-sync.js";
import * as entitlementsService from "./entitlements.js";
import * as client from "./client.js";
import * as commercial from "./commercial.js";

const MB = 1024 * 1024;
const MAX_ATTEMPTS = 5;
const FRESH_MS = 3 * 24 * 60 * 60 * 1000;

export async function desiredStorageMb(env, organizationId, { entitlements = entitlementsService } = {}) {
  const ent = await entitlements.resolveForOrganization(env, organizationId);
  const v = Number(ent?.["storage.max_mb"]?.value);
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

// Queue a push whenever a site's desired cap differs from what was last queued. Oldest-checked sites first, bounded per run.
export async function reconcileStorageLimits(env, { limit = 50, repository = repo, entitlements = entitlementsService } = {}) {
  const out = { checked: 0, queued: 0, unchanged: 0, skipped: 0 };
  const cache = new Map();
  for (const site of await repository.listSitesForStorageCheck(env, limit)) {
    out.checked++;
    if (!cache.has(site.organization_id)) cache.set(site.organization_id, await desiredStorageMb(env, site.organization_id, { entitlements }));
    const mb = cache.get(site.organization_id);
    if (mb == null) { out.skipped++; await repository.touchChecked(env, site.site_id); continue; }
    const existing = await repository.selectSync(env, site.site_id);
    if (!existing) { await repository.insertSync(env, { siteId: site.site_id, desiredMb: mb }); out.queued++; continue; }
    const changed = await repository.changeDesired(env, { siteId: site.site_id, desiredMb: mb });
    if (changed?.meta?.changes > 0) out.queued++; else { out.unchanged++; await repository.touchChecked(env, site.site_id); }
  }
  return out;
}

export async function processStorageLimitPushes(env, { limit = 25, now = new Date().toISOString().replace("T", " ").slice(0, 19), repository = repo, clientAdapter = client, siteLookup } = {}) {
  const result = { attempted: 0, succeeded: 0, retrying: 0, failed: 0 };
  for (const row of await repository.listDuePushes(env, { now, limit })) {
    const claim = await repository.claimPush(env, { siteId: row.site_id, generation: row.generation });
    if (!claim?.meta?.changes) continue;
    result.attempted++;
    try {
      const site = await (siteLookup ? siteLookup(env, row.site_id) : (await import("./sites.js")).getSite(env, row.site_id));
      if (!site?.tenant_id) throw new Error("site_tenant_not_provisioned");
      const r = await clientAdapter.pushTenantStorageLimit(env, site.tenant_id, { maxBytes: row.desired_mb * MB, generation: row.generation, siteId: row.site_id });
      if (!r.ok) throw new Error(r.reason || "tenant_push_failed");
      // 200 with accepted:false/already_applied is success. A tenant AHEAD of us (stale_generation) means the control plane lost
      // generations (e.g. a restore): fail loudly so staff see it, rather than leaving the cap silently unapplied.
      const body = r.data?.data ?? r.data;
      if (body?.accepted === false && body.reason === "stale_generation") throw new Error("tenant_generation_ahead");
      await repository.markPushed(env, { siteId: row.site_id, generation: row.generation, httpStatus: r.status });
      result.succeeded++;
    } catch (e) {
      const attempts = Number(row.attempts || 0) + 1, terminal = attempts >= MAX_ATTEMPTS;
      await repository.markPushRetry(env, { siteId: row.site_id, generation: row.generation, terminal, error: e?.message || e, delaySeconds: Math.min(3600, 30 * 2 ** (attempts - 1)) });
      if (terminal) { result.failed++; console.error(JSON.stringify({ msg: "storage_limit_push_failed", siteId: row.site_id, attempts })); } else result.retrying++;
    }
  }
  return result;
}

// Pull each reporting site's usage over the signed Super API (read-only) and keep the latest report.
export async function collectStorageUsage(env, { limit = 50, repository = repo, clientAdapter = client } = {}) {
  const out = { checked: 0, recorded: 0, failed: 0 };
  for (const site of await repository.listSitesForStorageCheck(env, limit)) {
    out.checked++;
    const r = await clientAdapter.getFromTenant(env, site.tenant_id, "/en/api/super/storage-usage");
    const d = r?.ok ? (r.data?.data ?? r.data) : null;
    if (!d || !Number.isSafeInteger(d.usedBytes) || d.usedBytes < 0) { out.failed++; continue; }
    await repository.upsertUsage(env, {
      siteId: site.site_id, usedBytes: d.usedBytes,
      reservedBytes: Number.isSafeInteger(d.reservedBytes) && d.reservedBytes >= 0 ? d.reservedBytes : 0,
      limitBytes: Number.isSafeInteger(d.limitBytes) && d.limitBytes >= 0 ? d.limitBytes : null,
      limitGeneration: Number.isSafeInteger(d.limitGeneration) ? d.limitGeneration : 0
    });
    out.recorded++;
  }
  return out;
}

// Real storage for the Usage page and daily snapshots. `null` means no site has reported; `partial` means some have not.
export async function organizationStorageUsage(env, organizationId, { now = Date.now(), repository = repo } = {}) {
  const row = await repository.organizationStorage(env, organizationId, { freshAfter: new Date(now - FRESH_MS).toISOString().replace("T", " ").slice(0, 19) });
  const reporting = Number(row?.reporting || 0), total = Number(row?.total || 0);
  if (!reporting) return { bytes: null, sitesReporting: 0, sitesTotal: total, partial: total > 0 };
  return { bytes: Number(row.used_bytes), sitesReporting: reporting, sitesTotal: total, partial: reporting < total };
}

export async function runStorageSync(env, opts = {}) {
  const reconcile = await reconcileStorageLimits(env, opts);
  const pushes = await processStorageLimitPushes(env, opts);
  const usage = await collectStorageUsage(env, opts);
  return { reconcile, pushes, usage };
}
