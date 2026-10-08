// =====================================================
// DEPLOYMENT MANAGEMENT (master prompt sections 21-22)
//
// Two cases share the same job/step machinery but behave
// differently at the site-status level:
//
//  - INITIAL deploy (site.status === 'provisioned'): the site
//    has no serving code yet, so this deployment DOES drive
//    the site status machine forward: provisioned ->
//    configuring -> deploying -> active, exactly the
//    transitions migration 0006 already allows (no schema
//    change needed for this phase).
//
//  - REDEPLOY (site.status === 'active' already): the site is
//    already serving traffic. This deployment does NOT touch
//    site.status at all — only the deployments row tracks its
//    own progress. A failed redeploy leaves the site "active"
//    or "failed": what's already running keeps running,
//    matching how a real platform's bad-deploy-doesn't-take-
//    down-prod expectation works. Only the *deployments* table
//    ever shows 'failed' here; the site itself is untouched.
//
// Migrations are NEVER reversed on rollback (master prompt
// section 22: don't claim a migration is reversible if it
// isn't) — rollbackDeployment() only ever re-deploys OLD CODE
// against the CURRENT (forward-migrated) schema.
// =====================================================

import * as cloudflareProvider from "./infra-cloudflare.js";
import * as jobsModule from "./jobs.js";
import * as tenantTemplate from "./tenant-template.js";
import { buildSiteBindings } from "./site-bindings.js";
import * as siteResources from "./repositories/site-resources.js";
import * as sites from "./sites.js";
import { computeResourceNames } from "./provisioning.js";
import * as webhooks from "./webhooks.js";

// The tenant application's own schedule (its wrangler.jsonc triggers): expired-session
// and conversation cleanup plus the optional link-health checks.
const TENANT_CRONS = ["0 */6 * * *"];

const INITIAL_DEPLOY_STEPS = ["validate_site_state", "run_migrations", "deploy_worker_script", "health_check"];
const ROLLBACK_STEPS = ["validate_site_state", "deploy_worker_script", "health_check"];

function reachableUrl(site, workerName, env) {
  if (site.primary_domain) return `https://${site.primary_domain}/`;
  const subdomain = env.CF_WORKERS_DEV_SUBDOMAIN || "workers";
  return `https://${workerName}.${subdomain}.workers.dev/`;
}

export function createDeploymentService(infra, { templateService = tenantTemplate } = {}) {
  async function updateDeploymentStatus(env, deploymentId, status, extra = {}) {
    const setClauses = ["status = ?"];
    const values = [status];
    if (extra.startedAt) {
      setClauses.push("started_at = COALESCE(started_at, CURRENT_TIMESTAMP)");
    }
    if (["active", "failed", "rolled_back"].includes(status)) {
      setClauses.push("completed_at = CURRENT_TIMESTAMP");
    }
    if (extra.errorMessage !== undefined) {
      setClauses.push("error_message = ?");
      values.push(extra.errorMessage);
    }
    values.push(deploymentId);
    await env.LUMMET_DB.prepare(`UPDATE deployments SET ${setClauses.join(", ")} WHERE id = ?`).bind(...values).run();
  }

  async function getDeployment(env, deploymentId) {
    return env.LUMMET_DB.prepare(`SELECT * FROM deployments WHERE id = ?`).bind(deploymentId).first();
  }

  async function listDeploymentsForSite(env, siteId) {
    const result = await env.LUMMET_DB.prepare(`SELECT * FROM deployments WHERE site_id = ? ORDER BY created_at DESC`)
      .bind(siteId)
      .all();
    return result.results || [];
  }

  async function createDeploymentRecord(env, { siteId, version, actorUserId, actorType, isRollback, targetDeploymentId }) {
    const id = crypto.randomUUID();
    await env.LUMMET_DB.prepare(
      `INSERT INTO deployments (id, site_id, version, status, is_rollback, target_deployment_id, triggered_by, actor_type)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`
    )
      .bind(id, siteId, version, isRollback ? 1 : 0, targetDeploymentId || null, actorUserId || null, actorType || "customer_user")
      .run();
    return id;
  }

  /**
   * Starts a new deployment for a site currently "provisioned"
   * (its first-ever deploy) or "active" (a redeploy). Refuses for
   * every other status — a site mid-provisioning, suspended, or
   * being deleted is not a valid deploy target.
   */
  async function startDeployment(env, { siteId, version, migrations, scriptContent, actorUserId, actorType = "customer_user" }) {
    const site = await sites.getSite(env, siteId);
    if (!site) return { ok: false, status: 404, error: "site_not_found" };
    if (!["provisioned", "active"].includes(site.status)) {
      return { ok: false, status: 409, error: "site_not_deployable", currentStatus: site.status };
    }
    if (!site.tenant_id) return { ok: false, status: 409, error: "site_not_registered" };
    if (!version) return { ok: false, status: 422, error: "version_required" };
    if (!scriptContent) return { ok: false, status: 422, error: "script_content_required" };

    const deploymentId = await createDeploymentRecord(env, { siteId, version, actorUserId, actorType });

    const jobResult = await jobsModule.createJob(env, {
      type: "site_deployment", organizationId: site.organization_id, siteId,
      createdBy: actorUserId, actorType,
      payload: { deploymentId, version, migrations: migrations || [], scriptContent },
      stepKeys: INITIAL_DEPLOY_STEPS
    });

    return { ok: true, deploymentId, jobId: jobResult.jobId };
  }

  /**
   * Re-deploys a PREVIOUS successful deployment's code. Requires the
   * caller to re-supply that version's scriptContent — this phase
   * has no build-artifact storage (R2 wiring for deployment
   * artifacts is future work), so "rollback" here means "deploy the
   * old code again", not "restore a stored bundle automatically".
   * Never re-runs migrations (see header comment).
   */
  async function rollbackDeployment(env, { siteId, targetDeploymentId, scriptContent, actorUserId, actorType = "customer_user" }) {
    const site = await sites.getSite(env, siteId);
    if (!site) return { ok: false, status: 404, error: "site_not_found" };
    if (site.status !== "active") return { ok: false, status: 409, error: "site_not_active" };
    if (!scriptContent) return { ok: false, status: 422, error: "script_content_required" };

    const target = await getDeployment(env, targetDeploymentId);
    if (!target || target.site_id !== siteId) return { ok: false, status: 404, error: "target_deployment_not_found" };
    if (target.status !== "active") return { ok: false, status: 409, error: "target_deployment_was_not_successful" };

    const deploymentId = await createDeploymentRecord(env, {
      siteId, version: target.version, actorUserId, actorType, isRollback: true, targetDeploymentId
    });

    const jobResult = await jobsModule.createJob(env, {
      type: "site_deployment", organizationId: site.organization_id, siteId,
      createdBy: actorUserId, actorType,
      payload: { deploymentId, version: target.version, migrations: [], scriptContent, isRollback: true },
      stepKeys: ROLLBACK_STEPS
    });

    return { ok: true, deploymentId, jobId: jobResult.jobId };
  }

  /**
   * Executes (or resumes) a deployment job. Like provisioning.js's
   * runJob, already-'success'/'skipped' steps are never re-run.
   */
  async function runJob(env, jobId) {
    const job = await jobsModule.getJob(env, jobId);
    if (!job) return { ok: false, status: 404, error: "job_not_found" };
    if (job.status === "success") return { ok: true, alreadyDone: true };
    if (!["queued", "running", "failed"].includes(job.status)) {
      return { ok: false, status: 409, error: `cannot run a job in status ${job.status}` };
    }

    const { deploymentId, version, migrations, scriptContent } = job.payload;
    const deployment = await getDeployment(env, deploymentId);
    if (!deployment) {
      await jobsModule.markJobFailed(env, jobId, "deployment record no longer exists");
      return { ok: false, status: 404, error: "deployment_not_found" };
    }

    const site = await sites.getSite(env, job.site_id);
    if (!site) {
      await jobsModule.markJobFailed(env, jobId, "site no longer exists");
      return { ok: false, status: 404, error: "site_not_found" };
    }

    const isInitialDeploy = site.status === "provisioned";
    await jobsModule.markJobRunning(env, jobId);
    await updateDeploymentStatus(env, deploymentId, "building", { startedAt: true });

    const names = computeResourceNames(site, env);

    async function failDeployment(step, message) {
      await jobsModule.failStep(env, jobId, step, message);
      await jobsModule.markJobFailed(env, jobId, `failed at step ${step}: ${message}`);
      await updateDeploymentStatus(env, deploymentId, "failed", { errorMessage: message });
      if (isInitialDeploy) {
        // The site never had serving code, so a failure here is a
        // genuine site-level failure, not "the old version keeps
        // running" — there is no old version.
        await sites.transitionSiteStatus(env, site.id, "failed", {
          reason: `deployment ${deploymentId} failed at ${step}: ${message}`, actorType: "system"
        });
        await webhooks.dispatchEvent(env, site.organization_id, "site.failed", { siteId: site.id, deploymentId, step, message });
      }
      // A redeploy failing leaves the already-'active' site exactly
      // as it was — no site-status transition here on purpose.
    }

    for (const step of job.steps) {
      if (step.status === "success" || step.status === "skipped") continue;

      await jobsModule.startStep(env, jobId, step.step_key);

      try {
        switch (step.step_key) {
          case "validate_site_state": {
            const currentSite = await sites.getSite(env, site.id);
            if (!["provisioned", "active"].includes(currentSite.status)) {
              throw new Error(`site is no longer in a deployable status (now ${currentSite.status})`);
            }
            if (isInitialDeploy) {
              const transition = await sites.transitionSiteStatus(env, site.id, "configuring", {
                reason: `deployment ${deploymentId} starting`, actorType: "system"
              });
              if (!transition.ok) throw new Error(`could not move site to configuring: ${transition.error}`);
            }
            await jobsModule.completeStep(env, jobId, step.step_key, { isInitialDeploy });
            break;
          }

          case "run_migrations": {
            await updateDeploymentStatus(env, deploymentId, "migrating");
            const d1Resource = await env.LUMMET_DB.prepare(
              `SELECT * FROM site_resources WHERE site_id = ? AND resource_type = 'd1' AND status = 'active'`
            )
              .bind(site.id)
              .first();
            if (!d1Resource) throw new Error("no D1 database resource recorded for this site — was it ever provisioned?");

            const applied = [];
            for (const migration of migrations || []) {
              const already = await env.LUMMET_DB.prepare(
                `SELECT 1 FROM site_migrations_applied WHERE site_id = ? AND migration_name = ?`
              )
                .bind(site.id, migration.name)
                .first();
              if (already) continue;

              await infra.runD1Query(env, { databaseId: d1Resource.resource_id, sql: migration.sql });
              await env.LUMMET_DB.prepare(
                `INSERT INTO site_migrations_applied (site_id, migration_name, deployment_id) VALUES (?, ?, ?)`
              )
                .bind(site.id, migration.name, deploymentId)
                .run();
              applied.push(migration.name);
            }
            await jobsModule.completeStep(env, jobId, step.step_key, { applied });
            break;
          }

          case "deploy_worker_script": {
            await updateDeploymentStatus(env, deploymentId, "deploying");
            if (isInitialDeploy) {
              const transition = await sites.transitionSiteStatus(env, site.id, "deploying", {
                reason: `deployment ${deploymentId} uploading code`, actorType: "system"
              });
              if (!transition.ok) throw new Error(`could not move site to deploying: ${transition.error}`);
            }

            // Bindings are rebuilt every deploy (an upload replaces them), and
            // the release's static assets, if it has any, ride along.
            const release = await templateService.getReleaseByVersion(env, version).catch(() => null);
            const assetManifest = release && release.ok && release.assets ? release.assets : null;
            const bindings = await buildSiteBindings(env, {
              site, deploymentId, host: site.primary_domain || names.host, hasAssets: !!assetManifest
            });
            await infra.uploadWorkerScript(env, {
              workerName: names.workerName, scriptContent, bindings,
              assets: assetManifest ? { manifest: assetManifest, readAsset: (hash) => templateService.readAsset(env, hash) } : null
            });

            await env.LUMMET_DB.prepare(
              `INSERT INTO site_resources (site_id, provider, resource_type, resource_id, resource_name, metadata)
               VALUES (?, ?, 'worker', ?, ?, ?)
               ON CONFLICT(site_id, resource_type) DO UPDATE SET
                 resource_id = excluded.resource_id, resource_name = excluded.resource_name, status = 'active', deleted_at = NULL`
            )
              .bind(site.id, infra.PROVIDER_NAME, names.workerName, names.workerName, JSON.stringify({ version }))
              .run();


            // Make the site reachable at its platform hostname. One route per
            // site, remembered in site_resources so redeploys and rollbacks
            // don't recreate it. A routing failure fails the deployment: a
            // site nobody can reach is not "active".
            const host = site.primary_domain || names.host;
            let routeId = null;
            const existingRoute = await siteResources.findActiveResource(env, site.id, "route");
            if (existingRoute) {
              routeId = existingRoute.resource_id;
            } else {
              const route = await infra.ensureWorkerRoute(env, { pattern: `${host}/*`, workerName: names.workerName });
              routeId = route.routeId;
              await siteResources.saveRoute(env, { siteId: site.id, provider: infra.PROVIDER_NAME, routeId, pattern: `${host}/*` });
            }

            // The tenant's cron triggers. Not fatal (the site works without
            // them), but never silent: the outcome is recorded on the step.
            let scheduleError = null;
            try { await infra.setWorkerSchedule(env, { workerName: names.workerName, crons: TENANT_CRONS }); }
            catch (err) { scheduleError = String(err?.message || err).slice(0, 160); }

            await jobsModule.completeStep(env, jobId, step.step_key, { workerName: names.workerName, bindingCount: bindings.length, assetCount: assetManifest ? Object.keys(assetManifest).length : 0, routeId, ...(scheduleError ? { scheduleError } : {}) });
            break;
          }

          case "health_check": {
            await updateDeploymentStatus(env, deploymentId, "checking");
            const url = reachableUrl(site, names.workerName, env);
            const result = await infra.checkHealth(env, { url });
            if (!result.ok) {
              throw new Error(`health check failed for ${url} (status ${result.statusCode ?? "unreachable"})`);
            }
            // A page can render while its stylesheet 404s, so when the
            // release has static assets also fetch one of them.
            const release = await templateService.getReleaseByVersion(env, version).catch(() => null);
            const sample = release && release.ok && release.assets
              ? (Object.keys(release.assets).find((p) => p.endsWith(".css")) || Object.keys(release.assets)[0]) : null;
            if (sample) {
              const assetUrl = new URL(sample, url).toString();
              const assetResult = await infra.checkHealth(env, { url: assetUrl });
              if (!assetResult.ok) {
                throw new Error(`static asset check failed for ${assetUrl} (status ${assetResult.statusCode ?? "unreachable"})`);
              }
            }
            await jobsModule.completeStep(env, jobId, step.step_key, { url, statusCode: result.statusCode, assetChecked: sample });
            break;
          }

          default:
            throw new Error(`unknown deployment step ${step.step_key}`);
        }
      } catch (error) {
        const message = error?.message || String(error);
        await failDeployment(step.step_key, message);
        return { ok: false, status: 500, error: message, failedStep: step.step_key };
      }
    }

    await jobsModule.markJobSuccess(env, jobId, { deploymentId, version });
    await env.LUMMET_DB.prepare(`UPDATE deployments SET is_current = 0 WHERE site_id = ? AND id != ?`)
      .bind(site.id, deploymentId)
      .run();
    await updateDeploymentStatus(env, deploymentId, "active");
    await env.LUMMET_DB.prepare(`UPDATE deployments SET is_current = 1 WHERE id = ?`).bind(deploymentId).run();
    await env.LUMMET_DB.prepare(
      `UPDATE sites SET app_version = ?, last_deployment_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    )
      .bind(version, deploymentId, site.id)
      .run();

    await webhooks.dispatchEvent(env, site.organization_id, "site.deployed", { siteId: site.id, deploymentId, version });

    if (isInitialDeploy) {
      const transition = await sites.transitionSiteStatus(env, site.id, "active", {
        reason: `deployment ${deploymentId} completed`, actorType: "system"
      });
      if (!transition.ok) {
        // Extremely unlikely (we just moved it to 'deploying' above),
        // but don't silently swallow it if the state machine disagrees.
        return { ok: false, status: 500, error: `deployment succeeded but site transition failed: ${transition.error}` };
      }
    }

    return { ok: true, deploymentId };
  }

  return { startDeployment, rollbackDeployment, runJob, getDeployment, listDeploymentsForSite };
}

// Production singleton — used by index.js. Unit tests import
// createDeploymentService directly with a fake infra provider. Route-level
// tests (which go through index.js and therefore this singleton) swap the
// provider with __setInfraProviderForTests(); production never calls it,
// and passing nothing restores the real Cloudflare provider.
const infraRef = { current: cloudflareProvider };
const infraProxy = new Proxy({}, { get: (_target, key) => infraRef.current[key] });
export function __setInfraProviderForTests(provider) {
  infraRef.current = provider || cloudflareProvider;
}
export const deployments = createDeploymentService(infraProxy);
