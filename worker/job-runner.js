// =====================================================
// DURABLE JOB EXECUTION (v7D)
//
// Before v7D a job ran only through ctx.waitUntil() from the request that created it. If that Worker was
// evicted, or a step failed, the job simply stayed where it was until a human noticed. This module adds:
//
//   dispatchJob    start a job: through a Cloudflare Queue when the JOB_QUEUE binding exists (durable, the
//                  platform retries and dead-letters), otherwise through ctx.waitUntil() as before.
//   sweepJobs      the safety net, run on every maintenance tick (the external pinger or a Cron Trigger).
//                  1. jobs created but never started          -> started
//                  2. running jobs with no activity for a while -> the Worker died: marked failed, resumed
//                  3. failed jobs whose type is safe to repeat -> retried with exponential backoff
//                  4. jobs that used all their automatic retries, or cannot be retried -> dead-lettered
//   handleQueueBatch  the Queue consumer (only used when JOB_QUEUE is bound).
//
// Safety rules:
//   * Every automatic attempt first "claims" the job with a compare-and-swap (repositories/job-sweep.js), so
//     two sweeps running at once never both run it.
//   * Only job types whose steps are resumable are touched, and only through their own runJob/retry
//     functions, which skip steps that already succeeded and re-check what exists before creating anything.
//   * A failed DEPLOYMENT is never retried automatically: deploying again is a decision (the code may be
//     wrong, and a retry would not know the customer changed their mind). Deployments that were LOST
//     (never started, or the Worker died mid-way) are resumed, because nothing ever concluded about them.
//   * Dead-lettered jobs keep status 'failed'; dead_lettered_at / dead_reason say the sweep gave up.
//     The `dead_jobs` alert reports them; staff "Retry" gives them a fresh set of automatic retries.
// =====================================================

import * as repo from "./repositories/job-sweep.js";
import * as jobsModule from "./jobs.js";
import { provisioning as realProvisioning } from "./provisioning.js";
import { deployments as realDeployments } from "./deployments.js";

export const MAX_AUTO_RETRIES = 5;
/** Wait before automatic retry number n+1 (n = retries already made), measured from when the job failed. */
export const BACKOFF_MINUTES = [5, 15, 45, 120, 360];
export const STUCK_QUEUED_MINUTES = 3;
export const STALE_RUNNING_MINUTES = 10;
export const SWEEP_LIMIT = 5;

export function backoffMinutes(autoRetries) {
  return BACKOFF_MINUTES[Math.min(Math.max(autoRetries, 0), BACKOFF_MINUTES.length - 1)];
}

/** Policy per job type. `run` resumes a job; `retry` re-opens a failed one (only where that is safe). */
export function defaultRunners({ provisioning = realProvisioning, deployments = realDeployments } = {}) {
  return {
    tenant_provisioning: {
      resumeLost: true,
      retryFailed: true,
      run: (env, job) => provisioning.runJob(env, job.id),
      // retryProvisioning moves the site failed -> provisioning and hands back the same job to run again.
      retry: async (env, job) => {
        const r = await provisioning.retryProvisioning(env, job.site_id, { actorType: "system" });
        if (!r.ok) return { ok: false, permanent: true, error: r.error };
        return provisioning.runJob(env, r.jobId);
      }
    },
    site_deployment: {
      resumeLost: true,
      retryFailed: false,
      run: (env, job) => deployments.runJob(env, job.id)
    }
  };
}

const hasQueue = (env) => !!env && !!env.JOB_QUEUE && typeof env.JOB_QUEUE.send === "function";

/** 'YYYY-MM-DD HH:MM:SS' (SQLite, UTC) or ISO -> ms since epoch. */
function parseDbTime(s) {
  if (!s) return NaN;
  const t = String(s);
  return Date.parse(/[TZ]/.test(t) ? t : t.replace(" ", "T") + "Z");
}

/** Runs (resumes) one job by id, through the runner for its type. */
export async function runJobById(env, jobId, runners = defaultRunners()) {
  const job = await jobsModule.getJob(env, jobId);
  if (!job) return { ok: false, status: 404, error: "job_not_found" };
  const policy = runners[job.type];
  if (!policy) return { ok: false, status: 409, error: "unknown_job_type" };
  return policy.run(env, job);
}

/**
 * Starts a freshly created job. With a JOB_QUEUE binding the job is put on the queue (and runs even if this
 * Worker is evicted right now); otherwise it runs via ctx.waitUntil(). If the queue refuses the message the job
 * falls back to waitUntil, and the sweep catches it if that is lost too.
 */
export async function dispatchJob(env, ctx, jobId, { runners } = {}) {
  if (hasQueue(env)) {
    try {
      await env.JOB_QUEUE.send({ kind: "run", jobId });
      return { via: "queue" };
    } catch (_) { /* fall through to waitUntil */ }
  }
  ctx.waitUntil(runJobById(env, jobId, runners).catch(() => {}));
  return { via: "waitUntil" };
}

/**
 * One pass of the safety net. Claims at most `limit` jobs; the work itself is handed to `launch` (the caller
 * passes ctx.waitUntil so a pinger request returns quickly) or, by default, awaited.
 */
export async function sweepJobs(env, {
  runners = defaultRunners(), now = Date.now(), limit = SWEEP_LIMIT,
  launch = (p) => p, wait = true
} = {}) {
  const results = [];
  const launched = [];
  let budget = limit;
  const useQueue = hasQueue(env);

  async function startClaimed(job, kind, fromStatus, label) {
    if (!(await repo.claim(env, job.id, fromStatus, job.auto_retries))) return false; // another sweep took it
    budget--;
    await jobsModule.logJob(env, job.id, "info", `${label} (automatic attempt ${job.auto_retries + 1} of ${MAX_AUTO_RETRIES})`);
    const policy = runners[job.type];
    const finish = async (r) => {
      if (r && r.ok === false && r.permanent) await repo.deadLetter(env, job.id, `cannot be retried: ${r.error}`);
    };
    if (useQueue) {
      try {
        await env.JOB_QUEUE.send({ kind: kind === "retry" ? "retry" : "run", jobId: job.id });
        results.push({ jobId: job.id, type: job.type, action: label, via: "queue" });
        return true;
      } catch (_) { /* queue refused: run it here instead */ }
    }
    const task = (async () => {
      try {
        await finish(await (kind === "retry" ? policy.retry(env, job) : policy.run(env, job)));
      } catch (error) {
        await jobsModule.logJob(env, job.id, "error", `automatic ${kind} threw: ${String(error?.message || error)}`).catch(() => {});
      }
    })();
    launched.push(launch(task));
    results.push({ jobId: job.id, type: job.type, action: label, via: "waitUntil" });
    return true;
  }

  async function giveUp(job, reason, { markFailed = false } = {}) {
    if (markFailed) await jobsModule.markJobFailed(env, job.id, reason);
    if (await repo.deadLetter(env, job.id, reason)) {
      await jobsModule.logJob(env, job.id, "error", `dead-lettered: ${reason}`);
      results.push({ jobId: job.id, type: job.type, action: "dead_lettered", reason });
    }
  }

  // 1. created but never started
  for (const job of await repo.listStuckQueued(env, STUCK_QUEUED_MINUTES, limit)) {
    const policy = runners[job.type];
    if (!policy || !policy.resumeLost) continue;
    if (job.auto_retries >= MAX_AUTO_RETRIES) { await giveUp(job, "never started, automatic attempts used up", { markFailed: true }); continue; }
    if (budget <= 0) break;
    await startClaimed(job, "run", "queued", "started by the sweep (it was never started)");
  }

  // 2. running but silent: the Worker that ran it is gone
  for (const job of await repo.listStaleRunning(env, STALE_RUNNING_MINUTES, limit)) {
    const policy = runners[job.type];
    if (!policy || !policy.resumeLost) continue;
    if (job.auto_retries >= MAX_AUTO_RETRIES) { await giveUp(job, "stopped repeatedly, automatic attempts used up", { markFailed: true }); continue; }
    if (budget <= 0) break;
    if (!(await repo.claim(env, job.id, "running", job.auto_retries))) continue;
    // Close the abandoned run as failed, then resume (already-successful steps are skipped).
    await jobsModule.markJobFailed(env, job.id, `the Worker running this job stopped (no activity for ${STALE_RUNNING_MINUTES} minutes)`);
    // markJobFailed does not change auto_retries; startClaimed would claim again, so resume directly:
    budget--;
    await jobsModule.logJob(env, job.id, "info", `resumed by the sweep (the Worker stopped) (automatic attempt ${job.auto_retries + 1} of ${MAX_AUTO_RETRIES})`);
    if (useQueue) {
      try { await env.JOB_QUEUE.send({ kind: "run", jobId: job.id }); results.push({ jobId: job.id, type: job.type, action: "resumed_stale", via: "queue" }); continue; } catch (_) { /* run here */ }
    }
    launched.push(launch((async () => {
      try { await policy.run(env, job); } catch (error) {
        await jobsModule.logJob(env, job.id, "error", `automatic resume threw: ${String(error?.message || error)}`).catch(() => {});
      }
    })()));
    results.push({ jobId: job.id, type: job.type, action: "resumed_stale", via: "waitUntil" });
  }

  // 3 + 4. failed jobs: retry when due, give up when the retries are used up
  for (const job of await repo.listFailedRetryable(env, Object.keys(runners).filter((t) => runners[t].retryFailed), 50)) {
    if (job.auto_retries >= MAX_AUTO_RETRIES) { await giveUp(job, `automatic retries used up (${MAX_AUTO_RETRIES})`); continue; }
    const due = parseDbTime(job.completed_at || job.created_at) + backoffMinutes(job.auto_retries) * 60000;
    if (!(due <= now)) continue;
    if (budget <= 0) continue;
    await startClaimed(job, "retry", "failed", "retried by the sweep (it had failed)");
  }

  if (wait) await Promise.all(launched);
  return { results, launched };
}

/** Staff action: forgive a dead-lettered job so the sweep may try it again. */
export async function requeueDeadLetter(env, jobId) {
  return repo.clearDeadLetter(env, jobId);
}

/**
 * Cloudflare Queues consumer (exported as the Worker's `queue` handler). Messages: { kind: 'run' | 'retry', jobId }.
 * A thrown error asks the queue to redeliver with a delay; after the queue's own max_retries the message goes
 * to its dead-letter queue, and the sweep still sees the job as failed/stale.
 */
export async function handleQueueBatch(batch, env, { runners = defaultRunners() } = {}) {
  for (const message of batch.messages) {
    try {
      const { kind, jobId } = message.body || {};
      const job = jobId ? await jobsModule.getJob(env, jobId) : null;
      const policy = job ? runners[job.type] : null;
      if (policy) {
        const r = await (kind === "retry" && policy.retry ? policy.retry(env, job) : policy.run(env, job));
        if (r && r.ok === false && r.permanent) await repo.deadLetter(env, job.id, `cannot be retried: ${r.error}`);
      }
      message.ack();
    } catch (_) {
      message.retry({ delaySeconds: Math.min(900, 30 * 2 ** Math.max((message.attempts || 1) - 1, 0)) });
    }
  }
}
