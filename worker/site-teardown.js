// =====================================================
// SITE TEARDOWN: deleting ONE site for real.
//
// Before this module "delete" only moved a site to `deleting` and stopped there: its route, Worker, D1, KV and R2 stayed in
// Cloudflare (only whole-organization erasure removed them). Now every deletion, from the customer or from staff, goes
// through beginSiteDeletion(), which moves the site to `deleting` and creates a durable `site_teardown` job. The job:
//
//   stop_routing           the site's route and any old-address redirect routes: the site stops answering first
//   remove_custom_domains  custom hostnames, delegated zones and their routes
//   delete_worker          the Worker script (its cron triggers go with it)
//   delete_database        D1
//   delete_kv              KV namespace
//   delete_r2              R2 bucket
//   delete_backups         the site's stored backup files
//   finalize               control-plane rows, the tenant registry row and its credentials; the site becomes `deleted`,
//                          which releases its address for anyone to use
//
// Every step is idempotent and resumable (same pattern as provisioning.js): a step that already succeeded is skipped, a
// resource Cloudflare no longer has counts as gone, and a failure leaves the site in `deleting` for the durable-job sweep to
// retry with backoff. Nothing is marked deleted in our database until the thing is really gone from the provider.
// =====================================================
import * as cloudflareProvider from "./infra-cloudflare.js";
import * as jobsModule from "./jobs.js";
import * as sites from "./sites.js";
import * as webhooks from "./webhooks.js";
import * as policy from "./retention-policy.js";
import { createZoneDomainService } from "./zone-domains.js";
import * as dohResolver from "./dns-doh.js";
import { routeZoneId } from "./repositories/site-resources.js";
import * as repo from "./repositories/site-teardown.js";

export const TEARDOWN_STEPS = ["stop_routing", "remove_custom_domains", "delete_worker", "delete_database", "delete_kv", "delete_r2", "delete_backups", "finalize"];
export const JOB_TYPE = "site_teardown";

const NOT_FOUND = /not\s*found|does\s*not\s*exist|no\s*such|could\s*not\s*(?:be\s*)?(?:find|found)|invalid zone/i;
// Kept as the audit record of what existed and when it ended; everything else about the site is removed at the end.
const KEEP_TABLES = new Set(["site_status_events", "site_resources"]);
// Every status except `deleted` can start a deletion (ALLOWED_TRANSITIONS in sites.js). A site stuck in provisioning, configuring or
// deploying (or failed, or provisioned) is deletable too: its other jobs are cancelled first, and whatever a job created in the
// meantime is caught by the `finalize` check (it refuses to finish while a resource is still recorded as active) and removed on retry.
export const BUSY_STATUSES = [];

export function createSiteTeardownService(infra, { zoneService = null } = {}) {
  const zones = () => zoneService || createZoneDomainService({ infra, dns: dohResolver });

  const openJob = (env, siteId) => repo.openJob(env, siteId, JOB_TYPE);

  /**
   * Starts deleting a site: `deleting` status plus the teardown job. Safe to call twice (returns the job already open).
   * Also adopts a site left in `deleting` by the old code that never had a job. Does not run the job: the caller dispatches it
   * (jobRunner.dispatchJob) so the HTTP response returns at once.
   */
  async function beginSiteDeletion(env, { siteId, organizationId = null, actorType = "customer_user", actorId = null, reason = null }) {
    const site = await sites.getSite(env, siteId);
    if (!site || (organizationId && site.organization_id !== organizationId)) return { ok: false, status: 404, error: "site_not_found" };
    if (site.status === "deleted") return { ok: false, status: 409, error: "site_already_deleted" };

    if (site.status !== "deleting") {
      const t = await sites.transitionSiteStatus(env, siteId, "deleting", { reason: reason || "deletion requested", actorType, actorId });
      if (!t.ok) return t;
    }
    await repo.cancelOtherJobs(env, siteId, JOB_TYPE);     // nothing else may run, or be retried by the sweep, for a site that is going away
    const existing = await openJob(env, siteId);
    if (existing) return { ok: true, jobId: existing.id, alreadyRunning: true };
    const job = await jobsModule.createJob(env, { type: JOB_TYPE, organizationId: site.organization_id, siteId, createdBy: actorId, actorType, stepKeys: TEARDOWN_STEPS, payload: { reason: reason || null } });
    return { ok: true, jobId: job.jobId };
  }

  const gone = (e) => NOT_FOUND.test(String(e?.message || e));

  const resourcesOf = (env, siteId, type) => repo.activeResources(env, siteId, type);
  const markResourceDeleted = (env, id) => repo.markResourceDeleted(env, id);
  /** Deletes every active resource of one type through `fn`, marking each deleted only after the provider confirms (or says it is gone). */
  async function dropResources(env, siteId, type, fn) {
    let n = 0;
    for (const r of await resourcesOf(env, siteId, type)) {
      try { await fn(r); } catch (e) { if (!gone(e)) throw new Error(`${type} ${r.resource_name || r.resource_id}: ${String(e?.message || e).slice(0, 160)}`); }
      await markResourceDeleted(env, r.id);
      n++;
    }
    return n;
  }

  const STEP = {
    async stop_routing(env, site) {
      let routes = await dropResources(env, site.id, "route", (r) => infra.deleteWorkerRoute(env, r.resource_id, { zoneId: routeZoneId(r) }));
      // After a domain move the OLD address redirects through its own route; that route must go too.
      for (const r of await repo.redirectsForSite(env, site.id)) {
        if (r.route_id) {
          try { await infra.deleteWorkerRoute(env, r.route_id, { zoneId: r.zone_id || undefined }); } catch (e) { if (!gone(e)) throw new Error(`redirect route ${r.old_host}: ${String(e?.message || e).slice(0, 160)}`); }
          routes++;
        }
        await repo.deleteRedirect(env, r.old_host);
      }
      return { routes };
    },
    async remove_custom_domains(env, site) {
      let hostnames = 0;
      for (const d of await repo.customHostnames(env, site.id)) {
        try { await infra.deleteCustomHostname(env, d.ssl_resource_id); } catch (e) { if (!gone(e)) throw new Error(`custom hostname ${d.id}: ${String(e?.message || e).slice(0, 160)}`); }
        await repo.markHostnameRemoved(env, d.id);
        hostnames++;
      }
      const failures = await zones().cleanupForSite(env, site.id);          // delegated hostnames, their routes and zones
      if (failures.length) throw new Error(`custom domains: ${failures.map((f) => `${f.step}: ${f.error}`).join("; ").slice(0, 300)}`);
      return { hostnames };
    },
    async delete_worker(env, site) { return { deleted: await dropResources(env, site.id, "worker", (r) => infra.deleteWorkerScript(env, r.resource_name)) }; },
    async delete_database(env, site) { return { deleted: await dropResources(env, site.id, "d1", (r) => infra.deleteDatabase(env, r.resource_id)) }; },
    async delete_kv(env, site) { return { deleted: await dropResources(env, site.id, "kv", (r) => infra.deleteKVNamespace(env, r.resource_id)) }; },
    async delete_r2(env, site) { return { deleted: await dropResources(env, site.id, "r2", (r) => infra.deleteR2Bucket(env, r.resource_id)) }; },
    async delete_backups(env, site) {
      const rows = await repo.storedBackups(env, site.id);
      let deleted = 0;
      for (const b of rows) {
        if (!env.BACKUPS) throw new Error("backup storage is not configured, so this site's stored backups cannot be removed");
        try { await env.BACKUPS.delete(b.storage_key); } catch (e) { if (!gone(e)) throw new Error(`backup ${b.id}: ${String(e?.message || e).slice(0, 160)}`); }
        await repo.clearBackupKey(env, b.id);
        deleted++;
      }
      return { deleted };
    },
    async finalize(env, site) {
      // Anything still marked active at the provider means an earlier step was skipped: do not pretend the site is gone.
      const left = await repo.activeResourceTypes(env, site.id);
      if (left.length) throw new Error(`resources still recorded as active: ${left.join(", ")}`);
      const counts = {};
      for (const [table, condition] of policy.SITE_DELETE) {
        if (KEEP_TABLES.has(table)) continue;
        counts[table] = await repo.deleteSiteRows(env, table, condition, site.id);
      }
      counts.site_backups = await repo.deleteBackupRows(env, site.id);
      const fresh = await sites.getSite(env, site.id);
      if (fresh?.tenant_id) {
        const shared = await repo.tenantSharedWithOtherSite(env, fresh.tenant_id, site.id);
        if (!shared) await repo.deleteTenant(env, fresh.tenant_id);   // credentials, health and capabilities cascade
      }
      await repo.detachTenantFromSite(env, site.id);
      const t = await sites.transitionSiteStatus(env, site.id, "deleted", { reason: "teardown complete", actorType: "system" });
      if (!t.ok && t.error !== "invalid_transition") throw new Error(`could not mark the site deleted: ${t.error}`);
      return { removed: counts };
    }
  };

  /** Runs (or resumes) one teardown job. Steps are idempotent and all re-run; a failure stops the job and leaves the site in `deleting`. */
  async function runJob(env, jobId) {
    const job = await jobsModule.getJob(env, jobId);
    if (!job) return { ok: false, status: 404, error: "job_not_found" };
    if (job.type !== JOB_TYPE) return { ok: false, status: 409, error: "not_a_teardown_job" };
    if (job.status === "success") return { ok: true, alreadyDone: true };
    if (!["queued", "running", "failed"].includes(job.status)) return { ok: false, status: 409, error: `cannot run a job in status ${job.status}` };
    const site = await sites.getSite(env, job.site_id);
    if (!site) { await jobsModule.markJobFailed(env, jobId, "site no longer exists"); return { ok: false, status: 404, error: "site_not_found" }; }
    if (site.status !== "deleting" && site.status !== "deleted") { await jobsModule.markJobFailed(env, jobId, `site is ${site.status}, not deleting`); return { ok: false, status: 409, error: "site_not_deleting" }; }

    await jobsModule.markJobRunning(env, jobId);
    const result = {};
    for (const step of job.steps) {
      // Every step runs on every attempt, even one that succeeded before: each only acts on what is still recorded as active, so
      // a repeat is a no-op, and a resource a straggling setup job created after its step passed is still caught and removed.
      await jobsModule.startStep(env, jobId, step.step_key);
      try {
        if (site.status === "deleted" && step.step_key !== "finalize") { await jobsModule.skipStep(env, jobId, step.step_key, "site already deleted"); continue; }
        const output = await STEP[step.step_key](env, site);
        result[step.step_key] = output;
        await jobsModule.completeStep(env, jobId, step.step_key, output);
      } catch (error) {
        const message = error?.message || String(error);
        await jobsModule.failStep(env, jobId, step.step_key, message);
        await jobsModule.markJobFailed(env, jobId, `failed at step ${step.step_key}: ${message}`);
        // The site stays `deleting`: its address stays held and the sweep retries. Nothing is half-erased in our database.
        return { ok: false, status: 502, error: message, failedStep: step.step_key };
      }
    }
    await jobsModule.markJobSuccess(env, jobId, result);
    await webhooks.dispatchEvent(env, site.organization_id, "site.deleted", { siteId: site.id, name: site.name }).catch(() => {});
    return { ok: true, result };
  }

  /** Re-opens a failed teardown for the sweep or a staff retry: the same job, the same step history. */
  async function retryTeardown(env, jobId) { return runJob(env, jobId); }

  return { beginSiteDeletion, runJob, retryTeardown, TEARDOWN_STEPS };
}

export const siteTeardown = createSiteTeardownService(cloudflareProvider);
export const beginSiteDeletion = (...args) => siteTeardown.beginSiteDeletion(...args);
