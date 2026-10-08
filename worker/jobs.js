// =====================================================
// JOB SYSTEM (master prompt sections 17, 38)
//
// Generic, not provisioning-specific — any long-running,
// step-based operation (provisioning today; deployments,
// exports, reports later) creates a job with a fixed,
// ordered step plan and tracks each step's outcome
// individually, so "which step failed and why" always has
// an answer.
//
// Execution model: this Worker has no Queues/Durable Objects
// binding configured, so a job's steps run inline, kicked off
// via `ctx.waitUntil()` from the route that created it — a
// real, sanctioned Cloudflare Workers pattern for work that
// shouldn't block the response, not a queue. This is fine for
// the handful of quick REST calls Phase 3's provisioning job
// makes; a job with much longer-running or higher-volume
// steps would need Queues or a Durable Object instead (master
// prompt section 38 explicitly anticipates this migration —
// nothing here would need to change except how runJob() gets
// invoked).
// =====================================================

function computeProgress(steps) {
  if (!steps.length) return 0;
  const done = steps.filter((s) => s.status === "success" || s.status === "skipped").length;
  return Math.round((done / steps.length) * 100);
}

export async function createJob(env, { type, organizationId, siteId, createdBy, actorType, payload, stepKeys }) {
  const id = crypto.randomUUID();

  await env.LUMMET_DB.prepare(
    `INSERT INTO jobs (id, type, organization_id, site_id, created_by, actor_type, status, payload)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`
  )
    .bind(id, type, organizationId || null, siteId || null, createdBy || null, actorType || "system", payload ? JSON.stringify(payload) : null)
    .run();

  const insertStep = env.LUMMET_DB.prepare(
    `INSERT INTO job_steps (job_id, step_key, step_order, status) VALUES (?, ?, ?, 'pending')`
  );
  await env.LUMMET_DB.batch(stepKeys.map((stepKey, index) => insertStep.bind(id, stepKey, index)));

  return { ok: true, jobId: id };
}

export async function getJob(env, jobId) {
  const job = await env.LUMMET_DB.prepare(`SELECT * FROM jobs WHERE id = ?`).bind(jobId).first();
  if (!job) return null;

  const stepsResult = await env.LUMMET_DB.prepare(
    `SELECT * FROM job_steps WHERE job_id = ? ORDER BY step_order`
  )
    .bind(jobId)
    .all();

  return {
    ...job,
    payload: job.payload ? JSON.parse(job.payload) : null,
    result: job.result ? JSON.parse(job.result) : null,
    steps: (stepsResult.results || []).map((s) => ({ ...s, output: s.output ? JSON.parse(s.output) : null }))
  };
}

export async function listJobsForSite(env, siteId) {
  const result = await env.LUMMET_DB.prepare(`SELECT * FROM jobs WHERE site_id = ? ORDER BY created_at DESC`)
    .bind(siteId)
    .all();
  return (result.results || []).map((job) => ({
    ...job,
    payload: job.payload ? JSON.parse(job.payload) : null,
    result: job.result ? JSON.parse(job.result) : null
  }));
}

export async function logJob(env, jobId, level, message) {
  // Never pass secrets in `message` — job_logs is visible to staff and customers.
  await env.LUMMET_DB.prepare(`INSERT INTO job_logs (job_id, level, message) VALUES (?, ?, ?)`)
    .bind(jobId, level, String(message).slice(0, 2000)).run();
}

async function currentRun(env, jobId) {
  return env.LUMMET_DB.prepare(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY run_number DESC LIMIT 1`).bind(jobId).first();
}

export async function markJobRunning(env, jobId) {
  await env.LUMMET_DB.prepare(
    `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?`
  )
    .bind(jobId)
    .run();
  // One job_runs row per execution; a retry is a new run of the same job.
  const last = await currentRun(env, jobId);
  if (!last || last.status !== 'running') {
    const n = last ? last.run_number + 1 : 1;
    await env.LUMMET_DB.prepare(`INSERT INTO job_runs (job_id, run_number, trigger) VALUES (?, ?, ?)`)
      .bind(jobId, n, n === 1 ? 'initial' : 'retry').run();
    await logJob(env, jobId, 'info', `run ${n} started`);
  }
}

async function closeRun(env, jobId, status, error) {
  const run = await currentRun(env, jobId);
  if (run && run.status === 'running') {
    await env.LUMMET_DB.prepare(`UPDATE job_runs SET status = ?, finished_at = CURRENT_TIMESTAMP, error_message = ? WHERE id = ?`)
      .bind(status, error ? String(error).slice(0, 1000) : null, run.id).run();
  }
  await logJob(env, jobId, status === 'success' ? 'info' : 'error', status === 'success' ? 'job succeeded' : `job failed: ${error}`);
}

export async function markJobSuccess(env, jobId, result) {
  await env.LUMMET_DB.prepare(
    `UPDATE jobs SET status = 'success', progress = 100, result = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(result ? JSON.stringify(result) : null, jobId)
    .run();
  await closeRun(env, jobId, 'success');
}

export async function markJobFailed(env, jobId, errorMessage) {
  await env.LUMMET_DB.prepare(
    `UPDATE jobs SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP WHERE id = ?`
  )
    .bind(String(errorMessage || "unknown error"), jobId)
    .run();
  await closeRun(env, jobId, 'failed', String(errorMessage || "unknown error"));
}

async function refreshProgress(env, jobId) {
  const stepsResult = await env.LUMMET_DB.prepare(`SELECT status FROM job_steps WHERE job_id = ?`).bind(jobId).all();
  const progress = computeProgress(stepsResult.results || []);
  await env.LUMMET_DB.prepare(`UPDATE jobs SET progress = ? WHERE id = ?`).bind(progress, jobId).run();
}

export async function getStep(env, jobId, stepKey) {
  return env.LUMMET_DB.prepare(`SELECT * FROM job_steps WHERE job_id = ? AND step_key = ?`).bind(jobId, stepKey).first();
}

export async function startStep(env, jobId, stepKey) {
  await env.LUMMET_DB.prepare(
    `UPDATE job_steps SET status = 'running', attempt = attempt + 1, started_at = CURRENT_TIMESTAMP WHERE job_id = ? AND step_key = ?`
  )
    .bind(jobId, stepKey)
    .run();
  const run = await currentRun(env, jobId);
  const step = await getStep(env, jobId, stepKey);
  await env.LUMMET_DB.prepare(
    `INSERT INTO job_attempts (job_id, run_number, step_key, attempt, status) VALUES (?, ?, ?, ?, 'running')`
  ).bind(jobId, run ? run.run_number : 1, stepKey, step ? step.attempt : 1).run();
}

async function finishAttempt(env, jobId, stepKey, status, error) {
  const a = await env.LUMMET_DB.prepare(
    `SELECT id FROM job_attempts WHERE job_id = ? AND step_key = ? AND status = 'running' ORDER BY id DESC LIMIT 1`
  ).bind(jobId, stepKey).first();
  if (a) {
    await env.LUMMET_DB.prepare(`UPDATE job_attempts SET status = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(status, error ? String(error).slice(0, 1000) : null, a.id).run();
  } else {
    const run = await currentRun(env, jobId);
    await env.LUMMET_DB.prepare(
      `INSERT INTO job_attempts (job_id, run_number, step_key, attempt, status, error_message, finished_at) VALUES (?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(jobId, run ? run.run_number : 1, stepKey, status, error ? String(error).slice(0, 1000) : null).run();
  }
  await logJob(env, jobId, status === 'failed' ? 'error' : 'info', `step ${stepKey}: ${status}${error ? ' — ' + String(error).slice(0, 300) : ''}`);
}

export async function completeStep(env, jobId, stepKey, output) {
  await env.LUMMET_DB.prepare(
    `UPDATE job_steps SET status = 'success', output = ?, completed_at = CURRENT_TIMESTAMP WHERE job_id = ? AND step_key = ?`
  )
    .bind(output ? JSON.stringify(output) : null, jobId, stepKey)
    .run();
  await finishAttempt(env, jobId, stepKey, 'success');
  await refreshProgress(env, jobId);
}

export async function skipStep(env, jobId, stepKey, reason) {
  await env.LUMMET_DB.prepare(
    `UPDATE job_steps SET status = 'skipped', output = ?, completed_at = CURRENT_TIMESTAMP WHERE job_id = ? AND step_key = ?`
  )
    .bind(reason ? JSON.stringify({ reason }) : null, jobId, stepKey)
    .run();
  await finishAttempt(env, jobId, stepKey, 'skipped');
  await refreshProgress(env, jobId);
}

export async function failStep(env, jobId, stepKey, errorMessage) {
  await env.LUMMET_DB.prepare(
    `UPDATE job_steps SET status = 'failed', error_message = ?, completed_at = CURRENT_TIMESTAMP WHERE job_id = ? AND step_key = ?`
  )
    .bind(String(errorMessage || "unknown error"), jobId, stepKey)
    .run();
  await finishAttempt(env, jobId, stepKey, 'failed', String(errorMessage || "unknown error"));
}

export async function getJobHistory(env, jobId) {
  const [runs, attempts, logs] = await Promise.all([
    env.LUMMET_DB.prepare(`SELECT * FROM job_runs WHERE job_id = ? ORDER BY run_number`).bind(jobId).all(),
    env.LUMMET_DB.prepare(`SELECT * FROM job_attempts WHERE job_id = ? ORDER BY id`).bind(jobId).all(),
    env.LUMMET_DB.prepare(`SELECT level, message, created_at FROM job_logs WHERE job_id = ? ORDER BY id`).bind(jobId).all()
  ]);
  return { runs: runs.results, attempts: attempts.results, logs: logs.results };
}
