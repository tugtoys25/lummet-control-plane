// =====================================================
// TENANT RELEASE ROLLOUTS (v1.2)
//
// Publishing a release (worker/tenant-template.js) only stores it; sites keep running what they have until a
// deployment replaces it. A ROLLOUT deploys the release to every live site, safely:
//
//   * ONE SITE AT A TIME. The next site is not touched until the previous one is deployed and healthy
//     (the deployment's own health check, including a static-asset fetch), so a bad release reaches one site, not all.
//   * STOPS ON FAILURE. The first failed deployment marks the rollout 'failed' and leaves every remaining site
//     untouched on the version it already runs. A failed REDEPLOY never takes a serving site down (see
//     deployments.js), so the failed site keeps serving too. Staff can fix and Resume, or Cancel.
//   * SKIPS WHAT IS CURRENT. Sites already on the version are recorded as skipped; sites that are not live
//     (suspended, failed, still provisioning) are never touched.
//   * ONE ROLLOUT AT A TIME (a database constraint), and every step runs under a compare-and-swap lock, so a
//     pinger, an open staff page and a CI job advancing the same rollout never deploy a site twice.
//   * RESUMABLE. Progress lives in the database, nothing in memory: advanceRollout() does one bounded step
//     (finish the site in flight, start the next) and can be called by anything, any number of times:
//     the maintenance tick (pinger/cron), the staff page while it is open, or the CI script.
//
// Nothing here changes how a deployment works: it calls the same deployments.startDeployment() the per-site
// Update button uses, and the existing durable-job sweep still resumes a deployment whose Worker died.
// =====================================================
import * as repo from "./repositories/rollouts.js";
import * as tenantTemplate from "./tenant-template.js";
import * as sites from "./sites.js";
// provisioning.js and deployments.js import each other; loading provisioning first is the order that works
// (job-runner.js does the same).
import "./provisioning.js";
import { deployments as realDeployments } from "./deployments.js";

export const LOCK_MS = 90_000;
export const ITEM_TIMEOUT_MINUTES = 45;
export const MAX_SKIPS_PER_STEP = 25;
const MAX_SITE_IDS = 200;

function parseDbTime(s) {
  if (!s) return NaN;
  const t = String(s);
  return Date.parse(/[TZ]/.test(t) ? t : t.replace(" ", "T") + "Z");
}

async function summarize(env, rollout, extra = {}) {
  const counts = await repo.itemCounts(env, rollout.id);
  const updated = counts.succeeded;
  return {
    ok: true,
    rolloutId: rollout.id,
    version: rollout.release_version,
    status: rollout.status,
    done: rollout.status !== "running",
    total: rollout.total_sites,
    counts,
    error: rollout.error_message || null,
    progress: `${updated} of ${rollout.total_sites} updated` +
      `${counts.running ? `, ${counts.running} in progress` : ""}${counts.pending ? `, ${counts.pending} waiting` : ""}` +
      `${counts.failed ? `, ${counts.failed} failed` : ""}${counts.skipped ? `, ${counts.skipped} skipped` : ""}`,
    ...extra
  };
}

/**
 * Starts a rollout of the ACTIVE release (or an explicit version) to every live site that is not already on it.
 * siteIds limits it to chosen sites: roll out to one site first as a canary, then to everyone.
 */
export async function startRollout(env, { version = null, siteIds = null, notes = null, startedBy = "system" } = {}, { templates = tenantTemplate } = {}) {
  if (siteIds !== null && siteIds !== undefined) {
    if (!Array.isArray(siteIds) || siteIds.length > MAX_SITE_IDS || siteIds.some((s) => typeof s !== "string" || !s || s.length > 64)) {
      return { ok: false, status: 422, error: "invalid_site_ids" };
    }
  }
  if (notes !== null && notes !== undefined && String(notes).length > 300) return { ok: false, status: 422, error: "notes_too_long" };

  const release = version ? await templates.getReleaseByVersion(env, String(version)) : await templates.getCurrentRelease(env);
  if (!release.ok) return { ok: false, status: release.status || 409, error: release.error };

  const id = crypto.randomUUID();
  if (!(await repo.insertRollout(env, { id, version: release.version, startedBy, notes }))) {
    const running = await repo.getRunning(env);
    return { ok: false, status: 409, error: "rollout_in_progress", rolloutId: running ? running.id : null };
  }
  await repo.seedItems(env, { rolloutId: id, version: release.version, siteIds: siteIds && siteIds.length ? siteIds : null });
  const counts = await repo.itemCounts(env, id);
  await repo.setTotal(env, id, counts.pending);
  if (counts.pending === 0) await repo.finishRollout(env, id, "completed");
  return { ok: true, ...(await summarize(env, await repo.getById(env, id))), nothingToDo: counts.pending === 0 };
}

async function classify(env, item, now) {
  if (!item.deployment_id) return { state: "failed", reason: "no_deployment_recorded" };
  const p = await repo.readProgress(env, item.deployment_id, item.job_id);
  if (!p) return { state: "failed", reason: "deployment_record_missing" };
  if (p.deployment_status === "active") return { state: "succeeded" };
  if (p.deployment_status === "failed") return { state: "failed", reason: p.deployment_error || "deployment_failed" };
  if (p.dead_lettered_at) return { state: "failed", reason: `the system gave up: ${p.dead_reason || "job dead-lettered"}` };
  const started = parseDbTime(item.started_at);
  if (Number.isFinite(started) && now - started > ITEM_TIMEOUT_MINUTES * 60000) {
    return { state: "failed", reason: `timed out after ${ITEM_TIMEOUT_MINUTES} minutes` };
  }
  return { state: "waiting" };
}

async function step(env, rollout, { dispatch, now, deployments, templates }) {
  const rolloutId = rollout.id;
  const version = rollout.release_version;
  const label = (item) => item.site_slug || item.site_id;

  const running = await repo.getRunningItem(env, rolloutId);
  if (running) {
    const verdict = await classify(env, running, now);
    if (verdict.state === "waiting") return;
    if (verdict.state === "succeeded") {
      await repo.markItemDone(env, running.id, "succeeded");
    } else {
      await repo.markItemDone(env, running.id, "failed", verdict.reason);
      await repo.finishRollout(env, rolloutId, "failed", `a site failed to deploy ${version}: ${verdict.reason}. Remaining sites were not touched.`);
      return;
    }
  }

  let release = null;
  let skips = 0;
  while (true) {
    const next = await repo.nextPending(env, rolloutId);
    if (!next) { await repo.finishRollout(env, rolloutId, "completed"); return; }

    const skip = (detail) => repo.markItemDone(env, next.id, "skipped", detail);
    const site = await sites.getSite(env, next.site_id);
    if (!site) { await skip("site_missing"); }
    else if (site.status !== "active") { await skip(`site_${site.status}`); }
    else if (site.app_version === version) { await skip("already_on_version"); }
    else {
      const inflight = await repo.inflightDeployment(env, site.id);
      if (inflight && inflight.version === version) {
        // Someone (a customer's Update button, or an earlier tick that was cut short) already started it: follow that one.
        await repo.markItemRunning(env, next.id, { deploymentId: inflight.deployment_id, jobId: inflight.job_id });
        return;
      }
      if (inflight) { await skip("busy_with_another_deployment"); }
      else {
        if (!release) release = await templates.getReleaseByVersion(env, version);
        if (!release.ok) {
          await repo.markItemDone(env, next.id, "failed", `release_unavailable: ${release.error}`);
          await repo.finishRollout(env, rolloutId, "failed", `release ${version} could not be read: ${release.error}`);
          return;
        }
        const started = await deployments.startDeployment(env, {
          siteId: site.id, version, migrations: release.migrations, scriptContent: release.scriptContent, actorType: "system"
        });
        if (!started.ok) {
          if (started.error === "site_not_deployable") { await skip(`site_${started.currentStatus || "not_deployable"}`); }
          else {
            await repo.markItemDone(env, next.id, "failed", started.error);
            await repo.finishRollout(env, rolloutId, "failed", `could not start the deployment for ${label(next)}: ${started.error}`);
            return;
          }
        } else {
          await repo.markItemRunning(env, next.id, { deploymentId: started.deploymentId, jobId: started.jobId });
          // If the dispatch is lost the durable-job sweep starts the queued job within minutes.
          try { await dispatch(started.jobId); } catch (_) { /* swept later */ }
          return;
        }
      }
    }
    if (++skips >= MAX_SKIPS_PER_STEP) return; // a long run of skips: carry on at the next call
  }
}

/** One bounded step of one rollout. Safe to call at any time, by anything, as often as wanted. */
export async function advanceRollout(env, rolloutId, { dispatch = async () => {}, now = Date.now(), deployments = realDeployments, templates = tenantTemplate } = {}) {
  const rollout = await repo.getById(env, rolloutId);
  if (!rollout) return { ok: false, status: 404, error: "rollout_not_found" };
  if (rollout.status !== "running") return summarize(env, rollout);
  if (!(await repo.acquireLock(env, rolloutId, now, now + LOCK_MS))) return summarize(env, rollout, { busy: true });
  try {
    await step(env, rollout, { dispatch, now, deployments, templates });
  } finally {
    await repo.releaseLock(env, rolloutId);
  }
  return summarize(env, await repo.getById(env, rolloutId));
}

/** What the maintenance tick calls: continue whatever rollout is running, if any. */
export async function advanceRunning(env, opts = {}) {
  const running = await repo.getRunning(env);
  if (!running) return { ok: true, idle: true };
  return advanceRollout(env, running.id, opts);
}

export async function getRollout(env, rolloutId) {
  const rollout = await repo.getById(env, rolloutId);
  if (!rollout) return { ok: false, status: 404, error: "rollout_not_found" };
  return summarize(env, rollout, { items: await repo.listItems(env, rolloutId, 200) });
}

export async function cancelRollout(env, rolloutId) {
  const rollout = await repo.getById(env, rolloutId);
  if (!rollout) return { ok: false, status: 404, error: "rollout_not_found" };
  if (!["running", "failed"].includes(rollout.status)) return { ok: false, status: 409, error: `rollout_already_${rollout.status}` };
  const running = await repo.getRunningItem(env, rolloutId);
  if (running) {
    // A deployment already under way cannot be recalled; record where it stands and let it finish on its own.
    const verdict = await classify(env, running, Date.now());
    if (verdict.state === "succeeded") await repo.markItemDone(env, running.id, "succeeded");
    else if (verdict.state === "failed") await repo.markItemDone(env, running.id, "failed", verdict.reason);
    else await repo.markItemDone(env, running.id, "skipped", "cancelled while deploying (that deployment was left to finish)");
  }
  await repo.skipPending(env, rolloutId, "rollout_cancelled");
  await repo.finishRollout(env, rolloutId, "cancelled");
  return { ok: true };
}

/** After a failure: queue the failed site(s) again and carry on. A new deployment is created; the old one stays as history. */
export async function resumeRollout(env, rolloutId) {
  const rollout = await repo.getById(env, rolloutId);
  if (!rollout) return { ok: false, status: 404, error: "rollout_not_found" };
  if (rollout.status !== "failed") return { ok: false, status: 409, error: "only_a_failed_rollout_can_be_resumed" };
  if (!(await repo.reopen(env, rolloutId))) return { ok: false, status: 409, error: "another_rollout_is_running" };
  await repo.requeueFailedItems(env, rolloutId);
  return { ok: true };
}

/** Everything the staff Deployments page shows about releases and rollouts. */
export async function dashboard(env) {
  const [active, fleet, running, recent] = await Promise.all([
    repo.activeRelease(env), repo.fleetVersions(env), repo.getRunning(env), repo.listRecent(env, 8)
  ]);
  const activeVersion = active ? active.version : null;
  const total = fleet.reduce((n, r) => n + r.n, 0);
  const current = fleet.filter((r) => r.version === activeVersion).reduce((n, r) => n + r.n, 0);
  const shown = running || recent[0] || null;
  return {
    active, fleet, totalLive: total, onActive: current, outdated: total - current,
    running: running || null,
    shown: shown ? { ...(await summarize(env, shown)), startedBy: shown.started_by, createdAt: shown.created_at, completedAt: shown.completed_at, items: await repo.listItems(env, shown.id, 100) } : null,
    recent: recent.map((r) => ({ id: r.id, version: r.release_version, status: r.status, total: r.total_sites, startedBy: r.started_by, createdAt: r.created_at, error: r.error_message }))
  };
}
