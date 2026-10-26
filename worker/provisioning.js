// =====================================================
// AUTOMATED TENANT PROVISIONING (master prompt section 17)
//
// Implements steps 1-9 of section 17's list (validate
// entitlement, generate identifiers, create D1/KV/R2, generate
// + store tenant credentials, register the tenant) as its own
// job, landing the site at "provisioned". From there,
// attemptAutoDeploy() (below) immediately hands off to
// deployments.js's own job (steps 10+: migrate, deploy the
// actual tenant application code, health check, mark active) —
// see worker/tenant-template.js for where that deployable
// artifact comes from (a shared, versioned release published by
// staff, not built per-site). If no release has been published
// yet, the site honestly stays "provisioned" rather than
// pretending to be live (Rule 5) — this is the one remaining
// manual precondition: publish at least one tenant template
// release before any site can reach "active" automatically.
//
// Every step is idempotent and resumable — re-running a job
// (via retryProvisioning) skips any step already marked
// 'success' or 'skipped' and continues from where it left
// off, per section 17's explicit requirement.
// =====================================================

import * as cloudflareProvider from "./infra-cloudflare.js";
import * as jobsModule from "./jobs.js";
import * as sites from "./sites.js";
import * as registry from "./registry.js";
import * as entitlementsService from "./entitlements.js";
import * as webhooks from "./webhooks.js";
import { deployments as realDeployments } from "./deployments.js";
import * as tenantTemplate from "./tenant-template.js";
import { evaluateWriteGate, refusalFor } from "./access.js";

export const PROVISIONING_STEPS = [
  "validate_entitlement",
  "generate_identifiers",
  "create_database",
  "create_kv_namespace",
  "create_r2_bucket",
  "register_tenant"
];

export function computeResourceNames(site, env) {
  const base = `lummet-site-${site.slug}`;
  const domainSuffix = env.PLATFORM_DOMAIN_SUFFIX || "sites.lummet.app";
  return {
    workerName: base,
    d1Name: `${base}-db`,
    kvTitle: `${base}-kv`,
    r2Name: `${base}-media`,
    // A provisional platform subdomain — real custom-domain
    // attachment is Phase 4's Domain Management (section 20). This
    // is what the tenant registry row (and the site's
    // primary_domain) point at until then.
    host: `${site.slug}.${domainSuffix}`
  };
}

export function createProvisioningService(infra, { deploymentService = realDeployments, templateService = tenantTemplate } = {}) {
  async function getSiteResource(env, siteId, resourceType) {
    return env.LUMMET_DB.prepare(
      `SELECT * FROM site_resources WHERE site_id = ? AND resource_type = ? AND status = 'active'`
    )
      .bind(siteId, resourceType)
      .first();
  }

  async function recordSiteResource(env, siteId, resourceType, resourceId, resourceName, metadata) {
    await env.LUMMET_DB.prepare(
      `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name, metadata)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, resource_type) DO UPDATE SET
         resource_id = excluded.resource_id, resource_name = excluded.resource_name,
         metadata = excluded.metadata, status = 'active', deleted_at = NULL`
    )
      .bind(siteId, infra.PROVIDER_NAME, resourceType, resourceId, resourceName, metadata ? JSON.stringify(metadata) : null)
      .run();
  }

  /**
   * Kicks off provisioning for a "pending" (or previously "failed")
   * site: re-validates the entitlement one more time (the count may
   * have changed since the site was created), transitions the site
   * to "provisioning", and creates the job record. Does NOT run the
   * job itself — the caller (index.js) does that via
   * `ctx.waitUntil(runJob(env, jobId))` so the HTTP response returns
   * immediately (master prompt section 17: "do not make the browser
   * wait for a long synchronous request").
   */
  async function startProvisioning(env, siteId, { actorUserId, actorType = "customer_user" } = {}) {
    const site = await sites.getSite(env, siteId);
    if (!site) return { ok: false, status: 404, error: "site_not_found" };
    const accessGate = await evaluateWriteGate(env, { organizationId: site.organization_id, method: "POST", subPath: `/sites/${siteId}/provision` });
    if (accessGate.blocked) return { ok: false, status: 402, ...refusalFor(accessGate.access) };
    if (site.status !== "pending") {
      return { ok: false, status: 409, error: "site_not_provisionable", currentStatus: site.status };
    }

    const maxSites = await entitlementsService.checkEntitlement(env, site.organization_id, "sites.max");
    const activeCount = await sites.countActiveSitesForOrganization(env, site.organization_id);
    if (typeof maxSites === "number" && activeCount > maxSites) {
      return { ok: false, status: 403, error: "site_limit_reached", limit: maxSites };
    }

    const transition = await sites.transitionSiteStatus(env, siteId, "provisioning", {
      reason: "provisioning started", actorType, actorId: actorUserId
    });
    if (!transition.ok) return transition;

    const jobResult = await jobsModule.createJob(env, {
      type: "tenant_provisioning", organizationId: site.organization_id, siteId,
      createdBy: actorUserId, actorType, stepKeys: PROVISIONING_STEPS
    });

    return { ok: true, jobId: jobResult.jobId };
  }

  /**
   * Resumes a job for a site currently in "failed" status. Reuses
   * the SAME job row (and therefore the same step history) rather
   * than creating a new one, so a job's error/attempt history for a
   * given site stays in one place.
   */
  async function retryProvisioning(env, siteId, { actorUserId, actorType = "customer_user" } = {}) {
    const site = await sites.getSite(env, siteId);
    if (!site) return { ok: false, status: 404, error: "site_not_found" };
    if (site.status !== "failed") return { ok: false, status: 409, error: "site_not_failed" };

    const existingJobs = await jobsModule.listJobsForSite(env, siteId);
    const lastJob = existingJobs.find((j) => j.type === "tenant_provisioning");
    if (!lastJob) return { ok: false, status: 404, error: "no_provisioning_job_found" };

    const transition = await sites.transitionSiteStatus(env, siteId, "provisioning", {
      reason: "provisioning retried", actorType, actorId: actorUserId
    });
    if (!transition.ok) return transition;

    return { ok: true, jobId: lastJob.id };
  }

  /**
   * Executes (or resumes) a provisioning job step by step. Safe to
   * call more than once for the same job — already-'success' or
   * '-skipped' steps are never re-run, and each step's own Cloudflare
   * call additionally checks site_resources / the site row itself
   * before doing anything, so even re-running a step that partially
   * completed can't create a duplicate resource.
   */
  async function runJob(env, jobId) {
    const job = await jobsModule.getJob(env, jobId);
    if (!job) return { ok: false, status: 404, error: "job_not_found" };
    if (job.status === "success") return { ok: true, alreadyDone: true };
    if (!["queued", "running", "failed"].includes(job.status)) {
      return { ok: false, status: 409, error: `cannot run a job in status ${job.status}` };
    }

    const site = await sites.getSite(env, job.site_id);
    if (!site) {
      await jobsModule.markJobFailed(env, jobId, "site no longer exists");
      return { ok: false, status: 404, error: "site_not_found" };
    }

    await jobsModule.markJobRunning(env, jobId);

    let names = null;
    const finalResult = {};

    for (const step of job.steps) {
      if (step.status === "success" || step.status === "skipped") {
        if (step.step_key === "generate_identifiers" && step.output) names = step.output;
        continue;
      }

      await jobsModule.startStep(env, jobId, step.step_key);

      try {
        switch (step.step_key) {
          case "validate_entitlement": {
            const maxSites = await entitlementsService.checkEntitlement(env, site.organization_id, "sites.max");
            const activeCount = await sites.countActiveSitesForOrganization(env, site.organization_id);
            if (typeof maxSites === "number" && activeCount > maxSites) {
              throw new Error(
                `organization ${site.organization_id} exceeds its sites.max entitlement (${activeCount} > ${maxSites})`
              );
            }
            await jobsModule.completeStep(env, jobId, step.step_key, { maxSites, activeCount });
            break;
          }

          case "generate_identifiers": {
            names = computeResourceNames(site, env);
            await jobsModule.completeStep(env, jobId, step.step_key, names);
            break;
          }

          case "create_database": {
            const existing = await getSiteResource(env, site.id, "d1");
            if (existing) {
              await jobsModule.skipStep(env, jobId, step.step_key, "already created");
              break;
            }
            const created = await infra.createDatabase(env, { name: names.d1Name });
            await recordSiteResource(env, site.id, "d1", created.resourceId, names.d1Name, created.metadata);
            await jobsModule.completeStep(env, jobId, step.step_key, { resourceId: created.resourceId });
            break;
          }

          case "create_kv_namespace": {
            const existing = await getSiteResource(env, site.id, "kv");
            if (existing) {
              await jobsModule.skipStep(env, jobId, step.step_key, "already created");
              break;
            }
            const created = await infra.createKVNamespace(env, { title: names.kvTitle });
            await recordSiteResource(env, site.id, "kv", created.resourceId, names.kvTitle, created.metadata);
            await jobsModule.completeStep(env, jobId, step.step_key, { resourceId: created.resourceId });
            break;
          }

          case "create_r2_bucket": {
            const existing = await getSiteResource(env, site.id, "r2");
            if (existing) {
              await jobsModule.skipStep(env, jobId, step.step_key, "already created");
              break;
            }
            const created = await infra.createR2Bucket(env, { name: names.r2Name });
            await recordSiteResource(env, site.id, "r2", created.resourceId, names.r2Name, created.metadata);
            await jobsModule.completeStep(env, jobId, step.step_key, { resourceId: created.resourceId });
            break;
          }

          case "register_tenant": {
            const currentSite = await sites.getSite(env, site.id);
            if (currentSite.tenant_id) {
              await jobsModule.skipStep(env, jobId, step.step_key, "tenant already registered");
              break;
            }

            const result = await registry.createTenant(env, {
              name: currentSite.name,
              host: names.host,
              description: `Auto-provisioned by tenant_provisioning job ${jobId} for site ${site.id}`,
              deployment_identifier: currentSite.slug
            });
            if (!result.ok) throw new Error(`registry.createTenant failed: ${result.error}`);

            await env.LUMMET_DB.prepare(
              `UPDATE sites SET tenant_id = ?, primary_domain = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
            )
              .bind(result.tenant.id, names.host, site.id)
              .run();

            // Shown once — same "shown once, encrypted at rest after
            // that" pattern as this codebase's existing manual
            // tenant-creation route and as invitations/password
            // resets. Never logged, never re-readable via the API.
            finalResult.tenantId = result.tenant.id;
            finalResult.host = names.host;
            finalResult.credential = result.credential;

            await jobsModule.completeStep(env, jobId, step.step_key, { tenantId: result.tenant.id, host: names.host });
            break;
          }

          default:
            throw new Error(`unknown provisioning step ${step.step_key}`);
        }
      } catch (error) {
        const message = error?.message || String(error);
        await jobsModule.failStep(env, jobId, step.step_key, message);
        await jobsModule.markJobFailed(env, jobId, `failed at step ${step.step_key}: ${message}`);
        await sites.transitionSiteStatus(env, site.id, "failed", {
          reason: `provisioning job ${jobId} failed at ${step.step_key}: ${message}`,
          actorType: "system"
        });
        await webhooks.dispatchEvent(env, site.organization_id, "site.failed", { siteId: site.id, step: step.step_key, message });
        return { ok: false, status: 500, error: message, failedStep: step.step_key };
      }
    }

    await jobsModule.markJobSuccess(env, jobId, finalResult);
    await sites.transitionSiteStatus(env, site.id, "provisioned", {
      reason: `provisioning job ${jobId} completed`, actorType: "system"
    });

    await webhooks.dispatchEvent(env, site.organization_id, "site.provisioned", { siteId: site.id, tenantId: finalResult.tenantId });

    const autoDeploy = await attemptAutoDeploy(env, site.id, { actorType: "system" });

    return { ok: true, result: { ...finalResult, autoDeploy } };
  }

  /**
   * Best-effort: once a site is freshly 'provisioned', immediately try
   * to carry it to 'active' using whatever tenant template release is
   * currently published (roadmap 0.1). This is deliberately NOT part
   * of PROVISIONING_STEPS/the job's own step list: provisioning
   * itself already succeeded and the site is validly 'provisioned'
   * either way. If no release has been published yet
   * (templateService.getCurrentRelease fails), the site simply stays
   * 'provisioned' — an honest, pre-existing, meaningful status — and
   * the result says so explicitly (Rule 5: never claim a site is
   * live when it isn't). If a release exists, deploymentService's own
   * fully-tested job (validate -> migrate -> deploy -> health check)
   * drives the site the rest of the way to 'active', including its
   * own failure handling (a bad first deploy correctly lands the site
   * in 'failed', exactly as deployments.js already documents).
   */
  async function attemptAutoDeploy(env, siteId, { actorType = "system" } = {}) {
    const release = await templateService.getCurrentRelease(env);
    if (!release.ok) {
      return { attempted: false, reason: release.error };
    }
    const started = await deploymentService.startDeployment(env, {
      siteId, version: release.version, migrations: release.migrations, scriptContent: release.scriptContent, actorType
    });
    if (!started.ok) return { attempted: true, ok: false, error: started.error };
    const ran = await deploymentService.runJob(env, started.jobId);
    return { attempted: true, ok: ran.ok, error: ran.ok ? undefined : ran.error, deploymentId: started.deploymentId };
  }

  return { startProvisioning, retryProvisioning, runJob, attemptAutoDeploy };
}

// Production singleton, bound to the real Cloudflare provider — used
// by index.js. Tests import createProvisioningService directly with
// a fake provider instead of this.
export const provisioning = createProvisioningService(cloudflareProvider);
